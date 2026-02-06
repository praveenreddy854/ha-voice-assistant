/**
 * TV Typing Agent Core Logic
 * Specialized agent for text input operations using Custom Agent Loop
 */

import { randomUUID } from "crypto";
import { HOME_ASSISTANT_TOKEN, HOME_ASSISTANT_URL } from "../../config";
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
} from "./types";
import { executeTool, ToolExecutionContext } from "./tools";
import {
  CustomAgentLoop,
  createAgentLoop,
  ToolExecutionResult as AgentToolResult,
} from "../tv/customAgentLoop";

// ============================================================================
// Session Management
// ============================================================================

const sessionStore = new Map<string, TypingAgentSessionState>();
let typingAgentLoop: CustomAgentLoop | null = null;

// ============================================================================
// Agent Loop Management
// ============================================================================

function getOrCreateTypingAgentLoop(): CustomAgentLoop {
  if (!typingAgentLoop) {
    typingAgentLoop = createAgentLoop({
      systemPrompt: TYPING_AGENT_INSTRUCTIONS,
      tools: TYPING_TOOLS,
      maxIterations: TYPING_AGENT_MAX_ITERATIONS_CAP,
    });
  }
  return typingAgentLoop;
}

// ============================================================================
// Main Agent Flow
// ============================================================================

export async function runTypingAgent(
  options: RunTypingAgenticFlowOptions,
): Promise<TypingAgenticFlowResult> {
  const sessionId = randomUUID();
  const maxIterations =
    options.maxIterations || TYPING_AGENT_MAX_ITERATIONS_CAP;

  console.log(`[Typing Agent] Starting typing flow:`, {
    sessionId,
    textToType: options.textToType,
    userMessage: options.userMessage,
    maxIterations,
  });

  const loop = getOrCreateTypingAgentLoop();

  // Build initial message with device configuration and text to type
  let initialMessage = `${options.userMessage}\n\n`;
  initialMessage += `Text to Type: "${options.textToType}"\n\n`;
  initialMessage += `Device Configuration:\n`;
  initialMessage += `- Remote Entity ID: ${options.deviceConfig.remoteEntityId}\n`;
  initialMessage += `- Media Player Entity ID: ${options.deviceConfig.mediaPlayerEntityId}\n\n`;
  initialMessage += `Instructions: Type the text "${options.textToType}" using the on-screen keyboard. `;
  initialMessage += `If a screenshot is available, use it to confirm the keyboard layout and current cursor position. If not, assume a standard layout starting on 'a'.`;

  // Add screenshot context if provided
  if (options.screenshotBase64) {
    initialMessage += `\n\n📸 Screenshot provided for visual context - keyboard should be visible`;
  }

  // Create session in the custom agent loop
  const loopSession = loop.createSession(initialMessage);

  // Session state
  const sessionState: TypingAgentSessionState = {
    threadId: loopSession.id,
    steps: [],
    isComplete: false,
    targetText: options.textToType,
    typedText: "",
  };
  sessionStore.set(sessionId, sessionState);

  // Create tool execution context with screenshot data
  const toolContext: ToolExecutionContext = {
    homeAssistantUrl: HOME_ASSISTANT_URL || "",
    homeAssistantToken: HOME_ASSISTANT_TOKEN || "",
    screenshotBase64: options.screenshotBase64,
    screenshotContentType: options.screenshotContentType,
    activeAgent: "typing",
    targetText: options.textToType,
    typedSoFar: "",
  };

  try {
    let iteration = 0;
    let hasInjectedScreenshot = false;

    while (iteration < maxIterations) {
      iteration++;
      console.log(`[Typing Agent] Iteration ${iteration}/${maxIterations}`);

      // Run a step in the agent loop
      const screenshotInput =
        !hasInjectedScreenshot &&
        options.screenshotBase64 &&
        options.screenshotContentType
          ? {
              imageBase64: options.screenshotBase64,
              imageContentType: options.screenshotContentType,
            }
          : undefined;

      const stepResult = await loop.runStep(loopSession.id, screenshotInput);
      if (screenshotInput) {
        hasInjectedScreenshot = true;
      }
      console.log(`[Typing Agent] Step result type: ${stepResult.type}`);

      if (stepResult.type === "error") {
        console.error(`[Typing Agent] Agent loop error: ${stepResult.error}`);
        sessionState.isComplete = true;
        sessionState.completionReason = "error";
        sessionState.finalMessage = stepResult.error || "Unknown error";

        return {
          success: false,
          message: sessionState.finalMessage,
          steps: sessionState.steps,
          sessionState,
        };
      }

      if (stepResult.type === "complete") {
        console.log(
          `[Typing Agent] Agent loop completed: ${stepResult.message}`,
        );
        sessionState.isComplete = true;
        sessionState.completionReason = "success";
        sessionState.finalMessage =
          stepResult.message || "Text input completed.";

        return {
          success: true,
          message: sessionState.finalMessage,
          steps: sessionState.steps,
          sessionState,
        };
      }

      if (stepResult.type === "tool_calls" && stepResult.toolCalls) {
        console.log(
          `[Typing Agent] Processing ${stepResult.toolCalls.length} tool calls`,
        );

        const toolResults: AgentToolResult[] = [];

        for (const toolCall of stepResult.toolCalls) {
          const toolName = toolCall.function.name;
          let args: unknown;

          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch (parseError) {
            console.error(
              `[Typing Agent] Failed to parse tool arguments:`,
              parseError,
            );
            toolResults.push({
              toolCallId: toolCall.id,
              result: JSON.stringify({
                success: false,
                error: "Failed to parse tool arguments",
              }),
            });
            continue;
          }

          console.log(`[Typing Agent] Tool call:`, { toolName, args });

          // Execute the tool
          const result = await executeTool(toolName, args, toolContext);

          // Track step
          const step: TypingAgentStep = {
            iteration,
            toolName,
            toolArgs: args as unknown as Record<string, unknown>,
            observation: result.observation,
            timestamp: new Date(),
            runId: loopSession.id,
            threadId: loopSession.id,
          };
          sessionState.steps.push(step);

          // Build tool result
          toolResults.push({
            toolCallId: toolCall.id,
            result: JSON.stringify({
              observation: result.observation,
              needsScreenshot: result.needsScreenshot,
            }),
          });
        }

        // Submit tool results and continue
        const nextResult = await loop.submitToolResults(
          loopSession.id,
          toolResults,
        );

        // Handle the result from submitting tool outputs
        if (nextResult.type === "error") {
          console.error(
            `[Typing Agent] Error after tool submission: ${nextResult.error}`,
          );
          sessionState.isComplete = true;
          sessionState.completionReason = "error";
          sessionState.finalMessage = nextResult.error || "Unknown error";

          return {
            success: false,
            message: sessionState.finalMessage,
            steps: sessionState.steps,
            sessionState,
          };
        }

        if (nextResult.type === "complete") {
          console.log(
            `[Typing Agent] Completed after tool submission: ${nextResult.message}`,
          );
          sessionState.isComplete = true;
          sessionState.completionReason = "success";
          sessionState.finalMessage =
            nextResult.message || "Text input completed.";

          return {
            success: true,
            message: sessionState.finalMessage,
            steps: sessionState.steps,
            sessionState,
          };
        }

        // If more tool calls, continue the loop
        if (nextResult.type === "tool_calls" && nextResult.toolCalls) {
          continue;
        }
      }

      // Regular message - continue processing
      if (stepResult.type === "message") {
        console.log(`[Typing Agent] Received message: ${stepResult.message}`);
        continue;
      }
    }

    // Max iterations reached
    console.log(`[Typing Agent] Max iterations (${maxIterations}) reached`);
    sessionState.isComplete = true;
    sessionState.completionReason = "max_iterations";
    sessionState.finalMessage = `Text input incomplete: Maximum iterations (${maxIterations}) reached. Target text: "${options.textToType}"`;

    return {
      success: false,
      message: sessionState.finalMessage,
      steps: sessionState.steps,
      sessionState,
    };
  } catch (error) {
    console.error("[Typing Agent] Error:", error);

    sessionState.isComplete = true;
    sessionState.completionReason = "error";
    sessionState.finalMessage =
      error instanceof Error ? error.message : "Unknown error";

    return {
      success: false,
      message: sessionState.finalMessage,
      steps: sessionState.steps,
      sessionState,
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
  sessionId: string,
): TypingAgentSessionState | undefined {
  return sessionStore.get(sessionId);
}

export function clearSession(sessionId: string): void {
  sessionStore.delete(sessionId);
}
