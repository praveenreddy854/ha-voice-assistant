/**
 * TV Agent Core Logic
 * Main implementation of the TV automation agent using Azure AI Agents
 */

import axios from "axios";
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
  TV_DEFAULT_WAIT_MS,
  AZURE_AGENTS_MAX_RETRIES,
  AZURE_AGENTS_BASE_RETRY_DELAY,
  AZURE_AGENTS_RETRY_ENABLED,
  AZURE_AGENTS_TIMEOUT_MS,
  TV_AGENT_DEVICES,
} from "../../config";
import {
  createTVAgentSpan,
  logPromptAndResponse,
  SpanStatusCode,
  SpanKind,
} from "../../tracing";
import {
  TV_AGENT_NAME,
  TV_AGENT_DESCRIPTION,
  TV_AGENT_INSTRUCTIONS,
  TV_AGENT_MAX_ITERATIONS_CAP,
  MIN_RUN_CREATION_INTERVAL_MS,
  TV_TOOLS,
} from "./constants";
import {
  TvAgentStep,
  TvAgenticFlowResult,
  RunTvAgenticFlowOptions,
  TvAgentSessionState,
  ScreenshotPayload,
  ToolOutputPayload,
  TvToolName,
  TvToolArguments,
  WaitArgs,
  LaunchAppArgs,
} from "./types";
import { parseFinalCommand } from "./utils";

// Helper function to get action summary for new tool format
function getToolActionSummary(toolName: string, args: TvToolArguments): string {
  switch (toolName) {
    case "click_power_button":
      return "Press power";
    case "media_control":
      const mediaArgs = args as any;
      return `Media control: ${mediaArgs.action || "action"}`;
    case "click_select_button":
      return "Press select";
    case "open_menu":
      return "Open menu";
    case "type_text":
      const textArgs = args as any;
      return `Type "${textArgs.text || "text"}"`;
    case "request_screenshot":
      return "Request screenshot";
    case "get_device_state":
      return "Get device state";
    case "launch_app":
      const appArgs = args as any;
      return `Launch ${appArgs.app_name || "app"}`;
    case "analyze_screenshot":
      const analyzeArgs = args as any;
      return `Analyze: ${analyzeArgs.query || "screenshot"}`;
    case "verify_ui_state":
      const verifyArgs = args as any;
      return `Verify: ${verifyArgs.expected_state || "UI state"}`;
    case "wait":
      const waitArgs = args as any;
      return `Wait ${waitArgs.duration_ms || 1000}ms`;
    default:
      return `Execute ${toolName}`;
  }
}

// Temporary helper to convert new tool format to legacy format for compatibility
function convertToLegacyFormat(toolName: string, args: TvToolArguments): any {
  switch (toolName) {
    case "click_power_button":
      const powerArgs = args as any;
      return {
        actionType: "press",
        button: "power",
        reason: powerArgs.reason,
      };
    case "media_control":
      const mediaArgs = args as any;
      return {
        actionType: "press",
        button: mediaArgs.action,
        reason: mediaArgs.reason,
      };
    case "click_select_button":
      const selectArgs = args as any;
      return {
        actionType: "press",
        button: "select",
        reason: selectArgs.reason,
      };
    case "open_menu":
      const menuArgs = args as any;
      return {
        actionType: "press",
        button: "menu",
        reason: menuArgs.reason,
      };
    case "type_text":
      const textArgs = args as any;
      return {
        actionType: "type",
        text: textArgs.text,
        reason: textArgs.reason,
      };
    case "launch_app":
      const appArgs = args as any;
      return {
        actionType: "launch",
        app_name: appArgs.app_name,
        media_player_entity_id: appArgs.media_player_entity_id,
        reason: appArgs.reason,
      };
    case "wait":
      const waitArgs = args as any;
      return {
        actionType: "wait",
        waitMs: waitArgs.duration_ms,
        reason: waitArgs.reason,
      };
    default:
      return {
        actionType: "wait",
        waitMs: 1000,
        reason: (args as any).reason || "Unknown action",
      };
  }
}
import { cropImageToTv } from "./imageProcessor";
import { saveScreenshotToServerFile } from "./screenshotSaver";
import {
  extractRestErrorMessage,
  logRestErrorDetails,
} from "../common/errors/azureAgentsErrors";
import { normalizeMultiline, resolveMaxSteps, delay } from "../common/utils";
import { getKnownDeviceStates } from "../../ha";
import { executeTool, ToolExecutionContext } from "./toolExecutors";
import { HassState } from "../../types/ha";

// ============================================================================
// Azure Client Retry Logic
// ============================================================================

interface RetryOptions {
  maxRetries?: number;
  baseDelay?: number;
  operationName?: string;
}

/**
 * Wrap Azure client calls with retry logic for network errors
 * @param operation - The async operation to retry
 * @param options - Retry configuration options
 * @returns Promise that resolves to the operation result
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxRetries = AZURE_AGENTS_RETRY_ENABLED ? AZURE_AGENTS_MAX_RETRIES : 1,
    baseDelay = AZURE_AGENTS_BASE_RETRY_DELAY,
    operationName = "Azure operation",
  } = options;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const isNetworkError =
        error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === "EPIPE" ||
          error.code === "ECONNRESET" ||
          error.code === "ETIMEDOUT" ||
          error.code === "ENOTFOUND" ||
          error.code === "EAI_AGAIN" ||
          error.code === "ECONNREFUSED");

      const isTimeoutError =
        error &&
        typeof error === "object" &&
        (("name" in error && error.name === "AbortError") ||
          ("message" in error &&
            typeof error.message === "string" &&
            (error.message.includes("timeout") ||
              error.message.includes("Timeout"))));

      const isRetriableError =
        error &&
        typeof error === "object" &&
        "statusCode" in error &&
        (error.statusCode === 429 || // Rate limit
          error.statusCode === 502 || // Bad gateway
          error.statusCode === 503 || // Service unavailable
          error.statusCode === 504); // Gateway timeout

      if (
        (isNetworkError || isTimeoutError || isRetriableError) &&
        attempt < maxRetries
      ) {
        const delay_ms = baseDelay * Math.pow(2, attempt - 1); // exponential backoff
        console.warn(
          `[TV Agent] ${operationName} failed on attempt ${attempt}/${maxRetries}:`,
          error instanceof Error ? error.message : String(error),
          `- retrying in ${delay_ms}ms...`
        );

        logRestErrorDetails(error);
        await delay(delay_ms);
        continue;
      }

      // If it's the final attempt or a non-retriable error, throw
      if (
        attempt === maxRetries ||
        (!isNetworkError && !isTimeoutError && !isRetriableError)
      ) {
        console.error(
          `[TV Agent] ${operationName} failed after ${attempt} attempts:`,
          error instanceof Error ? error.message : String(error)
        );
        logRestErrorDetails(error);
      }
      throw error;
    }
  }

  // This should never be reached due to the logic above, but TypeScript requires it
  throw new Error(
    `Unexpected error: retry loop completed without success or failure for ${operationName}`
  );
}

// Module-level state
const sessionStore = new Map<string, TvAgentSessionState>();
let cachedAgentId: string | null = null;
let cachedClient: AgentsClient | null = null;
let agentConfigurationSynced = false;
let pipelineLoggerAttached = false;
let lastRunCreationTimestamp = 0;

// ============================================================================
// Tool Execution Context
// ============================================================================

function getToolExecutionContext(): ToolExecutionContext {
  if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
    throw new Error(
      "Home Assistant connection is not configured. Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN."
    );
  }

  return {
    homeAssistantUrl: HOME_ASSISTANT_URL,
    homeAssistantToken: HOME_ASSISTANT_TOKEN,
    activeAgent: "tv", // Mark that TV agent is active
  };
}

// ============================================================================
// Azure Agents Client Management
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

  // Create client with timeout configuration
  const agentsClient = new AgentsClient(AZURE_AI_PROJECT_ENDPOINT, credential);

  if (!pipelineLoggerAttached) {
    // Add request timeout policy
    agentsClient.pipeline.addPolicy({
      name: "tvAgentTimeoutPolicy",
      sendRequest: async (request, next) => {
        // Set a timeout for the request
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, AZURE_AGENTS_TIMEOUT_MS);

        try {
          request.abortSignal = controller.signal;
          const response = await next(request);
          clearTimeout(timeoutId);
          return response;
        } catch (error) {
          clearTimeout(timeoutId);
          throw error;
        }
      },
    });

    // Add request logger
    agentsClient.pipeline.addPolicy({
      name: "tvAgentRequestLogger",
      sendRequest: async (request, next) => {
        const response = await next(request);
        return response;
      },
    });
    pipelineLoggerAttached = true;
  }

  cachedClient = agentsClient;
  return cachedClient;
}

function toolsMatch(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }

  if (tools.length !== TV_TOOLS.length) {
    return false;
  }

  // Check if all expected tools are present
  for (const expectedTool of TV_TOOLS) {
    const found = tools.some((tool) => {
      if (!tool || typeof tool !== "object") {
        return false;
      }

      if ((tool as { type?: string }).type !== "function") {
        return false;
      }

      const func = (tool as { function?: { name?: string } }).function;
      return func?.name === expectedTool.function.name;
    });

    if (!found) {
      return false;
    }
  }

  return true;
}

function agentNeedsUpdate(
  agent:
    | {
        model?: string;
        instructions?: string | null;
        description?: string | null;
        tools?: unknown;
      }
    | null
    | undefined,
  model: string
): boolean {
  if (!agent) {
    return true;
  }

  if (agent.model !== model) {
    return true;
  }

  if (
    normalizeMultiline(agent.instructions) !==
    normalizeMultiline(TV_AGENT_INSTRUCTIONS)
  ) {
    return true;
  }

  if (
    normalizeMultiline(agent.description) !==
    normalizeMultiline(TV_AGENT_DESCRIPTION)
  ) {
    return true;
  }

  if (!toolsMatch(agent.tools)) {
    return true;
  }

  return false;
}

async function syncAgentConfiguration(
  agentsClient: AgentsClient,
  agentId: string,
  model: string
): Promise<void> {
  await agentsClient.updateAgent?.(agentId, {
    model,
    name: TV_AGENT_NAME,
    description: TV_AGENT_DESCRIPTION,
    instructions: TV_AGENT_INSTRUCTIONS,
    tools: TV_TOOLS,
  });
}

async function ensureAgent(agentsClient: AgentsClient): Promise<string> {
  const model = AZURE_AI_AGENT_MODEL || "gpt-5-mini";
  const tryGetAgent = async (agentId: string) => {
    try {
      const agent = await agentsClient.getAgent?.(agentId);
      return agent ?? null;
    } catch (error) {
      const restMessage = extractRestErrorMessage(error);
      const message =
        restMessage || (error instanceof Error ? error.message : String(error));
      console.warn(`Failed to retrieve Azure agent (${agentId}): ${message}.`);
      return null;
    }
  };

  const finalizeAgent = async (agentId: string): Promise<string> => {
    const agent = await tryGetAgent(agentId);
    if (!agent) {
      throw new Error(`Azure agent ${agentId} no longer exists.`);
    }

    if (agentNeedsUpdate(agent, model)) {
      try {
        await syncAgentConfiguration(agentsClient, agentId, model);
      } catch (error) {
        const restMessage = extractRestErrorMessage(error);
        const message =
          restMessage ||
          (error instanceof Error ? error.message : String(error));
        console.warn(
          `Failed to synchronize Azure agent configuration (${message}).`
        );
        throw error instanceof Error ? error : new Error(message);
      }
    }

    cachedAgentId = agentId;
    agentConfigurationSynced = true;
    return agentId;
  };

  if (cachedAgentId) {
    try {
      return await finalizeAgent(cachedAgentId);
    } catch {
      cachedAgentId = null;
      agentConfigurationSynced = false;
    }
  }

  let existingAgentId: string | undefined;
  const listAgentsIterator = agentsClient.listAgents?.();
  if (
    listAgentsIterator &&
    Symbol.asyncIterator in Object(listAgentsIterator)
  ) {
    for await (const agent of listAgentsIterator) {
      if (agent?.name === TV_AGENT_NAME && agent?.id) {
        existingAgentId = agent.id;
        break;
      }
    }
  }

  if (existingAgentId) {
    try {
      return await finalizeAgent(existingAgentId);
    } catch (error) {
      const restMessage = extractRestErrorMessage(error);
      const message =
        restMessage || (error instanceof Error ? error.message : String(error));
      console.warn(
        `Failed to synchronize existing Azure agent (${existingAgentId}): ${message}. Recreating agent.`
      );
    }
  }

  const createdAgent = await agentsClient.createAgent?.(model, {
    name: TV_AGENT_NAME,
    description: TV_AGENT_DESCRIPTION,
    instructions: TV_AGENT_INSTRUCTIONS,
    tools: TV_TOOLS,
  });

  if (!createdAgent?.id) {
    throw new Error(
      "Failed to create Azure AI Agent instance for TV automation."
    );
  }

  cachedAgentId = createdAgent.id;
  agentConfigurationSynced = true;
  return createdAgent.id;
}

async function hydrateRunIdFromServer(
  agentsClient: AgentsClient,
  session: TvAgentSessionState
): Promise<void> {
  if (session.azureRunId) {
    return;
  }

  const runsIterator = agentsClient.runs.list?.(session.azureSessionId, {
    order: "desc",
    limit: 1,
  });

  if (!runsIterator) {
    return;
  }

  for await (const run of runsIterator as AsyncIterable<{
    id?: string;
  }>) {
    if (run?.id) {
      session.azureRunId = run.id;
      break;
    }
  }
}

// ============================================================================
// Session Management
// ============================================================================

async function createAgentSession(
  userPrompt: string,
  options?: {
    maxSteps?: number;
    messageHistory?: Array<{ role: string; content: string }>;
  }
): Promise<TvAgentSessionState> {
  // Create tracing span for session creation
  const span = createTVAgentSpan("tv-agent.createSession", {
    "prompt.length": userPrompt.length,
    "session.maxSteps": options?.maxSteps || 0,
    "session.hasHistory": !!options?.messageHistory?.length,
  });

  console.log(`[TV Agent] Creating agent session for prompt: "${userPrompt}"`);
  const agentsClient = loadAzureClient();
  await ensureAgent(agentsClient);
  const maxSteps = resolveMaxSteps(
    options?.maxSteps,
    TV_AGENT_MAX_ITERATIONS_CAP
  );

  console.log(`[TV Agent] Creating thread...`);
  const thread = await withRetry(
    async () => {
      return await agentsClient.threads.create();
    },
    { operationName: "create thread" }
  );

  if (!thread?.id) {
    throw new Error("Failed to create thread for TV automation.");
  }

  console.log(`[TV Agent] Thread created: ${thread.id}`);
  console.log(`[TV Agent] Creating initial message...`);

  // Build context-aware initial message
  let initialMessage = `The user asked: "${userPrompt}"\n\n`;
  initialMessage +=
    "You will now be provided with current state of all TVs in home assistant network.\n\n";
  initialMessage += `Current device states:\n${JSON.stringify(
    await getTvAgentDeviceStates(),
    null,
    2
  )}\n\n`;

  if (options?.messageHistory && options.messageHistory.length > 0) {
    initialMessage += `Previous conversation context:\n${JSON.stringify(
      options.messageHistory,
      null,
      2
    )}\n\n`;
  }

  initialMessage += `Begin by analyzing the goal and planning your approach.`;

  // Log the complete initial prompt to tracing
  logPromptAndResponse(span, initialMessage, "", {
    prompt: {
      "prompt.type": "initial-session-prompt",
      "prompt.userInput": userPrompt,
      "prompt.hasDeviceState": true,
      "prompt.hasHistory": !!options?.messageHistory?.length,
    },
  });

  await agentsClient.messages.create(thread.id, "user", initialMessage);

  const sessionState: TvAgentSessionState = {
    id: randomUUID(),
    azureSessionId: thread.id,
    steps: [],
    pendingScreenshot: undefined,
    completed: false,
    finalCommand: undefined,
    iterations: 1,
    maxSteps,
    userPrompt,
    additionalInstructions: options?.messageHistory
      ? `Context: ${JSON.stringify(options.messageHistory)}`
      : undefined,
    closed: false,
  };

  sessionStore.set(sessionState.id, sessionState);
  console.log(
    `[TV Agent] Session created: ${sessionState.id} (max steps: ${maxSteps})`
  );

  // Complete the session creation tracing
  span.setAttributes({
    "session.created.id": sessionState.id,
    "session.created.azureSessionId": sessionState.azureSessionId,
    "session.created.maxSteps": maxSteps,
  });
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();

  return sessionState;
}

async function getTvAgentDeviceStates(): Promise<HassState[]> {
  const deviceStates = (await getKnownDeviceStates()).filter((s) =>
    TV_AGENT_DEVICES.includes(s.entity_id.split(".")[1])
  );
  return deviceStates;
}

async function cleanupSession(session: TvAgentSessionState): Promise<void> {
  if (session.closed) {
    sessionStore.delete(session.id);
    return;
  }

  session.closed = true;
  sessionStore.delete(session.id);
}

function buildAwaitingScreenshotResult(
  session: TvAgentSessionState,
  step: TvAgentStep
): TvAgenticFlowResult {
  const retryInfo =
    step.retryCount && step.retryCount > 0
      ? ` (retry ${step.retryCount}/${step.maxRetries ?? 3})`
      : "";

  return {
    success: true,
    message: `Waiting for a camera screenshot after completing step ${step.index}${retryInfo}. The agent needs visual feedback to continue the task.`,
    steps: session.steps,
    finalCommand: session.finalCommand,
    sessionId: session.id,
    status: "awaiting_screenshot",
    pendingStep: step,
    screenshotRequest: {
      prompt: `Capture the TV screen to verify the result of: ${step.actionSummary}`,
      reason: step.reasoning,
      stepIndex: step.index,
    },
  };
}

function extractScreenshotPayload(
  options: RunTvAgenticFlowOptions
): ScreenshotPayload {
  if (options.screenshotError) {
    return { error: options.screenshotError };
  }

  if (options.screenshotBase64) {
    return {
      base64: options.screenshotBase64,
      contentType: options.screenshotContentType || "image/jpeg",
      dataUrl: options.screenshotDataUrl,
    };
  }

  if (!options.screenshotDataUrl) {
    return {};
  }

  const dataUrl = options.screenshotDataUrl;
  if (!dataUrl.startsWith("data:")) {
    return {
      error:
        "Invalid screenshot data URL provided. Expected data:<content-type>;base64,<data> format.",
    };
  }

  const base64Marker = ";base64,";
  const base64Index = dataUrl.indexOf(base64Marker);
  if (base64Index === -1) {
    return {
      error: "Invalid screenshot data URL provided. Expected base64 encoding.",
    };
  }

  const contentType = dataUrl.substring("data:".length, base64Index);
  const base64 = dataUrl.substring(base64Index + base64Marker.length);

  if (!contentType || !base64) {
    return {
      error:
        "Screenshot data URL is missing the content type or base64 payload.",
    };
  }

  return {
    base64,
    contentType,
    dataUrl,
  };
}

// ============================================================================
// Screenshot and Tool Output Processing
// ============================================================================

async function prepareScreenshotToolOutput(
  session: TvAgentSessionState,
  screenshot: ScreenshotPayload
): Promise<ToolOutputPayload> {
  const pending = session.pendingScreenshot;
  if (!pending) {
    throw new Error("No pending screenshot request for this session.");
  }

  const step =
    session.steps.find((item) => item.toolCallId === pending.toolCallId) ||
    session.steps.find((item) => item.index === pending.stepIndex);
  if (!step) {
    throw new Error(
      `Unable to locate step ${pending.stepIndex} for screenshot submission.`
    );
  }

  // Initialize retry tracking
  const currentRetryCount = pending.retryCount ?? 0;
  const maxRetries = step.maxRetries ?? 3;

  let observation = pending.observation;
  let screenshotError: string | undefined;
  let screenshotBase64: string | undefined;
  let screenshotContentType: string | undefined;
  let screenshotDataUrl: string | undefined;

  if (screenshot.error) {
    screenshotError = screenshot.error;

    // Track retry attempts
    if (currentRetryCount < maxRetries) {
      observation = `${observation}. Screenshot capture failed (attempt ${
        currentRetryCount + 1
      }/${maxRetries}): ${
        screenshot.error
      }. You may retry this action if needed.`;
      pending.retryCount = currentRetryCount + 1;
      step.retryCount = currentRetryCount + 1;
    } else {
      observation = `${observation}. Screenshot capture failed after ${maxRetries} attempts: ${screenshot.error}. Consider using a fallback strategy or different navigation approach.`;
      pending.retryCount = currentRetryCount + 1;
      step.retryCount = currentRetryCount + 1;
    }
  } else if (screenshot.base64 && screenshot.contentType) {
    // Save the raw screenshot received from client
    try {
      const toolName = step?.toolName || "unknown_tool";
      await saveScreenshotToServerFile({
        base64Data: screenshot.base64,
        sessionId: session.id,
        toolName: toolName,
        stepIndex: pending.stepIndex,
      });
    } catch (saveError) {
      console.warn(
        "[TV Agent] Error saving client screenshot file:",
        saveError
      );
    }

    // Try to crop the image to focus on the TV
    console.log(
      "[TV Agent] Processing screenshot - attempting to crop to TV..."
    );
    const croppedImage = await cropImageToTv(
      screenshot.base64,
      screenshot.contentType,
      session.id,
      pending.stepIndex,
      step?.toolName || "unknown_tool"
    );

    if (croppedImage) {
      console.log("[TV Agent] Using cropped image focused on TV");
      screenshotBase64 = croppedImage.base64;
      screenshotContentType = croppedImage.contentType;
      screenshotDataUrl = `data:${screenshotContentType};base64,${screenshotBase64}`;
      observation = `${observation}. Screenshot captured successfully and cropped to focus on TV screen. Analyze the image to determine the next action.`;
    } else {
      console.log("[TV Agent] Using original screenshot (cropping skipped)");
      screenshotBase64 = screenshot.base64;
      screenshotContentType = screenshot.contentType;
      screenshotDataUrl =
        screenshot.dataUrl ||
        `data:${screenshotContentType};base64,${screenshotBase64}`;
      observation = `${observation}. Screenshot captured successfully. Analyze the image to determine the next action.`;

      // Save original screenshot if no cropping was performed
      if (screenshotBase64) {
        try {
          const toolName = step?.toolName || "unknown_tool";
          await saveScreenshotToServerFile({
            base64Data: screenshotBase64,
            sessionId: session.id,
            toolName: `${toolName}_original`,
            stepIndex: pending.stepIndex,
          });
        } catch (saveError) {
          console.warn(
            "[TV Agent] Error saving original screenshot file:",
            saveError
          );
        }
      }
    }

    // Reset retry count on successful screenshot
    pending.retryCount = 0;
    step.retryCount = 0;
  } else {
    screenshotError =
      "Screenshot data missing. Provide a data URL or base64 payload when submitting the capture.";

    if (currentRetryCount < maxRetries) {
      observation = `${observation}. Screenshot data missing (attempt ${
        currentRetryCount + 1
      }/${maxRetries}). You may retry this action if needed.`;
      pending.retryCount = currentRetryCount + 1;
      step.retryCount = currentRetryCount + 1;
    } else {
      observation = `${observation}. Screenshot data missing after ${maxRetries} attempts. Consider using a fallback strategy.`;
      pending.retryCount = currentRetryCount + 1;
      step.retryCount = currentRetryCount + 1;
    }
  }

  step.observation = observation;
  step.screenshotBase64 = screenshotBase64;
  step.screenshotContentType = screenshotContentType;
  step.screenshotDataUrl = screenshotDataUrl;
  step.screenshotError = screenshotError;

  const toolOutput: Record<string, unknown> = {
    success: true,
    observation,
    status: screenshotError ? "screenshot_failed" : "screenshot_captured",
    retry_count: currentRetryCount,
    max_retries: maxRetries,
    can_retry: currentRetryCount < maxRetries,
  };

  if (screenshotBase64 && screenshotContentType) {
    toolOutput["screenshot_base64"] = screenshotBase64;
    toolOutput["screenshot_content_type"] = screenshotContentType;
  }

  if (screenshotError) {
    toolOutput["screenshot_error"] = screenshotError;
  }

  return {
    toolCallId: pending.toolCallId,
    output: JSON.stringify(toolOutput),
  };
}

async function reconcilePendingToolCallsFromRun(
  session: TvAgentSessionState,
  agentsClient: AgentsClient,
  run: ThreadRun | null
): Promise<void> {
  if (session.pendingScreenshot || !run) {
    return;
  }

  const requiredAction = run.requiredAction;
  if (!requiredAction || requiredAction.type !== "submit_tool_outputs") {
    return;
  }

  // Type narrowing for submit_tool_outputs
  if (!("submitToolOutputs" in requiredAction)) {
    return;
  }

  const toolCalls = requiredAction.submitToolOutputs?.toolCalls;
  if (!Array.isArray(toolCalls)) {
    return;
  }

  for (const toolCall of toolCalls) {
    if (!toolCall || toolCall.type !== "function") {
      continue;
    }

    // Type narrowing for function tool calls
    if (!("function" in toolCall)) {
      continue;
    }

    const toolCallId = toolCall.id;
    if (!toolCallId) {
      continue;
    }

    let parsedArgs: TvToolArguments | undefined;
    const rawArgs = toolCall.function?.arguments;
    if (typeof rawArgs === "string" && rawArgs.trim().length > 0) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (parsed && typeof parsed === "object") {
          parsedArgs = parsed as TvToolArguments;
        }
      } catch (error) {
        console.warn(
          `Failed to parse function arguments for tool call ${toolCallId}:`,
          error
        );
      }
    }

    let toolArguments: TvToolArguments;
    if (parsedArgs && typeof parsedArgs.reason === "string") {
      toolArguments = parsedArgs;
    } else {
      // Create a fallback wait tool if args are invalid
      toolArguments = {
        duration_ms: 1000,
        reason:
          parsedArgs && typeof parsedArgs.reason === "string"
            ? parsedArgs.reason
            : "Awaiting screenshot submission for pending tool call.",
      } as WaitArgs;
    }

    const actionSummary = getToolActionSummary(
      toolCall.function?.name || "unknown",
      toolArguments
    );
    const observation = `${actionSummary}. Awaiting screenshot submission.`;
    const reasoning = toolArguments.reason;

    let step = session.steps.find((item) => item.toolCallId === toolCallId);

    if (step) {
      step.actionSummary = actionSummary;
      step.observation = observation;
      step.reasoning = reasoning;
      step.toolArguments = toolArguments;
      step.retryCount = 0;
      step.maxRetries = 3;
    } else {
      step = {
        index: session.steps.length + 1,
        actionSummary,
        reasoning,
        observation,
        toolArguments,
        toolCallId,
        retryCount: 0,
        maxRetries: 3,
      };
      session.steps.push(step);
    }

    // Convert new tool format to legacy format temporarily for pendingScreenshot
    const legacyArgs = convertToLegacyFormat(
      toolCall.function?.name || "wait",
      toolArguments
    );
    session.pendingScreenshot = {
      toolCallId,
      args: legacyArgs,
      stepIndex: step.index,
      observation,
      retryCount: 0,
    };

    if (agentsClient.runSteps?.list && run.id) {
      try {
        const runStepsIterator = agentsClient.runSteps.list(
          session.azureSessionId,
          run.id,
          { order: "desc", limit: 20 }
        );

        for await (const runStep of runStepsIterator as AsyncIterable<any>) {
          const detail = runStep?.stepDetails;
          if (detail?.type !== "tool_calls") {
            continue;
          }

          const matchingCall = Array.isArray(detail.toolCalls)
            ? detail.toolCalls.find(
                (call: { id?: string }) => call?.id === toolCallId
              )
            : undefined;

          if (matchingCall?.function?.arguments) {
            try {
              const refreshedArgs = JSON.parse(matchingCall.function.arguments);
              if (refreshedArgs && typeof refreshedArgs.reason === "string") {
                step.actionSummary = getToolActionSummary(
                  matchingCall.function?.name || "unknown",
                  refreshedArgs
                );
                step.observation = `${step.actionSummary}. Awaiting screenshot submission.`;
                step.reasoning = refreshedArgs.reason;
                step.toolArguments = refreshedArgs;
                const legacyArgs = convertToLegacyFormat(
                  matchingCall.function?.name || "wait",
                  refreshedArgs
                );
                session.pendingScreenshot = {
                  toolCallId,
                  args: legacyArgs,
                  stepIndex: step.index,
                  observation: step.observation,
                };
              }
            } catch (error) {
              console.warn(
                `Failed to parse run step arguments for tool call ${toolCallId}:`,
                error
              );
            }
            break;
          }
        }
      } catch (error) {
        logRestErrorDetails(error);
      }
    }

    return;
  }
}

async function continueRunWithToolOutputs(
  session: TvAgentSessionState,
  toolOutputs: ToolOutputPayload[]
): Promise<TvAgenticFlowResult> {
  console.log(
    `[TV Agent] Continuing run with tool outputs for session ${session.id}`
  );

  if (!session.azureRunId) {
    console.log(`[TV Agent] No run ID, hydrating from server...`);
    const agentsClient = loadAzureClient();
    await hydrateRunIdFromServer(agentsClient, session);
  }

  if (!session.azureRunId) {
    throw new Error("No active run ID to submit tool outputs.");
  }

  // Add rate limiting before submitting tool outputs
  const now = Date.now();
  const waitFor = lastRunCreationTimestamp + MIN_RUN_CREATION_INTERVAL_MS - now;
  if (waitFor > 0) {
    console.log(
      `[TV Agent] Rate limiting: waiting ${waitFor}ms before submitting tool outputs`
    );
    await delay(waitFor);
  }

  console.log(
    `[TV Agent] Submitting ${toolOutputs.length} tool output(s) to run ${session.azureRunId}`
  );

  await withRetry(
    async () => {
      const agentsClient = loadAzureClient();
      lastRunCreationTimestamp = Date.now(); // Update timestamp after submission

      if (!session.azureRunId) {
        throw new Error("No active run ID to submit tool outputs.");
      }

      await agentsClient.runs.submitToolOutputs(
        session.azureSessionId,
        session.azureRunId,
        toolOutputs
      );
    },
    { operationName: "submit tool outputs" }
  );

  session.pendingScreenshot = undefined;
  console.log(
    `[TV Agent] Tool outputs submitted successfully, polling for completion...`
  );
  return pollRunCompletion(session);
}

// ============================================================================
// Polling Processing
// ============================================================================

async function pollRunCompletion(
  session: TvAgentSessionState
): Promise<TvAgenticFlowResult> {
  const agentsClient = loadAzureClient();
  const POLL_INTERVAL_MS = 100; // Poll every 100 milliseconds
  const MAX_POLL_TIME_MS = 120000; // 2 minutes max
  const startTime = Date.now();

  console.log(
    `[TV Agent] Polling run completion for session ${session.id}, iteration ${session.iterations}`
  );

  try {
    while (Date.now() - startTime < MAX_POLL_TIME_MS) {
      if (!session.azureRunId) {
        throw new Error("No active run ID to poll");
      }

      const run = await withRetry(
        async () => {
          return await agentsClient.runs.get(
            session.azureSessionId,
            session.azureRunId!
          );
        },
        {
          operationName: "get run status",
          maxRetries: 2, // Use fewer retries for polling to avoid long delays
          baseDelay: 500, // Shorter delay for polling
        }
      );

      console.log(`[TV Agent] Run status: ${run.status}`);

      if (run.status === "completed") {
        console.log(`[TV Agent] Run completed: ${session.azureRunId}`);

        // Create tracing span for completion
        const completionSpan = createTVAgentSpan("tv-agent.run-completed", {
          "session.id": session.id,
          "session.azureRunId": session.azureRunId || "",
          "session.totalSteps": session.steps.length,
          "session.userPrompt": session.userPrompt,
        });

        // Log the completion as a final "response" from the agent
        const completionMessage = `Completed agentic flow for request: ${session.userPrompt}`;
        logPromptAndResponse(
          completionSpan,
          session.userPrompt,
          completionMessage,
          {
            response: {
              "response.type": "flow-completion",
              "response.success": true,
              "response.totalSteps": session.steps.length,
              "response.finalCommand": session.finalCommand || "",
            },
          }
        );

        completionSpan.setStatus({ code: SpanStatusCode.OK });
        completionSpan.end();

        session.azureRunId = undefined;
        session.completed = true;

        await cleanupSession(session);

        return {
          success: true,
          message: completionMessage,
          steps: session.steps,
          finalCommand: session.finalCommand,
          sessionId: session.id,
          status: "completed",
        };
      }

      if (run.status === "failed") {
        console.error(`[TV Agent] Run failed: ${session.azureRunId}`, {
          lastError: run.lastError,
        });
        session.azureRunId = undefined;

        const lastError = run.lastError;
        const errorMessage = lastError?.message || "";
        const errorCode = lastError?.code;

        // Handle rate limiting
        if (errorCode === "rate_limit_exceeded") {
          const waitTimeMatch = errorMessage.match(
            /Try again in (\d+) seconds?/i
          );
          const waitSeconds = waitTimeMatch
            ? parseInt(waitTimeMatch[1], 10)
            : 60;

          throw new Error(
            `Rate limit exceeded. Please wait ${waitSeconds} seconds before retrying. ${errorMessage}`
          );
        }

        // Handle context length errors
        if (
          errorCode === "context_length_exceeded" ||
          errorMessage.includes("context")
        ) {
          throw new Error(
            `Context length exceeded. The conversation has become too long. Consider starting a new session or reducing the number of steps. ${lastError?.message}`
          );
        }

        throw new Error(
          lastError?.message ||
            "Azure agent run failed during polling. Check the device state and try a different approach."
        );
      }

      if (run.status === "cancelled" || run.status === "expired") {
        console.warn(`[TV Agent] Run ${run.status}: ${session.azureRunId}`);
        session.azureRunId = undefined;
        throw new Error(`Azure agent run was ${run.status} during polling.`);
      }

      if (run.status === "requires_action") {
        console.log(`[TV Agent] Run requires action`);
        const requiredAction = run.requiredAction;

        if (requiredAction?.type === "submit_tool_outputs") {
          const toolCalls = (requiredAction as SubmitToolOutputsAction)
            .submitToolOutputs.toolCalls;
          console.log(
            `[TV Agent] Found ${toolCalls.length} tool calls requiring execution`
          );

          if (toolCalls.length > 0) {
            const toolCall = toolCalls[0];

            if (toolCall.type === "function") {
              const toolName = (toolCall as RequiredFunctionToolCall).function
                .name as TvToolName;
              const toolInvocation = {
                id: toolCall.id,
                name: toolName,
                arguments:
                  (toolCall as RequiredFunctionToolCall).function.arguments ||
                  "{}",
              };

              // Create tracing span for tool execution
              const toolSpan = createTVAgentSpan("tv-agent.tool-execution", {
                "tool.id": toolInvocation.id,
                "tool.name": toolInvocation.name,
                "session.id": session.id,
                "step.index": session.steps.length + 1,
              });

              console.log(`[TV Agent] Tool invocation from requires_action:`, {
                id: toolInvocation.id,
                name: toolInvocation.name,
                arguments: toolInvocation.arguments,
              });

              // Log the tool call as a "response" from the agent
              logPromptAndResponse(
                toolSpan,
                "",
                `Tool Call: ${toolInvocation.name}\nArguments: ${toolInvocation.arguments}`,
                {
                  response: {
                    "response.type": "tool-call",
                    "tool.name": toolInvocation.name,
                    "tool.callId": toolInvocation.id,
                  },
                }
              );

              let parsedArgs: TvToolArguments;
              try {
                parsedArgs = JSON.parse(toolInvocation.arguments);
              } catch (error) {
                toolSpan.recordException(
                  error instanceof Error ? error : new Error(String(error))
                );
                toolSpan.setStatus({
                  code: SpanStatusCode.ERROR,
                  message: "Failed to parse tool arguments",
                });
                toolSpan.end();
                throw new Error(
                  `Failed to parse tool arguments: ${toolInvocation.arguments}`
                );
              }

              console.log(
                `[TV Agent] Executing tool from requires_action:`,
                parsedArgs
              );

              let observation: string;
              let needsScreenshot: boolean;

              // Get execution context
              const context = getToolExecutionContext();

              // Execute the appropriate tool using the new specialized tools
              const result = await executeTool(
                toolName,
                parsedArgs as TvToolArguments,
                context
              );
              observation = result.observation;
              needsScreenshot = result.needsScreenshot;

              console.log(
                `[TV Agent] Tool completed: ${observation}, needsScreenshot: ${needsScreenshot}`
              );

              // Log tool execution result to tracing
              toolSpan.addEvent("tool.completed", {
                "tool.observation": observation,
                "tool.needsScreenshot": needsScreenshot,
                "tool.success": true,
              });

              toolSpan.setAttributes({
                "tool.completed": true,
                "tool.observation.length": observation.length,
                "tool.needsScreenshot": needsScreenshot,
              });

              toolSpan.setStatus({ code: SpanStatusCode.OK });
              toolSpan.end();

              const step: TvAgentStep = {
                index: session.steps.length + 1,
                actionSummary: observation,
                reasoning: (parsedArgs as any).reason,
                observation,
                toolArguments: parsedArgs,
                toolName: toolName,
                toolCallId: toolInvocation.id as string,
                retryCount: 0,
                maxRetries: 3,
              };
              session.steps.push(step);

              // If screenshot is not needed, submit tool output immediately
              if (!needsScreenshot) {
                console.log(
                  `[TV Agent] No screenshot needed for step ${step.index}, submitting tool output with observation`
                );

                const toolOutput: ToolOutputPayload = {
                  toolCallId: toolInvocation.id as string,
                  output: JSON.stringify({
                    success: true,
                    observation,
                    status: "completed",
                  }),
                };

                return continueRunWithToolOutputs(session, [toolOutput]);
              }

              // Otherwise, wait for screenshot
              session.pendingScreenshot = {
                toolCallId: toolInvocation.id as string,
                args: parsedArgs as any,
                stepIndex: step.index,
                observation,
                retryCount: 0,
              };

              console.log(
                `[TV Agent] Awaiting screenshot for step ${step.index}`
              );
              return buildAwaitingScreenshotResult(session, step);
            }
          }
        }
      }

      // Wait before polling again
      await delay(POLL_INTERVAL_MS);
    }

    // Timeout reached
    throw new Error(
      `Polling timeout reached (${MAX_POLL_TIME_MS}ms) for run ${session.azureRunId}`
    );
  } catch (error) {
    console.error(
      `[TV Agent] Error during polling for session ${session.id}:`,
      error
    );
    logRestErrorDetails(error);
    const restMessage = extractRestErrorMessage(error);
    if (restMessage && error instanceof Error) {
      error.message = restMessage;
    } else if (restMessage) {
      throw new Error(restMessage);
    }
    throw error;
  }
}

async function processAgentUntilBreakpoint(
  session: TvAgentSessionState
): Promise<TvAgenticFlowResult> {
  console.log(
    `[TV Agent] Processing agent for session ${session.id}, iteration ${session.iterations}/${session.maxSteps}`
  );
  const agentsClient = loadAzureClient();

  if (session.azureRunId) {
    console.log(`[TV Agent] Checking existing run: ${session.azureRunId}`);
    try {
      const existingRun = await agentsClient.runs.get(
        session.azureSessionId,
        session.azureRunId
      );

      if (existingRun) {
        const status = existingRun.status;
        console.log(`[TV Agent] Existing run status: ${status}`);

        if (status === "requires_action") {
          console.log(`[TV Agent] Run requires action, reconciling tool calls`);
          await reconcilePendingToolCallsFromRun(
            session,
            agentsClient,
            existingRun
          );

          if (session.pendingScreenshot) {
            const pendingStep = session.steps.find(
              (step) => step.index === session.pendingScreenshot?.stepIndex
            );
            if (pendingStep) {
              console.log(
                `[TV Agent] Pending screenshot for step ${pendingStep.index}`
              );
              return buildAwaitingScreenshotResult(session, pendingStep);
            }
          }

          return {
            success: true,
            message:
              "Agent run is waiting for tool outputs. Submit the pending screenshot to continue.",
            steps: session.steps,
            finalCommand: session.finalCommand,
            sessionId: session.id,
            status: "awaiting_screenshot",
          };
        }

        if (status === "queued" || status === "in_progress") {
          console.log(`[TV Agent] Run is ${status}, returning running status`);
          return {
            success: true,
            message: "Agentic flow is running.",
            steps: session.steps,
            finalCommand: session.finalCommand,
            sessionId: session.id,
            status: "running",
          };
        }

        if (status === "completed") {
          console.log(`[TV Agent] Run completed, clearing run ID`);
          session.azureRunId = undefined;
        } else if (status === "failed") {
          console.error(`[TV Agent] Run failed:`, {
            lastError: existingRun.lastError,
            usage: existingRun.usage,
          });
          session.azureRunId = undefined;
          const failureMessage =
            existingRun.lastError?.message ||
            existingRun.lastError?.code ||
            "Azure agent run failed.";
          await cleanupSession(session);
          return {
            success: false,
            message: failureMessage,
            steps: session.steps,
            finalCommand: session.finalCommand,
            sessionId: session.id,
            status: "error",
          };
        } else if (status === "cancelled" || status === "expired") {
          console.warn(`[TV Agent] Run ${status}`);
          session.azureRunId = undefined;
          await cleanupSession(session);
          return {
            success: false,
            message: `Azure agent run ${status}.`,
            steps: session.steps,
            finalCommand: session.finalCommand,
            sessionId: session.id,
            status: "error",
          };
        } else if (status === "cancelling") {
          console.log(`[TV Agent] Run is cancelling`);
          return {
            success: true,
            message: "Agent run is cancelling. Try again shortly.",
            steps: session.steps,
            finalCommand: session.finalCommand,
            sessionId: session.id,
            status: "running",
          };
        }
      } else {
        console.warn(`[TV Agent] Existing run not found, clearing run ID`);
        session.azureRunId = undefined;
      }
    } catch (error) {
      console.error(`[TV Agent] Error inspecting run:`, error);
      logRestErrorDetails(error);
      const restMessage = extractRestErrorMessage(error);
      if (restMessage) {
        console.warn(
          `Failed to inspect the active Azure agent run: ${restMessage}`
        );
      }
      session.azureRunId = undefined;
    }
  }

  if (session.iterations > session.maxSteps) {
    console.warn(`[TV Agent] Max iterations (${session.maxSteps}) exceeded`);
    await cleanupSession(session);
    return {
      success: false,
      message: `Agentic TV flow reached the maximum allowed iterations (${
        session.maxSteps
      }) without completing the task. Completed ${
        session.steps.length
      } steps across ${
        session.iterations - 1
      } iterations. Consider refining the instructions or increasing the max iterations limit.`,
      steps: session.steps,
      finalCommand: session.finalCommand,
      sessionId: session.id,
      status: "error",
    };
  }

  const agentId = await ensureAgent(agentsClient);

  if (session.iterations > 1) {
    console.log(
      `Starting iteration ${session.iterations} for session ${session.id} (${session.steps.length} steps completed so far)`
    );
  }

  try {
    await withRetry(
      async () => {
        const now = Date.now();
        const waitFor =
          lastRunCreationTimestamp + MIN_RUN_CREATION_INTERVAL_MS - now;
        if (waitFor > 0) {
          console.log(
            `[TV Agent] Rate limiting: waiting ${waitFor}ms before creating run`
          );
          await delay(waitFor);
        }

        console.log(
          `[TV Agent] Creating new run for thread ${session.azureSessionId}`
        );
        lastRunCreationTimestamp = Date.now();
        const run = await agentsClient.runs.create(
          session.azureSessionId,
          agentId
        );

        session.azureRunId = run.id;
        session.iterations += 1;
        console.log(
          `[TV Agent] Run created successfully with ID ${run.id}, incremented iteration to ${session.iterations}`
        );
      },
      { operationName: "create run" }
    );
  } catch (error) {
    console.error(`[TV Agent] Error creating run:`, error);
    const restMessage = extractRestErrorMessage(error);
    if (restMessage && error instanceof Error) {
      error.message = restMessage;
    } else if (restMessage) {
      throw new Error(restMessage);
    }
    throw error;
  }

  return pollRunCompletion(session);
}

// ============================================================================
// Public API
// ============================================================================

export async function runTvAgenticFlow(
  options: RunTvAgenticFlowOptions
): Promise<TvAgenticFlowResult> {
  // Create tracing span for the entire TV agent flow
  const span = createTVAgentSpan("tv-agent.runAgenticFlow", {
    "session.id": options.sessionId || "new-session",
    "session.hasUserPrompt": !!options.userPrompt,
    "session.hasScreenshot": !!(
      options.screenshotBase64 || options.screenshotDataUrl
    ),
    "session.maxSteps": options.maxSteps || 0,
  });

  console.log(`[TV Agent] runTvAgenticFlow called with options:`, {
    sessionId: options.sessionId,
    hasUserPrompt: !!options.userPrompt,
    hasScreenshot: !!(options.screenshotBase64 || options.screenshotDataUrl),
    hasScreenshotError: !!options.screenshotError,
    maxSteps: options.maxSteps,
  });

  let session: TvAgentSessionState | undefined;

  try {
    if (options.sessionId) {
      console.log(
        `[TV Agent] Looking for existing session: ${options.sessionId}`
      );
      session = sessionStore.get(options.sessionId);
      if (!session) {
        throw new Error(
          `No active TV agent session found for sessionId ${options.sessionId}. Start a new session by omitting sessionId.`
        );
      }
      console.log(
        `[TV Agent] Found existing session with ${session.steps.length} steps`
      );
    }

    if (!session) {
      if (!options.userPrompt) {
        throw new Error(
          "userPrompt is required when starting a new agentic flow session."
        );
      }
      console.log(
        `[TV Agent] Creating new session for prompt: "${options.userPrompt}"`
      );
      session = await createAgentSession(options.userPrompt, {
        maxSteps: options.maxSteps,
        messageHistory: options.messageHistory,
      });
      console.log(`[TV Agent] New session created: ${session.id}`);
    }

    if (!session) {
      throw new Error("Failed to initialize the TV agent session.");
    }

    const currentSession = session;
    currentSession.maxSteps = resolveMaxSteps(
      currentSession.maxSteps,
      TV_AGENT_MAX_ITERATIONS_CAP
    );

    let result: TvAgenticFlowResult;

    if (currentSession.pendingScreenshot) {
      console.log(
        `[TV Agent] Session has pending screenshot request for step ${currentSession.pendingScreenshot.stepIndex}`
      );
      const screenshotPayload = extractScreenshotPayload(options);
      if (screenshotPayload.base64 && screenshotPayload.contentType) {
        console.log(`[TV Agent] Screenshot received, preparing tool output`);
        const toolOutput = await prepareScreenshotToolOutput(
          currentSession,
          screenshotPayload
        );
        result = await continueRunWithToolOutputs(currentSession, [toolOutput]);
      } else if (screenshotPayload.error) {
        console.log(`[TV Agent] Screenshot error, processing`);
        const toolOutput = await prepareScreenshotToolOutput(
          currentSession,
          screenshotPayload
        );
        result = await continueRunWithToolOutputs(currentSession, [toolOutput]);
      } else {
        console.log(
          `[TV Agent] No screenshot provided, returning pending state`
        );
        const pendingStep = currentSession.steps.find(
          (step) => step.index === currentSession.pendingScreenshot?.stepIndex
        );
        if (pendingStep) {
          return buildAwaitingScreenshotResult(currentSession, pendingStep);
        }
        console.warn(
          `[TV Agent] Pending screenshot state inconsistent, clearing`
        );
        currentSession.pendingScreenshot = undefined;
        result = await processAgentUntilBreakpoint(currentSession);
      }
    } else {
      console.log(`[TV Agent] No pending screenshot, processing agent`);
      result = await processAgentUntilBreakpoint(currentSession);
    }

    if (result.status === "completed" || result.status === "error") {
      console.log(
        `[TV Agent] Flow ${result.status}, cleaning up session ${currentSession.id}`
      );
      await cleanupSession(currentSession);
    }

    console.log(`[TV Agent] Returning result:`, {
      success: result.success,
      status: result.status,
      stepCount: result.steps.length,
      message: result.message.substring(0, 100),
    });

    // Log final result to tracing
    span.setAttributes({
      "result.success": result.success,
      "result.status": result.status,
      "result.stepCount": result.steps.length,
      "result.sessionId": result.sessionId,
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    return result;
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unknown error executing TV agentic flow.";
    console.error("[TV Agent] runTvAgenticFlow error:", {
      message,
      error,
      sessionId: session?.id || options.sessionId || "",
    });

    if (session) {
      await cleanupSession(session);
    }

    // Log error to tracing
    span.recordException(
      error instanceof Error ? error : new Error(String(error))
    );
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    span.end();

    return {
      success: false,
      message,
      steps: session?.steps ?? [],
      finalCommand: session?.finalCommand,
      sessionId: session?.id || options.sessionId || "",
      status: "error",
    };
  }
}
