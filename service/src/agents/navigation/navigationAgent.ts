/**
 * TV Navigation Agent Core Logic
 * Specialized agent for TV navigation operations using Azure AI Agents
 */

import { DefaultAzureCredential } from "@azure/identity";
import {
  AgentsClient,
  RequiredFunctionToolCall,
  SubmitToolOutputsAction,
  ThreadRun,
} from "@azure/ai-agents";
import { randomUUID } from "crypto";
import {
  AZURE_AI_PROJECT_ENDPOINT,
  AZURE_AI_AGENT_MODEL,
  HOME_ASSISTANT_TOKEN,
  HOME_ASSISTANT_URL,
} from "../../config";
import {
  NAV_AGENT_NAME,
  NAV_AGENT_DESCRIPTION,
  NAV_AGENT_INSTRUCTIONS,
  NAV_AGENT_MAX_ITERATIONS_CAP,
  MIN_RUN_CREATION_INTERVAL_MS,
  NAV_TOOLS,
} from "./constants";
import {
  NavAgentStep,
  NavAgenticFlowResult,
  RunNavAgenticFlowOptions,
  NavAgentSessionState,
  ScreenshotPayload,
  ToolOutputPayload,
  NavToolName,
  NavToolArguments,
  GoHomeArgs,
  GoBackArgs,
  NavigateArgs,
  FindSearchArgs,
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
  executeRequestScreenshot,
  executeWait,
} from "./toolExecutors";
import { delay } from "../common/utils";

// ============================================================================
// Session Management
// ============================================================================

let cachedClient: AgentsClient | undefined;
const sessionStore = new Map<string, NavAgentSessionState>();

// ============================================================================
// Azure Client Management
// ============================================================================

function loadAzureClient(): AgentsClient {
  if (cachedClient) {
    return cachedClient;
  }

  if (!AZURE_AI_PROJECT_ENDPOINT) {
    throw new Error(
      "Azure AI Project endpoint missing. Please configure AZURE_AI_PROJECT_ENDPOINT."
    );
  }

  const credential = new DefaultAzureCredential();
  cachedClient = new AgentsClient(AZURE_AI_PROJECT_ENDPOINT, credential);
  return cachedClient;
}

// ============================================================================
// Agent Management
// ============================================================================

let cachedAgentId: string | undefined;

async function getOrCreateAgent(): Promise<string> {
  if (cachedAgentId) {
    return cachedAgentId;
  }

  const client = loadAzureClient();
  const model = AZURE_AI_AGENT_MODEL || "gpt-5-mini";

  // Create new agent
  console.log(`[Nav Agent] Creating new agent: ${NAV_AGENT_NAME}`);
  const agent = await client.createAgent?.(model, {
    name: NAV_AGENT_NAME,
    description: NAV_AGENT_DESCRIPTION,
    instructions: NAV_AGENT_INSTRUCTIONS,
    tools: NAV_TOOLS,
  });

  if (!agent?.id) {
    throw new Error("Failed to create navigation agent");
  }

  console.log(`[Nav Agent] Created new agent with ID: ${agent.id}`);
  cachedAgentId = agent.id;
  return agent.id;
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
  const sessionId = options.existingThreadId || randomUUID();
  const maxIterations = options.maxIterations || NAV_AGENT_MAX_ITERATIONS_CAP;

  console.log(`[Nav Agent] Starting navigation flow:`, {
    sessionId,
    userMessage: options.userMessage,
    maxIterations,
  });

  const client = loadAzureClient();
  const agentId = await getOrCreateAgent();

  // Create or get thread
  let threadId: string;
  if (options.existingThreadId) {
    threadId = options.existingThreadId;
    console.log(`[Nav Agent] Using existing thread: ${threadId}`);
  } else {
    const thread = await client.threads.create?.();
    if (!thread?.id) {
      throw new Error("Failed to create thread");
    }
    threadId = thread.id;
    console.log(`[Nav Agent] Created new thread: ${threadId}`);
  }

  // Session state
  const sessionState: NavAgentSessionState = {
    threadId,
    steps: [],
    isComplete: false,
  };
  sessionStore.set(sessionId, sessionState);

  // Add user message to thread with device configuration context
  let messageWithContext =
    `${options.userMessage}\n\n` +
    `Device Configuration:\n` +
    `- Remote Entity ID: ${options.deviceConfig.remoteEntityId}\n` +
    `- Media Player Entity ID: ${options.deviceConfig.mediaPlayerEntityId}`;

  // Add screenshot context if provided
  if (options.screenshotBase64) {
    messageWithContext += `\n\n📸 Screenshot provided for visual context`;
  }

  await client.messages.create?.(threadId, "user", messageWithContext);

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
    let run = await client.runs.create?.(threadId, agentId);

    if (!run?.id) {
      throw new Error("Failed to create run");
    }

    while (iteration < maxIterations) {
      iteration++;
      console.log(`[Nav Agent] Iteration ${iteration}/${maxIterations}`);

      // Poll run status
      while (run.status === "queued" || run.status === "in_progress") {
        await delay(500);
        const updatedRun = await client.runs.get?.(threadId, run.id);
        if (updatedRun) {
          run = updatedRun;
        }
      }

      console.log(`[Nav Agent] Run status: ${run.status}`);

      if (run.status === "requires_action") {
        const action = run.requiredAction as SubmitToolOutputsAction;
        const toolCalls = action.submitToolOutputs
          .toolCalls as RequiredFunctionToolCall[];

        const toolOutputs = [];

        for (const toolCall of toolCalls) {
          const toolName = toolCall.function.name as NavToolName;
          const args = JSON.parse(
            toolCall.function.arguments
          ) as NavToolArguments;

          console.log(`[Nav Agent] Tool call:`, { toolName, args });

          // Execute the tool
          const result = await executeTool(toolName, args, toolContext);

          // Track step
          const step: NavAgentStep = {
            iteration,
            toolName,
            toolArgs: args as unknown as Record<string, unknown>,
            observation: result.observation,
            timestamp: new Date(),
            runId: run.id,
            threadId,
          };
          sessionState.steps.push(step);

          // Handle screenshot requests
          if (result.needsScreenshot) {
            console.log(`[Nav Agent] Tool requires screenshot`);

            toolOutputs.push({
              toolCallId: toolCall.id,
              output: JSON.stringify({
                observation:
                  result.observation +
                  "\n📸 Screenshot recommended for verification.",
                needsScreenshot: true,
              }),
            });
          } else {
            toolOutputs.push({
              toolCallId: toolCall.id,
              output: JSON.stringify({
                observation: result.observation,
                needsScreenshot: false,
              }),
            });
          }
        }

        // Submit tool outputs
        run = await client.runs.submitToolOutputs?.(
          threadId,
          run.id,
          toolOutputs
        );
        if (!run) {
          throw new Error("Failed to submit tool outputs");
        }
      } else if (run.status === "completed") {
        console.log(`[Nav Agent] Run completed successfully`);

        // Get final message
        const messagesIterator = client.messages.list?.(threadId);
        let finalMessage = "Navigation task completed.";

        if (messagesIterator) {
          for await (const message of messagesIterator) {
            if (message.role === "assistant") {
              const textContent = message.content.find(
                (c: any) => c.type === "text"
              );
              if (textContent && "text" in textContent) {
                finalMessage = (textContent as any).text.value;
                break;
              }
            }
          }
        }

        sessionState.isComplete = true;
        sessionState.completionReason = "success";
        sessionState.finalMessage = finalMessage;

        return {
          success: true,
          message: finalMessage,
          steps: sessionState.steps,
          sessionState,
        };
      } else if (run.status === "failed" || run.status === "cancelled") {
        console.error(`[Nav Agent] Run ${run.status}:`, run.lastError);

        sessionState.isComplete = true;
        sessionState.completionReason = "error";
        sessionState.finalMessage = `Navigation failed: ${
          run.lastError?.message || "Unknown error"
        }`;

        return {
          success: false,
          message: sessionState.finalMessage,
          steps: sessionState.steps,
          sessionState,
          error: run.lastError?.message,
        };
      }
    }

    // Max iterations reached
    console.log(`[Nav Agent] Max iterations (${maxIterations}) reached`);
    sessionState.isComplete = true;
    sessionState.completionReason = "max_iterations";
    sessionState.finalMessage = `Navigation incomplete: Maximum iterations (${maxIterations}) reached.`;

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
