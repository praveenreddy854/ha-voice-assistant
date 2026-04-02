/**
 * Agent Loop — wrapper around AI SDK's ToolLoopAgent
 *
 * Key design:
 * - Tools WITH execute functions: auto-loop inside ToolLoopAgent
 * - Tools WITHOUT execute (e.g. request_screenshot): loop breaks, returns to caller
 * - complete_task: stop condition via hasToolCall
 * - Session stores messages so the orchestrator can resume after external input
 */

import { randomUUID } from "crypto";
import {
  ToolLoopAgent,
  tool,
  jsonSchema,
  stepCountIs,
  hasToolCall,
} from "ai";
import type {
  ModelMessage,
  ToolSet,
} from "ai";
import { AI_MODEL_ADVANCED } from "../../config";
import { azureProvider } from "../../ai";

// ============================================================================
// Types
// ============================================================================

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
  /**
   * If provided, the tool auto-executes inside the ToolLoopAgent loop.
   * If omitted, the loop breaks and returns the tool call to the caller
   * (used for tools that need external input like screenshots).
   */
  execute?: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface AgentLoopConfig {
  systemPrompt: string;
  tools: ToolDefinition[];
  maxIterations?: number;
  model?: string;
  /** Called after each LLM step for logging/tracking. */
  onStepFinish?: (event: StepEvent) => void;
}

export interface StepEvent {
  stepNumber: number;
  text: string;
  toolCalls: Array<{ toolName: string; args: unknown }>;
  finishReason: string;
}

// ---- Result types ----

export type AgentStepResultType =
  | "tool_calls"
  | "complete"
  | "error";

export interface AgentToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface AgentStepResult {
  type: AgentStepResultType;
  message?: string;
  /** Present when type === "tool_calls" — these are tool calls that need external handling. */
  toolCalls?: AgentToolCall[];
  error?: string;
}

// ---- Session ----

export interface AgentLoopSession {
  id: string;
  messages: ModelMessage[];
  maxIterations: number;
  currentIteration: number;
  isComplete: boolean;
}

// ---- Public interface ----

export interface AgentLoop {
  createSession(
    userPrompt: string,
    messageHistory?: Array<{ role: string; content: string }>
  ): AgentLoopSession;
  deleteSession(sessionId: string): void;
  /**
   * Run the agent. The ToolLoopAgent handles the full tool loop internally.
   * Returns when:
   * - complete_task is called → type: "complete"
   * - a tool without execute is invoked → type: "tool_calls"
   * - max iterations reached → type: "error"
   * - LLM error → type: "error"
   */
  run(sessionId: string): Promise<AgentStepResult>;
  /**
   * After the caller handles external tool results, submit them and re-run.
   */
  submitToolResults(
    sessionId: string,
    results: ToolResultInput[]
  ): Promise<AgentStepResult>;
  getMessages(sessionId: string): ModelMessage[];
}

export interface ToolResultInput {
  toolCallId: string;
  toolName: string;
  result: unknown;
}

// ============================================================================
// Implementation
// ============================================================================

export function createAgentLoop(config: AgentLoopConfig): AgentLoop {
  const sessions = new Map<string, AgentLoopSession>();
  const model = config.model || AI_MODEL_ADVANCED;
  const maxIterations = config.maxIterations || 20;

  // Build AI SDK tool set from our definitions
  const aiTools: ToolSet = {};
  for (const def of config.tools) {
    if (def.execute) {
      // Tool with execute — auto-loops inside ToolLoopAgent
      const executeFn = def.execute;
      aiTools[def.function.name] = tool({
        description: def.function.description ?? "",
        inputSchema: jsonSchema(def.function.parameters as any),
        execute: async (args: any) => executeFn(args),
      });
    } else {
      // Tool without execute — loop breaks, returns to caller
      aiTools[def.function.name] = tool({
        description: def.function.description ?? "",
        inputSchema: jsonSchema(def.function.parameters as any),
      });
    }
  }

  // complete_task tool — always without execute so it triggers hasToolCall stop
  aiTools["complete_task"] = tool({
    description:
      "Call this tool when you have completed the user's request. Provide a summary.",
    inputSchema: jsonSchema({
      type: "object",
      properties: {
        success: {
          type: "boolean",
          description: "Whether the task was completed successfully.",
        },
        message: {
          type: "string",
          description: "A brief summary of what was accomplished.",
        },
      },
      required: ["success", "message"],
    } as any),
  });

  const agent = new ToolLoopAgent({
    model: azureProvider(model ?? ""),
    tools: aiTools,
    instructions: config.systemPrompt,
    stopWhen: [
      stepCountIs(maxIterations),
      hasToolCall("complete_task"),
    ],
    onStepFinish: config.onStepFinish
      ? ({ stepNumber, text, toolCalls, finishReason }) => {
          config.onStepFinish!({
            stepNumber,
            text: text || "",
            toolCalls: (toolCalls || []).map((tc: any) => ({
              toolName: tc.toolName,
              args: tc.input ?? tc.args,
            })),
            finishReason: finishReason || "unknown",
          });
        }
      : undefined,
  });

  // ---- Session management ----

  function createSession(
    userPrompt: string,
    messageHistory?: Array<{ role: string; content: string }>
  ): AgentLoopSession {
    const sessionId = randomUUID();
    const messages: ModelMessage[] = [];

    if (messageHistory && messageHistory.length > 0) {
      messages.push({
        role: "user",
        content: "The following is the conversation history from our previous interactions:",
      });

      for (const msg of messageHistory) {
        const prefix = msg.role === "user" ? "[User]:" : "[Assistant]:";
        messages.push({
          role: "assistant",
          content: `${prefix} ${msg.content}`,
        });
      }

      messages.push({
        role: "assistant",
        content: "I understand the conversation history above. I'll continue from where we left off.",
      });
    }

    messages.push({ role: "user", content: userPrompt });

    const session: AgentLoopSession = {
      id: sessionId,
      messages,
      maxIterations,
      currentIteration: 0,
      isComplete: false,
    };

    sessions.set(sessionId, session);
    return session;
  }

  function deleteSession(sessionId: string): void {
    sessions.delete(sessionId);
  }

  async function run(sessionId: string): Promise<AgentStepResult> {
    const session = sessions.get(sessionId);
    if (!session) {
      return { type: "error", error: `Session ${sessionId} not found` };
    }
    if (session.isComplete) {
      return { type: "complete", message: "Session already completed" };
    }

    try {
      const result = await agent.generate({
        messages: session.messages,
      });

      return processResult(session, result as any);
    } catch (error) {
      console.error("[AgentLoop] Error in run:", error);
      return {
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function processResult(
    session: AgentLoopSession,
    result: any
  ): AgentStepResult {
    // Append all response messages to session for continuity
    for (const step of result.steps) {
      session.currentIteration++;
    }

    // Store the response messages so we can resume
    const responseMessages = result.response.messages;
    session.messages.push(...responseMessages);

    // Check if complete_task was called
    const allToolCalls = result.steps.flatMap((s: any) => s.toolCalls);
    const completeCall = allToolCalls.find(
      (tc: any) => tc.toolName === "complete_task"
    );

    if (completeCall) {
      session.isComplete = true;
      const args = (completeCall as any).input ?? (completeCall as any).args ?? {};
      return {
        type: "complete",
        message: args.message || "Task completed",
      };
    }

    // Check if the loop stopped because a tool without execute was called
    // (finishReason will be "tool-calls" and there are unexecuted tool calls)
    const lastStep = result.steps[result.steps.length - 1];
    if (lastStep && lastStep.finishReason === "tool-calls") {
      // Find tool calls that don't have results (no execute function)
      const unresolvedToolCalls = lastStep.toolCalls.filter((tc: any) => {
        const hasResult = lastStep.toolResults.some(
          (tr: any) => tr.toolCallId === tc.toolCallId
        );
        return !hasResult;
      });

      if (unresolvedToolCalls.length > 0) {
        return {
          type: "tool_calls",
          toolCalls: unresolvedToolCalls.map((tc: any) => ({
            id: tc.toolCallId,
            type: "function" as const,
            function: {
              name: tc.toolName,
              arguments: JSON.stringify(tc.input ?? tc.args),
            },
          })),
        };
      }
    }

    // If we ran out of steps or the model just finished
    if (result.finishReason === "stop" || result.finishReason === "length") {
      session.isComplete = true;
      return {
        type: "complete",
        message: result.text || "Task completed",
      };
    }

    // Max iterations or other stop
    session.isComplete = true;
    return {
      type: "error",
      error: `Agent stopped: ${result.finishReason}. Text: ${result.text || "(none)"}`,
    };
  }

  async function submitToolResults(
    sessionId: string,
    results: ToolResultInput[]
  ): Promise<AgentStepResult> {
    const session = sessions.get(sessionId);
    if (!session) {
      return { type: "error", error: `Session ${sessionId} not found` };
    }

    // Append tool result messages to the conversation
    const toolResultMessage: ModelMessage = {
      role: "tool",
      content: results.map((r) => ({
        type: "tool-result" as const,
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        output: {
          type: "text" as const,
          value: typeof r.result === "string" ? r.result : JSON.stringify(r.result),
        },
      })),
    };

    session.messages.push(toolResultMessage);

    // Re-run the agent with the updated messages
    return run(sessionId);
  }

  function getMessages(sessionId: string): ModelMessage[] {
    const session = sessions.get(sessionId);
    return session ? [...session.messages] : [];
  }

  return {
    createSession,
    deleteSession,
    run,
    submitToolResults,
    getMessages,
  };
}
