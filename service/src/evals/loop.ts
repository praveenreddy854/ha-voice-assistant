import type {
  AgentLoop,
  AgentLoopConfig,
  AgentStepResult,
  ToolDefinition,
  ToolResultInput,
} from "../agents/core/agentLoop";
import type { Evidence, Usage } from "./types";

export interface OfflineLoopOptions {
  createLoop(config: AgentLoopConfig): AgentLoop;
  systemPrompt: string;
  tools: ToolDefinition[];
  model: string;
  maxIterations: number;
  initialMessage: string;
  signal: AbortSignal;
  record(item: Omit<Evidence, "id">): unknown;
  executeTool(name: string, args: Record<string, unknown>): Promise<
    Pick<ToolResultInput, "result" | "imageBase64" | "imageContentType">
  >;
  oneToolPerTurn?: boolean;
  requireInputSchemas?: boolean;
  rejectCompletion?(result: AgentStepResult, steps: number): string | undefined;
}

export interface OfflineLoopResult {
  finalResponse: string;
  completionSuccess?: boolean;
  usage: Usage;
  steps: number;
  stoppedAtIterationLimit: boolean;
}

/** Only the supplied simulator receives tool calls; no production executor is retained. */
export async function runOfflineAgentLoop(options: OfflineLoopOptions): Promise<OfflineLoopResult> {
  const tools = options.tools.map(({ type, function: contract }) => ({ type, function: contract }));
  const usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let steps = 0;
  const loop = options.createLoop({
    systemPrompt: options.systemPrompt,
    tools,
    model: options.model,
    maxIterations: options.maxIterations,
    onStepFinish(event) {
      steps++;
      for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
        if (event.usage[key] === undefined || usage[key] === undefined) usage[key] = undefined;
        else usage[key]! += event.usage[key]!;
      }
      options.record({
        kind: "context",
        text: JSON.stringify({ model: event.requestModel, text: event.text, toolCalls: event.toolCalls, usage: event.usage }),
      });
    },
  });
  const session = loop.createSession(options.initialMessage);
  try {
    let result = await loop.run(session.id, options.signal);
    while (true) {
      options.signal.throwIfAborted();
      if (result.type === "complete") {
        const rejection = options.rejectCompletion?.(result, steps);
        if (rejection && result.completionToolCallId) {
          result = await loop.submitToolResults(session.id, [{
            toolName: "complete_task", toolCallId: result.completionToolCallId, result: rejection,
          }], options.signal);
          continue;
        }
        return {
          finalResponse: result.message || "", completionSuccess: result.success,
          usage, steps, stoppedAtIterationLimit: false,
        };
      }
      if (result.type === "error") throw new Error(result.error || "Model execution failed");
      if (steps >= options.maxIterations) {
        return {
          finalResponse: "[Agent iteration limit reached without completion]",
          usage, steps, stoppedAtIterationLimit: true,
        };
      }
      const outputs: ToolResultInput[] = [];
      for (const [index, call] of (result.toolCalls || []).entries()) {
        const name = call.function.name, args = JSON.parse(call.function.arguments);
        const contract = tools.find(tool => tool.function.name === name);
        if (!contract) throw new Error(`Unknown tool ${name}`);
        if (options.requireInputSchemas && !contract.function.inputSchema) {
          throw new Error(`Missing input schema for offline tool ${name}`);
        }
        const parsed = contract.function.inputSchema?.parse(args) as Record<string, unknown> | undefined;
        const value = options.oneToolPerTurn && index > 0
          ? { result: { observation: "Rejected parallel tool call: only one tool is allowed per turn.", toolSuccess: false } }
          : await options.executeTool(name, parsed || args);
        outputs.push({ toolName: name, toolCallId: call.id, ...value });
      }
      result = await loop.submitToolResults(session.id, outputs, options.signal);
    }
  } finally {
    loop.deleteSession(session.id);
  }
}
