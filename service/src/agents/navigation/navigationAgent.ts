/**
 * TV Navigation Agent Core Logic
 * Specialized agent for TV navigation operations using ToolLoopAgent
 *
 * All tools have execute functions, so the ToolLoopAgent auto-loops
 * until complete_task is called or max iterations are reached.
 */

import {
  HOME_ASSISTANT_TOKEN,
  HOME_ASSISTANT_URL,
} from "../../config";
import {
  NAV_AGENT_INSTRUCTIONS,
  NAV_AGENT_MAX_ITERATIONS_CAP,
  NAV_TOOLS,
} from "./constants";
import {
  NavAgentStep,
  NavAgenticFlowResult,
  RunNavAgenticFlowOptions,
  NavAgentSessionState,
  NavToolName,
  NavToolArguments,
  GoHomeArgs,
  GoBackArgs,
  NavigateArgs,
  FindSearchArgs,
  ClickSelectButtonArgs,
  RequestScreenshotArgs,
  WaitArgs,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types";
import {
  executeGoHome,
  executeGoBack,
  executeNavigate,
  executeFindSearch,
  executeClickSelectButton,
  executeRequestScreenshot,
  executeWait,
} from "./toolExecutors";
import {
  AgentLoop,
  createAgentLoop,
  ToolDefinition,
} from "../core/agentLoop";

// ============================================================================
// Tool Execution
// ============================================================================

async function executeTool(
  toolName: NavToolName,
  args: NavToolArguments,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  console.log(`[Nav Agent] Executing tool: ${toolName}`, args);

  switch (toolName) {
    case "go_home":
      return executeGoHome(args as GoHomeArgs, context);
    case "go_back":
      return executeGoBack(args as GoBackArgs, context);
    case "navigate":
      return executeNavigate(args as NavigateArgs, context);
    case "find_search":
      return executeFindSearch(args as FindSearchArgs, context);
    case "click_select_button":
      return executeClickSelectButton(args as ClickSelectButtonArgs, context);
    case "request_screenshot":
      return executeRequestScreenshot(args as RequestScreenshotArgs, context);
    case "wait":
      return executeWait(args as WaitArgs);
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

function buildNavTools(
  context: ToolExecutionContext,
  steps: NavAgentStep[]
): ToolDefinition[] {
  return NAV_TOOLS.map((t): ToolDefinition => ({
    type: "function" as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters as Record<string, unknown>,
    },
    execute: async (args: Record<string, unknown>) => {
      const toolName = t.function.name as NavToolName;
      const result = await executeTool(
        toolName,
        args as unknown as NavToolArguments,
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
    },
  }));
}

// ============================================================================
// Main Agent Flow
// ============================================================================

export async function runNavigationAgent(
  options: RunNavAgenticFlowOptions
): Promise<NavAgenticFlowResult> {
  const maxIterations = options.maxIterations || NAV_AGENT_MAX_ITERATIONS_CAP;

  console.log(`[Nav Agent] Starting navigation flow:`, {
    userMessage: options.userMessage,
    maxIterations,
    hasScreenshot: !!options.screenshotBase64,
  });

  // Mutable context — execute closures read from this
  const toolContext: ToolExecutionContext = {
    homeAssistantUrl: HOME_ASSISTANT_URL || "",
    homeAssistantToken: HOME_ASSISTANT_TOKEN || "",
    screenshotBase64: options.screenshotBase64,
    screenshotContentType: options.screenshotContentType,
    activeAgent: "navigation",
  };

  const steps: NavAgentStep[] = [];
  const tools = buildNavTools(toolContext, steps);

  // Create a fresh agent loop for this invocation
  const loop = createAgentLoop({
    systemPrompt: NAV_AGENT_INSTRUCTIONS,
    tools,
    maxIterations,
  });

  // Build initial message
  let initialMessage = `## Navigation Task\n${options.userMessage}\n\n`;
  initialMessage += `## Device Configuration\n`;
  initialMessage += `- Remote Entity ID: ${options.deviceConfig.remoteEntityId}\n`;
  initialMessage += `- Media Player Entity ID: ${options.deviceConfig.mediaPlayerEntityId}\n\n`;

  if (options.screenshotBase64) {
    initialMessage += `## Current Screen State\n`;
    initialMessage += `A screenshot of the current TV screen is available for analysis via the find_search tool.\n`;
    initialMessage += `Look for:\n`;
    initialMessage += `- Currently highlighted/selected item (usually has a border or different color)\n`;
    initialMessage += `- Target element location relative to current position\n`;
    initialMessage += `- Navigation path needed (up/down/left/right presses)\n\n`;
  } else {
    initialMessage += `No screenshot available. Request a screenshot first to see the current TV state.\n\n`;
  }

  initialMessage += `## Instructions\n`;
  initialMessage += `Complete the navigation task efficiently. After each navigation action, analyze the result and adjust as needed.`;

  const loopSession = loop.createSession(initialMessage);

  try {
    const result = await loop.run(loopSession.id);

    const sessionState: NavAgentSessionState = {
      threadId: loopSession.id,
      steps,
      isComplete: true,
      lastScreenshotBase64: toolContext.screenshotBase64,
      lastScreenshotContentType: toolContext.screenshotContentType,
    };

    if (result.type === "complete") {
      console.log(`[Nav Agent] Completed: ${result.message}`);
      sessionState.completionReason = "success";
      sessionState.finalMessage = result.message || "Navigation task completed.";

      return {
        success: true,
        message: sessionState.finalMessage,
        steps,
        sessionState,
      };
    }

    // error or unexpected tool_calls (shouldn't happen since all tools have execute)
    const errorMsg = result.error || result.message || "Navigation error";
    console.error(`[Nav Agent] Error: ${errorMsg}`);
    sessionState.completionReason = "error";
    sessionState.finalMessage = errorMsg;

    return {
      success: false,
      message: errorMsg,
      steps,
      sessionState,
      error: errorMsg,
    };
  } catch (error) {
    console.error("[Nav Agent] Error:", error);

    const errorMsg = error instanceof Error ? error.message : "Unknown error";

    return {
      success: false,
      message: errorMsg,
      steps,
      sessionState: {
        threadId: loopSession.id,
        steps,
        isComplete: true,
        completionReason: "error",
        finalMessage: errorMsg,
      },
      error: errorMsg,
    };
  } finally {
    loop.deleteSession(loopSession.id);
  }
}
