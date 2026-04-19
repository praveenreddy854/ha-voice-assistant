/**
 * TV Agent Definition
 *
 * Implements AgentDefinition for the TV automation agent.
 *
 * Tools WITH execute functions auto-loop inside ToolLoopAgent.
 * The `get_latest_screenshot` tool has NO execute — it breaks the loop
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
  TV_AGENT_NAME,
  TV_AGENT_DESCRIPTION,
} from "./constants";
import {
  executeTool as executeTvTool,
  ToolExecutionContext as TvToolContext,
  TV_TOOLS,
  TOOLS_NEEDING_EXTERNAL_INPUT,
  getToolActionSummary,
} from "./tools";
import { TvToolName, TvToolArguments, TvAgentStep } from "./types";
import { getKnownDeviceStates, callHAServiceDirect } from "../../ha";
import {
  HOME_ASSISTANT_TOKEN,
  HOME_ASSISTANT_URL,
  TV_AGENT_DEVICES,
} from "../../config";
import { delay } from "../common/utils";
import { saveScreenshotToServerFile } from "./screenshotSaver";
import { saveTvFlowMemory } from "./flowMemory";
import { HassState } from "../../types/ha";
import { getAvailableSkills, formatSkillSummaries } from "./skills/skillRegistry";
import {
  addEvent,
  addToolResult,
  getActiveSessionId,
} from "../../tracing/agentTraceStore";

// ============================================================================
// Helpers
// ============================================================================

async function getTvAgentDeviceStates(): Promise<HassState[]> {
  return (await getKnownDeviceStates()).filter((s) => {
    const entityName = s.entity_id.split(".")[1];
    return TV_AGENT_DEVICES.some((d) => entityName === d || entityName.startsWith(d + "_"));
  });
}

/**
 * Check if any TV agent device is in standby/off and wake it.
 * Returns info about whether a wake was performed.
 */
async function ensureDeviceAwake(): Promise<{ woken: boolean; state: string }> {
  const states = await getTvAgentDeviceStates();
  const mediaPlayer = states.find((s) => s.entity_id.startsWith("media_player."));
  const remoteEntity = states.find((s) => s.entity_id.startsWith("remote."));

  if (!mediaPlayer) {
    return { woken: false, state: "unknown" };
  }

  if (mediaPlayer.state === "standby" || mediaPlayer.state === "off") {
    if (remoteEntity) {
      console.log(
        `[TV Agent] Device in ${mediaPlayer.state}, sending wakeup to ${remoteEntity.entity_id}`
      );
      await callHAServiceDirect("remote", "send_command", remoteEntity.entity_id, {
        command: "wakeup",
      });
      await delay(2500);

      // Verify state after wake
      const updatedStates = await getTvAgentDeviceStates();
      const updated = updatedStates.find((s) => s.entity_id === mediaPlayer.entity_id);
      return { woken: true, state: updated?.state || "unknown" };
    }
  }

  return { woken: false, state: mediaPlayer.state };
}

/** Latest screenshot captured by processExternalInput, shared with sub-agents. */
let latestScreenshot: { base64: string; contentType: string } | null = null;

function getTvToolContext(sessionId?: string): TvToolContext {
  if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
    throw new Error(
      "Home Assistant connection is not configured. Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN."
    );
  }
  return {
    homeAssistantUrl: HOME_ASSISTANT_URL,
    homeAssistantToken: HOME_ASSISTANT_TOKEN,
    sessionId: sessionId || getActiveSessionId() || undefined,
    activeAgent: "tv",
    screenshotBase64: latestScreenshot?.base64,
    screenshotContentType: latestScreenshot?.contentType,
  };
}


// ============================================================================
// Build tools with execute functions
// ============================================================================

/**
 * Step-level concurrency guard.
 *
 * When the LLM emits multiple tool calls in a single response, the AI SDK
 * fires all execute functions concurrently. We only allow the first tool to
 * run; the rest get a rejection message telling the LLM to call them one at
 * a time. Node.js is single-threaded, so the synchronous check+set before
 * the first `await` is atomic — no race condition.
 */
let stepGuardOwner: string | null = null;

function buildTools(): ToolDefinition[] {
  return TV_TOOLS.map((t): ToolDefinition => {
    const toolName = t.function.name;

    const def: ToolDefinition = {
      type: "function" as const,
      function: {
        name: toolName,
        description: t.function.description,
        parameters: t.function.parameters as Record<string, unknown>,
        inputSchema: t.function.inputSchema,
      },
    };

    if (!TOOLS_NEEDING_EXTERNAL_INPUT.has(toolName)) {
      // Auto-execute: the ToolLoopAgent runs this inside its loop
      def.execute = async (args: Record<string, unknown>) => {
        // ── Concurrency guard: one tool per step ──
        if (stepGuardOwner !== null) {
          console.warn(
            `[TV Agent] BLOCKED parallel tool call: "${toolName}" rejected (step already running "${stepGuardOwner}")`
          );
          return {
            observation:
              `⚠️ REJECTED: "${toolName}" was called in parallel with "${stepGuardOwner}". ` +
              `Only ONE tool is allowed per turn. Call "${toolName}" alone in your next response.`,
            toolSuccess: false,
          };
        }
        stepGuardOwner = toolName;

        const startTime = Date.now();
        console.log(`[TV Agent] ▶ Tool call: ${toolName}`, JSON.stringify(args, null, 2));
        const traceSessionId = getActiveSessionId();
        if (traceSessionId) {
          addEvent(traceSessionId, "agent.tool.started", `${toolName} started`, {
            toolName,
            args,
          });
        }

        try {
          const context = getTvToolContext();
          const result = await executeTvTool(
            toolName as TvToolName,
            args as unknown as TvToolArguments,
            context
          );
          const durationMs = Date.now() - startTime;
          const success = result.toolSuccess ?? true;

          console.log(
            `[TV Agent] ${success ? "✓" : "✗"} Tool result: ${toolName} (${durationMs}ms) → ${result.observation.substring(0, 200)}`
          );

          // Record in trace store
          if (traceSessionId) {
            addToolResult(traceSessionId, {
              toolCallId: "",
              toolName,
              observation: result.observation,
              toolSuccess: success,
              durationMs,
              args,
            });
          }

          return {
            observation: result.observation,
            toolSuccess: success,
            appUiContext: result.appUiContext,
          };
        } catch (error) {
          const durationMs = Date.now() - startTime;
          const errMsg = error instanceof Error ? error.message : String(error);
          console.error(`[TV Agent] ✗ Tool error: ${toolName} (${durationMs}ms) → ${errMsg}`);
          if (traceSessionId) {
            addToolResult(traceSessionId, {
              toolCallId: "",
              toolName,
              observation: `Tool "${toolName}" failed: ${errMsg}`,
              toolSuccess: false,
              durationMs,
              args,
            });
          }
          return {
            observation: `Tool "${toolName}" failed: ${errMsg}`,
            toolSuccess: false,
          };
        } finally {
          stepGuardOwner = null;
        }
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
  agentType: "tv",
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
    const deviceStates = await getTvAgentDeviceStates();
    msg += `Current device states:\n${JSON.stringify(
      deviceStates,
      null,
      2
    )}\n\n`;

    const skills = formatSkillSummaries(getAvailableSkills(deviceStates));
    if (skills) {
      msg += `${skills}\n\n`;
    }

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
    return getTvToolContext(session.id) as unknown as import("../core/types").ToolExecutionContext;
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

    // Check if device went to standby during the screenshot round-trip
    const wakeResult = await ensureDeviceAwake();
    let standbyWarning = "";
    if (wakeResult.woken) {
      console.log(
        `[TV Agent] Device was in standby when screenshot arrived — auto-woke, now: ${wakeResult.state}`
      );
      standbyWarning =
        "\n⚠️ IMPORTANT: The device went to STANDBY during the screenshot capture. " +
        "It has been automatically re-awakened (current state: " + wakeResult.state + "). " +
        "This screenshot likely shows a BLACK SCREEN because the TV was asleep when captured. " +
        "You MUST request a new screenshot before making any navigation decisions. " +
        "Do NOT interpret a black screenshot as a valid TV state.";
    }

    const finalBase64 = base64;
    const finalContentType = contentType;
    const observation = `Screenshot captured. Analyze the image to determine the next action.${standbyWarning}`;

    // Store latest screenshot so sub-agents (typing, navigation) can access it
    latestScreenshot = { base64: finalBase64, contentType: finalContentType };

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
