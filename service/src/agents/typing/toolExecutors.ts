/**
 * TV Typing Agent Tool Executors
 * Implementation of deterministic typing, delete, and supporting helpers.
 */

import {
  DeleteTypedTextArgs,
  DeterministicTypingArgs,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types";
import { callHAServiceDirect } from "../../ha";
import { delay } from "../common/utils";
import { AI_MODEL_MINI } from "../../config";
import { resolveKeyboardLayout, computeTypingSequence } from "./keyboards";
import { generateVisionText } from "../../ai";
import { getLatestScreenshot } from "../common/screenshotStore";

// ============================================================================
// Constants
// ============================================================================

/** Wait time after navigation (cursor move) — short since it's just a highlight shift */
const NAV_WAIT_MS = 300;
/** Wait time after select (character input) — slightly longer for the character to register */
const SELECT_WAIT_MS = 400;
/** Wait after typing a word before capturing a validation screenshot */
const SCREENSHOT_SETTLE_MS = 1000;

// ============================================================================
// delete_typed_text
// ============================================================================

export async function executeDeleteTypedText(
  args: DeleteTypedTextArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  // On Apple TV YouTube, pressing the MENU/BACK button exits the keyboard/app.
  // To delete a character, we must navigate to the DELETE key (position 28 on the
  // keyboard strip) and press select.
  const layout = resolveKeyboardLayout();
  const deletePos = layout.positions["delete"];

  if (deletePos === undefined) {
    return {
      observation: "❌ DELETE key not found in keyboard layout. Cannot delete characters.",
      needsScreenshot: false,
    };
  }

  const currentPos = context.currentCursorPosition ?? deletePos;
  const diff = deletePos - currentPos;

  if (diff !== 0) {
    const direction = diff > 0 ? "right" : "left";
    const navResult = await callHAServiceDirect(
      "remote", "send_command", args.remote_entity_id,
      { command: direction, num_repeats: Math.abs(diff) }
    );

    if (!navResult.success) {
      return {
        observation: `❌ Failed to navigate to DELETE key: ${navResult.message}`,
        needsScreenshot: true,
      };
    }
    await delay(NAV_WAIT_MS);
  }

  const selectResult = await callHAServiceDirect(
    "remote", "send_command", args.remote_entity_id,
    { command: "select" }
  );

  if (!selectResult.success) {
    return {
      observation: `❌ Failed to press DELETE: ${selectResult.message}`,
      needsScreenshot: true,
    };
  }

  await delay(SELECT_WAIT_MS);
  context.currentCursorPosition = deletePos;

  return {
    observation: `✅ Navigated to DELETE key and deleted last character. Cursor is now on DELETE (position ${deletePos}). ${args.reason}`,
    needsScreenshot: true,
  };
}

// ============================================================================
// deterministic_typing (+ internal helpers)
// ============================================================================

/**
 * Read the latest screenshot from the session's screenshot directory on disk.
 */
async function readLatestScreenshot(
  sessionId: string
): Promise<{ base64: string; contentType: string } | undefined> {
  const result = await getLatestScreenshot(sessionId);
  if (!result) {
    return undefined;
  }
  console.log(`[Typing Agent] Read screenshot from disk: ${result.filePath} (${Math.round((result.base64.length * 3) / 4 / 1024)}KB)`);
  return { base64: result.base64, contentType: result.contentType };
}

/**
 * Use the vision model to check if any suggestion pill below the keyboard
 * matches the full target text. Returns navigation instructions if found.
 */
async function canUseSuggestion(
  screenshot: { base64: string; contentType: string },
  targetText: string,
  typedSoFar: string
): Promise<{ found: boolean; position?: number; text?: string }> {
  try {
    const visionModel = AI_MODEL_MINI || "gpt-5.4-mini";
    const result = await generateVisionText({
      model: visionModel,
      prompt: `Look at this TV screen showing a search keyboard with a horizontal strip of letters.
Below the keyboard strip there is a row of suggestion pills (small text bubbles with autocomplete suggestions).

The user wants to search for: "${targetText}"
Text typed so far: "${typedSoFar}"

Check the suggestion pills. Is there one that matches or closely matches "${targetText}"?
Count the pills from left starting at 0.

Reply with ONLY a JSON object (no markdown):
- If a matching suggestion exists: {"found": true, "position": <0-based index from left>, "text": "<exact suggestion text>"}
- If no matching suggestion or no suggestions visible: {"found": false}`,
      imageBase64: screenshot.base64,
      imageContentType: screenshot.contentType,
      maxTokens: 100,
      temperature: 0,
    });

    const cleaned = result.replace(/```json\s*|\s*```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      found: Boolean(parsed.found),
      position: parsed.position,
      text: parsed.text,
    };
  } catch (error) {
    console.warn(
      `[Typing Agent] Suggestion check failed:`,
      error instanceof Error ? error.message : error
    );
    return { found: false };
  }
}

export async function executeDeterministicTyping(
  args: DeterministicTypingArgs,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const layout = resolveKeyboardLayout();
  const cursorChar = args.current_cursor_position.toLowerCase();
  const startPos = layout.positions[cursorChar];

  if (startPos === undefined) {
    return {
      observation:
        `❌ Unknown cursor position "${args.current_cursor_position}". ` +
        `Valid positions: ${Object.keys(layout.positions).map(k => k === " " ? "SPACE" : k).join(", ")}`,
      needsScreenshot: false,
    };
  }

  const fullText = args.text.toLowerCase();
  const words = fullText.split(" ");
  const entityId = args.remote_entity_id;
  const allTypedChars: string[] = [];
  let currentPos = startPos;
  let totalActions = 0;
  let abortReason: string | undefined;

  // Background suggestion check — runs in parallel with typing the next word.
  let pendingSuggestion: Promise<void> | undefined;
  const suggestion: { match?: { position: number; text: string } } = {};

  console.log(
    `[Typing Agent] Deterministic typing "${fullText}" (${words.length} words) from '${cursorChar}' (pos ${startPos})`
  );

  for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
    // Before starting a new word, check if a previous suggestion check found a match
    if (suggestion.match) break;
    if (pendingSuggestion) {
      await pendingSuggestion;
      pendingSuggestion = undefined;
      if (suggestion.match) break;
    }

    const word = words[wordIdx];

    // Type space before each word (except the first)
    if (wordIdx > 0) {
      const { steps: spaceSteps, finalPosition: spaceEnd } =
        computeTypingSequence(" ", currentPos, layout);

      for (const step of spaceSteps) {
        const err = await executeStep(step, entityId);
        if (err) { abortReason = err; break; }
        if (step.action === "select") allTypedChars.push(step.character);
        totalActions++;
      }
      if (abortReason) break;
      currentPos = spaceEnd;
    }

    // Type the word
    const { steps: wordSteps, finalPosition: wordEnd } =
      computeTypingSequence(word, currentPos, layout);

    for (const step of wordSteps) {
      const err = await executeStep(step, entityId);
      if (err) { abortReason = err; break; }
      if (step.action === "select") allTypedChars.push(step.character);
      totalActions++;
    }
    if (abortReason) break;
    currentPos = wordEnd;

    // Launch background suggestion check (runs in parallel with typing the next word)
    const typedSoFar = allTypedChars.join("");
    const sessionId = context.sessionId || "typing";
    pendingSuggestion = (async () => {
      await delay(SCREENSHOT_SETTLE_MS);
      const screenshot = await readLatestScreenshot(sessionId);
      if (!screenshot) return;
      console.log(`[Typing Agent] Checking suggestions after word "${word}" (typed: "${typedSoFar}")`);
      const result = await canUseSuggestion(screenshot, context.targetText || fullText, typedSoFar);
      if (result.found && result.position !== undefined) {
        console.log(`[Typing Agent] Suggestion match: "${result.text}" at position ${result.position}`);
        suggestion.match = { position: result.position, text: result.text || "" };
      }
    })();
  }

  // Wait for any remaining suggestion check
  if (pendingSuggestion) {
    await pendingSuggestion;
  }

  if (abortReason) {
    // Update context tracking before returning error
    if (context.typedSoFar !== undefined) {
      context.typedSoFar += allTypedChars.join("");
    }
    context.currentCursorPosition = currentPos;

    const finalChar =
      Object.entries(layout.positions).find(([, pos]) => pos === currentPos)?.[0] || "?";
    const finalCharDisplay = finalChar === " " ? "SPACE" : finalChar;

    return {
      observation:
        `⚠️ Deterministic typing stopped: ${abortReason}\n` +
        `📝 Typed so far: "${allTypedChars.join("")}"\n` +
        `📍 Cursor is on '${finalCharDisplay}' (position ${currentPos})\n` +
        `🔧 Use delete_typed_text to delete incorrect characters (cursor moves to DELETE key at position 28), then call deterministic_typing again with current_cursor_position="delete".`,
      needsScreenshot: true,
    };
  }

  // If a suggestion matched, select it
  if (suggestion.match) {
    const selected = await selectSuggestion(entityId, suggestion.match.position);
    if (selected) {
      if (context.typedSoFar !== undefined) {
        context.typedSoFar = suggestion.match.text;
      }
      context.currentCursorPosition = currentPos;

      return {
        observation:
          `✅ Selected suggestion "${suggestion.match.text}" (position ${suggestion.match.position}) after typing "${allTypedChars.join("")}".\n` +
          `📝 ${totalActions} HA commands + suggestion selection\n` +
          `⚡ Skipped typing remaining text by using autocomplete suggestion.`,
        needsScreenshot: true,
      };
    }
    // Selection failed — fall through to normal completion
    console.warn(`[Typing Agent] Suggestion selection failed, returning typed text result`);
  }

  // Update context tracking
  if (context.typedSoFar !== undefined) {
    context.typedSoFar += allTypedChars.join("");
  }
  context.currentCursorPosition = currentPos;

  const finalChar =
    Object.entries(layout.positions).find(([, pos]) => pos === currentPos)?.[0] || "?";
  const finalCharDisplay = finalChar === " " ? "SPACE" : finalChar;

  return {
    observation:
      `✅ Deterministic typing complete: "${allTypedChars.join("")}"\n` +
      `📝 ${totalActions} HA commands executed (${allTypedChars.length} characters typed)\n` +
      `📍 Cursor is now on '${finalCharDisplay}' (position ${currentPos})\n` +
      `✅ All words typed successfully.`,
    needsScreenshot: true,
  };
}

/**
 * Navigate to a suggestion pill and select it.
 * Suggestion pills are one row below the keyboard strip.
 * Returns true if selection succeeded.
 */
async function selectSuggestion(entityId: string, position: number): Promise<boolean> {
  const downResult = await callHAServiceDirect(
    "remote", "send_command", entityId,
    { command: "down" }
  );
  if (!downResult.success) {
    console.warn(`[Typing Agent] Failed to navigate down to suggestions: ${downResult.message}`);
    return false;
  }
  await delay(NAV_WAIT_MS);

  if (position > 0) {
    const rightResult = await callHAServiceDirect(
      "remote", "send_command", entityId,
      { command: "right", num_repeats: position }
    );
    if (!rightResult.success) {
      console.warn(`[Typing Agent] Failed to navigate right to suggestion: ${rightResult.message}`);
      return false;
    }
    await delay(NAV_WAIT_MS);
  }

  const selectResult = await callHAServiceDirect(
    "remote", "send_command", entityId,
    { command: "select" }
  );
  if (!selectResult.success) {
    console.warn(`[Typing Agent] Failed to select suggestion: ${selectResult.message}`);
    return false;
  }
  await delay(SELECT_WAIT_MS);
  return true;
}

/** Execute a single navigate or select step. Returns error string or undefined on success. */
async function executeStep(
  step: { action: string; direction?: string; count?: number; character: string },
  entityId: string
): Promise<string | undefined> {
  if (step.action === "navigate" && step.direction && step.count) {
    const command = step.direction === "left" ? "left" : "right";
    const result = await callHAServiceDirect(
      "remote", "send_command", entityId,
      { command, num_repeats: step.count }
    );
    if (!result.success) {
      return `Navigation failed at '${step.character}': ${result.message}`;
    }
    await delay(NAV_WAIT_MS);
  } else if (step.action === "select") {
    const result = await callHAServiceDirect(
      "remote", "send_command", entityId,
      { command: "select" }
    );
    if (!result.success) {
      return `Select failed for '${step.character}': ${result.message}`;
    }
    await delay(SELECT_WAIT_MS);
  }
  return undefined;
}
