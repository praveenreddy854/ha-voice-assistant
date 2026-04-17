/**
 * TV Typing Agent Core Logic
 * Specialized agent for text input operations using ToolLoopAgent
 *
 * All tools have execute functions, so the ToolLoopAgent auto-loops
 * until complete_task is called or max iterations are reached.
 */

import {
  HOME_ASSISTANT_TOKEN,
  HOME_ASSISTANT_URL,
  AI_MODEL_ADVANCED,
} from "../../config";
import {
  TYPING_AGENT_INSTRUCTIONS,
  TYPING_AGENT_MAX_ITERATIONS_CAP,
  TYPING_TOOLS,
} from "./constants";
import {
  TypingAgentStep,
  TypingAgenticFlowResult,
  RunTypingAgenticFlowOptions,
  TypingAgentSessionState,
  TypingToolName,
  TypingToolArguments,
  GetLatestScreenshotArgs,
  DeleteTypedTextArgs,
  DeterministicTypingArgs,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types";
import {
  executeDeleteTypedText,
  executeDeterministicTyping,
} from "./toolExecutors";
import {
  createAgentLoop,
  AgentLoop,
  ToolDefinition,
  ToolResultInput,
} from "../core/agentLoop";

interface ActiveTypingRun {
  key: string;
  loop: AgentLoop;
  loopSessionId: string;
  toolContext: ToolExecutionContext;
  steps: TypingAgentStep[];
  targetText: string;
  lastTouchedAt: number;
  pendingToolCallId?: string;
  pendingToolName?: string;
}

const activeTypingRuns = new Map<string, ActiveTypingRun>();
const ACTIVE_TYPING_RUN_TTL_MS = 30 * 60 * 1000;

function cleanupExpiredTypingRuns(): void {
  const now = Date.now();

  for (const [key, run] of activeTypingRuns.entries()) {
    if (now - run.lastTouchedAt <= ACTIVE_TYPING_RUN_TTL_MS) {
      continue;
    }

    try {
      run.loop.deleteSession(run.loopSessionId);
    } catch (error) {
      console.warn(`[Typing Agent] Failed to delete expired session ${key}:`, error);
    }
    activeTypingRuns.delete(key);
  }
}

function buildInitialTypingMessage(options: RunTypingAgenticFlowOptions): string {
  let initialMessage = `${options.userMessage}\n\n`;
  initialMessage += `Text to Type: "${options.textToType}"\n\n`;
  initialMessage += `Device Configuration:\n`;
  initialMessage += `- Remote Entity ID: ${options.deviceConfig.remoteEntityId}\n`;
  initialMessage += `- Media Player Entity ID: ${options.deviceConfig.mediaPlayerEntityId}\n\n`;
  initialMessage += `Instructions: Type the text "${options.textToType}" using deterministic_typing.`;

  if (options.screenshotBase64) {
    initialMessage += `\n\nA screenshot is already available. Identify the current cursor position from the screenshot, then call deterministic_typing.`;
  } else {
    initialMessage += `\n\nNo screenshot is available yet. Request a screenshot so you can identify the current cursor position before calling deterministic_typing.`;
  }

  if (options.keyboardHints) {
    initialMessage += `\n\nApp-Specific Keyboard Guidance:\n${options.keyboardHints}`;
  }

  return initialMessage;
}

function createActiveTypingRun(options: RunTypingAgenticFlowOptions): ActiveTypingRun {
  const toolContext: ToolExecutionContext = {
    homeAssistantUrl: HOME_ASSISTANT_URL || "",
    homeAssistantToken: HOME_ASSISTANT_TOKEN || "",
    screenshotBase64: options.screenshotBase64,
    screenshotContentType: options.screenshotContentType,
    keyboardHints: options.keyboardHints,
    sessionId: options.resumeSessionKey,
    activeAgent: "typing",
    targetText: options.textToType,
    typedSoFar: "",
  };

  const steps: TypingAgentStep[] = [];
  const tools = buildTypingTools(toolContext, steps);
  const loop = createAgentLoop({
    systemPrompt: TYPING_AGENT_INSTRUCTIONS,
    tools,
    maxIterations: options.maxIterations || TYPING_AGENT_MAX_ITERATIONS_CAP,
    model: AI_MODEL_ADVANCED,
  });
  const loopSession = loop.createSession(buildInitialTypingMessage(options));

  return {
    key: options.resumeSessionKey || loopSession.id,
    loop,
    loopSessionId: loopSession.id,
    toolContext,
    steps,
    targetText: options.textToType,
    lastTouchedAt: Date.now(),
  };
}

function clearActiveTypingRun(run?: ActiveTypingRun): void {
  if (!run) {
    return;
  }

  try {
    run.loop.deleteSession(run.loopSessionId);
  } catch (error) {
    console.warn(`[Typing Agent] Failed to delete session ${run.key}:`, error);
  }
  activeTypingRuns.delete(run.key);
}

function buildSessionState(run: ActiveTypingRun, isComplete: boolean): TypingAgentSessionState {
  return {
    threadId: run.loopSessionId,
    steps: run.steps,
    isComplete,
    targetText: run.targetText,
    typedText: run.toolContext.typedSoFar,
    resumeSessionKey: run.key,
    pendingToolCallId: run.pendingToolCallId,
    pendingToolName: run.pendingToolName,
    awaitingScreenshot: Boolean(run.pendingToolCallId),
  };
}

async function executeTypingLoop(
  run: ActiveTypingRun,
  options: RunTypingAgenticFlowOptions
): Promise<ReturnType<AgentLoop["run"]>> {
  run.lastTouchedAt = Date.now();
  run.toolContext.screenshotBase64 = options.screenshotBase64;
  run.toolContext.screenshotContentType = options.screenshotContentType;
  run.toolContext.keyboardHints = options.keyboardHints;

  if (
    run.pendingToolCallId &&
    options.screenshotBase64 &&
    options.screenshotContentType
  ) {
    const toolResults: ToolResultInput[] = [
      {
        toolCallId: run.pendingToolCallId,
        toolName: run.pendingToolName || "get_latest_screenshot",
        result: "Screenshot captured. Analyze the image to determine the next action.",
        imageBase64: options.screenshotBase64,
        imageContentType: options.screenshotContentType,
      },
    ];
    run.pendingToolCallId = undefined;
    run.pendingToolName = undefined;
    return run.loop.submitToolResults(run.loopSessionId, toolResults);
  }

  return run.loop.run(run.loopSessionId);
}

// ============================================================================
// Tool Execution
// ============================================================================

async function executeTool(
  toolName: TypingToolName,
  args: TypingToolArguments,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  console.log(`[Typing Agent] Executing tool: ${toolName}`, args);

  switch (toolName) {
    case "delete_typed_text":
      return executeDeleteTypedText(args as DeleteTypedTextArgs, context);
    case "deterministic_typing":
      return executeDeterministicTyping(
        args as DeterministicTypingArgs,
        context
      );
    default:
      return {
        observation: `Unknown tool: ${toolName}`,
        needsScreenshot: false,
      };
  }
}

// ============================================================================
// Tool Builder
// ============================================================================

function buildTypingTools(
  context: ToolExecutionContext,
  steps: TypingAgentStep[]
): ToolDefinition[] {
  return TYPING_TOOLS.map((t): ToolDefinition => {
    const toolName = t.function.name as TypingToolName;

    const definition: ToolDefinition = {
      type: "function" as const,
      function: {
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters as Record<string, unknown>,
      },
    };

    if (toolName !== "get_latest_screenshot") {
      definition.execute = async (args: Record<string, unknown>) => {
        const result = await executeTool(
          toolName,
          args as unknown as TypingToolArguments,
          context
        );

        steps.push({
          iteration: steps.length + 1,
          toolName,
          toolArgs: args,
          observation: result.observation,
          timestamp: new Date(),
        });

        return { observation: result.observation };
      };
    }

    return definition;
  });
}

// ============================================================================
// Main Agent Flow
// ============================================================================

export async function runTypingAgent(
  options: RunTypingAgenticFlowOptions
): Promise<TypingAgenticFlowResult> {
  const maxIterations = options.maxIterations || TYPING_AGENT_MAX_ITERATIONS_CAP;

  console.log(`[Typing Agent] Starting typing flow:`, {
    textToType: options.textToType,
    userMessage: options.userMessage,
    maxIterations,
    resumeSessionKey: options.resumeSessionKey,
  });
  cleanupExpiredTypingRuns();

  const resumeKey = options.resumeSessionKey;
  let run = resumeKey ? activeTypingRuns.get(resumeKey) : undefined;
  if (!run) {
    run = createActiveTypingRun(options);
    if (resumeKey) {
      activeTypingRuns.set(resumeKey, run);
    }
  }

  try {
    const result = await executeTypingLoop(run, options);
    const sessionState = buildSessionState(run, false);

    if (result.type === "complete") {
      console.log(`[Typing Agent] Completed: ${result.message}`);
      sessionState.completionReason = "success";
      sessionState.finalMessage = result.message || "Text input completed.";
      sessionState.isComplete = true;

      clearActiveTypingRun(run);

      return {
        success: true,
        message: sessionState.finalMessage,
        steps: run.steps,
        sessionState,
      };
    }

    if (result.type === "tool_calls") {
      const requestedTool = result.toolCalls?.[0];
      let requestMessage = "Typing agent needs external input before it can continue.";

       run.pendingToolCallId = requestedTool?.id;
       run.pendingToolName = requestedTool?.function.name;
       sessionState.pendingToolCallId = run.pendingToolCallId;
       sessionState.pendingToolName = run.pendingToolName;
       sessionState.awaitingScreenshot = requestedTool?.function.name === "get_latest_screenshot";

      if (requestedTool?.function.name === "get_latest_screenshot") {
        let reason = "to inspect the current keyboard state";
        try {
          const parsedArgs = JSON.parse(requestedTool.function.arguments) as GetLatestScreenshotArgs;
          if (parsedArgs.reason) {
            reason = parsedArgs.reason;
          }
        } catch (error) {
          console.warn("[Typing Agent] Failed to parse get_latest_screenshot arguments", error);
        }

        // Always keep the run alive for resume — the typing agent needs to
        // validate the screenshot and decide whether to continue or complete.
        requestMessage = `Typing agent needs a fresh screenshot ${reason}.`;
        sessionState.awaitingScreenshot = true;
      }

      console.warn(`[Typing Agent] Paused for external input: ${requestMessage}`);
      sessionState.completionReason = "error";
      sessionState.finalMessage = requestMessage;

      return {
        success: false,
        message: requestMessage,
        steps: run.steps,
        sessionState,
      };
    }

    // error or unexpected tool_calls
    const errorMsg = result.error || result.message || "Typing error";
    console.error(`[Typing Agent] Error: ${errorMsg}`);
    sessionState.completionReason = "error";
    sessionState.finalMessage = errorMsg;
    sessionState.isComplete = true;

    clearActiveTypingRun(run);

    return {
      success: false,
      message: errorMsg,
      steps: run.steps,
      sessionState,
    };
  } catch (error) {
    console.error("[Typing Agent] Error:", error);

    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    clearActiveTypingRun(run);

    return {
      success: false,
      message: errorMsg,
      steps: run.steps,
      sessionState: {
        threadId: run.loopSessionId,
        steps: run.steps,
        isComplete: true,
        completionReason: "error",
        finalMessage: errorMsg,
        targetText: options.textToType,
        typedText: run.toolContext.typedSoFar,
        resumeSessionKey: run.key,
      },
    };
  }
}
