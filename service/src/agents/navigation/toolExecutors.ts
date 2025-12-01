/**
 * TV Navigation Agent Tool Executors
 * Implementation of all navigation tool execution handlers
 */

import {
  GoHomeArgs,
  GoBackArgs,
  NavigateArgs,
  FindSearchArgs,
  RequestScreenshotArgs,
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
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = args.remote_entity_id.replace("remote.", "");
  const plainCommand = `Go home on ${deviceName}`;

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `❌ Failed to go home: ${result.message}`;
    return { observation, needsScreenshot: false };
  }

  await delay(defaultWait);
  const observation = `✅ Successfully navigated to home screen. ${args.reason}`;
  return { observation, needsScreenshot: true }; // Request screenshot to verify home screen
}

export async function executeGoBack(
  args: GoBackArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = args.remote_entity_id.replace("remote.", "");
  const plainCommand = `Go back on ${deviceName}`;

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    const observation = `❌ Failed to go back: ${result.message}`;
    return { observation, needsScreenshot: false };
  }

  await delay(defaultWait);
  const observation = `✅ Successfully went back. ${args.reason}`;
  return { observation, needsScreenshot: true }; // Request screenshot to verify previous screen
}

export async function executeNavigate(
  args: NavigateArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;
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
  const observation = `✅ Successfully navigated ${args.direction} ${count}x. ${args.reason}`;
  return { observation, needsScreenshot: true }; // Always request screenshot after navigation
}

export async function executeFindSearch(
  args: FindSearchArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const { screenshotBase64, screenshotContentType } = context;

  if (!screenshotBase64) {
    return {
      observation:
        "⚠️ No screenshot available. Please call request_screenshot first to capture the current TV screen, then call find_search again.",
      needsScreenshot: true,
    };
  }

  try {
    // Use OpenAI vision to analyze the screenshot and find the search icon
    const { AzureOpenAI } = await import("openai");
    const {
      OPEN_AI_BASE_URL,
      API_KEY,
      OPENAI_RESPONSES_API_VERSION,
      AZURE_AI_AGENT_MODEL,
    } = await import("../../config");

    const visionModel = AZURE_AI_AGENT_MODEL || "gpt-5-mini";
    console.log(
      `[Nav Agent] Analyzing screenshot to find search icon using ${visionModel}...`
    );

    const client = new AzureOpenAI({
      baseURL: OPEN_AI_BASE_URL,
      apiKey: API_KEY,
      apiVersion: OPENAI_RESPONSES_API_VERSION,
    });

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Analyze this TV/streaming app screenshot and locate the search icon, search button, or search field.

IMPORTANT CONTEXT:
- YouTube: Search icon (magnifying glass) is typically in the TOP-LEFT corner of the screen
- Netflix: Search icon is usually in the TOP navigation bar
- Apple TV: Search is often in the TOP row of apps or in the TOP menu
- Most apps: Search is in the TOP-LEFT or TOP-RIGHT area

Analyze the current cursor/selection position (look for highlighted items, borders, or different colors).

Return a JSON object with precise navigation instructions:
{
  "found": true/false,
  "location": "exact description (e.g., 'top-left corner, first icon', 'top row, third item from left')",
  "current_position": "where the cursor/selection currently is",
  "navigation": {
    "up": <number 0-10> (how many times to press UP to reach search),
    "down": <number 0-10> (DOWN presses needed),
    "left": <number 0-10> (LEFT presses needed),
    "right": <number 0-10> (RIGHT presses needed)
  },
  "confidence": "high/medium/low",
  "reasoning": "explain the navigation path"
}

If search is not visible:
{
  "found": false,
  "suggestion": "specific action to take (e.g., 'go home first', 'scroll up to top bar', 'try going left')"
}`,
          },
          {
            type: "image_url",
            image_url: {
              url: `data:${screenshotContentType};base64,${screenshotBase64}`,
            },
          },
        ],
      },
    ];

    let response = await client.responses.create({
      model: visionModel,
      input: JSON.stringify({
        messages,
        max_tokens: 300,
        temperature: 0.1,
      }),
    });

    // Poll until response is complete
    while (response.status === "queued" || response.status === "in_progress") {
      await delay(50);
      response = await client.responses.retrieve(response.id);
    }

    if (response.status === "failed") {
      console.error(
        `[Nav Agent] Search icon detection failed: ${
          response.error || "Unknown error"
        }`
      );
      return {
        observation:
          "❌ Failed to analyze screenshot for search icon. Please try manual navigation with the navigate tool.",
        needsScreenshot: false,
      };
    }

    const content = response.output_text;
    if (!content) {
      return {
        observation:
          "❌ No response from vision model. Please try manual navigation.",
        needsScreenshot: false,
      };
    }

    console.log(`[Nav Agent] Search icon analysis response:`, content);

    // Parse the JSON response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        observation: `Vision model response: ${content}. Try manual navigation with the navigate tool.`,
        needsScreenshot: false,
      };
    }

    const result = JSON.parse(jsonMatch[0]);

    if (!result.found) {
      const observation =
        `❌ Search icon not found in current view.\n` +
        `💡 Suggestion: ${
          result.suggestion ||
          "Try using go_home first, then call find_search again."
        }`;

      return {
        observation,
        needsScreenshot: false,
      };
    }

    // Search icon found - now navigate to it
    console.log(
      `[Nav Agent] Search icon found at ${result.location}, navigating...`
    );

    const navigation = result.navigation || {};
    let navigationSteps: string[] = [];
    const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
      ? Math.max(250, TV_DEFAULT_WAIT_MS)
      : 1500;

    // Execute navigation commands
    if (navigation.up && navigation.up > 0) {
      const upCommand = `Scroll up ${
        navigation.up
      } times on ${args.remote_entity_id.replace("remote.", "")}`;
      await executeHACommand(upCommand);
      navigationSteps.push(`up ${navigation.up}x`);
      await delay(defaultWait);
    }

    if (navigation.down && navigation.down > 0) {
      const downCommand = `Scroll down ${
        navigation.down
      } times on ${args.remote_entity_id.replace("remote.", "")}`;
      await executeHACommand(downCommand);
      navigationSteps.push(`down ${navigation.down}x`);
      await delay(defaultWait);
    }

    if (navigation.left && navigation.left > 0) {
      const leftCommand = `Scroll left ${
        navigation.left
      } times on ${args.remote_entity_id.replace("remote.", "")}`;
      await executeHACommand(leftCommand);
      navigationSteps.push(`left ${navigation.left}x`);
      await delay(defaultWait);
    }

    if (navigation.right && navigation.right > 0) {
      const rightCommand = `Scroll right ${
        navigation.right
      } times on ${args.remote_entity_id.replace("remote.", "")}`;
      await executeHACommand(rightCommand);
      navigationSteps.push(`right ${navigation.right}x`);
      await delay(defaultWait);
    }

    // Activate the search field by pressing select
    const selectCommand = `Select on ${args.remote_entity_id.replace(
      "remote.",
      ""
    )}`;
    await executeHACommand(selectCommand);

    const observation =
      `✅ Successfully navigated to and activated search!\n` +
      `📍 Location: ${result.location}\n` +
      `🧭 Navigation: ${navigationSteps.join(" → ") || "already focused"}\n` +
      `⌨️ Search field is now active and ready for text input.\n` +
      `➡️ Task complete - search is ready to use.`;

    return {
      observation,
      needsScreenshot: true, // Request screenshot to verify search field is active
    };
  } catch (error) {
    console.error(
      "[Nav Agent] Error finding and navigating to search icon:",
      error
    );
    return {
      observation: `❌ Error: ${
        error instanceof Error ? error.message : "Unknown error"
      }. Try manual navigation with the navigate tool.`,
      needsScreenshot: false,
    };
  }
}

export async function executeRequestScreenshot(
  args: RequestScreenshotArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  // Navigation agent screenshot handling
  const observation =
    `📸 Screenshot requested for ${args.media_player_entity_id}.\n` +
    `📍 Reason: ${args.reason}\n` +
    `🎯 Context: Navigation Agent (currently executing navigation task)\n` +
    `➡️ The screenshot will be used for navigation decisions.`;

  return { observation, needsScreenshot: true };
}

export async function executeWait(
  args: WaitArgs
): Promise<ToolExecutionResult> {
  const duration = args.duration_ms ?? 1500;
  await delay(duration);

  const observation = `⏱️ Waited ${duration}ms. ${args.reason}`;
  return { observation, needsScreenshot: false };
}
