import { httpPost, BASE_URL } from "./httpUtils";
import {
  AgenticFlowResponse,
  AgenticFlowStatus,
  AgenticStep,
} from "../types/agentic";
import { Response } from "../types/response";
import { messageHistoryManager } from "../utils/sessionManager";
import { captureTvScreenshot, tvCameraController, isCameraOnDevice } from "../utils/tvCamera";
import { SessionLogEntry } from "../components/AgentSessionLog";
import { AgentRunResult, formatToolArgs, logStepDelta } from "./agentic";

// ============================================================================
// Request body builders
// ============================================================================

function buildNewSessionBody(
  userPrompt: string,
  maxSteps: number | undefined,
  messageHistory: Array<{ role: string; content: string }> | undefined
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    agentType: "tv",
    userPrompt,
    maxSteps,
  };
  if (messageHistory && messageHistory.length > 0) {
    body.messageHistory = messageHistory;
  }
  return body;
}

function buildContinuationBody(
  sessionId: string,
  screenshot: { base64?: string; contentType?: string; error?: string } | undefined
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    agentType: "tv",
    sessionId,
  };

  if (screenshot) {
    body.externalInput = screenshot.error
      ? { type: "screenshot", data: {}, error: screenshot.error }
      : {
          type: "screenshot",
          data: {
            base64: screenshot.base64,
            contentType: screenshot.contentType || "image/jpeg",
          },
        };
  }

  return body;
}

// ============================================================================
// Response mapping — unified AgentRunResult → frontend AgenticFlowResponse
// ============================================================================

function mapStep(s: AgentRunResult["steps"][number]): AgenticStep {
  return {
    index: s.index,
    actionSummary: s.actionSummary,
    reasoning: (s.toolArgs?.reason as string) || "",
    observation: s.observation,
    toolName: s.toolName,
    toolCallId: s.toolCallId,
    toolArguments: s.toolArgs,
    toolSuccess: s.toolSuccess,
    awaitedScreenshot: s.awaitingExternalInput,
    screenshotOutcome: (s.metadata?.screenshotOutcome as AgenticStep["screenshotOutcome"]) || "none",
    screenshotDataUrl: s.metadata?.screenshotDataUrl as string | undefined,
    screenshotBase64: s.metadata?.screenshotBase64 as string | undefined,
    screenshotContentType: s.metadata?.screenshotContentType as string | undefined,
    screenshotError: s.metadata?.screenshotError as string | undefined,
    appUiContext: s.metadata?.appUiContext as AgenticStep["appUiContext"],
    retryCount: s.retryCount,
    maxRetries: s.maxRetries,
  };
}

const STATUS_MAP: Record<AgentRunResult["status"], AgenticFlowStatus> = {
  running: "running",
  awaiting_external_input: "awaiting_screenshot",
  completed: "completed",
  error: "error",
};

function mapResponse(r: AgentRunResult): AgenticFlowResponse {
  const steps = r.steps.map(mapStep);
  return {
    success: r.success,
    message: r.message,
    steps,
    sessionId: r.sessionId,
    status: STATUS_MAP[r.status] || "error",
    pendingStep: r.externalInputRequest
      ? steps.find((s) => s.index === r.externalInputRequest!.stepIndex)
      : undefined,
    screenshotRequest: r.externalInputRequest
      ? {
          prompt: r.externalInputRequest.prompt,
          reason: r.externalInputRequest.reason,
          stepIndex: r.externalInputRequest.stepIndex,
        }
      : undefined,
  };
}

// ============================================================================
// Session log
// ============================================================================

/** Holds the session log for the most recent agentic flow run. */
let _lastSessionLog: SessionLogEntry[] = [];

/** Get the session log from the last `runTvAgenticFlow` call. */
export function getLastSessionLog(): SessionLogEntry[] {
  return _lastSessionLog;
}

// ============================================================================
// Screenshot Subscription — SSE-driven capture. The server sends "capture"
// events; the client captures from the camera and uploads on each event.
// ============================================================================

class ScreenshotSubscription {
  private eventSource: EventSource | null = null;
  private sessionId: string | undefined;
  private capturing = false;

  subscribe(sessionId: string): void {
    if (this.eventSource) return;
    this.sessionId = sessionId;
    const url = `${BASE_URL}/screenshot/subscribe?sessionId=${encodeURIComponent(sessionId)}`;
    this.eventSource = new EventSource(url);

    this.eventSource.addEventListener("capture", () => {
      this.handleCaptureEvent();
    });

    this.eventSource.onerror = () => {
      // EventSource auto-reconnects; nothing to do
    };

    console.info(`[Screenshot Sub] Subscribed for session ${sessionId}`);
  }

  unsubscribe(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.sessionId = undefined;
    console.info("[Screenshot Sub] Unsubscribed");
  }

  isActive(): boolean {
    return this.eventSource !== null;
  }

  private async handleCaptureEvent(): Promise<void> {
    if (!this.sessionId || this.capturing) return;
    // In RTSP mode, the server saves frames directly — no local capture needed.
    const onDevice = await isCameraOnDevice();
    if (!onDevice) return;
    this.capturing = true;
    try {
      const capture = await captureTvScreenshot(-1);
      if (capture.base64 && !capture.error) {
        await httpPost("/screenshot", {
          sessionId: this.sessionId,
          base64: capture.base64,
        });
      }
    } catch {
      // Best effort — next event will retry
    } finally {
      this.capturing = false;
    }
  }
}

const screenshotSub = new ScreenshotSubscription();

// ============================================================================
// Main flow
// ============================================================================

export async function runTvAgenticFlow(
  userPrompt: string,
  maxSteps?: number
): Promise<Response<AgenticFlowResponse>> {
  const initialHistory = messageHistoryManager.getContextualHistory();
  let sessionId: string | undefined;
  let screenshotPayload: { base64?: string; contentType?: string; error?: string } | undefined;
  let latestResponse: AgenticFlowResponse | undefined;
  let status: AgenticFlowStatus = "running";
  let iterations = 0;
  const maxIterations = Math.max(6, (maxSteps ?? 12) * 3);
  let knownSteps: AgenticStep[] = [];
  const sessionLog: SessionLogEntry[] = [];
  _lastSessionLog = sessionLog;

  try {
    while (iterations < maxIterations) {
      iterations += 1;

      // Build request — new session or continuation
      const body = sessionId
        ? buildContinuationBody(sessionId, screenshotPayload)
        : buildNewSessionBody(userPrompt, maxSteps, initialHistory);

      // Clear so we don't resend the same screenshot
      screenshotPayload = undefined;

      sessionLog.push({
        timestamp: Date.now(),
        type: "request",
        iteration: iterations,
      });

      const response = await httpPost<AgentRunResult>(
        "/agent/run",
        body,
        { headers: { "Content-Type": "application/json" } }
      );

      if (!response?.data) {
        throw new Error(
          response?.statusText || "Agent did not return a response."
        );
      }

      // Map unified response → frontend types
      latestResponse = mapResponse(response.data);
      sessionId = latestResponse.sessionId ?? sessionId;
      status = latestResponse.status;

      // Subscribe to screenshot capture events once we have a session ID
      if (sessionId && !screenshotSub.isActive()) {
        screenshotSub.subscribe(sessionId);
      }

      sessionLog.push({
        timestamp: Date.now(),
        type: "response",
        iteration: iterations,
        response: latestResponse,
      });

      if (latestResponse.steps && latestResponse.steps.length > 0) {
        logStepDelta(knownSteps, latestResponse.steps);
        knownSteps = latestResponse.steps;
      }

      if (status === "awaiting_screenshot") {
        const pendingStep =
          latestResponse.pendingStep ||
          latestResponse.steps?.[latestResponse.steps.length - 1];
        if (!pendingStep) {
          console.warn("[Agent Flow] Awaiting screenshot but no pending step.");
          screenshotPayload = { error: "No pending step available for screenshot capture." };
          sessionLog.push({
            timestamp: Date.now(),
            type: "screenshot_error",
            iteration: iterations,
            screenshot: { error: "No pending step available" },
          });
          continue;
        }

        const reasonText = latestResponse.screenshotRequest?.reason
          ? ` Reason: ${latestResponse.screenshotRequest.reason}`
          : "";
        console.info(
          `[Agent Flow] Awaiting screenshot for step ${pendingStep.index}.${reasonText}`
        );

        const capture = await captureTvScreenshot(pendingStep.index);

        // Map to the simpler payload shape for buildContinuationBody
        screenshotPayload = {
          base64: capture.base64,
          contentType: capture.contentType,
          error: capture.error,
        };

        if (capture.error) {
          sessionLog.push({
            timestamp: Date.now(),
            type: "screenshot_error",
            iteration: iterations,
            screenshot: { error: capture.error, stepIndex: pendingStep.index },
          });
        } else {
          sessionLog.push({
            timestamp: Date.now(),
            type: "screenshot_capture",
            iteration: iterations,
            screenshot: { dataUrl: capture.dataUrl, stepIndex: pendingStep.index },
          });
        }

        continue;
      }

      if (status === "completed") {
        if (latestResponse.success && latestResponse.message) {
          messageHistoryManager.addMessage("assistant", latestResponse.message);
        }
        return {
          success: true,
          data: latestResponse,
          message: latestResponse.message,
        };
      }

      if (status === "error") {
        return {
          success: false,
          errorMessage: latestResponse.message,
          data: latestResponse,
          message: latestResponse.message,
        };
      }

      // Continue looping while the agent is still running.
    }

    return {
      success: false,
      errorMessage: "Agent flow exceeded the maximum number of client-side iterations.",
    };
  } catch (error) {
    console.error("Error running agent flow:", error);

    const message =
      error instanceof Error
        ? error.message
        : "Failed to execute agent flow.";

    return {
      success: false,
      errorMessage: message,
    };
  } finally {
    screenshotSub.unsubscribe();
    if (tvCameraController.isActive()) {
      await tvCameraController.stop();
    }
  }
}
