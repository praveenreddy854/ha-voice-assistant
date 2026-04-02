/**
 * TV Agent Definition
 *
 * Implements AgentDefinition for the TV automation agent.
 *
 * Tools WITH execute functions auto-loop inside ToolLoopAgent.
 * The `request_screenshot` tool has NO execute — it breaks the loop
 * and the orchestrator pauses for external input from the client.
 */

import {
  AgentDefinition,
  AgentRunOptions,
  AgentSession,
  AgentRunResult,
  ExternalInputData,
} from "../core/types";
import { ToolDefinition } from "../core/agentLoop";
import {
  TV_AGENT_INSTRUCTIONS,
  TV_AGENT_MAX_ITERATIONS_CAP,
  TV_TOOLS,
  TV_AGENT_NAME,
  TV_AGENT_DESCRIPTION,
} from "./constants";
import {
  executeTool as executeTvTool,
  ToolExecutionContext as TvToolContext,
} from "./toolExecutors";
import { TvToolName, TvToolArguments, TvAgentStep } from "./types";
import { getKnownDeviceStates } from "../../ha";
import {
  HOME_ASSISTANT_TOKEN,
  HOME_ASSISTANT_URL,
  TV_AGENT_DEVICES,
} from "../../config";
import { cropImageToTv } from "./imageProcessor";
import { saveScreenshotToServerFile } from "./screenshotSaver";
import { saveTvFlowMemory } from "./flowMemory";
import { HassState } from "../../types/ha";

// ============================================================================
// Helpers
// ============================================================================

async function getTvAgentDeviceStates(): Promise<HassState[]> {
  return (await getKnownDeviceStates()).filter((s) =>
    TV_AGENT_DEVICES.includes(s.entity_id.split(".")[1])
  );
}

function getTvToolContext(): TvToolContext {
  if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
    throw new Error(
      "Home Assistant connection is not configured. Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN."
    );
  }
  return {
    homeAssistantUrl: HOME_ASSISTANT_URL,
    homeAssistantToken: HOME_ASSISTANT_TOKEN,
    activeAgent: "tv",
  };
}

function getToolActionSummary(
  toolName: string,
  args: Record<string, unknown>
): string {
  switch (toolName) {
    case "click_power_button":
      return "Press power";
    case "media_control":
      return `Media control: ${args.action || "action"}`;
    case "click_select_button":
      return "Press select";
    case "open_menu":
      return "Open menu";
    case "delegate_to_typing":
      return `Delegate typing: "${args.text_to_type || "text"}"`;
    case "request_screenshot":
      return "Request screenshot";
    case "get_device_state":
      return "Get device state";
    case "launch_app":
      return `Launch ${args.app_name || "app"}`;
    case "analyze_screenshot":
      return `Analyze: ${args.query || "screenshot"}`;
    case "verify_ui_state":
      return `Verify: ${args.expected_state || "UI state"}`;
    case "retrieve_similar_flows":
      return `Retrieve similar flows: ${args.current_goal || "goal"}`;
    case "wait":
      return `Wait ${args.duration_ms || 1000}ms`;
    default:
      return `Execute ${toolName}`;
  }
}

// ============================================================================
// Tools without execute (break the loop for external input)
// ============================================================================

/** Tools that break the loop — they need external input from the client. */
const TOOLS_WITHOUT_EXECUTE = new Set<string>(["request_screenshot"]);

// ============================================================================
// Build tools with execute functions
// ============================================================================

function buildTools(): ToolDefinition[] {
  return TV_TOOLS.map((t): ToolDefinition => {
    const toolName = t.function.name;

    const def: ToolDefinition = {
      type: "function" as const,
      function: {
        name: toolName,
        description: t.function.description,
        parameters: t.function.parameters as Record<string, unknown>,
      },
    };

    if (!TOOLS_WITHOUT_EXECUTE.has(toolName)) {
      // Auto-execute: the ToolLoopAgent runs this inside its loop
      def.execute = async (args: Record<string, unknown>) => {
        const context = getTvToolContext();
        const result = await executeTvTool(
          toolName as TvToolName,
          args as unknown as TvToolArguments,
          context
        );
        return {
          observation: result.observation,
          toolSuccess: result.toolSuccess ?? true,
          appUiContext: result.appUiContext,
        };
      };
    }
    // else: no execute → loop breaks, orchestrator asks client for screenshot

    return def;
  });
}

// ============================================================================
// TV Agent Definition
// ============================================================================

export const tvAgentDefinition: AgentDefinition = {
  id: "tv",
  name: TV_AGENT_NAME,
  description: TV_AGENT_DESCRIPTION,
  systemPrompt: TV_AGENT_INSTRUCTIONS,
  tools: buildTools(),
  maxIterations: TV_AGENT_MAX_ITERATIONS_CAP,

  async buildInitialMessage(
    userPrompt: string,
    options: AgentRunOptions
  ): Promise<string> {
    let msg = `The user asked: "${userPrompt}"\n\n`;
    msg +=
      "You will now be provided with current state of all TVs in home assistant network.\n\n";
    msg += `Current device states:\n${JSON.stringify(
      await getTvAgentDeviceStates(),
      null,
      2
    )}\n\n`;

    if (options.messageHistory && options.messageHistory.length > 0) {
      msg += `Previous conversation context:\n${JSON.stringify(
        options.messageHistory,
        null,
        2
      )}\n\n`;
    }

    msg += `Begin by analyzing the goal and planning your approach.`;
    return msg;
  },

  // executeTool is not used by the orchestrator anymore — tools auto-execute
  // inside ToolLoopAgent. This method exists for potential direct invocation.
  async executeTool(toolName, args, context) {
    const tvContext = getTvToolContext();
    const result = await executeTvTool(
      toolName as TvToolName,
      args as unknown as TvToolArguments,
      tvContext
    );
    return {
      observation: result.observation,
      needsExternalInput: result.needsScreenshot,
      toolSuccess: result.toolSuccess,
      metadata: { appUiContext: result.appUiContext },
    };
  },

  getToolActionSummary,

  buildToolContext(session) {
    return getTvToolContext() as unknown as import("../core/types").ToolExecutionContext;
  },

  async processExternalInput(
    session: AgentSession,
    input: ExternalInputData
  ): Promise<{ observation: string; imageBase64?: string; imageContentType?: string }> {
    const pending = session.pendingExternalInput;
    if (!pending) {
      throw new Error("No pending external input request for this session.");
    }

    const step = session.steps.find((s) => s.index === pending.stepIndex);
    const currentRetryCount = pending.retryCount ?? 0;
    const maxRetries = 3;

    // Handle error
    if (input.error) {
      const observation =
        currentRetryCount < maxRetries
          ? `Screenshot capture failed (attempt ${currentRetryCount + 1}/${maxRetries}): ${input.error}. You may retry this action if needed.`
          : `Screenshot capture failed after ${maxRetries} attempts: ${input.error}. Consider using a fallback strategy.`;

      if (step) {
        step.metadata = {
          ...step.metadata,
          screenshotError: input.error,
          screenshotOutcome: "error",
        };
        step.retryCount = currentRetryCount + 1;
      }
      pending.retryCount = currentRetryCount + 1;

      return { observation };
    }

    const base64 = input.data.base64 as string | undefined;
    const contentType = (input.data.contentType as string) || "image/jpeg";

    if (!base64) {
      const observation =
        currentRetryCount < maxRetries
          ? `Screenshot data missing (attempt ${currentRetryCount + 1}/${maxRetries}). You may retry.`
          : `Screenshot data missing after ${maxRetries} attempts. Consider a fallback.`;

      pending.retryCount = currentRetryCount + 1;
      if (step) {
        step.metadata = { ...step.metadata, screenshotOutcome: "error" };
      }
      return { observation };
    }

    // Save raw screenshot
    try {
      await saveScreenshotToServerFile({
        base64Data: base64,
        sessionId: session.id,
        toolName: pending.toolName,
        stepIndex: pending.stepIndex,
      });
    } catch (saveError) {
      console.warn("[TV Agent] Error saving screenshot file:", saveError);
    }

    // Try to crop to TV
    console.log("[TV Agent] Processing screenshot - attempting to crop to TV...");
    const croppedImage = await cropImageToTv(
      base64,
      contentType,
      session.id,
      pending.stepIndex,
      pending.toolName
    );

    let finalBase64: string;
    let finalContentType: string;
    let observation: string;

    if (croppedImage) {
      console.log("[TV Agent] Using cropped image focused on TV");
      finalBase64 = croppedImage.base64;
      finalContentType = croppedImage.contentType;
      observation = `Screenshot captured and cropped to TV screen. Analyze the image to determine the next action.`;
    } else {
      console.log("[TV Agent] Using original screenshot (cropping skipped)");
      finalBase64 = base64;
      finalContentType = contentType;
      observation = `Screenshot captured. Analyze the image to determine the next action.`;
    }

    // Update step metadata
    if (step) {
      step.observation = `${pending.observation}. ${observation}`;
      step.retryCount = 0;
      step.metadata = {
        ...step.metadata,
        screenshotBase64: finalBase64,
        screenshotContentType: finalContentType,
        screenshotDataUrl: `data:${finalContentType};base64,${finalBase64}`,
        screenshotOutcome: "captured",
      };
    }

    pending.retryCount = 0;

    return {
      observation: `${pending.observation}. ${observation}`,
      imageBase64: finalBase64,
      imageContentType: finalContentType,
    };
  },

  async onComplete(
    session: AgentSession,
    result: AgentRunResult
  ): Promise<void> {
    const status = result.status === "completed" ? "completed" : "error";

    try {
      await saveTvFlowMemory({
        sessionId: session.id,
        userPrompt: session.userPrompt,
        status,
        success: result.success,
        finalMessage: result.message,
        iterations: session.iterations,
        maxSteps: session.maxSteps,
        steps: session.steps.map((s) => ({
          index: s.index,
          actionSummary: s.actionSummary,
          reasoning: (s.toolArgs as any).reason || "",
          observation: s.observation,
          toolArguments: s.toolArgs as unknown as TvToolArguments,
          toolName: s.toolName as TvToolName,
          toolCallId: s.toolCallId,
          toolSuccess: s.toolSuccess,
          awaitedScreenshot: s.awaitingExternalInput,
          screenshotOutcome: ((s.metadata?.screenshotOutcome as string) || "none") as TvAgentStep["screenshotOutcome"],
          appUiContext: s.metadata?.appUiContext as TvAgentStep["appUiContext"],
          retryCount: s.retryCount,
          maxRetries: s.maxRetries,
        })),
      });
    } catch (error) {
      console.warn(
        `[TV Agent] Failed to persist flow memory for session ${session.id}:`,
        error
      );
    }
  },
};
