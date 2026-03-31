/**
 * TV Typing Agent Tool Executors
 * Implementation of all typing tool execution handlers
 */

import {
  NavigateArgs,
  ClickSelectButtonArgs,
  TypeCharacterArgs,
  RequestScreenshotArgs,
  GoBackArgs,
  WaitArgs,
  AnalyzeKeyboardArgs,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types";
import { executeHACommand } from "../../ha";
import { delay } from "../common/utils";
import { TV_DEFAULT_WAIT_MS } from "../../config";

// ============================================================================
// Typing Tool Executors
// ============================================================================

export async function executeNavigate(
  args: NavigateArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1000;
  const count = Math.min(Math.max(args.count, 1), 10);

  const deviceName = args.remote_entity_id.replace("remote.", "");
  let plainCommand = "";

  if (count === 1) {
    plainCommand = `Scroll ${args.direction} on ${deviceName}`;
  } else {
    plainCommand = `Scroll ${args.direction} ${count} times on ${deviceName}`;
  }

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `❌ Failed to navigate ${args.direction}: ${result.message}`;
    return { observation, needsScreenshot: true };
  }

  await delay(defaultWait);
  const observation = `✅ Navigated ${args.direction} ${count}x on keyboard. ${args.reason}`;
  return { observation, needsScreenshot: true };
}

export async function executeClickSelectButton(
  args: ClickSelectButtonArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 800;

  const deviceName = args.remote_entity_id.replace("remote.", "");
  const plainCommand = `Select on ${deviceName}`;

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `❌ Failed to click select: ${result.message}`;
    return { observation, needsScreenshot: true };
  }

  await delay(defaultWait);
  const observation = `✅ Clicked select button. ${args.reason}`;
  return { observation, needsScreenshot: true };
}

export async function executeTypeCharacter(
  args: TypeCharacterArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 800;

  const deviceName = args.remote_entity_id.replace("remote.", "");
  const plainCommand = `Type "${args.character}" on ${deviceName}`;

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `❌ Failed to type character "${args.character}": ${result.message}`;
    return { observation, needsScreenshot: true };
  }

  await delay(defaultWait);
  const observation = `✅ Typed "${args.character}". ${args.reason}`;
  return { observation, needsScreenshot: true };
}

export async function executeRequestScreenshot(
  args: RequestScreenshotArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const observation =
    `📸 Screenshot requested for ${args.media_player_entity_id}.\n` +
    `📍 Reason: ${args.reason}\n` +
    `🎯 Context: Typing Agent (currently executing text input task)\n` +
    `➡️ The screenshot will be used to verify keyboard position and entered text.`;

  return { observation, needsScreenshot: true };
}

export async function executeGoBack(
  args: GoBackArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 800;

  const deviceName = args.remote_entity_id.replace("remote.", "");
  const plainCommand = `Go back on ${deviceName}`;

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `❌ Failed to go back/delete: ${result.message}`;
    return { observation, needsScreenshot: true };
  }

  await delay(defaultWait);
  const observation = `✅ Pressed back (backspace/delete). ${args.reason}`;
  return { observation, needsScreenshot: true };
}

export async function executeWait(args: WaitArgs): Promise<ToolExecutionResult> {
  const duration = args.duration_ms ?? 500;
  await delay(duration);

  const observation = `⏱️ Waited ${duration}ms. ${args.reason}`;
  return { observation, needsScreenshot: false };
}

export async function executeAnalyzeKeyboard(
  args: AnalyzeKeyboardArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const { screenshotBase64, screenshotContentType } = context;

  if (!screenshotBase64) {
    return {
      observation:
        "⚠️ No screenshot available. Please call request_screenshot first to capture the current TV screen with the keyboard, then call analyze_keyboard again.",
      needsScreenshot: true,
    };
  }

  try {
    const { AI_MODEL_MINI } = await import("../../config");
    const { generateVisionText } = await import("../../ai");

    const visionModel = AI_MODEL_MINI || "gpt-5.1-mini";
    console.log(
      `[Typing Agent] Analyzing keyboard layout using ${visionModel}...`
    );

    const prompt = `Analyze this TV on-screen keyboard screenshot. I need to type: "${args.target_text}"

Please identify:
1. KEYBOARD TYPE: Is this a QWERTY keyboard, alphabetical (A-Z in order), or other layout?
2. CURRENT POSITION: Where is the cursor/highlight currently positioned? (describe the character or button)
3. ALREADY TYPED: What text, if any, has already been entered in the search/input field?
4. REMAINING TEXT: What characters still need to be typed?
5. NAVIGATION PLAN: For each remaining character, describe the navigation steps needed (up/down/left/right) from the current position.

Provide a clear, actionable response focusing on the most efficient navigation path to type the remaining characters.`;

    const analysisResult = await generateVisionText({
      model: visionModel,
      prompt,
      imageBase64: screenshotBase64,
      imageContentType: screenshotContentType || "image/png",
      maxTokens: 1000,
    });

    const observation =
      `🔍 Keyboard Analysis Complete:\n\n${analysisResult || "Unable to analyze keyboard."}\n\n` +
      `🎯 Target text: "${args.target_text}"`;

    return { observation, needsScreenshot: false };
  } catch (error) {
    console.error("[Typing Agent] Error analyzing keyboard:", error);
    return {
      observation: `❌ Error analyzing keyboard: ${
        error instanceof Error ? error.message : "Unknown error"
      }. Try navigating manually based on common keyboard layouts.`,
      needsScreenshot: false,
    };
  }
}
