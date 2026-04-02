/**
 * TV Agent — Public API
 *
 * Thin wrapper around the core orchestrator that registers the TV agent
 * definition and translates between the TV-specific types and the generic
 * orchestrator protocol.
 *
 * The heavy lifting (session management, loop processing, external-input
 * pause/resume) is all handled by the core orchestrator.
 */

import {
  runAgent,
  registerAgent,
  getSession,
  getSessionMessages as coreGetSessionMessages,
  addMessageToSession as coreAddMessage,
  AgentRunResult,
} from "../core";
import type { ModelMessage } from "ai";
import { tvAgentDefinition } from "./definition";
import {
  TvAgenticFlowResult,
  RunTvAgenticFlowOptions,
  TvAgentStep,
} from "./types";

// ============================================================================
// Register TV Agent
// ============================================================================

registerAgent(tvAgentDefinition);

// ============================================================================
// Result Translation
// ============================================================================

/**
 * Convert generic AgentRunResult → TV-specific TvAgenticFlowResult.
 * Keeps backward compatibility with existing clients.
 */
function toTvResult(result: AgentRunResult): TvAgenticFlowResult {
  // Map generic steps → TvAgentStep
  const tvSteps: TvAgentStep[] = result.steps.map((s) => ({
    index: s.index,
    actionSummary: s.actionSummary,
    reasoning: (s.toolArgs as any).reason || "",
    observation: s.observation,
    toolArguments: s.toolArgs as any,
    toolName: s.toolName as any,
    toolCallId: s.toolCallId,
    toolSuccess: s.toolSuccess,
    awaitedScreenshot: s.awaitingExternalInput,
    screenshotOutcome: s.awaitingExternalInput
      ? (s.metadata?.screenshotOutcome as any) || "pending"
      : "none",
    appUiContext: s.metadata?.appUiContext as any,
    retryCount: s.retryCount,
    maxRetries: s.maxRetries,
    screenshotBase64: s.metadata?.screenshotBase64 as string | undefined,
    screenshotContentType: s.metadata?.screenshotContentType as string | undefined,
    screenshotDataUrl: s.metadata?.screenshotDataUrl as string | undefined,
    screenshotError: s.metadata?.screenshotError as string | undefined,
  }));

  // Map status
  const statusMap: Record<string, TvAgenticFlowResult["status"]> = {
    running: "running",
    awaiting_external_input: "awaiting_screenshot",
    completed: "completed",
    error: "error",
  };

  const tvResult: TvAgenticFlowResult = {
    success: result.success,
    message: result.message,
    steps: tvSteps,
    finalCommand: result.agentData?.finalMessage as string | undefined,
    sessionId: result.sessionId,
    status: statusMap[result.status] || "error",
  };

  // Add pending step and screenshot request when awaiting
  if (result.status === "awaiting_external_input" && result.externalInputRequest) {
    const pendingStep = tvSteps.find(
      (s) => s.index === result.externalInputRequest!.stepIndex
    );
    if (pendingStep) {
      tvResult.pendingStep = pendingStep;
      tvResult.screenshotRequest = {
        prompt: result.externalInputRequest.prompt,
        reason: result.externalInputRequest.reason,
        stepIndex: result.externalInputRequest.stepIndex,
      };
    }
  }

  return tvResult;
}

// ============================================================================
// Screenshot Payload Extraction
// ============================================================================

function extractExternalInput(
  options: RunTvAgenticFlowOptions
): { type: string; data: Record<string, unknown>; error?: string } | undefined {
  if (options.screenshotError) {
    return {
      type: "screenshot",
      data: {},
      error: options.screenshotError,
    };
  }

  if (options.screenshotBase64) {
    return {
      type: "screenshot",
      data: {
        base64: options.screenshotBase64,
        contentType: options.screenshotContentType || "image/jpeg",
        dataUrl: options.screenshotDataUrl,
      },
    };
  }

  if (options.screenshotDataUrl) {
    const dataUrl = options.screenshotDataUrl;
    if (!dataUrl.startsWith("data:")) {
      return {
        type: "screenshot",
        data: {},
        error: "Invalid screenshot data URL provided. Expected data:<content-type>;base64,<data> format.",
      };
    }

    const base64Marker = ";base64,";
    const base64Index = dataUrl.indexOf(base64Marker);
    if (base64Index === -1) {
      return {
        type: "screenshot",
        data: {},
        error: "Invalid screenshot data URL provided. Expected base64 encoding.",
      };
    }

    const contentType = dataUrl.substring("data:".length, base64Index);
    const base64 = dataUrl.substring(base64Index + base64Marker.length);

    if (!contentType || !base64) {
      return {
        type: "screenshot",
        data: {},
        error: "Screenshot data URL is missing the content type or base64 payload.",
      };
    }

    return {
      type: "screenshot",
      data: { base64, contentType, dataUrl },
    };
  }

  return undefined;
}

// ============================================================================
// Public API (backward compatible)
// ============================================================================

/**
 * Run the TV agentic flow.
 * Accepts the same options as before — translates to/from the generic orchestrator.
 */
export async function runTvAgenticFlow(
  options: RunTvAgenticFlowOptions
): Promise<TvAgenticFlowResult> {
  console.log(`[TV Agent] runTvAgenticFlow called with options:`, {
    sessionId: options.sessionId,
    hasUserPrompt: !!options.userPrompt,
    hasScreenshot: !!(options.screenshotBase64 || options.screenshotDataUrl),
    hasScreenshotError: !!options.screenshotError,
    maxSteps: options.maxSteps,
  });

  const externalInput = options.sessionId
    ? extractExternalInput(options)
    : undefined;

  const result = await runAgent({
    agentType: "tv",
    userPrompt: options.userPrompt,
    sessionId: options.sessionId,
    maxSteps: options.maxSteps,
    messageHistory: options.messageHistory,
    externalInput: externalInput,
  });

  const tvResult = toTvResult(result);

  console.log(`[TV Agent] Returning result:`, {
    success: tvResult.success,
    status: tvResult.status,
    stepCount: tvResult.steps.length,
    message: tvResult.message.substring(0, 100),
  });

  return tvResult;
}

// ============================================================================
// Message Management API (backward compatible)
// ============================================================================

export function addMessageToSession(
  sessionId: string,
  role: "user" | "assistant",
  content: string
): boolean {
  return coreAddMessage(sessionId, role, content);
}

export function getSessionMessages(sessionId: string): ModelMessage[] {
  return coreGetSessionMessages(sessionId);
}
