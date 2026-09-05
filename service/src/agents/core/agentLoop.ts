/**
 * Agent Loop — wrapper around AI SDK's generateText with maxSteps
 *
 * Key design:
 * - Tools WITH execute functions: auto-loop inside generateText
 * - Tools WITHOUT execute (e.g. get_latest_screenshot): loop breaks, returns to caller
 * - complete_task: no execute function, so it naturally breaks the loop
 * - Session stores messages so the orchestrator can resume after external input
 */

import { randomUUID } from "crypto";
import {
  generateText,
  tool,
  jsonSchema,
  stepCountIs,
} from "ai";
import type {
  ModelMessage,
  Tool,
  ToolExecutionOptions,
} from "ai";
import type { z } from "zod";
import { AI_MODEL_ADVANCED } from "../../config";
import { azureProvider } from "../../ai";
import type { AgentPauseGate } from "./types";

// ============================================================================
// Types
// ============================================================================

export type AgentToolContext = {
  pauseGate?: AgentPauseGate;
  toolExecutionState?: { activeTool: string | null };
};

export type AgentToolExecutionOptions = ToolExecutionOptions<AgentToolContext>;

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    /** Raw JSON schema (legacy). Ignored when `inputSchema` is provided. */
    parameters: Record<string, unknown>;
    /** Zod schema (preferred). When present, used instead of `parameters`. */
    inputSchema?: z.ZodType;
  };
  /**
   * If provided, the tool auto-executes inside the generateText loop.
   * If omitted, the loop breaks and returns the tool call to the caller
   * (used for tools that need external input like screenshots).
   */
  execute?: (
    args: Record<string, unknown>,
    options?: AgentToolExecutionOptions
  ) => Promise<unknown>;
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
  requestModel: string;
  responseModel?: string;
  responseId?: string;
  provider: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    cacheReadTokens?: number;
    totalTokens?: number;
  };
  performance: {
    responseTimeMs?: number;
    stepTimeMs?: number;
    outputTokensPerSecond?: number;
  };
  /** Snapshot of the conversation messages at the time of this step. */
  messages: ModelMessage[];
  /** Per-session system context sent with this step, such as retrieved memory. */
  systemMessages?: string[];
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
  /** Present when type === "complete" — reflects the success flag the agent passed to complete_task. */
  success?: boolean;
  /** Tool-call ID for complete_task, used when completion must be rejected and resumed. */
  completionToolCallId?: string;
  /** Present when type === "tool_calls" — these are tool calls that need external handling. */
  toolCalls?: AgentToolCall[];
  error?: string;
}

// ---- Session ----

export interface AgentLoopSession {
  id: string;
  systemMessages: string[];
  messages: ModelMessage[];
  maxIterations: number;
  currentIteration: number;
  isComplete: boolean;
}

// ---- Public interface ----

export interface AgentLoop {
  createSession(
    userPrompt: string,
    messageHistory?: Array<{ role: string; content: string }>,
    systemMessages?: string[]
  ): AgentLoopSession;
  deleteSession(sessionId: string): void;
  /**
   * Run the agent. generateText with maxSteps handles the tool loop.
   * Returns when:
   * - complete_task is called → type: "complete"
   * - a tool without execute is invoked → type: "tool_calls"
   * - max iterations reached → type: "error"
   * - LLM error → type: "error"
   */
  run(
    sessionId: string,
    abortSignal?: AbortSignal,
    pauseGate?: AgentPauseGate
  ): Promise<AgentStepResult>;
  /**
   * After the caller handles external tool results, submit them and re-run.
   */
  submitToolResults(
    sessionId: string,
    results: ToolResultInput[],
    abortSignal?: AbortSignal,
    pauseGate?: AgentPauseGate
  ): Promise<AgentStepResult>;
  getMessages(sessionId: string): ModelMessage[];
}

export interface ToolResultInput {
  toolCallId: string;
  toolName: string;
  result: unknown;
  /** Optional image to inject into conversation so the LLM can see it directly. */
  imageBase64?: string;
  imageContentType?: string;
}


interface GenerateResultShape {
  readonly text: string;
  readonly finishReason: string;
  readonly steps: ReadonlyArray<{
    readonly toolCalls: ReadonlyArray<{
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input?: unknown;
    }>;
    readonly toolResults: ReadonlyArray<{
      readonly toolCallId: string;
    }>;
    readonly finishReason: string;
  }>;
  readonly response: {
    readonly messages: ReadonlyArray<ModelMessage>;
  };
}

// ============================================================================
// Implementation
// ============================================================================

export function createAgentLoop(config: AgentLoopConfig): AgentLoop {
  const sessions = new Map<string, AgentLoopSession>();
  const model = config.model || AI_MODEL_ADVANCED;
  const maxIterations = config.maxIterations || 20;

  // Build AI SDK tool set from our definitions
  const aiTools: Record<string, Tool<any, any, AgentToolContext>> = {};
  for (const def of config.tools) {
    const desc = def.function.description ?? "";
    const schema = def.function.inputSchema ?? jsonSchema(def.function.parameters as any);

    if (def.execute) {
      const executeFn = def.execute;
      aiTools[def.function.name] = tool({
        description: desc,
        inputSchema: schema as any,
        execute: async (args: any, options: AgentToolExecutionOptions) =>
          executeFn(args, options),
      });
    } else {
      aiTools[def.function.name] = tool({
        description: desc,
        inputSchema: schema as any,
      });
    }
  }

  // complete_task tool — no execute, so generateText loop breaks when it's called
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

  // ---- Session management ----

  function createSession(
    userPrompt: string,
    messageHistory?: Array<{ role: string; content: string }>,
    systemMessages?: string[]
  ): AgentLoopSession {
    const sessionId = randomUUID();
    const sessionSystemMessages = (systemMessages || [])
      .map((message) => message.trim())
      .filter(Boolean);
    const messages: ModelMessage[] = [];

    if (messageHistory && messageHistory.length > 0) {
      for (const msg of messageHistory) {
        messages.push({
          role: msg.role === "user" ? "user" : "assistant",
          content: msg.content,
        });
      }
    }

    messages.push({ role: "user", content: userPrompt });

    const session: AgentLoopSession = {
      id: sessionId,
      systemMessages: sessionSystemMessages,
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

  async function run(
    sessionId: string,
    abortSignal?: AbortSignal,
    pauseGate?: AgentPauseGate
  ): Promise<AgentStepResult> {
    const session = sessions.get(sessionId);
    if (!session) {
      return { type: "error", error: `Session ${sessionId} not found` };
    }
    if (session.isComplete) {
      return { type: "complete", message: "Session already completed" };
    }

    try {
      abortSignal?.throwIfAborted();
      await pauseGate?.waitIfPaused();
      abortSignal?.throwIfAborted();
      let stepCounter = 0;
      const systemPrompt = [config.systemPrompt, ...session.systemMessages]
        .filter(Boolean)
        .join("\n\n");
      const sharedToolContext: AgentToolContext = {
        pauseGate,
        toolExecutionState: { activeTool: null },
      };
      const toolsContext = Object.fromEntries(
        Object.keys(aiTools).map((toolName) => [toolName, sharedToolContext])
      );
      const result = await generateText<typeof aiTools, AgentToolContext>({
        model: azureProvider(model ?? ""),
        tools: aiTools,
        system: systemPrompt,
        messages: session.messages,
        abortSignal,
        toolsContext,
        stopWhen: stepCountIs(maxIterations),
        onStepFinish: config.onStepFinish
          ? ({ text, toolCalls, finishReason, usage, performance, response }) => {
              stepCounter++;
              config.onStepFinish!({
                stepNumber: stepCounter,
                text: text || "",
                toolCalls: (toolCalls || []).map((tc) => ({
                  toolName: tc.toolName,
                  args: (tc as { input?: unknown }).input,
                })),
                finishReason: finishReason || "unknown",
                requestModel: model ?? "unknown",
                responseModel: response.modelId || model || undefined,
                responseId: response.id,
                provider: "azure.ai.openai",
                usage: {
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  reasoningTokens: usage.outputTokenDetails?.reasoningTokens,
                  cacheReadTokens: usage.inputTokenDetails?.cacheReadTokens,
                  totalTokens: usage.totalTokens,
                },
                performance: {
                  responseTimeMs: performance.responseTimeMs,
                  stepTimeMs: performance.stepTimeMs,
                  outputTokensPerSecond: performance.outputTokensPerSecond,
                },
                messages: [...session.messages],
                systemMessages: [...session.systemMessages],
              });
            }
          : undefined,
      });

      await pauseGate?.waitIfPaused();
      abortSignal?.throwIfAborted();
      return processResult(session, result as unknown as GenerateResultShape);
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
    result: GenerateResultShape
  ): AgentStepResult {
    // Append all response messages to session for continuity
    for (const _step of result.steps) {
      session.currentIteration++;
    }

    // Store the response messages so we can resume
    const responseMessages = result.response.messages;
    session.messages.push(...(responseMessages as ModelMessage[]));

    // Check if complete_task was called
    const allToolCalls = result.steps.flatMap((s) => s.toolCalls);
    const completeCall = allToolCalls.find(
      (tc) => tc.toolName === "complete_task"
    );

    if (completeCall) {
      const args = (completeCall.input ?? {}) as Record<string, unknown>;
      return {
        type: "complete",
        message: (args.message as string) || "Task completed",
        success: args.success !== false,
        completionToolCallId: completeCall.toolCallId,
      };
    }

    // Check if the loop stopped because a tool without execute was called
    // (finishReason will be "tool-calls" and there are unexecuted tool calls)
    const lastStep = result.steps[result.steps.length - 1];
    if (lastStep && lastStep.finishReason === "tool-calls") {
      // Find tool calls that don't have results (no execute function)
      const unresolvedToolCalls = lastStep.toolCalls.filter((tc) => {
        const hasResult = lastStep.toolResults.some(
          (tr) => tr.toolCallId === tc.toolCallId
        );
        return !hasResult;
      });

      const fallbackToolCalls =
        unresolvedToolCalls.length > 0
          ? unresolvedToolCalls
          : lastStep.toolCalls.length > 0
            ? lastStep.toolCalls
            : allToolCalls.slice(-1);

      if (fallbackToolCalls.length > 0) {
        return {
          type: "tool_calls",
          toolCalls: fallbackToolCalls.map((tc) => ({
            id: tc.toolCallId,
            type: "function" as const,
            function: {
              name: tc.toolName,
              arguments: JSON.stringify(tc.input ?? {}),
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
    results: ToolResultInput[],
    abortSignal?: AbortSignal,
    pauseGate?: AgentPauseGate
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

    // If any result includes an image, inject it as a user message so the LLM
    // can see the screenshot directly in the conversation.
    const imageResult = results.find((r) => r.imageBase64);
    if (imageResult?.imageBase64) {
      const imageMessage: ModelMessage = {
        role: "user",
        content: [
          {
            type: "text",
            text: "Here is the screenshot from the TV. Analyze this image to decide your next action.",
          },
          {
            type: "image",
            image: imageResult.imageBase64,
            mediaType: (imageResult.imageContentType || "image/jpeg") as
              | "image/jpeg"
              | "image/png"
              | "image/gif"
              | "image/webp",
          },
        ],
      };
      session.messages.push(imageMessage);
    }

    // Re-run the agent with the updated messages
    return run(sessionId, abortSignal, pauseGate);
  }

  function getMessages(sessionId: string): ModelMessage[] {
    const session = sessions.get(sessionId);
    if (!session) return [];
    return [
      ...session.systemMessages.map((content) => ({
        role: "system" as const,
        content,
      })),
      ...session.messages,
    ];
  }

  return {
    createSession,
    deleteSession,
    run,
    submitToolResults,
    getMessages,
  };
}
