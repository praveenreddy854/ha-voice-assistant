/**
 * TV Agent Core Logic - Custom Agent Loop Implementation
 * Main implementation of the TV automation agent using custom OpenAI chat completions loop
 * Replaces Azure AI Agents framework with a simpler, more controllable approach
 */

import { randomUUID } from "crypto";
import {
  HOME_ASSISTANT_TOKEN,
  HOME_ASSISTANT_URL,
  TV_DEFAULT_WAIT_MS,
  TV_AGENT_DEVICES,
  AZURE_OPENAI_MODEL_ADVANCED,
} from "../../config";
import {
  addStoryEvent,
  createTVAgentSpan,
  getTelemetryMetrics,
  logPromptAndResponse,
  recordSpanError,
  setSpanAttributes,
  SpanKind,
  SpanStatusCode,
  withSpan,
} from "../../tracing";
import {
  TV_AGENT_INSTRUCTIONS,
  TV_AGENT_MAX_ITERATIONS_CAP,
  TV_TOOLS,
} from "./constants";
import {
  TvAgentStep,
  TvAgenticFlowResult,
  RunTvAgenticFlowOptions,
  TvToolName,
  TvToolArguments,
  WaitArgs,
  BoundingBox,
} from "./types";
import { cropImageToTv } from "./imageProcessor";
import { saveScreenshotToServerFile } from "./screenshotSaver";
import { delay, resolveMaxSteps } from "../common/utils";
import { getKnownDeviceStates } from "../../ha";
import { executeTool, ToolExecutionContext } from "./toolExecutors";
import { HassState } from "../../types/ha";
import {
  CustomAgentLoop,
  createAgentLoop,
  AgentToolCall,
  AgentStepResult,
  ToolExecutionResult,
  AgentMessage,
  ToolDefinition,
  ScreenshotInput,
} from "./customAgentLoop";

// ============================================================================
// Types
// ============================================================================

interface PendingScreenshotState {
  toolCallId: string;
  toolName: TvToolName;
  args: TvToolArguments;
  stepIndex: number;
  observation: string;
  retryCount?: number;
}

interface TvAgentSessionState {
  id: string;
  agentLoopSessionId: string; // Session ID for the custom agent loop
  steps: TvAgentStep[];
  pendingScreenshot?: PendingScreenshotState;
  lastKnownTvBounds?: BoundingBox;
  completed: boolean;
  finalCommand?: string;
  iterations: number;
  maxSteps: number;
  userPrompt: string;
  closed: boolean;
}

interface ScreenshotPayload {
  base64?: string;
  contentType?: string;
  dataUrl?: string;
  error?: string;
}

// ============================================================================
// Module State
// ============================================================================

const sessionStore = new Map<string, TvAgentSessionState>();
let agentLoop: CustomAgentLoop | null = null;

// ============================================================================
// Helper Functions
// ============================================================================

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
    case "delegate_to_typing":
      const typingArgs = args as any;
      return `Delegate typing: "${typingArgs.text_to_type || "text"}"`;
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

function getToolExecutionContext(
  screenshotBase64?: string,
  screenshotContentType?: string,
): ToolExecutionContext {
  if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
    throw new Error(
      "Home Assistant connection is not configured. Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN.",
    );
  }

  return {
    homeAssistantUrl: HOME_ASSISTANT_URL,
    homeAssistantToken: HOME_ASSISTANT_TOKEN,
    activeAgent: "tv",
    screenshotBase64,
    screenshotContentType,
  };
}

async function getTvAgentDeviceStates(): Promise<HassState[]> {
  const deviceStates = (await getKnownDeviceStates()).filter((s) =>
    TV_AGENT_DEVICES.includes(s.entity_id.split(".")[1]),
  );
  return deviceStates;
}

// ============================================================================
// Agent Loop Management
// ============================================================================

function getOrCreateAgentLoop(): CustomAgentLoop {
  if (!agentLoop) {
    // Convert TV_TOOLS to ToolDefinition format
    const tools: ToolDefinition[] = TV_TOOLS.map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters as Record<string, unknown>,
      },
    }));

    agentLoop = createAgentLoop({
      systemPrompt: TV_AGENT_INSTRUCTIONS,
      tools,
      maxIterations: TV_AGENT_MAX_ITERATIONS_CAP,
      model: AZURE_OPENAI_MODEL_ADVANCED || undefined,
    });
  }
  return agentLoop;
}

// ============================================================================
// Session Management
// ============================================================================

async function createAgentSession(
  userPrompt: string,
  options?: {
    maxSteps?: number;
    messageHistory?: Array<{ role: string; content: string }>;
  },
): Promise<TvAgentSessionState> {
  const metrics = getTelemetryMetrics();
  const span = createTVAgentSpan("tv-agent.createSession", {
    "prompt.length": userPrompt.length,
    "session.maxSteps": options?.maxSteps || 0,
    "session.hasHistory": !!options?.messageHistory?.length,
  });

  console.log(`[TV Agent] Creating agent session for prompt: "${userPrompt}"`);
  addStoryEvent(span, "tv.session.create.started", {
    "tv.session.prompt.length": userPrompt.length,
    "tv.session.history.count": options?.messageHistory?.length || 0,
  });

  const loop = getOrCreateAgentLoop();
  const maxSteps = resolveMaxSteps(
    options?.maxSteps,
    TV_AGENT_MAX_ITERATIONS_CAP,
  );

  // Build initial message with context
  let initialMessage = `The user asked: "${userPrompt}"\n\n`;
  initialMessage +=
    "You will now be provided with current state of all TVs in home assistant network.\n\n";
  const deviceStates = await getTvAgentDeviceStates();
  addStoryEvent(span, "tv.session.device_states.loaded", {
    "tv.session.device_states.count": deviceStates.length,
  });
  initialMessage += `Current device states:\n${JSON.stringify(
    deviceStates,
    null,
    2,
  )}\n\n`;

  if (options?.messageHistory && options.messageHistory.length > 0) {
    initialMessage += `Previous conversation context:\n${JSON.stringify(
      options.messageHistory,
      null,
      2,
    )}\n\n`;
  }

  initialMessage += `Begin by analyzing the goal and planning your approach.`;

  // Create session in the custom agent loop
  const loopSession = loop.createSession(initialMessage);

  // Log the initial prompt
  logPromptAndResponse(span, initialMessage, "", {
    prompt: {
      "prompt.type": "initial-session-prompt",
      "prompt.userInput": userPrompt,
      "prompt.hasDeviceState": true,
      "prompt.hasHistory": !!options?.messageHistory?.length,
    },
  });

  const sessionState: TvAgentSessionState = {
    id: randomUUID(),
    agentLoopSessionId: loopSession.id,
    steps: [],
    pendingScreenshot: undefined,
    lastKnownTvBounds: undefined,
    completed: false,
    finalCommand: undefined,
    iterations: 0,
    maxSteps,
    userPrompt,
    closed: false,
  };

  sessionStore.set(sessionState.id, sessionState);
  metrics.tvAgentActiveSessions.add(1, {
    "agent.name": "tv-agent",
  });

  console.log(
    `[TV Agent] Session created: ${sessionState.id} (agent loop session: ${loopSession.id}, max steps: ${maxSteps})`,
  );

  setSpanAttributes(span, {
    "session.created.id": sessionState.id,
    "session.created.agentLoopSessionId": loopSession.id,
    "session.created.maxSteps": maxSteps,
  });
  addStoryEvent(span, "tv.session.create.completed", {
    "tv.session.id": sessionState.id,
    "tv.session.loop_id": loopSession.id,
    "tv.session.max_steps": maxSteps,
  });
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();

  return sessionState;
}

async function cleanupSession(session: TvAgentSessionState): Promise<void> {
  const metrics = getTelemetryMetrics();
  if (session.closed) {
    sessionStore.delete(session.id);
    return;
  }

  session.closed = true;
  sessionStore.delete(session.id);
  metrics.tvAgentActiveSessions.add(-1, {
    "agent.name": "tv-agent",
  });

  // Clean up agent loop session
  const loop = getOrCreateAgentLoop();
  loop.deleteSession(session.agentLoopSessionId);
}

// ============================================================================
// Screenshot Handling
// ============================================================================

function extractScreenshotPayload(
  options: RunTvAgenticFlowOptions,
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

async function processScreenshot(
  session: TvAgentSessionState,
  screenshot: ScreenshotPayload,
): Promise<{ observation: string; base64?: string; contentType?: string }> {
  return withSpan(
    "tv-agent.process_screenshot",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "tv.session.id": session.id,
      },
    },
    async (span) => {
      const metrics = getTelemetryMetrics();
      const pending = session.pendingScreenshot;
      if (!pending) {
        throw new Error("No pending screenshot request for this session.");
      }

      addStoryEvent(span, "tv.screenshot.processing_started", {
        "tv.screenshot.step_index": pending.stepIndex,
        "tv.screenshot.tool_name": pending.toolName,
      });

      const step = session.steps.find((s) => s.index === pending.stepIndex);
      const currentRetryCount = pending.retryCount ?? 0;
      const maxRetries = 3;

      if (screenshot.error) {
        metrics.tvAgentScreenshotEvents.add(1, {
          "tv.screenshot.event": "capture_error",
        });
        const observation =
          currentRetryCount < maxRetries
            ? `Screenshot capture failed (attempt ${currentRetryCount + 1}/${maxRetries}): ${screenshot.error}. You may retry this action if needed.`
            : `Screenshot capture failed after ${maxRetries} attempts: ${screenshot.error}. Consider using a fallback strategy.`;

        if (step) {
          step.screenshotError = screenshot.error;
          step.retryCount = currentRetryCount + 1;
        }
        pending.retryCount = currentRetryCount + 1;
        addStoryEvent(span, "tv.screenshot.processing_failed", {
          "tv.screenshot.error": screenshot.error,
          "tv.screenshot.retry_count": pending.retryCount,
        });

        return { observation };
      }

      if (!screenshot.base64 || !screenshot.contentType) {
        metrics.tvAgentScreenshotEvents.add(1, {
          "tv.screenshot.event": "missing_payload",
        });
        const observation =
          currentRetryCount < maxRetries
            ? `Screenshot data missing (attempt ${currentRetryCount + 1}/${maxRetries}). You may retry this action if needed.`
            : `Screenshot data missing after ${maxRetries} attempts. Consider using a fallback strategy.`;

        pending.retryCount = currentRetryCount + 1;
        addStoryEvent(span, "tv.screenshot.processing_failed", {
          "tv.screenshot.error": "missing_payload",
          "tv.screenshot.retry_count": pending.retryCount,
        });
        return { observation };
      }

      try {
        await saveScreenshotToServerFile({
          base64Data: screenshot.base64,
          sessionId: session.id,
          toolName: pending.toolName,
          stepIndex: pending.stepIndex,
        });
      } catch (saveError) {
        console.warn("[TV Agent] Error saving client screenshot file:", saveError);
        addStoryEvent(span, "tv.screenshot.save_failed", {
          "tv.screenshot.error":
            saveError instanceof Error ? saveError.message : String(saveError),
        });
      }

      console.log("[TV Agent] Processing screenshot - attempting to crop to TV...");
      const croppedImage = await cropImageToTv(
        screenshot.base64,
        screenshot.contentType,
        session.id,
        pending.stepIndex,
        pending.toolName,
        session.lastKnownTvBounds,
      );

      let finalBase64: string;
      let finalContentType: string;
      let observation: string;

      if (croppedImage) {
        metrics.tvAgentScreenshotEvents.add(1, {
          "tv.screenshot.event": "cropped",
        });
        if (croppedImage.boundingBox) {
          session.lastKnownTvBounds = croppedImage.boundingBox;
        }
        console.log("[TV Agent] Using cropped image focused on TV");
        finalBase64 = croppedImage.base64;
        finalContentType = croppedImage.contentType;
        observation = `Screenshot captured successfully and cropped to focus on TV screen. Analyze the image to determine the next action.`;
      } else {
        metrics.tvAgentScreenshotEvents.add(1, {
          "tv.screenshot.event": "uncropped",
        });
        console.log("[TV Agent] Using original screenshot (cropping skipped)");
        finalBase64 = screenshot.base64;
        finalContentType = screenshot.contentType;
        observation = `Screenshot captured successfully. Analyze the image to determine the next action.`;
      }

      if (step) {
        step.screenshotBase64 = finalBase64;
        step.screenshotContentType = finalContentType;
        step.screenshotDataUrl = `data:${finalContentType};base64,${finalBase64}`;
        step.observation = `${pending.observation}. ${observation}`;
        step.retryCount = 0;
      }

      pending.retryCount = 0;
      addStoryEvent(span, "tv.screenshot.processing_completed", {
        "tv.screenshot.step_index": pending.stepIndex,
        "tv.screenshot.used_crop": !!croppedImage,
        "tv.screenshot.output_content_type": finalContentType,
      });

      return {
        observation: `${pending.observation}. ${observation}`,
        base64: finalBase64,
        contentType: finalContentType,
      };
    },
  );
}

// ============================================================================
// Result Building
// ============================================================================

function buildAwaitingScreenshotResult(
  session: TvAgentSessionState,
  step: TvAgentStep,
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

// ============================================================================
// Tool Execution
// ============================================================================

async function executeToolCall(
  session: TvAgentSessionState,
  toolCall: AgentToolCall,
  context: ToolExecutionContext,
): Promise<{
  result: ToolExecutionResult;
  needsScreenshot: boolean;
  step: TvAgentStep;
}> {
  const toolName = toolCall.function.name as TvToolName;
  return withSpan(
    "tv-agent.execute_tool_call",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "tv.session.id": session.id,
        "tv.tool.name": toolName,
      },
    },
    async (span) => {
      const metrics = getTelemetryMetrics();
      metrics.toolCallsTotal.add(1, {
        "workflow.name": "tv_agent",
        "tool.name": toolName,
      });

      let parsedArgs: TvToolArguments;
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        throw new Error(
          `Failed to parse tool arguments for ${toolName}: ${toolCall.function.arguments}`,
        );
      }

      addStoryEvent(span, "tv.tool_call.started", {
        "tv.tool.name": toolName,
        "tv.tool.call_id": toolCall.id,
      });

      console.log(`[TV Agent] Executing tool: ${toolName}`, parsedArgs);
      const execResult = await executeTool(toolName, parsedArgs, context);

      const step: TvAgentStep = {
        index: session.steps.length + 1,
        actionSummary: getToolActionSummary(toolName, parsedArgs),
        reasoning: (parsedArgs as any).reason || "",
        observation: execResult.observation,
        toolArguments: parsedArgs,
        toolName,
        toolCallId: toolCall.id,
        retryCount: 0,
        maxRetries: 3,
      };

      session.steps.push(step);
      addStoryEvent(span, "tv.tool_call.completed", {
        "tv.tool.name": toolName,
        "tv.tool.step_index": step.index,
        "tv.tool.needs_screenshot": execResult.needsScreenshot,
      });

      return {
        result: {
          toolCallId: toolCall.id,
          result: JSON.stringify({
            success: true,
            observation: execResult.observation,
            status: execResult.needsScreenshot
              ? "awaiting_screenshot"
              : "completed",
          }),
        },
        needsScreenshot: execResult.needsScreenshot,
        step,
      };
    },
  );
}

// ============================================================================
// Agent Loop Processing
// ============================================================================

async function processAgentLoop(
  session: TvAgentSessionState,
  screenshotContext?: { base64: string; contentType: string },
): Promise<TvAgenticFlowResult> {
  return withSpan(
    "tv-agent.process_loop",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "tv.session.id": session.id,
        "tv.loop.iteration": session.iterations + 1,
        "tv.loop.max_steps": session.maxSteps,
        "tv.loop.has_screenshot_context": !!screenshotContext,
      },
    },
    async (span) => {
      const metrics = getTelemetryMetrics();
      const loop = getOrCreateAgentLoop();
      const context = getToolExecutionContext(
        screenshotContext?.base64,
        screenshotContext?.contentType,
      );

      console.log(
        `[TV Agent] Processing agent loop for session ${session.id}, iteration ${session.iterations}/${session.maxSteps}`,
      );
      addStoryEvent(span, "tv.loop.started", {
        "tv.loop.iteration": session.iterations + 1,
        "tv.loop.max_steps": session.maxSteps,
      });

      if (session.iterations >= session.maxSteps) {
        console.warn(`[TV Agent] Max iterations (${session.maxSteps}) exceeded`);
        metrics.errorsTotal.add(1, {
          "error.source": "tv_agent.process_loop",
          "error.type": "max_iterations",
        });
        addStoryEvent(span, "tv.loop.max_iterations_reached", {
          "tv.loop.max_steps": session.maxSteps,
        });
        await cleanupSession(session);
        return {
          success: false,
          message: `Agentic TV flow reached the maximum allowed iterations (${session.maxSteps}) without completing the task.`,
          steps: session.steps,
          finalCommand: session.finalCommand,
          sessionId: session.id,
          status: "error",
        };
      }

      session.iterations++;

      const screenshotInputForStep: ScreenshotInput | undefined =
        screenshotContext?.base64 && screenshotContext?.contentType
          ? {
              imageBase64: screenshotContext.base64,
              imageContentType: screenshotContext.contentType,
            }
          : undefined;

      const stepResult = await loop.runStep(
        session.agentLoopSessionId,
        screenshotInputForStep,
      );

      console.log(`[TV Agent] Step result type: ${stepResult.type}`);
      addStoryEvent(span, "tv.loop.step_result", {
        "tv.loop.step_result.type": stepResult.type,
      });

      if (stepResult.type === "error") {
        console.error(`[TV Agent] Agent loop error: ${stepResult.error}`);
        metrics.errorsTotal.add(1, {
          "error.source": "tv_agent.process_loop",
          "error.type": "loop_error",
        });
        await cleanupSession(session);
        return {
          success: false,
          message: stepResult.error || "Unknown agent error",
          steps: session.steps,
          finalCommand: session.finalCommand,
          sessionId: session.id,
          status: "error",
        };
      }

      if (stepResult.type === "complete") {
        console.log(`[TV Agent] Agent loop completed: ${stepResult.message}`);
        session.completed = true;
        session.finalCommand = stepResult.message;
        addStoryEvent(span, "tv.loop.completed", {
          "tv.loop.message": stepResult.message || "",
        });
        await cleanupSession(session);
        return {
          success: true,
          message: stepResult.message || "Task completed successfully",
          steps: session.steps,
          finalCommand: session.finalCommand,
          sessionId: session.id,
          status: "completed",
        };
      }

      if (stepResult.type === "awaiting_screenshot") {
        console.log(
          `[TV Agent] Screenshot requested by model, returning to client`,
        );
        metrics.tvAgentScreenshotEvents.add(1, {
          "tv.screenshot.event": "requested",
        });

        const step: TvAgentStep = {
          index: session.steps.length + 1,
          actionSummary: "Request screenshot",
          reasoning:
            (stepResult.screenshotArgs?.reason as string) ||
            "Capture current TV screen state",
          observation: "Awaiting screenshot from client",
          toolArguments: (stepResult.screenshotArgs ||
            {}) as unknown as TvToolArguments,
          toolName: "request_screenshot",
          toolCallId: stepResult.screenshotToolCallId || "",
          retryCount: 0,
          maxRetries: 3,
        };

        session.steps.push(step);
        session.pendingScreenshot = {
          toolCallId: stepResult.screenshotToolCallId || "",
          toolName: "request_screenshot",
          args: (stepResult.screenshotArgs || {}) as unknown as TvToolArguments,
          stepIndex: step.index,
          observation: step.observation,
          retryCount: 0,
        };

        addStoryEvent(span, "tv.loop.awaiting_screenshot", {
          "tv.screenshot.step_index": step.index,
          "tv.screenshot.reason": step.reasoning,
        });

        return buildAwaitingScreenshotResult(session, step);
      }

      if (stepResult.type === "tool_calls" && stepResult.toolCalls) {
        console.log(
          `[TV Agent] Processing ${stepResult.toolCalls.length} tool calls`,
        );
        metrics.toolCallsTotal.add(stepResult.toolCalls.length, {
          "workflow.name": "tv_agent",
          "tool.group": "model_generated",
        });

        const toolResults: ToolExecutionResult[] = [];
        let screenshotNeeded = false;
        let pendingStep: TvAgentStep | undefined;

        for (const toolCall of stepResult.toolCalls) {
          try {
            const { result, needsScreenshot, step } = await executeToolCall(
              session,
              toolCall,
              context,
            );
            toolResults.push(result);

            if (needsScreenshot && !screenshotNeeded) {
              screenshotNeeded = true;
              pendingStep = step;
              session.pendingScreenshot = {
                toolCallId: toolCall.id,
                toolName: toolCall.function.name as TvToolName,
                args: JSON.parse(toolCall.function.arguments),
                stepIndex: step.index,
                observation: step.observation,
                retryCount: 0,
              };
            }
          } catch (error) {
            console.error(`[TV Agent] Tool execution error:`, error);
            metrics.errorsTotal.add(1, {
              "error.source": "tv_agent.execute_tool_call",
            });
            toolResults.push({
              toolCallId: toolCall.id,
              result: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            });
          }
        }

        if (screenshotNeeded && pendingStep) {
          console.log(
            `[TV Agent] Awaiting screenshot for step ${pendingStep.index}`,
          );
          addStoryEvent(span, "tv.loop.awaiting_screenshot", {
            "tv.screenshot.step_index": pendingStep.index,
          });
          return buildAwaitingScreenshotResult(session, pendingStep);
        }

        const nextResult = await loop.submitToolResults(
          session.agentLoopSessionId,
          toolResults,
        );

        return handleStepResult(session, nextResult, context);
      }

      if (stepResult.type === "message") {
        console.log(`[TV Agent] Received message: ${stepResult.message}`);
        addStoryEvent(span, "tv.loop.message", {
          "tv.loop.message.preview": stepResult.message || "",
        });
        return processAgentLoop(session);
      }

      console.warn(`[TV Agent] Unexpected step result type: ${stepResult.type}`);
      addStoryEvent(span, "tv.loop.unexpected_result", {
        "tv.loop.step_result.type": stepResult.type,
      });
      return {
        success: true,
        message: "Agent is processing...",
        steps: session.steps,
        finalCommand: session.finalCommand,
        sessionId: session.id,
        status: "running",
      };
    },
  );
}

async function handleStepResult(
  session: TvAgentSessionState,
  stepResult: AgentStepResult,
  context: ToolExecutionContext,
): Promise<TvAgenticFlowResult> {
  return withSpan(
    "tv-agent.handle_step_result",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "tv.session.id": session.id,
        "tv.step_result.type": stepResult.type,
      },
    },
    async (span) => {
      const metrics = getTelemetryMetrics();
      const loop = getOrCreateAgentLoop();
      addStoryEvent(span, "tv.step_result.received", {
        "tv.step_result.type": stepResult.type,
      });

      if (stepResult.type === "error") {
        console.error(`[TV Agent] Agent loop error: ${stepResult.error}`);
        metrics.errorsTotal.add(1, {
          "error.source": "tv_agent.handle_step_result",
          "error.type": "loop_error",
        });
        await cleanupSession(session);
        return {
          success: false,
          message: stepResult.error || "Unknown agent error",
          steps: session.steps,
          finalCommand: session.finalCommand,
          sessionId: session.id,
          status: "error",
        };
      }

      if (stepResult.type === "complete") {
        console.log(`[TV Agent] Agent loop completed: ${stepResult.message}`);
        session.completed = true;
        session.finalCommand = stepResult.message;
        addStoryEvent(span, "tv.step_result.complete", {
          "tv.step_result.message": stepResult.message || "",
        });
        await cleanupSession(session);
        return {
          success: true,
          message: stepResult.message || "Task completed successfully",
          steps: session.steps,
          finalCommand: session.finalCommand,
          sessionId: session.id,
          status: "completed",
        };
      }

      if (stepResult.type === "awaiting_screenshot") {
        console.log(
          `[TV Agent] Screenshot requested by model, returning to client`,
        );
        metrics.tvAgentScreenshotEvents.add(1, {
          "tv.screenshot.event": "requested",
        });

        const step: TvAgentStep = {
          index: session.steps.length + 1,
          actionSummary: "Request screenshot",
          reasoning:
            (stepResult.screenshotArgs?.reason as string) ||
            "Capture current TV screen state",
          observation: "Awaiting screenshot from client",
          toolArguments: (stepResult.screenshotArgs ||
            {}) as unknown as TvToolArguments,
          toolName: "request_screenshot",
          toolCallId: stepResult.screenshotToolCallId || "",
          retryCount: 0,
          maxRetries: 3,
        };

        session.steps.push(step);
        session.pendingScreenshot = {
          toolCallId: stepResult.screenshotToolCallId || "",
          toolName: "request_screenshot",
          args: (stepResult.screenshotArgs || {}) as unknown as TvToolArguments,
          stepIndex: step.index,
          observation: step.observation,
          retryCount: 0,
        };

        addStoryEvent(span, "tv.step_result.awaiting_screenshot", {
          "tv.screenshot.step_index": step.index,
        });
        return buildAwaitingScreenshotResult(session, step);
      }

      if (stepResult.type === "tool_calls" && stepResult.toolCalls) {
        console.log(
          `[TV Agent] Processing ${stepResult.toolCalls.length} tool calls`,
        );
        metrics.toolCallsTotal.add(stepResult.toolCalls.length, {
          "workflow.name": "tv_agent",
          "tool.group": "model_generated",
        });

        const toolResults: ToolExecutionResult[] = [];
        let screenshotNeeded = false;
        let pendingStep: TvAgentStep | undefined;

        for (const toolCall of stepResult.toolCalls) {
          try {
            const { result, needsScreenshot, step } = await executeToolCall(
              session,
              toolCall,
              context,
            );
            toolResults.push(result);

            if (needsScreenshot && !screenshotNeeded) {
              screenshotNeeded = true;
              pendingStep = step;
              session.pendingScreenshot = {
                toolCallId: toolCall.id,
                toolName: toolCall.function.name as TvToolName,
                args: JSON.parse(toolCall.function.arguments),
                stepIndex: step.index,
                observation: step.observation,
                retryCount: 0,
              };
            }
          } catch (error) {
            console.error(`[TV Agent] Tool execution error:`, error);
            metrics.errorsTotal.add(1, {
              "error.source": "tv_agent.execute_tool_call",
            });
            toolResults.push({
              toolCallId: toolCall.id,
              result: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            });
          }
        }

        if (screenshotNeeded && pendingStep) {
          console.log(
            `[TV Agent] Awaiting screenshot for step ${pendingStep.index}`,
          );
          addStoryEvent(span, "tv.step_result.awaiting_screenshot", {
            "tv.screenshot.step_index": pendingStep.index,
          });
          return buildAwaitingScreenshotResult(session, pendingStep);
        }

        const nextResult = await loop.submitToolResults(
          session.agentLoopSessionId,
          toolResults,
        );

        return handleStepResult(session, nextResult, context);
      }

      return processAgentLoop(session);
    },
  );
}

// ============================================================================
// Message Management API
// ============================================================================

export function addMessageToSession(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
): boolean {
  const session = sessionStore.get(sessionId);
  if (!session) {
    console.error(`[TV Agent] Session ${sessionId} not found`);
    return false;
  }

  const loop = getOrCreateAgentLoop();
  const message = loop.addMessage(session.agentLoopSessionId, role, content);
  return !!message;
}

export function removeMessageFromSession(
  sessionId: string,
  messageId: string,
): boolean {
  const session = sessionStore.get(sessionId);
  if (!session) {
    console.error(`[TV Agent] Session ${sessionId} not found`);
    return false;
  }

  const loop = getOrCreateAgentLoop();
  return loop.removeMessage(session.agentLoopSessionId, messageId);
}

export function removeLastMessagesFromSession(
  sessionId: string,
  count: number,
): number {
  const session = sessionStore.get(sessionId);
  if (!session) {
    console.error(`[TV Agent] Session ${sessionId} not found`);
    return 0;
  }

  const loop = getOrCreateAgentLoop();
  return loop.removeLastNMessages(session.agentLoopSessionId, count);
}

export function getSessionMessages(sessionId: string): AgentMessage[] {
  const session = sessionStore.get(sessionId);
  if (!session) {
    console.error(`[TV Agent] Session ${sessionId} not found`);
    return [];
  }

  const loop = getOrCreateAgentLoop();
  return loop.getMessages(session.agentLoopSessionId);
}

export function clearSessionMessages(
  sessionId: string,
  keepSystemMessage: boolean = true,
): boolean {
  const session = sessionStore.get(sessionId);
  if (!session) {
    console.error(`[TV Agent] Session ${sessionId} not found`);
    return false;
  }

  const loop = getOrCreateAgentLoop();
  const result = loop.clearMessages(
    session.agentLoopSessionId,
    keepSystemMessage,
  );

  // Reset session state
  if (result) {
    session.steps = [];
    session.pendingScreenshot = undefined;
    session.completed = false;
    session.finalCommand = undefined;
    session.iterations = 0;
  }

  return result;
}

// ============================================================================
// Public API
// ============================================================================

export async function runTvAgenticFlow(
  options: RunTvAgenticFlowOptions,
): Promise<TvAgenticFlowResult> {
  const metrics = getTelemetryMetrics();
  const span = createTVAgentSpan("tv-agent.runAgenticFlow", {
    "session.id": options.sessionId || "new-session",
    "session.hasUserPrompt": !!options.userPrompt,
    "session.hasScreenshot": !!(
      options.screenshotBase64 || options.screenshotDataUrl
    ),
    "session.maxSteps": options.maxSteps || 0,
  });
  const startedAt = Date.now();
  metrics.workflowRunsTotal.add(1, {
    "workflow.name": "tv_agentic_flow",
  });
  addStoryEvent(span, "tv.flow.request_received", {
    "tv.flow.session_id": options.sessionId || "new-session",
    "tv.flow.has_user_prompt": !!options.userPrompt,
    "tv.flow.has_screenshot": !!(
      options.screenshotBase64 || options.screenshotDataUrl
    ),
    "tv.flow.has_screenshot_error": !!options.screenshotError,
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
    // Get or create session
    if (options.sessionId) {
      console.log(
        `[TV Agent] Looking for existing session: ${options.sessionId}`,
      );
      session = sessionStore.get(options.sessionId);
      if (!session) {
        throw new Error(
          `No active TV agent session found for sessionId ${options.sessionId}. Start a new session by omitting sessionId.`,
        );
      }
      addStoryEvent(span, "tv.flow.session_reused", {
        "tv.session.id": session.id,
        "tv.session.steps": session.steps.length,
      });
      console.log(
        `[TV Agent] Found existing session with ${session.steps.length} steps`,
      );
    }

    if (!session) {
      if (!options.userPrompt) {
        throw new Error(
          "userPrompt is required when starting a new agentic flow session.",
        );
      }
      console.log(
        `[TV Agent] Creating new session for prompt: "${options.userPrompt}"`,
      );
      session = await createAgentSession(options.userPrompt, {
        maxSteps: options.maxSteps,
        messageHistory: options.messageHistory,
      });
      addStoryEvent(span, "tv.flow.session_created", {
        "tv.session.id": session.id,
        "tv.session.max_steps": session.maxSteps,
      });
      console.log(`[TV Agent] New session created: ${session.id}`);
    }

    if (!session) {
      throw new Error("Failed to initialize the TV agent session.");
    }

    session.maxSteps = resolveMaxSteps(
      session.maxSteps,
      TV_AGENT_MAX_ITERATIONS_CAP,
    );

    let result: TvAgenticFlowResult;

    // Handle pending screenshot
    if (session.pendingScreenshot) {
      addStoryEvent(span, "tv.flow.pending_screenshot_detected", {
        "tv.screenshot.step_index": session.pendingScreenshot.stepIndex,
      });
      console.log(
        `[TV Agent] Session has pending screenshot request for step ${session.pendingScreenshot.stepIndex}`,
      );

      const screenshotPayload = extractScreenshotPayload(options);

      if (screenshotPayload.base64 && screenshotPayload.contentType) {
        console.log(`[TV Agent] Screenshot received, processing`);
        addStoryEvent(span, "tv.flow.screenshot_received", {
          "tv.screenshot.content_type": screenshotPayload.contentType,
        });
        const processed = await processScreenshot(session, screenshotPayload);

        // Submit the screenshot result to the agent loop
        const loop = getOrCreateAgentLoop();
        const toolResult: ToolExecutionResult = {
          toolCallId: session.pendingScreenshot.toolCallId,
          result: JSON.stringify({
            success: true,
            observation: processed.observation,
            screenshot_captured: true,
          }),
        };
        if (processed.base64 && processed.contentType) {
          toolResult.imageBase64 = processed.base64;
          toolResult.imageContentType = processed.contentType;
        }

        session.pendingScreenshot = undefined;

        const nextResult = await loop.submitToolResults(
          session.agentLoopSessionId,
          [toolResult],
        );

        const context = getToolExecutionContext(
          processed.base64,
          processed.contentType,
        );
        result = await handleStepResult(session, nextResult, context);
      } else if (screenshotPayload.error) {
        console.log(`[TV Agent] Screenshot error, processing`);
        addStoryEvent(span, "tv.flow.screenshot_error_received", {
          "tv.screenshot.error": screenshotPayload.error,
        });
        const processed = await processScreenshot(session, screenshotPayload);

        const loop = getOrCreateAgentLoop();
        const toolResult: ToolExecutionResult = {
          toolCallId: session.pendingScreenshot.toolCallId,
          result: JSON.stringify({
            success: false,
            observation: processed.observation,
            screenshot_error: screenshotPayload.error,
          }),
        };

        session.pendingScreenshot = undefined;

        const nextResult = await loop.submitToolResults(
          session.agentLoopSessionId,
          [toolResult],
        );

        result = await handleStepResult(
          session,
          nextResult,
          getToolExecutionContext(),
        );
      } else {
        console.log(
          `[TV Agent] No screenshot provided, returning pending state`,
        );
        const pendingStepIndex = session.pendingScreenshot?.stepIndex;
        const pendingStep = session.steps.find(
          (step) => step.index === pendingStepIndex,
        );
        if (pendingStep) {
          addStoryEvent(span, "tv.flow.awaiting_screenshot_response", {
            "tv.screenshot.step_index": pendingStep.index,
          });
          result = buildAwaitingScreenshotResult(session, pendingStep);
        } else {
          // Inconsistent state, clear and continue
          console.warn(
            `[TV Agent] Pending screenshot state inconsistent, clearing`,
          );
          session.pendingScreenshot = undefined;
          addStoryEvent(span, "tv.flow.pending_screenshot_cleared");
          result = await processAgentLoop(session);
        }
      }
    } else {
      console.log(`[TV Agent] No pending screenshot, processing agent`);
      let screenshotContext:
        | { base64: string; contentType: string }
        | undefined;

      if (options.screenshotBase64) {
        screenshotContext = {
          base64: options.screenshotBase64,
          contentType: options.screenshotContentType || "image/jpeg",
        };
      } else if (options.screenshotDataUrl) {
        const parsed = extractScreenshotPayload(options);
        if (parsed.base64 && parsed.contentType) {
          screenshotContext = {
            base64: parsed.base64,
            contentType: parsed.contentType,
          };
        }
      }

      result = await processAgentLoop(session, screenshotContext);
    }

    if (result.status === "completed" || result.status === "error") {
      console.log(
        `[TV Agent] Flow ${result.status}, cleaning up session ${session.id}`,
      );
      await cleanupSession(session);
    }

    console.log(`[TV Agent] Returning result:`, {
      success: result.success,
      status: result.status,
      stepCount: result.steps.length,
      message: result.message.substring(0, 100),
    });

    setSpanAttributes(span, {
      "result.success": result.success,
      "result.status": result.status,
      "result.stepCount": result.steps.length,
      "result.sessionId": result.sessionId,
      "result.duration_ms": Date.now() - startedAt,
    });
    addStoryEvent(span, "tv.flow.completed", {
      "tv.flow.success": result.success,
      "tv.flow.status": result.status,
      "tv.flow.step_count": result.steps.length,
      "tv.flow.duration_ms": Date.now() - startedAt,
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
    metrics.errorsTotal.add(1, {
      "error.source": "tv_agent.runTvAgenticFlow",
    });

    if (session) {
      await cleanupSession(session);
    }

    recordSpanError(span, error, {
      "tv.flow.duration_ms": Date.now() - startedAt,
      "tv.flow.session_id": session?.id || options.sessionId || "",
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
