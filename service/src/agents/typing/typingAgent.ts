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
  NavigateArgs,
  ClickSelectButtonArgs,
  TypeCharacterArgs,
  RequestScreenshotArgs,
  GoBackArgs,
  WaitArgs,
  AnalyzeKeyboardArgs,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types";
import {
  executeNavigate,
  executeClickSelectButton,
  executeTypeCharacter,
  executeRequestScreenshot,
  executeGoBack,
  executeWait,
  executeAnalyzeKeyboard,
} from "./toolExecutors";
import {
  createAgentLoop,
  ToolDefinition,
} from "../core/agentLoop";

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
    case "navigate":
      return executeNavigate(args as NavigateArgs, context);
    case "click_select_button":
      return executeClickSelectButton(args as ClickSelectButtonArgs, context);
    case "type_character":
      return executeTypeCharacter(args as TypeCharacterArgs, context);
    case "request_screenshot":
      return executeRequestScreenshot(args as RequestScreenshotArgs, context);
    case "go_back":
      return executeGoBack(args as GoBackArgs, context);
    case "wait":
      return executeWait(args as WaitArgs);
    case "analyze_keyboard":
      return executeAnalyzeKeyboard(args as AnalyzeKeyboardArgs, context);
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
  return TYPING_TOOLS.map((t): ToolDefinition => ({
    type: "function" as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters as Record<string, unknown>,
    },
    execute: async (args: Record<string, unknown>) => {
      const toolName = t.function.name as TypingToolName;
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
    },
  }));
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
  });

  // Mutable context — execute closures read from this
  const toolContext: ToolExecutionContext = {
    homeAssistantUrl: HOME_ASSISTANT_URL || "",
    homeAssistantToken: HOME_ASSISTANT_TOKEN || "",
    screenshotBase64: options.screenshotBase64,
    screenshotContentType: options.screenshotContentType,
    activeAgent: "typing",
    targetText: options.textToType,
    typedSoFar: "",
  };

  const steps: TypingAgentStep[] = [];
  const tools = buildTypingTools(toolContext, steps);

  // Create a fresh agent loop for this invocation
  const loop = createAgentLoop({
    systemPrompt: TYPING_AGENT_INSTRUCTIONS,
    tools,
    maxIterations,
  });

  // Build initial message
  let initialMessage = `${options.userMessage}\n\n`;
  initialMessage += `Text to Type: "${options.textToType}"\n\n`;
  initialMessage += `Device Configuration:\n`;
  initialMessage += `- Remote Entity ID: ${options.deviceConfig.remoteEntityId}\n`;
  initialMessage += `- Media Player Entity ID: ${options.deviceConfig.mediaPlayerEntityId}\n\n`;
  initialMessage += `Instructions: Type the text "${options.textToType}" using the on-screen keyboard. `;
  initialMessage += `Start by requesting a screenshot to see the current keyboard state, then navigate and select characters.`;

  if (options.screenshotBase64) {
    initialMessage += `\n\nA screenshot is available for analysis via the analyze_keyboard tool.`;
  }

  const loopSession = loop.createSession(initialMessage);

  try {
    const result = await loop.run(loopSession.id);

    const sessionState: TypingAgentSessionState = {
      threadId: loopSession.id,
      steps,
      isComplete: true,
      targetText: options.textToType,
      typedText: toolContext.typedSoFar,
    };

    if (result.type === "complete") {
      console.log(`[Typing Agent] Completed: ${result.message}`);
      sessionState.completionReason = "success";
      sessionState.finalMessage = result.message || "Text input completed.";

      return {
        success: true,
        message: sessionState.finalMessage,
        steps,
        sessionState,
      };
    }

    // error or unexpected tool_calls
    const errorMsg = result.error || result.message || "Typing error";
    console.error(`[Typing Agent] Error: ${errorMsg}`);
    sessionState.completionReason = "error";
    sessionState.finalMessage = errorMsg;

    return {
      success: false,
      message: errorMsg,
      steps,
      sessionState,
    };
  } catch (error) {
    console.error("[Typing Agent] Error:", error);

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
        targetText: options.textToType,
        typedText: toolContext.typedSoFar,
      },
    };
  } finally {
    loop.deleteSession(loopSession.id);
  }
}
