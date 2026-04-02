/**
 * Agent Orchestrator
 *
 * Drives any AgentDefinition through its lifecycle:
 *   1. Create or resume a session
 *   2. Run the ToolLoopAgent (auto-loops through tools with execute functions)
 *   3. When a tool without execute is called (e.g. request_screenshot),
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
import type { ModelMessage } from "ai";

// ============================================================================
// Session Store
// ============================================================================

const sessionStore = new Map<string, AgentSession>();

/** One AgentLoop instance per agent ID (shared across sessions). */
const agentLoops = new Map<string, AgentLoop>();

function getOrCreateLoop(def: AgentDefinition): AgentLoop {
  let loop = agentLoops.get(def.id);
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
    });
    agentLoops.set(def.id, loop);
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
    agentType: def.id,
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

  console.log(
    `[Orchestrator] Session created for agent "${def.id}": ${session.id} (loop: ${loopSession.id}, max: ${maxSteps})`
  );

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
    `[Orchestrator] Running agent "${def.id}" session ${session.id}`
  );

  const stepResult = await loop.run(session.agentLoopSessionId);

  console.log(`[Orchestrator] Agent result type: ${stepResult.type}`);

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
  // Typically this is request_screenshot or similar external-input tools.
  console.log(
    `[Orchestrator] Loop broke for ${toolCalls.length} tool call(s) needing external input`
  );

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

  // Let the agent definition process the external input (e.g. crop screenshot)
  let toolOutput: unknown;

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

  // Submit the tool result and re-run the agent
  const nextResult = await loop.submitToolResults(
    session.agentLoopSessionId,
    [{
      toolCallId,
      toolName,
      result: toolOutput,
    }]
  );

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
