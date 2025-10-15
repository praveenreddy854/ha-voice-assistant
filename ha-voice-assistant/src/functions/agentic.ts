import { httpPost } from "./httpUtils";
import {
  AgenticFlowResponse,
  AgenticFlowStatus,
  AgenticStep,
} from "../types/agentic";
import { Response } from "../types/response";
import { messageHistoryManager } from "../utils/sessionManager";
import { captureTvScreenshot, tvCameraController } from "../utils/tvCamera";

interface ScreenshotPayload {
  dataUrl?: string;
  base64?: string;
  contentType?: string;
  error?: string;
}

function buildRequestBody(
  userPrompt: string,
  sessionId: string | undefined,
  maxSteps: number | undefined,
  initialHistory: Array<{ role: string; content: string }> | undefined,
  screenshot: ScreenshotPayload | undefined
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    sessionId,
    maxSteps,
  };

  if (!sessionId) {
    body.userPrompt = userPrompt;
    if (initialHistory && initialHistory.length > 0) {
      body.messageHistory = initialHistory;
    }
  }

  if (screenshot?.dataUrl) {
    body.screenshotDataUrl = screenshot.dataUrl;
  }
  if (screenshot?.base64) {
    body.screenshotBase64 = screenshot.base64;
  }
  if (screenshot?.contentType) {
    body.screenshotContentType = screenshot.contentType;
  }
  if (screenshot?.error) {
    body.screenshotError = screenshot.error;
  }

  return body;
}

function logStepDelta(previousSteps: AgenticStep[], nextSteps: AgenticStep[]): void {
  if (nextSteps.length <= previousSteps.length) {
    return;
  }

  const newSteps = nextSteps.slice(previousSteps.length);
  newSteps.forEach((step) => {
    console.info(
      `[TV Agentic Flow] Recorded step ${step.index}: ${step.actionSummary}. Observation: ${step.observation}`
    );
  });
}

export async function runAgenticFlow(
  userPrompt: string,
  maxSteps?: number
): Promise<Response<AgenticFlowResponse>> {
  const initialHistory = messageHistoryManager.getContextualHistory();
  let sessionId: string | undefined;
  let screenshotPayload: ScreenshotPayload | undefined;
  let latestResponse: AgenticFlowResponse | undefined;
  let status: AgenticFlowStatus = "running";
  let iterations = 0;
  const maxIterations = Math.max(6, (maxSteps ?? 12) * 3);
  let knownSteps: AgenticStep[] = [];

  try {
    while (iterations < maxIterations) {
      iterations += 1;

      const body = buildRequestBody(
        userPrompt,
        sessionId,
        maxSteps,
        initialHistory,
        screenshotPayload
      );

      // Clear the payload so we do not resend the same capture multiple times.
      screenshotPayload = undefined;

      const response = await httpPost<AgenticFlowResponse>(
        "/runTvAgenticFlow",
        body,
        {
          headers: {
            "Content-Type": "application/json",
          },
        }
      );

      if (!response?.data) {
        throw new Error(response?.message || "Agentic flow did not return a response.");
      }

      latestResponse = response.data;
      sessionId = latestResponse.sessionId ?? sessionId;
      status = latestResponse.status;

      if (latestResponse.steps && latestResponse.steps.length > 0) {
        logStepDelta(knownSteps, latestResponse.steps);
        knownSteps = latestResponse.steps;
      }

      if (status === "awaiting_screenshot") {
        const pendingStep =
          latestResponse.pendingStep || latestResponse.steps?.[latestResponse.steps.length - 1];
        if (!pendingStep) {
          console.warn(
            "[TV Agentic Flow] Awaiting screenshot but no pending step was provided by the service."
          );
          screenshotPayload = {
            error: "No pending step available for screenshot capture.",
          };
          continue;
        }

        const reasonText = latestResponse.screenshotRequest?.reason
          ? ` Reason: ${latestResponse.screenshotRequest.reason}`
          : "";
        console.info(
          `[TV Agentic Flow] Awaiting screenshot for step ${pendingStep.index}.${reasonText}`
        );

        screenshotPayload = await captureTvScreenshot(pendingStep.index);
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
      errorMessage: "Agentic flow exceeded the maximum number of client-side iterations.",
    };
  } catch (error) {
    console.error("Error running agentic flow:", error);

    const message =
      error instanceof Error ? error.message : "Failed to execute agentic TV flow.";

    return {
      success: false,
      errorMessage: message,
    };
  } finally {
    if (tvCameraController.isActive()) {
      await tvCameraController.stop();
    }
  }
}
