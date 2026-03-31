/**
 * TV Navigation Agent Core Logic
 * Specialized agent for TV navigation operations using Custom Agent Loop
 */

import { randomUUID } from "crypto";
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
  CustomAgentLoop,
  createAgentLoop,
  AgentToolCall,
  ToolExecutionResult as AgentToolResult,
} from "../tv/agentLoop";

// ============================================================================
// Session Management
// ============================================================================

const sessionStore = new Map<string, NavAgentSessionState>();
let navAgentLoop: CustomAgentLoop | null = null;

// ============================================================================
// Agent Loop Management
// ============================================================================

function getOrCreateNavAgentLoop(): CustomAgentLoop {
  if (!navAgentLoop) {
    navAgentLoop = createAgentLoop({
      systemPrompt: NAV_AGENT_INSTRUCTIONS,
      tools: NAV_TOOLS,
      maxIterations: NAV_AGENT_MAX_ITERATIONS_CAP,
    });
  }
  return navAgentLoop;
}

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
// Main Agent Flow
// ============================================================================

export async function runNavigationAgent(
  options: RunNavAgenticFlowOptions
): Promise<NavAgenticFlowResult> {
  const sessionId = randomUUID();
  const maxIterations = options.maxIterations || NAV_AGENT_MAX_ITERATIONS_CAP;

  console.log(`[Nav Agent] Starting navigation flow:`, {
    sessionId,
    userMessage: options.userMessage,
    maxIterations,
    hasScreenshot: !!options.screenshotBase64,
  });

  const loop = getOrCreateNavAgentLoop();

  // Build initial message with device configuration context
  let initialMessage = `## Navigation Task\n${options.userMessage}\n\n`;
  initialMessage += `## Device Configuration\n`;
  initialMessage += `- Remote Entity ID: ${options.deviceConfig.remoteEntityId}\n`;
  initialMessage += `- Media Player Entity ID: ${options.deviceConfig.mediaPlayerEntityId}\n\n`;

  // Add screenshot instruction
  if (options.screenshotBase64) {
    initialMessage += `## Current Screen State\n`;
    initialMessage += `📸 A screenshot of the current TV screen is attached. Analyze it to understand the current UI state and determine your navigation strategy.\n`;
    initialMessage += `Look for:\n`;
    initialMessage += `- Currently highlighted/selected item (usually has a border or different color)\n`;
    initialMessage += `- Target element location relative to current position\n`;
    initialMessage += `- Navigation path needed (up/down/left/right presses)\n\n`;
  } else {
    initialMessage += `⚠️ No screenshot available. Request a screenshot first to see the current TV state.\n\n`;
  }

  initialMessage += `## Instructions\n`;
  initialMessage += `Complete the navigation task efficiently. After each navigation action, analyze the result and adjust as needed.`;

  // Create session in the custom agent loop
  const loopSession = loop.createSession(initialMessage);

  // If we have an initial screenshot, inject it as context
  if (options.screenshotBase64 && options.screenshotContentType) {
    // Add the screenshot as a follow-up user message with image
    const screenshotMessage = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Here is the current TV screen:" },
        {
          type: "image_url" as const,
          image_url: {
            url: `data:${options.screenshotContentType};base64,${options.screenshotBase64}`,
            detail: "high" as const,
          },
        },
      ],
    };
    
    // Manually add to session messages (accessing internal structure)
    const sessionMessages = loop.getMessages(loopSession.id);
    if (sessionMessages.length > 0) {
      loop.addMessage(loopSession.id, "user", JSON.stringify(screenshotMessage.content));
    }
  }

  // Session state - track current screenshot for tool execution
  const sessionState: NavAgentSessionState = {
    threadId: loopSession.id,
    steps: [],
    isComplete: false,
    lastScreenshotBase64: options.screenshotBase64,
    lastScreenshotContentType: options.screenshotContentType,
  };
  sessionStore.set(sessionId, sessionState);

  // Create tool execution context with screenshot data
  const toolContext: ToolExecutionContext = {
    homeAssistantUrl: HOME_ASSISTANT_URL || "",
    homeAssistantToken: HOME_ASSISTANT_TOKEN || "",
    screenshotBase64: options.screenshotBase64,
    screenshotContentType: options.screenshotContentType,
    activeAgent: "navigation",
  };

  try {
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;
      console.log(`[Nav Agent] Iteration ${iteration}/${maxIterations}`);

      // Run a step in the agent loop
      const stepResult = await loop.runStep(loopSession.id);
      console.log(`[Nav Agent] Step result type: ${stepResult.type}`);

      if (stepResult.type === "error") {
        console.error(`[Nav Agent] Agent loop error: ${stepResult.error}`);
        sessionState.isComplete = true;
        sessionState.completionReason = "error";
        sessionState.finalMessage = stepResult.error || "Unknown error";

        return {
          success: false,
          message: sessionState.finalMessage,
          steps: sessionState.steps,
          sessionState,
          error: stepResult.error,
        };
      }

      if (stepResult.type === "complete") {
        console.log(`[Nav Agent] Agent loop completed: ${stepResult.message}`);
        sessionState.isComplete = true;
        sessionState.completionReason = "success";
        sessionState.finalMessage = stepResult.message || "Navigation task completed.";

        return {
          success: true,
          message: sessionState.finalMessage,
          steps: sessionState.steps,
          sessionState,
        };
      }

      if (stepResult.type === "tool_calls" && stepResult.toolCalls) {
        console.log(`[Nav Agent] Processing ${stepResult.toolCalls.length} tool calls`);

        const toolResults: AgentToolResult[] = [];

        for (const toolCall of stepResult.toolCalls) {
          const toolName = toolCall.function.name as NavToolName;
          let args: NavToolArguments;

          try {
            args = JSON.parse(toolCall.function.arguments) as NavToolArguments;
          } catch (parseError) {
            console.error(`[Nav Agent] Failed to parse tool arguments:`, parseError);
            toolResults.push({
              toolCallId: toolCall.id,
              result: JSON.stringify({
                success: false,
                error: "Failed to parse tool arguments",
              }),
            });
            continue;
          }

          console.log(`[Nav Agent] Tool call:`, { toolName, args });

          // Update tool context with latest screenshot
          toolContext.screenshotBase64 = sessionState.lastScreenshotBase64;
          toolContext.screenshotContentType = sessionState.lastScreenshotContentType;

          // Execute the tool
          const result = await executeTool(toolName, args, toolContext);

          // Track step
          const step: NavAgentStep = {
            iteration,
            toolName,
            toolArgs: args as unknown as Record<string, unknown>,
            observation: result.observation,
            timestamp: new Date(),
            runId: loopSession.id,
            threadId: loopSession.id,
          };
          sessionState.steps.push(step);

          // Build tool result - include screenshot if tool needs it and we have one
          const toolResult: AgentToolResult = {
            toolCallId: toolCall.id,
            result: result.observation,
          };

          // If tool needs screenshot feedback and we have a screenshot, include it
          if (result.needsScreenshot && sessionState.lastScreenshotBase64 && sessionState.lastScreenshotContentType) {
            toolResult.imageBase64 = sessionState.lastScreenshotBase64;
            toolResult.imageContentType = sessionState.lastScreenshotContentType;
            console.log(`[Nav Agent] Including screenshot in tool result for ${toolName}`);
          }

          toolResults.push(toolResult);
        }

        // Submit tool results and continue
        const nextResult = await loop.submitToolResults(loopSession.id, toolResults);

        // Handle the result from submitting tool outputs
        if (nextResult.type === "error") {
          console.error(`[Nav Agent] Error after tool submission: ${nextResult.error}`);
          sessionState.isComplete = true;
          sessionState.completionReason = "error";
          sessionState.finalMessage = nextResult.error || "Unknown error";

          return {
            success: false,
            message: sessionState.finalMessage,
            steps: sessionState.steps,
            sessionState,
            error: nextResult.error,
          };
        }

        if (nextResult.type === "complete") {
          console.log(`[Nav Agent] Completed after tool submission: ${nextResult.message}`);
          sessionState.isComplete = true;
          sessionState.completionReason = "success";
          sessionState.finalMessage = nextResult.message || "Navigation task completed.";

          return {
            success: true,
            message: sessionState.finalMessage,
            steps: sessionState.steps,
            sessionState,
          };
        }

        // If more tool calls, continue the loop
        if (nextResult.type === "tool_calls" && nextResult.toolCalls) {
          // Process in next iteration
          continue;
        }
      }

      // Regular message - continue processing
      if (stepResult.type === "message") {
        console.log(`[Nav Agent] Received message: ${stepResult.message}`);
        // Continue processing
        continue;
      }
    }

    // Max iterations reached
    console.log(`[Nav Agent] Max iterations (${maxIterations}) reached`);
    sessionState.isComplete = true;
    sessionState.completionReason = "max_iterations";
    sessionState.finalMessage = `Navigation incomplete: Maximum iterations (${maxIterations}) reached. Last state: ${sessionState.steps[sessionState.steps.length - 1]?.observation || "unknown"}`;

    return {
      success: false,
      message: sessionState.finalMessage,
      steps: sessionState.steps,
      sessionState,
      error: "Max iterations reached",
    };
  } catch (error) {
    console.error("[Nav Agent] Error:", error);

    sessionState.isComplete = true;
    sessionState.completionReason = "error";
    sessionState.finalMessage =
      error instanceof Error ? error.message : "Unknown error";

    return {
      success: false,
      message: sessionState.finalMessage,
      steps: sessionState.steps,
      sessionState,
      error: sessionState.finalMessage,
    };
  } finally {
    // Clean up
    loop.deleteSession(loopSession.id);
    sessionStore.delete(sessionId);
  }
}

// ============================================================================
// Utility Functions
// ============================================================================

export function getSessionState(
  sessionId: string
): NavAgentSessionState | undefined {
  return sessionStore.get(sessionId);
}

export function clearSession(sessionId: string): void {
  sessionStore.delete(sessionId);
}

/**
 * Update the current screenshot for an active navigation session
 * This allows the parent agent to inject new screenshots during delegation
 */
export function updateSessionScreenshot(
  sessionId: string,
  screenshotBase64: string,
  screenshotContentType: string
): boolean {
  const session = sessionStore.get(sessionId);
  if (!session) {
    return false;
  }
  session.lastScreenshotBase64 = screenshotBase64;
  session.lastScreenshotContentType = screenshotContentType;
  return true;
}
