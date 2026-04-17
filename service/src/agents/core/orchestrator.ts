/**
 * Agent Orchestrator
 *
 * Drives any AgentDefinition through its lifecycle:
 *   1. Create or resume a session
 *   2. Run the ToolLoopAgent (auto-loops through tools with execute functions)
 *   3. When a tool without execute is called (e.g. get_latest_screenshot),
 *      the loop breaks and we pause for external input
 *   4. Resume when the client provides external input
 *   5. Clean up on completion or error
 *
 * Domain-specific logic lives in the AgentDefinition hooks.
 */

import { randomUUID } from "crypto";
import {
  createAgentLoop,
  AgentLoop,
  AgentToolCall,
  AgentStepResult,
  ToolDefinition,
  ToolResultInput,
} from "./agentLoop";
import {
  AgentDefinition,
  AgentSession,
  AgentStep,
  AgentRunOptions,
  AgentRunResult,
  AgentSessionStatus,
  ExternalInputData,
  PendingExternalInput,
} from "./types";
import { getAgent } from "./registry";
import { resolveMaxSteps } from "../common/utils";
import { getLatestScreenshot } from "../common/screenshotStore";
import type { ModelMessage } from "ai";
import {
  createTrace,
  addEvent,
  addLLMStep,
  addScreenshot,
  completeTrace,
  updateTraceStatus,
  setActiveSession,
  getActiveSessionId,
} from "../../tracing/agentTraceStore";

// ============================================================================
// Session Store
// ============================================================================

const sessionStore = new Map<string, AgentSession>();

/** One AgentLoop instance per agent type (shared across sessions). */
const agentLoops = new Map<string, AgentLoop>();

function getOrCreateLoop(def: AgentDefinition): AgentLoop {
  let loop = agentLoops.get(def.agentType);
  if (!loop) {
    // Build ToolDefinitions — tools with execute auto-run inside ToolLoopAgent,
    // tools without execute break the loop for external handling
    const tools: ToolDefinition[] = def.tools.map((t) => {
      const toolDef: ToolDefinition = {
        type: "function" as const,
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters as Record<string, unknown>,
          inputSchema: t.function.inputSchema,
        },
      };

      // If the agent definition provides an executor and this tool should auto-execute
      if (t.execute) {
        toolDef.execute = t.execute;
      }

      return toolDef;
    });

    loop = createAgentLoop({
      systemPrompt: def.systemPrompt,
      tools,
      maxIterations: def.maxIterations,
      model: def.model,
      onStepFinish: (event) => {
        const toolNames = event.toolCalls.map((tc) => tc.toolName).join(", ") || "none";
        console.log(
          `[AgentLoop] Step ${event.stepNumber} finished (reason: ${event.finishReason}, tools: [${toolNames}])`
        );
        const traceSessionId = getActiveSessionId();
        if (traceSessionId) {
          addLLMStep(traceSessionId, {
            stepNumber: event.stepNumber,
            timestamp: new Date().toISOString(),
            finishReason: event.finishReason,
            text: event.text || "",
            toolCalls: event.toolCalls.map((toolCall) => ({
              toolName: toolCall.toolName,
              toolCallId: "",
              args:
                typeof toolCall.args === "object" &&
                toolCall.args !== null &&
                !Array.isArray(toolCall.args)
                  ? (toolCall.args as Record<string, unknown>)
                  : {},
              actionSummary: "",
            })),
            messages: event.messages as Array<{ role: string; content: unknown }>,
          });
        }
        if (event.text) {
          console.log(`[AgentLoop]   LLM text: ${event.text.substring(0, 300)}`);
        }
        for (const tc of event.toolCalls) {
          console.log(`[AgentLoop]   Tool call: ${tc.toolName}(${JSON.stringify(tc.args)})`);
        }
      },
    });
    agentLoops.set(def.agentType, loop);
  }
  return loop;
}

// ============================================================================
// Session Management
// ============================================================================

export function getSession(sessionId: string): AgentSession | undefined {
  return sessionStore.get(sessionId);
}

async function createSession(
  def: AgentDefinition,
  options: AgentRunOptions
): Promise<AgentSession> {
  const loop = getOrCreateLoop(def);
  const maxSteps = resolveMaxSteps(options.maxSteps, def.maxIterations);

  const initialMessage = await def.buildInitialMessage(
    options.userPrompt!,
    options
  );

  const loopSession = loop.createSession(initialMessage, options.messageHistory);

  const session: AgentSession = {
    id: randomUUID(),
    agentType: def.agentType,
    agentLoopSessionId: loopSession.id,
    steps: [],
    pendingExternalInput: undefined,
    completed: false,
    iterations: 0,
    maxSteps,
    userPrompt: options.userPrompt!,
    closed: false,
    agentData: {},
  };

  sessionStore.set(session.id, session);

  // Create trace for this session
  createTrace(session.id, def.agentType, options.userPrompt!);

  console.log(
    `[Orchestrator] Session created for agent "${def.agentType}": ${session.id} (loop: ${loopSession.id}, max: ${maxSteps})`
  );
  console.log(`[Orchestrator] User prompt: "${options.userPrompt}"`);

  return session;
}

async function cleanupSession(
  session: AgentSession,
  def: AgentDefinition
): Promise<void> {
  if (session.closed) {
    sessionStore.delete(session.id);
    return;
  }
  session.closed = true;
  sessionStore.delete(session.id);

  const loop = getOrCreateLoop(def);
  loop.deleteSession(session.agentLoopSessionId);
}

// ============================================================================
// Result Builders
// ============================================================================

function buildResult(
  session: AgentSession,
  status: AgentSessionStatus,
  success: boolean,
  message: string,
  externalInputRequest?: AgentRunResult["externalInputRequest"]
): AgentRunResult {
  return {
    success,
    message,
    sessionId: session.id,
    status,
    steps: session.steps,
    externalInputRequest,
    agentData: { ...session.agentData },
  };
}

// ============================================================================
// Agent Loop Processing
// ============================================================================

async function processLoop(
  session: AgentSession,
  def: AgentDefinition
): Promise<AgentRunResult> {
  const loop = getOrCreateLoop(def);

  console.log(
    `[Orchestrator] Running agent "${def.agentType}" session ${session.id}`
  );
  addEvent(session.id, "agent.loop.started", `Running agent loop for session ${session.id}`);
  setActiveSession(session.id);

  const stepResult = await loop.run(session.agentLoopSessionId);
  setActiveSession(null);

  console.log(`[Orchestrator] Agent result type: ${stepResult.type}`);
  if (stepResult.type === "tool_calls") {
    const toolNames = stepResult.toolCalls?.map((tc) => tc.function.name).join(", ") || "none";
    console.log(`[Orchestrator] Unresolved tool calls: ${toolNames}`);
  }
  if (stepResult.type === "error") {
    console.error(`[Orchestrator] Agent loop error: ${stepResult.error}`);
  }

  return handleResult(session, def, stepResult);
}

function handleResult(
  session: AgentSession,
  def: AgentDefinition,
  stepResult: AgentStepResult
): Promise<AgentRunResult> {
  switch (stepResult.type) {
    case "error":
      return handleError(session, def, stepResult.error || "Unknown agent error");

    case "complete":
      return handleComplete(session, def, stepResult.message || "Task completed successfully");

    case "tool_calls":
      return handleToolCalls(session, def, stepResult.toolCalls || []);
  }
}

async function handleError(
  session: AgentSession,
  def: AgentDefinition,
  message: string
): Promise<AgentRunResult> {
  console.error(`[Orchestrator] Agent error: ${message}`);
  completeTrace(session.id, false, message, "error");
  const result = buildResult(session, "error", false, message);
  if (def.onComplete) await def.onComplete(session, result);
  await cleanupSession(session, def);
  return result;
}

async function handleComplete(
  session: AgentSession,
  def: AgentDefinition,
  message: string
): Promise<AgentRunResult> {
  console.log(`[Orchestrator] Agent completed: ${message}`);
  completeTrace(session.id, true, message, "completed");
  session.completed = true;
  session.agentData.finalMessage = message;
  const result = buildResult(session, "completed", true, message);
  if (def.onComplete) await def.onComplete(session, result);
  await cleanupSession(session, def);
  return result;
}

async function handleToolCalls(
  session: AgentSession,
  def: AgentDefinition,
  toolCalls: AgentToolCall[]
): Promise<AgentRunResult> {
  // These are tool calls without execute functions (loop broke).
  // Typically this is get_latest_screenshot or similar external-input tools.
  const externalToolNames = toolCalls.map((tc) => tc.function.name).join(", ");
  console.log(
    `[Orchestrator] Loop broke for ${toolCalls.length} tool call(s) needing external input: ${externalToolNames}`
  );
  updateTraceStatus(session.id, "awaiting_external_input");
  addEvent(session.id, "agent.external_input.requested", `Paused for external input: ${externalToolNames}`, {
    toolCalls: toolCalls.map((tc) => ({
      name: tc.function.name,
      args: tc.function.arguments,
    })),
  });

  // Track steps for each tool call
  for (const tc of toolCalls) {
    let parsedArgs: Record<string, unknown>;
    try {
      parsedArgs = JSON.parse(tc.function.arguments);
    } catch {
      parsedArgs = {};
    }

    const step: AgentStep = {
      index: session.steps.length + 1,
      toolName: tc.function.name,
      toolCallId: tc.id,
      toolArgs: parsedArgs,
      actionSummary: def.getToolActionSummary(tc.function.name, parsedArgs),
      observation: "Awaiting external input",
      toolSuccess: undefined,
      awaitingExternalInput: true,
      retryCount: 0,
      maxRetries: 3,
      metadata: { externalInputType: "screenshot" },
    };

    session.steps.push(step);
  }

  // Use the first tool call as the pending external input
  const primaryCall = toolCalls[0];
  let parsedArgs: Record<string, unknown>;
  try {
    parsedArgs = JSON.parse(primaryCall.function.arguments);
  } catch {
    parsedArgs = {};
  }

  const pendingStep = session.steps[session.steps.length - toolCalls.length];

  session.pendingExternalInput = {
    toolCallId: primaryCall.id,
    toolName: primaryCall.function.name,
    args: parsedArgs,
    stepIndex: pendingStep.index,
    observation: pendingStep.observation,
    request: {
      type: "screenshot",
      prompt: `Provide input after: ${pendingStep.actionSummary}`,
      reason: (parsedArgs as any).reason || pendingStep.actionSummary,
    },
    retryCount: 0,
  };

  // Auto-fulfill get_latest_screenshot by reading from disk
  if (primaryCall.function.name === "get_latest_screenshot") {
    const screenshot = await getLatestScreenshot(session.id);
    if (screenshot) {
      console.log(
        `[Orchestrator] Auto-fulfilling get_latest_screenshot from disk: ${screenshot.filePath}`
      );
      return handleExternalInput(session, def, {
        type: "screenshot",
        data: { base64: screenshot.base64, contentType: screenshot.contentType },
      });
    }
    console.warn(
      `[Orchestrator] No screenshot on disk for session ${session.id}, falling back to client`
    );
  }

  return buildResult(
    session,
    "awaiting_external_input",
    true,
    `Waiting for external input for step ${pendingStep.index}.`,
    {
      ...session.pendingExternalInput.request,
      stepIndex: pendingStep.index,
    }
  );
}

// ============================================================================
// External Input Handling
// ============================================================================

async function handleExternalInput(
  session: AgentSession,
  def: AgentDefinition,
  input: ExternalInputData
): Promise<AgentRunResult> {
  const pending = session.pendingExternalInput;
  if (!pending) {
    throw new Error("No pending external input request for this session.");
  }

  const loop = getOrCreateLoop(def);

  const hasImage = !!(input.data?.base64);
  console.log(
    `[Orchestrator] Processing external input for tool "${pending.toolName}" (hasImage: ${hasImage}, error: ${input.error || "none"})`
  );
  addEvent(session.id, "agent.external_input.received", `Received external input for "${pending.toolName}"`, {
    hasImage,
    error: input.error,
  });

  // If screenshot received, record it in trace
  if (hasImage) {
    const contentType = (input.data.contentType as string) || "image/jpeg";
    const base64 = input.data.base64 as string;
    addScreenshot(session.id, {
      stepIndex: pending.stepIndex,
      dataUrl: `data:${contentType};base64,${base64}`,
      timestamp: new Date().toISOString(),
      outcome: "captured",
    });
    addEvent(session.id, "agent.screenshot.received", `Screenshot captured for step ${pending.stepIndex}`, {
      stepIndex: pending.stepIndex,
      contentType,
      sizeBytes: base64.length,
    });
  } else if (input.error) {
    addScreenshot(session.id, {
      stepIndex: pending.stepIndex,
      timestamp: new Date().toISOString(),
      outcome: "error",
      error: input.error,
    });
  }

  // Let the agent definition process the external input (e.g. screenshot)
  let toolOutput: unknown;
  let imageBase64: string | undefined;
  let imageContentType: string | undefined;

  if (def.processExternalInput) {
    const processed = await def.processExternalInput(session, input);

    // Update the step
    const step = session.steps.find((s) => s.index === pending.stepIndex);
    if (step) {
      step.observation = `${pending.observation}. ${processed.observation}`;
      step.retryCount = 0;
      step.awaitingExternalInput = false;
    }

    toolOutput = {
      success: !input.error,
      observation: processed.observation,
      external_input_received: true,
    };

    imageBase64 = processed.imageBase64;
    imageContentType = processed.imageContentType;
  } else if (input.error) {
    toolOutput = {
      success: false,
      observation: `External input failed: ${input.error}`,
    };
  } else {
    toolOutput = {
      success: true,
      observation: `External input received: ${JSON.stringify(input.data)}`,
      external_input_received: true,
    };
  }

  // Clear pending state
  const toolCallId = pending.toolCallId;
  const toolName = pending.toolName;
  session.pendingExternalInput = undefined;

  // Submit the tool result (with image if available) and re-run the agent
  setActiveSession(session.id);
  const nextResult = await loop.submitToolResults(
    session.agentLoopSessionId,
    [{
      toolCallId,
      toolName,
      result: toolOutput,
      imageBase64,
      imageContentType,
    }]
  );
  setActiveSession(null);

  return handleResult(session, def, nextResult);
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Run an agent. Handles both new sessions and continuations.
 *
 * Usage:
 * ```ts
 * // New session
 * const result = await runAgent({ agentType: "tv", userPrompt: "Play YouTube" });
 *
 * // Continue with external input
 * const result = await runAgent({
 *   agentType: "tv",
 *   sessionId: prevResult.sessionId,
 *   externalInput: { type: "screenshot", data: { base64, contentType } },
 * });
 * ```
 */
export async function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const def = getAgent(options.agentType);
  if (!def) {
    return {
      success: false,
      message: `Agent "${options.agentType}" is not registered.`,
      sessionId: "",
      status: "error",
      steps: [],
    };
  }

  let session: AgentSession | undefined;

  try {
    // Get or create session
    if (options.sessionId) {
      session = sessionStore.get(options.sessionId);
      if (!session) {
        throw new Error(
          `No active session found for sessionId ${options.sessionId}. Start a new session by omitting sessionId.`
        );
      }
      console.log(
        `[Orchestrator] Resuming session ${session.id} with ${session.steps.length} steps`
      );
    }

    if (!session) {
      if (!options.userPrompt) {
        throw new Error(
          "userPrompt is required when starting a new agent session."
        );
      }
      session = await createSession(def, options);
    }

    session.maxSteps = resolveMaxSteps(session.maxSteps, def.maxIterations);

    let result: AgentRunResult;

    // Handle pending external input
    if (session.pendingExternalInput) {
      if (options.externalInput) {
        result = await handleExternalInput(session, def, options.externalInput);
      } else {
        // No input provided — return current awaiting state
        const pending = session.pendingExternalInput;
        return buildResult(
          session,
          "awaiting_external_input",
          true,
          `Still waiting for external input for step ${pending.stepIndex}.`,
          {
            ...pending.request,
            stepIndex: pending.stepIndex,
          }
        );
      }
    } else {
      result = await processLoop(session, def);
    }

    // Cleanup on terminal states
    if (result.status === "completed" || result.status === "error") {
      await cleanupSession(session, def);
    }

    return result;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error running agent.";
    console.error(`[Orchestrator] Error:`, { message, error });

    if (session) {
      const result = buildResult(session, "error", false, message);
      if (def.onComplete) {
        try {
          await def.onComplete(session, result);
        } catch (cleanupErr) {
          console.warn(`[Orchestrator] onComplete error:`, cleanupErr);
        }
      }
      await cleanupSession(session, def);
      return result;
    }

    return {
      success: false,
      message,
      sessionId: options.sessionId || "",
      status: "error",
      steps: [],
    };
  }
}

// ============================================================================
// Session Utilities (exposed for agents that need direct access)
// ============================================================================

export function getAgentLoop(agentType: string): AgentLoop | undefined {
  return agentLoops.get(agentType);
}

export function getSessionMessages(sessionId: string): ModelMessage[] {
  const session = sessionStore.get(sessionId);
  if (!session) return [];

  const def = getAgent(session.agentType);
  if (!def) return [];

  const loop = getOrCreateLoop(def);
  return loop.getMessages(session.agentLoopSessionId);
}

export function addMessageToSession(
  sessionId: string,
  role: "user" | "assistant",
  content: string
): boolean {
  // Direct message injection is not supported with ToolLoopAgent.
  // Messages are managed through the generate() call flow.
  console.warn(
    `[Orchestrator] addMessageToSession is not supported with ToolLoopAgent. Session: ${sessionId}`
  );
  return false;
}
