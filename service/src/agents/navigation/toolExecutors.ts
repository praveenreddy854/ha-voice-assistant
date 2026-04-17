/**
 * TV Navigation Agent Tool Executors
 * Implementation of all navigation tool execution handlers
 */

import {
  GoHomeArgs,
  GoBackArgs,
  NavigateArgs,
  FindSearchArgs,
  ClickSelectButtonArgs,
  GetLatestScreenshotArgs,
  WaitArgs,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types";
import { executeHACommand } from "../../ha";
import { delay } from "../common/utils";
import { TV_DEFAULT_WAIT_MS } from "../../config";

// ============================================================================
// Navigation Tool Executors
// ============================================================================

export async function executeGoHome(
  args: GoHomeArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(500, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = args.remote_entity_id.replace("remote.", "");
  const plainCommand = `Go home on ${deviceName}`;

  console.log(`[Nav Agent] Executing go_home: ${plainCommand}`);

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `❌ Failed to go home: ${result.message}. Try again or use an alternative approach.`;
    return { observation, needsScreenshot: false };
  }

  await delay(defaultWait);
  const observation = `✅ Successfully pressed HOME button on ${deviceName}.\n📍 Reason: ${args.reason}\n➡️ The TV should now show the home screen. Analyze the next screenshot to confirm.`;
  return { observation, needsScreenshot: true };
}

export async function executeGoBack(
  args: GoBackArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(500, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = args.remote_entity_id.replace("remote.", "");
  const plainCommand = `Go back on ${deviceName}`;

  console.log(`[Nav Agent] Executing go_back: ${plainCommand}`);

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `❌ Failed to go back: ${result.message}. Try again or use go_home to reset.`;
    return { observation, needsScreenshot: false };
  }

  await delay(defaultWait);
  const observation = `✅ Successfully pressed BACK button on ${deviceName}.\n📍 Reason: ${args.reason}\n➡️ The TV should now show the previous screen. Analyze the next screenshot to see current state.`;
  return { observation, needsScreenshot: true };
}

export async function executeNavigate(
  args: NavigateArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(300, TV_DEFAULT_WAIT_MS)
    : 1000;
  const count = Math.min(Math.max(args.count, 1), 10);

  const deviceName = args.remote_entity_id.replace("remote.", "");
  
  console.log(`[Nav Agent] Executing navigate: ${args.direction} x${count} on ${deviceName}`);

  // Execute navigation commands one at a time for reliability
  let successCount = 0;
  let lastError = "";

  for (let i = 0; i < count; i++) {
    const plainCommand = `Scroll ${args.direction} on ${deviceName}`;
    const result = await executeHACommand(plainCommand);
    
    if (result.success) {
      successCount++;
      // Small delay between presses for UI to update
      if (i < count - 1) {
        await delay(200);
      }
    } else {
      lastError = result.message;
      console.warn(`[Nav Agent] Navigation press ${i + 1}/${count} failed: ${lastError}`);
    }
  }

  // Wait for final UI update
  await delay(defaultWait);

  if (successCount === 0) {
    const observation = `❌ Failed to navigate ${args.direction}: ${lastError}. The UI may be unresponsive or the remote entity may be incorrect.`;
    return { observation, needsScreenshot: true };
  }

  if (successCount < count) {
    const observation = `⚠️ Partial navigation: Pressed ${args.direction.toUpperCase()} ${successCount}/${count} times on ${deviceName}.\n📍 Reason: ${args.reason}\n⚠️ Some commands failed, verify position in screenshot.`;
    return { observation, needsScreenshot: true };
  }

  const observation = `✅ Successfully navigated ${args.direction.toUpperCase()} ${count}x on ${deviceName}.\n📍 Reason: ${args.reason}\n➡️ Selection should have moved ${count} position(s) ${args.direction}. Check screenshot to verify new position.`;
  return { observation, needsScreenshot: true };
}

export async function executeClickSelectButton(
  args: ClickSelectButtonArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(500, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = args.remote_entity_id.replace("remote.", "");
  const plainCommand = `Select on ${deviceName}`;

  console.log(`[Nav Agent] Executing click_select: ${plainCommand}`);

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `❌ Failed to click select: ${result.message}. Try again or verify navigation position first.`;
    return { observation, needsScreenshot: true };
  }

  await delay(defaultWait);
  const observation = `✅ Successfully pressed SELECT/OK button on ${deviceName}.\n📍 Reason: ${args.reason}\n➡️ The highlighted item should now be activated. Check screenshot for result.`;
  return { observation, needsScreenshot: true };
}

export async function executeFindSearch(
  args: FindSearchArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const { screenshotBase64, screenshotContentType } = context;

  if (!screenshotBase64) {
    return {
      observation:
        "⚠️ No screenshot available for visual analysis. I need a screenshot to locate the search icon.\n" +
        "➡️ Use the navigate tool to move UP to reach the top menu bar (search is usually there), then verify with a screenshot.\n" +
        "💡 Common pattern: Search icon is typically in the top-left corner of streaming apps.",
      needsScreenshot: true,
    };
  }

  try {
    const { AI_MODEL_MINI } = await import("../../config");
    const { generateVisionText } = await import("../../ai");

    const visionModel = AI_MODEL_MINI || "gpt-4o";
    console.log(`[Nav Agent] Analyzing screenshot to find search icon using ${visionModel}...`);

    const analysisPrompt = `You are analyzing an image captured by a camera pointed at a smart TV. The image contains the TV screen along with surrounding room elements (walls, furniture, etc.).

CRITICAL: Focus ONLY on the TV screen content. Ignore everything outside the TV (room, furniture, reflections, etc.).

FIRST: Determine if content is currently playing on the TV:
- If you see a fullscreen video, movie, show, or video player UI -> content IS playing
- If you see a browse interface, menu, app home screen -> content is NOT playing

TASK: Locate the search icon/button and provide precise navigation instructions.

ANALYSIS STEPS:
1. Identify the TV screen boundaries in the image
2. Check if content/video is currently playing (fullscreen video, player controls visible, no navigation menu)
3. If content is playing, recommend pressing BACK first before navigation can work
4. Identify the current cursor/selection position (look for highlighted items with borders, different colors, or glow effects)
5. Locate the search icon (usually a magnifying glass 🔍) - typically in top-left corner or top navigation bar
6. Calculate exact navigation path from current position to search

COMMON APP LAYOUTS:
- YouTube: Search icon in top-left, navigation bar at top
- Netflix: Search in top navigation bar
- Prime Video: Search icon in top-left area
- Disney+: Search in top navigation
- Hulu: Search in top-left

OUTPUT FORMAT (JSON only):
{
  "content_playing": true/false,
  "content_playing_details": "what video/content appears to be playing, or 'none' if browse UI visible",
  "must_go_back_first": true/false,
  "search_found": true/false,
  "current_position": {
    "description": "what is currently highlighted",
    "row": "top/middle/bottom or specific row name",
    "estimated_column": number (0-based from left)
  },
  "search_position": {
    "description": "where search icon is located",
    "row": "top/middle/bottom or specific row name",
    "estimated_column": number (0-based from left)
  },
  "navigation_required": {
    "up": number (0-10),
    "down": number (0-10),
    "left": number (0-10),
    "right": number (0-10),
    "reasoning": "step by step explanation"
  },
  "confidence": "high/medium/low",
  "app_detected": "app name if identifiable",
  "alternative_suggestion": "what to do if search not visible or content is playing"
}

IMPORTANT:
- If content is playing, set must_go_back_first=true and provide guidance to exit player first
- Focus ONLY on the TV screen, ignore room elements
- Be conservative with navigation counts - better to under-navigate and verify
- If search is not visible, suggest how to get there (e.g., "go home first", "press back to exit player")
- Only return the JSON object, no additional text`;

    const content = await generateVisionText({
      model: visionModel,
      prompt: analysisPrompt,
      imageBase64: screenshotBase64,
      imageContentType: screenshotContentType || "image/jpeg",
      maxTokens: 500,
    });

    if (!content) {
      return {
        observation:
          "❌ No response from vision analysis. Try manual navigation to search.",
        needsScreenshot: false,
      };
    }

    console.log(`[Nav Agent] Vision analysis response:`, content);

    // Parse the JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        observation: `Vision analysis result: ${content}\n\n➡️ If search is visible, use navigate tool to reach it manually.`,
        needsScreenshot: false,
      };
    }

    let analysisResult;
    try {
      analysisResult = JSON.parse(jsonMatch[0]);
    } catch (parseError) {
      return {
        observation: `Could not parse vision analysis. Raw response: ${content}\n\n➡️ Try manual navigation to search.`,
        needsScreenshot: false,
      };
    }

    // Check if content is playing and we need to go back first
    if (analysisResult.content_playing || analysisResult.must_go_back_first) {
      const contentDetails = analysisResult.content_playing_details || "video/content";
      return {
        observation:
          `🎬 Content is currently playing on the TV: ${contentDetails}\n` +
          `⚠️ Navigation will NOT work while content is playing!\n` +
          `📍 App detected: ${analysisResult.app_detected || "unknown"}\n` +
          `\n🔧 ACTION REQUIRED: Press BACK button first to exit the player, then retry find_search.\n` +
          `💡 Use go_back tool with reason "to exit playing content before navigation"`,
        needsScreenshot: false,
      };
    }

    if (!analysisResult.search_found) {
      const suggestion = analysisResult.alternative_suggestion || "Try pressing HOME to get to main screen, then look for search.";
      return {
        observation:
          `❌ Search icon not found in current view.\n` +
          `📍 Current position: ${analysisResult.current_position?.description || "unknown"}\n` +
          `🎯 App detected: ${analysisResult.app_detected || "unknown"}\n` +
          `💡 Suggestion: ${suggestion}`,
        needsScreenshot: false,
      };
    }

    // Search found - execute navigation
    const nav = analysisResult.navigation_required || {};
    const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS) ? Math.max(300, TV_DEFAULT_WAIT_MS) : 800;
    const deviceName = args.remote_entity_id.replace("remote.", "");
    const navigationSteps: string[] = [];
    let navigationSuccess = true;

    console.log(`[Nav Agent] Executing navigation to search: up=${nav.up || 0}, down=${nav.down || 0}, left=${nav.left || 0}, right=${nav.right || 0}`);

    // Execute navigation in order: up/down first (to reach correct row), then left/right
    const directions: Array<{ dir: string; count: number }> = [
      { dir: "up", count: nav.up || 0 },
      { dir: "down", count: nav.down || 0 },
      { dir: "left", count: nav.left || 0 },
      { dir: "right", count: nav.right || 0 },
    ];

    for (const { dir, count } of directions) {
      if (count > 0) {
        for (let i = 0; i < count; i++) {
          const navCommand = `Scroll ${dir} on ${deviceName}`;
          const navResult = await executeHACommand(navCommand);
          if (!navResult.success) {
            console.warn(`[Nav Agent] Navigation ${dir} failed: ${navResult.message}`);
            navigationSuccess = false;
          }
          await delay(200);
        }
        navigationSteps.push(`${dir.toUpperCase()} x${count}`);
        await delay(defaultWait);
      }
    }

    // Press SELECT to activate search
    const selectCommand = `Select on ${deviceName}`;
    const selectResult = await executeHACommand(selectCommand);
    
    if (!selectResult.success) {
      return {
        observation:
          `⚠️ Navigation completed but failed to press SELECT.\n` +
          `🧭 Navigation path: ${navigationSteps.join(" → ") || "none needed"}\n` +
          `📍 Current position should be at search icon.\n` +
          `➡️ Try using click_select_button manually.`,
        needsScreenshot: true,
      };
    }

    await delay(defaultWait);

    const observation =
      `✅ Navigation to search completed!\n` +
      `🎯 App: ${analysisResult.app_detected || "detected app"}\n` +
      `🧭 Navigation: ${navigationSteps.join(" → ") || "already at search"} → SELECT\n` +
      `📍 From: ${analysisResult.current_position?.description || "previous position"}\n` +
      `📍 To: ${analysisResult.search_position?.description || "search icon"}\n` +
      `🔍 Confidence: ${analysisResult.confidence || "medium"}\n` +
      `⌨️ Search field should now be active and ready for text input.\n` +
      `➡️ Verify with screenshot that keyboard/search input is visible.`;

    return {
      observation,
      needsScreenshot: true,
    };
  } catch (error) {
    console.error("[Nav Agent] Error in find_search:", error);
    return {
      observation: `❌ Error during search navigation: ${error instanceof Error ? error.message : "Unknown error"}\n` +
        `➡️ Use manual navigation: UP to top menu, LEFT towards search icon, SELECT to activate.`,
      needsScreenshot: false,
    };
  }
}

export async function executeRequestScreenshot(
  args: GetLatestScreenshotArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  // Navigation agent signals it needs a screenshot
  // The parent TV agent or client will need to provide one
  const observation =
    `📸 Screenshot requested for: ${args.reason}\n` +
    `🎯 Media player: ${args.media_player_entity_id}\n` +
    `➡️ Waiting for fresh screenshot to analyze current TV state.`;

  return { observation, needsScreenshot: true };
}

export async function executeWait(
  args: WaitArgs
): Promise<ToolExecutionResult> {
  const duration = Math.min(Math.max(args.duration_ms ?? 1000, 100), 10000);
  
  console.log(`[Nav Agent] Waiting ${duration}ms: ${args.reason}`);
  await delay(duration);

  const observation = `⏱️ Waited ${duration}ms.\n📍 Reason: ${args.reason}\n➡️ Continue with next action.`;
  return { observation, needsScreenshot: false };
}
