/**
 * TV Agent Tool Executors
 * Implementation of all tool execution handlers for the TV automation agent
 */

import {
  ClickPowerButtonArgs,
  MediaControlArgs,
  ClickSelectButtonArgs,
  OpenMenuArgs,
  DelegateToTypingArgs,
  RequestScreenshotArgs,
  GetDeviceStateArgs,
  LaunchAppArgs,
  DelegateToNavigationArgs,
  WaitArgs,
  RetrieveSimilarFlowsArgs,
  AnalyzeScreenshotArgs,
  VerifyUIStateArgs,
  TvToolName,
  TvToolArguments,
} from "./types";
import { getKnownDeviceStates, executeHACommand } from "../../ha";
import { delay } from "../common/utils";
import { TV_DEFAULT_WAIT_MS, TV_AGENT_DEVICES } from "../../config";
import {
  runNavigationAgent,
} from "../navigation";
import { runTypingAgent } from "../typing";
import { retrieveSimilarTvFlows } from "./flowMemory";

// ============================================================================
// Plain English Command Processing
// ============================================================================
// All TV control commands are now processed as plain English through the
// executeHACommand function which converts them to appropriate HA API calls

// ============================================================================
// Tool Execution Handlers
// ============================================================================

export interface ToolExecutionContext {
  homeAssistantUrl: string;
  homeAssistantToken: string;
  screenshotBase64?: string;
  screenshotContentType?: string;
  sessionId?: string; // Current TV agent session ID for context
  activeAgent?: "tv" | "navigation"; // Which agent is actively executing
}

export interface ToolExecutionResult {
  observation: string;
  needsScreenshot: boolean;
  toolSuccess?: boolean;
  appUiContext?: {
    appName?: string;
    layoutType?: string;
    selectionPosition?: string;
    navigationLandmarks?: string[];
  };
}

function pickFirstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
}

function extractAppUiContext(payload: unknown): ToolExecutionResult["appUiContext"] {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }

  const parsed = payload as Record<string, unknown>;

  const appName = pickFirstString(
    parsed.app_name,
    parsed.current_app,
    parsed.app_detected
  );
  const layoutType = pickFirstString(
    parsed.layout_type,
    parsed.screen_type,
    parsed.current_state_type
  );
  const selectionPosition = pickFirstString(
    parsed.selection_position,
    parsed.selected_item,
    parsed.current_position && typeof parsed.current_position === "object"
      ? (parsed.current_position as Record<string, unknown>).description
      : undefined
  );
  const navigationLandmarks = [
    ...normalizeStringArray(parsed.navigation_landmarks),
    ...normalizeStringArray(parsed.ui_elements),
  ];

  if (!appName && !layoutType && !selectionPosition && navigationLandmarks.length === 0) {
    return undefined;
  }

  return {
    appName,
    layoutType,
    selectionPosition,
    navigationLandmarks,
  };
}

export async function executeClickPowerButton(
  args: ClickPowerButtonArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = args.remote_entity_id.replace("remote.", "");
  const plainCommand = `Turn on ${deviceName}`;

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `Failed to execute "${plainCommand}": ${result.message}`;
    return { observation, needsScreenshot: false };
  }

  await delay(defaultWait);

  // Get device state to verify power status
  const deviceStates = (await getKnownDeviceStates()).filter((d) =>
    d.entity_id.includes(deviceName)
  );
  const observation = `Successfully executed "${plainCommand}". ${
    args.reason
  }. Device states: ${JSON.stringify(
    deviceStates.map((s) => ({
      entity_id: s.entity_id,
      state: s.state,
    }))
  )}`;

  return { observation, needsScreenshot: false };
}

export async function executeMediaControl(
  args: MediaControlArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = args.remote_entity_id.replace("remote.", "");
  let plainCommand = "";

  // Map media control actions to natural language commands
  switch (args.action) {
    case "play":
      plainCommand = `Play on ${deviceName}`;
      break;
    case "pause":
      plainCommand = `Pause on ${deviceName}`;
      break;
    case "stop":
      plainCommand = `Stop on ${deviceName}`;
      break;
    case "rewind":
      plainCommand = `Rewind on ${deviceName}`;
      break;
    case "fast_forward":
      plainCommand = `Fast forward on ${deviceName}`;
      break;
    case "volume_up":
      plainCommand = `Increase volume on ${deviceName}`;
      break;
    case "volume_down":
      plainCommand = `Decrease volume on ${deviceName}`;
      break;
    case "mute":
      plainCommand = `Mute ${deviceName}`;
      break;
    case "unmute":
      plainCommand = `Unmute ${deviceName}`;
      break;
    case "next":
      plainCommand = `Next on ${deviceName}`;
      break;
    case "previous":
      plainCommand = `Previous on ${deviceName}`;
      break;
    case "skip_forward":
      plainCommand = `Skip forward on ${deviceName}`;
      break;
    case "skip_backward":
      plainCommand = `Skip backward on ${deviceName}`;
      break;
    default:
      plainCommand = `${args.action} on ${deviceName}`;
  }

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `Failed to execute "${plainCommand}": ${result.message}`;
    return { observation, needsScreenshot: false };
  }

  await delay(defaultWait);

  // Get device state to verify media control
  const deviceStates = (await getKnownDeviceStates()).filter((d) =>
    d.entity_id.includes(deviceName)
  );
  const observation = `Successfully executed "${plainCommand}". ${
    args.reason
  }. Device states: ${JSON.stringify(
    deviceStates.map((s) => ({
      entity_id: s.entity_id,
      state: s.state,
      attributes: s.attributes,
    }))
  )}`;

  return { observation, needsScreenshot: false };
}

export async function executeClickSelectButton(
  args: ClickSelectButtonArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = args.remote_entity_id.replace("remote.", "");
  const plainCommand = `Select on ${deviceName}`;

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `Failed to execute "${plainCommand}": ${result.message}`;
    return { observation, needsScreenshot: false };
  }

  await delay(defaultWait);
  const observation = `Successfully executed "${plainCommand}". ${args.reason}`;
  return { observation, needsScreenshot: false };
}

export async function executeOpenMenu(
  args: OpenMenuArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = args.remote_entity_id.replace("remote.", "");
  const plainCommand = `Open menu on ${deviceName}`;

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `Failed to execute "${plainCommand}": ${result.message}`;
    return { observation, needsScreenshot: false };
  }

  await delay(defaultWait);
  const observation = `Successfully executed "${plainCommand}". ${args.reason}`;
  return { observation, needsScreenshot: false };
}

export async function executeDelegateToTyping(
  args: DelegateToTypingArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  console.log(
    `[TV Agent] Delegating to Typing Agent: "${args.text_to_type}"`
  );

  try {
    // Delegate to Typing Agent's full agentic flow
    // Pass screenshot data if available for visual context
    const result = await runTypingAgent({
      userMessage: `Type the text "${args.text_to_type}" into the focused input field. ${args.reason}`,
      textToType: args.text_to_type,
      deviceConfig: {
        remoteEntityId: args.remote_entity_id,
        mediaPlayerEntityId: args.media_player_entity_id,
      },
      screenshotBase64: context.screenshotBase64,
      screenshotContentType: context.screenshotContentType,
      maxIterations: 15, // Text input may need more iterations for longer text
    });

    if (!result.success) {
      return {
        observation: `❌ Typing Agent failed: ${result.message}\nTarget text: "${args.text_to_type}"`,
        needsScreenshot: true, // May need screenshot to understand what went wrong
      };
    }

    // Extract last step observation or use final message
    const lastStep = result.steps[result.steps.length - 1];
    const stepObservation = lastStep?.observation || result.message;

    const observation =
      `⌨️ Typing Agent completed:\n` +
      `📝 Text typed: "${args.text_to_type}"\n` +
      `${stepObservation}\n` +
      `${args.reason}`;

    return {
      observation,
      needsScreenshot: true, // Always verify text input with screenshot
    };
  } catch (error) {
    console.error("[TV Agent] Typing delegation error:", error);
    return {
      observation: `❌ Typing delegation failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }\nTarget text: "${args.text_to_type}"`,
      needsScreenshot: false,
    };
  }
}

export async function executeRequestScreenshot(
  args: RequestScreenshotArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  // Determine target agent based on args or context
  let targetAgent: "tv" | "navigation" = "tv";
  let routingReason = "";

  if (args.target_agent === "navigation") {
    targetAgent = "navigation";
    routingReason = " (explicitly routed to navigation agent)";
  } else if (args.target_agent === "tv") {
    targetAgent = "tv";
    routingReason = " (explicitly routed to TV agent)";
  } else {
    // Auto mode (default): check context to determine active agent
    if (context.activeAgent === "navigation") {
      targetAgent = "navigation";
      routingReason =
        " (auto-routed to navigation agent based on active delegation)";
    } else {
      targetAgent = "tv";
      routingReason =
        " (auto-routed to TV agent - no active navigation delegation)";
    }
  }

  const observation =
    `📸 Screenshot requested: ${args.reason}\n` +
    `🎯 Target Agent: ${targetAgent}${routingReason}\n` +
    `➡️ The screenshot will be delivered to the ${targetAgent} agent in the next tool response.`;

  return { observation, needsScreenshot: true };
}

export async function executeGetDeviceState(
  args: GetDeviceStateArgs
): Promise<ToolExecutionResult> {
  const allDeviceStates = await getKnownDeviceStates();
  let deviceStates;
  let observationPrefix;

  if (args.device_name) {
    // Get all entities related to the specified device name
    // This includes both remote.* and media_player.* entities for the device
    deviceStates = allDeviceStates.filter((s) => {
      const entityParts = s.entity_id.split(".");
      if (entityParts.length < 2) return false;

      const deviceNameFromEntity = entityParts[1];
      return deviceNameFromEntity === args.device_name;
    });

    observationPrefix = `Device states for ${args.device_name}`;

    if (deviceStates.length === 0) {
      // Get available device names from TV_AGENT_DEVICES for error message
      const availableDevices = allDeviceStates
        .filter((s) => TV_AGENT_DEVICES.includes(s.entity_id.split(".")[1]))
        .map((s) => s.entity_id.split(".")[1])
        .filter((name, index, arr) => arr.indexOf(name) === index) // Remove duplicates
        .join(", ");

      return {
        observation: `Device with name '${args.device_name}' not found. Available device names: ${availableDevices}`,
        needsScreenshot: false,
      };
    }
  } else {
    // Get only TV-related device states when no specific device_name provided
    deviceStates = allDeviceStates.filter((s) =>
      TV_AGENT_DEVICES.includes(s.entity_id.split(".")[1])
    );
    observationPrefix = "TV device states";
  }

  const observation = `${observationPrefix} retrieved: ${JSON.stringify(
    deviceStates.map((s) => ({
      entity_id: s.entity_id,
      state: s.state,
      attributes: s.attributes,
    })),
    null,
    2
  )}`;
  return { observation, needsScreenshot: false };
}

export async function executeLaunchApp(
  args: LaunchAppArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;

  // Create a simple, natural plain English command for launching apps
  const deviceName = args.media_player_entity_id.replace("media_player.", "");
  const plainCommand = `Launch ${args.app_name} on ${deviceName}`;

  // Execute the command using the HA command processor
  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `Failed to launch ${args.app_name}: ${result.message}`;
    return { observation, needsScreenshot: false };
  }

  // Wait for the app to launch
  await delay(defaultWait);

  // Get device state to verify if the app launched successfully
  const allDeviceStates = await getKnownDeviceStates();
  const mediaPlayerStates = allDeviceStates.filter(
    (s) => s.entity_id === args.media_player_entity_id
  );

  let appLaunchStatus = "unknown";
  let currentApp = "unknown";
  let deviceState = "unknown";

  if (mediaPlayerStates.length > 0) {
    const mediaPlayer = mediaPlayerStates[0];
    deviceState = mediaPlayer.state;

    // Check various attributes that might contain app information
    const attributes = mediaPlayer.attributes || {};
    currentApp =
      attributes.app_name ||
      attributes.media_title ||
      attributes.source ||
      attributes.app_id ||
      "unknown";

    // Determine if the requested app is currently active
    if (currentApp && typeof currentApp === "string") {
      const normalizedCurrentApp = currentApp.toLowerCase();
      const normalizedRequestedApp = args.app_name.toLowerCase();

      if (
        normalizedCurrentApp.includes(normalizedRequestedApp) ||
        normalizedRequestedApp.includes(normalizedCurrentApp)
      ) {
        appLaunchStatus = "success";
      } else {
        appLaunchStatus = "different_app";
      }
    }
  }

  // Create detailed observation based on verification results
  let observation = `App "${args.app_name}" launch command sent to ${args.media_player_entity_id}. `;

  if (appLaunchStatus === "success") {
    observation += `✅ SUCCESS: ${args.app_name} is now active on the device.`;
  } else if (appLaunchStatus === "different_app") {
    observation += `⚠️ PARTIAL: Launch command sent, but device shows "${currentApp}" instead of "${args.app_name}". Device state: ${deviceState}.`;
  } else {
    observation += `❓ UNKNOWN: Launch command sent, but unable to verify app status. Device state: ${deviceState}, Current app: ${currentApp}.`;
  }

  observation += ` ${args.reason}`;

  // Include device state details for debugging
  if (mediaPlayerStates.length > 0) {
    observation += ` Device details: ${JSON.stringify({
      entity_id: mediaPlayerStates[0].entity_id,
      state: mediaPlayerStates[0].state,
      attributes: {
        app_name: mediaPlayerStates[0].attributes?.app_name,
        media_title: mediaPlayerStates[0].attributes?.media_title,
        source: mediaPlayerStates[0].attributes?.source,
        app_id: mediaPlayerStates[0].attributes?.app_id,
      },
    })}`;
  }

  return { observation, needsScreenshot: false };
}

export async function executeDelegateToNavigation(
  args: DelegateToNavigationArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  console.log(
    `[TV Agent] Delegating to Navigation Agent: ${args.task_description}`
  );
  console.log(`[TV Agent] Screenshot available: ${!!context.screenshotBase64}`);

  try {
    // Delegate to Navigation Agent's full agentic flow
    // The navigation agent has comprehensive instructions to handle any task
    // Pass screenshot data if available for visual context
    const result = await runNavigationAgent({
      userMessage: args.task_description,
      deviceConfig: {
        remoteEntityId: args.remote_entity_id,
        mediaPlayerEntityId: args.media_player_entity_id,
      },
      screenshotBase64: context.screenshotBase64,
      screenshotContentType: context.screenshotContentType,
      maxIterations: 10, // Increase iterations for complex navigation
    });

    console.log(`[TV Agent] Navigation Agent result: success=${result.success}, steps=${result.steps.length}`);

    if (!result.success) {
      // Provide detailed failure information
      const stepSummary = result.steps
        .map((s, i) => `  ${i + 1}. ${s.toolName}: ${s.observation?.substring(0, 100)}...`)
        .join("\n");
      
      return {
        observation: 
          `❌ Navigation Agent failed after ${result.steps.length} steps.\n` +
          `📋 Task: ${args.task_description}\n` +
          `❗ Error: ${result.message}\n` +
          `📝 Steps attempted:\n${stepSummary}\n` +
          `💡 Suggestion: Try a different approach or request a screenshot to assess the current state.`,
        needsScreenshot: true,
      };
    }

    // Extract useful information from all steps
    const stepSummary = result.steps
      .filter(s => s.observation && !s.observation.startsWith("⏱️"))
      .map(s => `• ${s.toolName}: ${s.observation?.split("\n")[0] || "completed"}`)
      .slice(-3) // Last 3 meaningful steps
      .join("\n");

    const observation =
      `✅ Navigation Agent completed successfully!\n` +
      `📋 Task: ${args.task_description}\n` +
      `📍 Reason: ${args.reason}\n` +
      `🔄 Steps completed: ${result.steps.length}\n` +
      `📝 Recent actions:\n${stepSummary}\n` +
      `🎯 Result: ${result.message}`;

    return {
      observation,
      needsScreenshot: true, // Always verify navigation results with screenshot
    };
  } catch (error) {
    console.error("[TV Agent] Navigation delegation error:", error);
    return {
      observation: 
        `❌ Navigation delegation failed with error.\n` +
        `📋 Task: ${args.task_description}\n` +
        `❗ Error: ${error instanceof Error ? error.message : "Unknown error"}\n` +
        `💡 Try using direct navigation tools or request a screenshot first.`,
      needsScreenshot: true,
    };
  }
}

export async function executeWait(args: WaitArgs): Promise<ToolExecutionResult> {
  const duration = args.duration_ms && args.duration_ms > 0 ? args.duration_ms : TV_DEFAULT_WAIT_MS;
  
  await delay(duration);
  
  return {
    observation: `⏱️ Waited ${duration}ms. ${args.reason}`,
    needsScreenshot: false,
  };
}

export async function executeRetrieveSimilarFlows(
  args: RetrieveSimilarFlowsArgs
): Promise<ToolExecutionResult> {
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  const { flows, usedFallbackPartials } = await retrieveSimilarTvFlows({
    currentGoal: args.current_goal,
    currentContext: args.current_context,
    limit,
  });

  if (!flows.length) {
    return {
      observation:
        `📚 No relevant TV flow memory found for current goal.\n` +
        `Goal: ${args.current_goal}\n` +
        `Reason: ${args.reason}\n` +
        `Proceed with fresh reasoning and request screenshots for verification.`,
      needsScreenshot: false,
      toolSuccess: true,
    };
  }

  const payload = {
    goal: args.current_goal,
    reason: args.reason,
    totalReturned: flows.length,
    usedFallbackPartials,
    flows,
  };

  return {
    observation: `📚 Retrieved similar TV flows:\n${JSON.stringify(payload, null, 2)}`,
    needsScreenshot: false,
    toolSuccess: true,
  };
}

export async function executeAnalyzeScreenshot(
  args: AnalyzeScreenshotArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const { screenshotBase64, screenshotContentType } = context;

  if (!screenshotBase64) {
    return {
      observation:
        "⚠️ No screenshot available. Please call request_screenshot first to capture the current TV screen.",
      needsScreenshot: true,
      toolSuccess: false,
    };
  }

  try {
    const { AI_MODEL_MINI } = await import("../../config");
    const { generateVisionText } = await import("../../ai");

    const visionModel = AI_MODEL_MINI || "gpt-4o-mini";
    console.log(
      `[TV Agent] Analyzing screenshot with query: "${args.query}" using ${visionModel}...`
    );

    const analysisPrompt = `You are analyzing an image captured by a camera pointed at a smart TV. The image contains the TV screen along with surrounding room elements (walls, furniture, ambient lighting, etc.).

CRITICAL: Focus ONLY on the content displayed on the TV screen. Completely ignore everything outside the TV boundaries (room, furniture, reflections, decorations, etc.).
CRITICAL: Do NOT describe or depend on dynamic content titles/names. Use stable UI structure only.

USER QUERY: "${args.query}"

FIRST - Detect if content is actively playing:
- Fullscreen video/movie/show playing = content IS playing
- Browse UI, menus, app home screens = content NOT playing
- Video player controls visible (play/pause, progress bar) = content IS playing

Provide a detailed analysis in JSON format:
{
  "tv_screen_identified": true/false,
  "content_playing": true/false,
  "content_playing_type": "video/movie/show/music/none",
  "must_exit_player_first": true/false,
  "app_name": "app shell name if identifiable (YouTube, Netflix, Home, etc.)",
  "layout_type": "home/search/results/video_player/menu/profile_picker/etc",
  "row_column_structure": "stable description like '3 content rows with left navigation rail'",
  "navigation_landmarks": ["stable UI landmarks like profile icon, search icon, home tab, left rail, top tabs"],
  "selection_position": "stable position text such as 'row 1 column 1' or 'left rail item 1 selected'",
  "screen_type": "type of screen (home, search, video_player, browse, menu, etc.)",
  "ui_elements": ["stable UI elements only, no dynamic title text"],
  "selected_item": "describe highlighted element by position/type, not by content title",
  "keyboard_visible": true/false,
  "answer": "direct answer to the query",
  "suggested_actions": ["list of suggested next actions based on current structure"],
  "navigation_hints": "hints for navigating to desired elements"
}

IMPORTANT:
- If content is playing, recommend pressing BACK before attempting navigation
- Only analyze what's ON the TV screen
- Ignore any room elements, reflections, or items outside the TV
- Never output dynamic content titles as evidence`;

    const content = await generateVisionText({
      model: visionModel,
      prompt: analysisPrompt,
      imageBase64: screenshotBase64,
      imageContentType: screenshotContentType || "image/jpeg",
      maxTokens: 500,
    });

    if (!content) {
      return {
        observation: "❌ No response from vision model for screenshot analysis.",
        needsScreenshot: false,
        toolSuccess: false,
      };
    }

    console.log(`[TV Agent] Screenshot analysis result:`, content);

    // Try to parse JSON response
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const analysis = JSON.parse(jsonMatch[0]);
        return {
          observation: `🔍 Screenshot Analysis:\n${JSON.stringify(
            analysis,
            null,
            2
          )}\n\nQuery: ${args.query}\nReason: ${args.reason}`,
          needsScreenshot: false,
          toolSuccess: true,
          appUiContext: extractAppUiContext(analysis),
        };
      }
    } catch (parseError) {
      // If JSON parsing fails, return raw content
    }

    return {
      observation: `🔍 Screenshot Analysis:\n${content}\n\nQuery: ${args.query}\nReason: ${args.reason}`,
      needsScreenshot: false,
      toolSuccess: true,
    };
  } catch (error) {
    console.error("[TV Agent] Screenshot analysis error:", error);
    return {
      observation: `❌ Screenshot analysis failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }
}

export async function executeVerifyUIState(
  args: VerifyUIStateArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const { screenshotBase64, screenshotContentType } = context;

  if (!screenshotBase64) {
    return {
      observation:
        "⚠️ No screenshot available. Please call request_screenshot first to capture the current TV screen.",
      needsScreenshot: true,
      toolSuccess: false,
    };
  }

  try {
    const { AI_MODEL_MINI } = await import("../../config");
    const { generateVisionText } = await import("../../ai");

    const visionModel = AI_MODEL_MINI || "gpt-4o-mini";
    console.log(
      `[TV Agent] Verifying UI state: "${args.expected_state}" using ${visionModel}...`
    );

    const verificationPrompt = `You are analyzing an image captured by a camera pointed at a smart TV. The image contains the TV screen along with surrounding room elements.

CRITICAL: Focus ONLY on the content displayed on the TV screen. Completely ignore everything outside the TV (room, furniture, reflections, etc.).
CRITICAL: Verify using stable UI structure cues only. Do NOT rely on dynamic content titles.

VERIFY THIS STATE: "${args.expected_state}"

FIRST - Check if content is actively playing on the TV:
- If video/movie/show is playing fullscreen -> navigation commands won't work, need to press BACK first
- If browse UI or menu is visible -> navigation is possible

Return a JSON object with:
{
  "tv_screen_identified": true/false,
  "content_playing": true/false,
  "must_exit_player_first": true/false,
  "verified": true/false,
  "confidence": "high/medium/low",
  "app_name": "app shell name if identifiable",
  "layout_type": "home/search/results/video_player/menu/profile_picker/etc",
  "selection_position": "stable selected position description (e.g., row/column/index)",
  "navigation_landmarks": ["stable landmarks like search icon, profile icon, left rail, top tabs"],
  "current_state": "stable structure-centric description of what is visible on TV screen",
  "match_details": "explanation of why it matches or doesn't match",
  "keyboard_visible": true/false,
  "recommendations": "if not verified, what needs to happen to reach expected state (include 'press back to exit player' if content is playing)"
}

IMPORTANT:
- Base your verification ONLY on what's displayed on the TV screen, not room elements
- Avoid dynamic content title references in evidence`;

    const content = await generateVisionText({
      model: visionModel,
      prompt: verificationPrompt,
      imageBase64: screenshotBase64,
      imageContentType: screenshotContentType || "image/jpeg",
      maxTokens: 400,
    });

    if (!content) {
      return {
        observation: "❌ No response from vision model for UI verification.",
        needsScreenshot: false,
        toolSuccess: false,
      };
    }

    console.log(`[TV Agent] UI verification result:`, content);

    // Try to parse JSON response
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const verification = JSON.parse(jsonMatch[0]);
        const status = verification.verified ? "✅ VERIFIED" : "❌ NOT VERIFIED";
        return {
          observation: `${status}: ${args.expected_state}\n\n${JSON.stringify(
            verification,
            null,
            2
          )}\n\nReason: ${args.reason}`,
          needsScreenshot: false,
          toolSuccess: Boolean(verification.verified),
          appUiContext: extractAppUiContext(verification),
        };
      }
    } catch (parseError) {
      // If JSON parsing fails, return raw content
    }

    return {
      observation: `🔍 UI State Verification:\n${content}\n\nExpected: ${args.expected_state}\nReason: ${args.reason}`,
      needsScreenshot: false,
      toolSuccess: true,
    };
  } catch (error) {
    console.error("[TV Agent] UI state verification error:", error);
    return {
      observation: `❌ UI state verification failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }
}

export async function executeTool(
  toolName: TvToolName,
  args: TvToolArguments,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  console.log(`[TV Agent] Executing tool: ${toolName}`, args);

  switch (toolName) {
    case "click_power_button":
      return await executeClickPowerButton(
        args as ClickPowerButtonArgs,
        context
      );
    case "media_control":
      return await executeMediaControl(args as MediaControlArgs, context);
    case "click_select_button":
      return await executeClickSelectButton(
        args as ClickSelectButtonArgs,
        context
      );
    case "open_menu":
      return await executeOpenMenu(args as OpenMenuArgs, context);
    case "delegate_to_typing":
      return await executeDelegateToTyping(args as DelegateToTypingArgs, context);
    case "request_screenshot":
      return await executeRequestScreenshot(
        args as RequestScreenshotArgs,
        context
      );
    case "get_device_state":
      return await executeGetDeviceState(args as GetDeviceStateArgs);
    case "launch_app":
      return await executeLaunchApp(args as LaunchAppArgs, context);
    case "delegate_to_navigation":
      return await executeDelegateToNavigation(
        args as DelegateToNavigationArgs,
        context
      );
    case "retrieve_similar_flows":
      return await executeRetrieveSimilarFlows(
        args as RetrieveSimilarFlowsArgs
      );
    case "analyze_screenshot":
      return await executeAnalyzeScreenshot(
        args as AnalyzeScreenshotArgs,
        context
      );
    case "verify_ui_state":
      return await executeVerifyUIState(args as VerifyUIStateArgs, context);
    case "wait":
      return await executeWait(args as WaitArgs);
    default:
      throw new Error(`Unsupported tool: ${toolName}`);
  }
}

// All TV control commands are now handled by the specialized tool functions above.
// The legacy executePerformAction function has been removed as it's no longer needed.
