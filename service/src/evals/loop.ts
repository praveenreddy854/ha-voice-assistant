import type {
  AgentLoop,
  AgentLoopConfig,
  AgentStepResult,
  ToolDefinition,
  ToolResultInput,
} from "../agents/core/agentLoop";
import type { EvalModelCall, Evidence, Usage } from "./types";
import { reportedModelUsage, type TrialTelemetry } from "./telemetry";

export interface OfflineLoopOptions {
  createLoop(config: AgentLoopConfig): AgentLoop;
  systemPrompt: string;
  tools: ToolDefinition[];
  model: string;
  maxIterations: number;
  initialMessage: string;
  signal: AbortSignal;
  telemetry: TrialTelemetry;
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
  const telemetry = options.telemetry;
  let activeCall: EvalModelCall | undefined;
  let requestCalls: EvalModelCall[] = [];
  let steps = 0;
  const loop = options.createLoop({
    systemPrompt: options.systemPrompt,
    tools,
    model: options.model,
    maxIterations: options.maxIterations,
    modelMiddleware: {
      specificationVersion: "v4",
      async wrapGenerate({ doGenerate }) {
        const call = telemetry.beginModel(options.model);
        activeCall = call;
        requestCalls.push(call);
        try {
          const result = await doGenerate();
          const inputTokens = result.usage.inputTokens.total, outputTokens = result.usage.outputTokens.total;
          const response = telemetry.response(call, {
            model: result.response?.modelId || options.model, responseId: result.response?.id,
            finishReason: result.finishReason.unified,
            text: result.content.filter(part => part.type === "text").map(part => part.text).join("\n"),
            content: result.content,
            usage: reportedModelUsage({
              inputTokens, outputTokens,
              totalTokens: inputTokens === undefined || outputTokens === undefined ? undefined : inputTokens + outputTokens,
            }, result.usage.raw),
          });
          for (const tool of result.content) if (tool.type === "tool-call") {
            telemetry.requestTool(call, response.turn, tool.toolCallId, tool.toolName, tool.input);
          }
          telemetry.endModel(call);
          response.responseTimeMs = call.durationMs;
          return result;
        } catch (error) {
          telemetry.endModel(call, error);
          throw error;
        }
      },
    },
    onStepFinish(event) {
      steps++;
      for (const call of event.toolCalls) if (call.error && activeCall) {
        telemetry.rejectTool(telemetry.findTool(activeCall, call.toolCallId), call.error);
      }
      options.record({
        kind: "context",
        text: JSON.stringify({ model: event.requestModel, text: event.text, toolCalls: event.toolCalls, usage: event.usage }),
      });
    },
  });
  const session = loop.createSession(options.initialMessage);
  telemetry.beginUserTurn();
  const requestModel = async (execute: () => Promise<AgentStepResult>) => {
    options.signal.throwIfAborted();
    activeCall = undefined;
    requestCalls = [];
    const result = await execute();
    const finalCall = requestCalls.at(-1);
    if (result.type === "error" && finalCall) {
      for (const tool of telemetry.trace.toolCalls) {
        if (tool.modelCallId === finalCall.id && tool.status === "not_executed") {
          telemetry.rejectTool(tool, result.error || "Model execution failed");
        }
      }
    }
    return result;
  };
  try {
    let result = await requestModel(() => loop.run(session.id, options.signal));
    while (true) {
      options.signal.throwIfAborted();
      if (result.type === "complete") {
        // SDK recovery can return a completion from an earlier step in this request.
        const completion = result.completionToolCallId
          ? telemetry.findTool(requestCalls, result.completionToolCallId) : undefined;
        const rejection = options.rejectCompletion?.(result, steps);
        if (rejection && completion) {
          telemetry.rejectTool(completion, rejection);
          result = await requestModel(() => loop.submitToolResults(session.id, [{
            toolName: "complete_task", toolCallId: completion.toolCallId, result: rejection,
          }], options.signal));
          continue;
        }
        if (completion?.status === "not_executed") telemetry.completeTool(completion, { completionSuccess: result.success, message: result.message });
        return {
          finalResponse: result.message || "", completionSuccess: result.success,
          usage: telemetry.usage(), steps, stoppedAtIterationLimit: false,
        };
      }
      if (result.type === "error") throw new Error(result.error || "Model execution failed");
      if (steps >= options.maxIterations) {
        telemetry.stop("iteration_limit");
        return {
          finalResponse: "[Agent iteration limit reached without completion]",
          usage: telemetry.usage(), steps, stoppedAtIterationLimit: true,
        };
      }
      const outputs: ToolResultInput[] = [];
      for (const [index, call] of (result.toolCalls || []).entries()) {
        const name = call.function.name, trace = telemetry.findTool(activeCall!, call.id);
        let args: Record<string, unknown>;
        try {
          const input: Record<string, unknown> = JSON.parse(call.function.arguments);
          const contract = tools.find(tool => tool.function.name === name);
          if (!contract) throw new Error(`Unknown tool ${name}`);
          if (options.requireInputSchemas && !contract.function.inputSchema) {
            throw new Error(`Missing input schema for offline tool ${name}`);
          }
          args = contract.function.inputSchema ? contract.function.inputSchema.parse(input) as Record<string, unknown> : input;
        } catch (error) {
          telemetry.rejectTool(trace, error instanceof Error ? error.message : String(error));
          throw error;
        }
        let value: Pick<ToolResultInput, "result" | "imageBase64" | "imageContentType">;
        if (options.oneToolPerTurn && index > 0) {
          const rejection = "Rejected parallel tool call: only one tool is allowed per turn.";
          telemetry.rejectTool(trace, rejection);
          value = { result: { observation: rejection, toolSuccess: false } };
        } else {
          value = await telemetry.executeTool(trace, () => options.executeTool(name, args), output => output.result);
        }
        outputs.push({ toolName: name, toolCallId: call.id, ...value });
      }
      result = await requestModel(() => loop.submitToolResults(session.id, outputs, options.signal));
    }
  } finally {
    try {
      telemetry.trace.systemMessages = [options.systemPrompt];
      telemetry.trace.messages = loop.getMessages(session.id);
    } finally { loop.deleteSession(session.id); }
  }
}
