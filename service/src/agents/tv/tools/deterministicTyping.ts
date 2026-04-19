import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { callHAServiceDirect } from "../../../ha";
import { delay } from "../../common/utils";
import { AI_MODEL_MINI } from "../../../config";
import { resolveKeyboardLayout, computeTypingSequence } from "../../common/keyboards";
import { generateVisionText } from "../../../ai";
import { getLatestScreenshot } from "../../common/screenshotStore";

// ============================================================================
// Constants
// ============================================================================

const NAV_WAIT_MS = 100;
const SELECT_WAIT_MS = 100;
const SCREENSHOT_SETTLE_MS = 1000;

// ============================================================================
// Module-level typing state (persists across tool calls within a session)
// ============================================================================

let typingCursorPosition: number | undefined;

/** Reset typing state — call when a new typing session starts. */
export function resetTypingState(): void {
  typingCursorPosition = undefined;
}

// ============================================================================
// Input Schema
// ============================================================================

export const inputSchema = z.object({
  text: z.string().describe(
    "The FULL text to type on the keyboard (e.g., 'latest telugu songs'). Only lowercase letters and spaces are supported."
  ),
  current_cursor_position: z.string().describe(
    "The character currently highlighted on the on-screen keyboard. Use the screenshot to identify this. Examples: 'a', 'h', 'space', 'delete'. When the keyboard first opens, this is usually 'a'."
  ),
  remote_entity_id: z.string().describe(
    "Home Assistant entity ID of the remote control to use."
  ),
  reason: z.string().describe(
    "Why this text is being typed."
  ),
});

export type DeterministicTypingInput = z.infer<typeof inputSchema>;

// ============================================================================
// Internal helpers
// ============================================================================

async function readLatestScreenshot(
  sessionId: string
): Promise<{ base64: string; contentType: string } | undefined> {
  const result = await getLatestScreenshot(sessionId);
  if (!result) return undefined;
  console.log(`[TV Agent] Read screenshot from disk: ${result.filePath} (${Math.round((result.base64.length * 3) / 4 / 1024)}KB)`);
  return { base64: result.base64, contentType: result.contentType };
}

async function canUseSuggestion(
  screenshot: { base64: string; contentType: string },
  targetText: string,
  typedSoFar: string
): Promise<{ found: boolean; position?: number; text?: string }> {
  try {
    const visionModel = AI_MODEL_MINI || "gpt-4o-mini";
    const result = await generateVisionText({
      model: visionModel,
      prompt: `Look at this TV screen showing a search keyboard with a horizontal strip of letters.
Below the keyboard strip there is a row of suggestion pills (small text bubbles with autocomplete suggestions).

The user wants to search for: "${targetText}"
Text typed so far: "${typedSoFar}"

Check the suggestion pills. Is there one that EXACTLY matches or very closely matches "${targetText}"?
Count the suggestion pills from left starting at 0. Be very precise about the position.

IMPORTANT: Only match if the suggestion text is essentially the same as "${targetText}" (minor differences like capitalization are OK). Do NOT match partial or loosely related suggestions.

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
    console.warn(`[TV Agent] Suggestion check failed:`, error instanceof Error ? error.message : error);
    return { found: false };
  }
}

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

// ============================================================================
// Main execute
// ============================================================================

async function execute(
  args: DeterministicTypingInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const layout = resolveKeyboardLayout();
  const cursorChar = parsed.current_cursor_position.toLowerCase();
  const startPos = layout.positions[cursorChar];

  if (startPos === undefined) {
    return {
      observation:
        `❌ Unknown cursor position "${parsed.current_cursor_position}". ` +
        `Valid positions: ${Object.keys(layout.positions).map(k => k === " " ? "SPACE" : k).join(", ")}`,
      needsScreenshot: false,
    };
  }

  const fullText = parsed.text.toLowerCase();
  const words = fullText.split(" ");
  const entityId = parsed.remote_entity_id;
  const allTypedChars: string[] = [];
  let currentPos = startPos;
  let totalActions = 0;
  let abortReason: string | undefined;

  let pendingSuggestion: Promise<void> | undefined;
  const suggestion: { match?: { position: number; text: string } } = {};

  console.log(`[TV Agent] Deterministic typing "${fullText}" (${words.length} words) from '${cursorChar}' (pos ${startPos})`);

  for (let wordIdx = 0; wordIdx < words.length; wordIdx++) {
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

    // Launch background suggestion check
    const typedSoFar = allTypedChars.join("");
    const sessionId = context.sessionId || "typing";
    pendingSuggestion = (async () => {
      await delay(SCREENSHOT_SETTLE_MS);
      const screenshot = await readLatestScreenshot(sessionId);
      if (!screenshot) return;
      console.log(`[TV Agent] Checking suggestions after word "${word}" (typed: "${typedSoFar}")`);
      const result = await canUseSuggestion(screenshot, fullText, typedSoFar);
      if (result.found && result.position !== undefined) {
        console.log(`[TV Agent] Suggestion match: "${result.text}" at position ${result.position}`);
        suggestion.match = { position: result.position, text: result.text || "" };
      }
    })();
  }

  if (pendingSuggestion) {
    await pendingSuggestion;
  }

  // Update module-level cursor position
  typingCursorPosition = currentPos;

  if (abortReason) {
    const finalChar =
      Object.entries(layout.positions).find(([, pos]) => pos === currentPos)?.[0] || "?";
    const finalCharDisplay = finalChar === " " ? "SPACE" : finalChar;

    return {
      observation:
        `⚠️ Deterministic typing stopped: ${abortReason}\n` +
        `📝 Typed so far: "${allTypedChars.join("")}"\n` +
        `📍 Cursor is on '${finalCharDisplay}' (position ${currentPos})\n` +
        `🔧 Use delete_typed_text to delete incorrect characters, then call deterministic_typing again with current_cursor_position="delete".`,
      needsScreenshot: true,
    };
  }

  if (suggestion.match) {
    const pos = suggestion.match.position;
    const rightSteps = pos > 0 ? `then navigate RIGHT ${pos} time(s) to reach it, ` : "";
    return {
      observation:
        `✅ Typing paused — autocomplete suggestion found!\n` +
        `📝 Typed so far: "${allTypedChars.join("")}"\n` +
        `💡 Suggestion "${suggestion.match.text}" detected at position ${pos} (0-based from left).\n` +
        `\n🔧 TO SELECT THIS SUGGESTION:\n` +
        `1. Navigate DOWN 1 time to move from the keyboard strip to the suggestion row\n` +
        `2. ${rightSteps ? `Navigate RIGHT ${pos} time(s) to reach the suggestion at position ${pos}` : "The suggestion is already at position 0 (leftmost)"}\n` +
        `3. Press SELECT (click_select_button) to choose it\n` +
        `4. Take a screenshot to verify the suggestion was selected\n` +
        `\n⚠️ Use get_latest_screenshot AFTER selecting to verify. If the wrong suggestion was picked, use go_back and retry.`,
      needsScreenshot: true,
    };
  }

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

export const definition: TvToolDefinition = {
  name: "deterministic_typing",
  description:
    "Type text on the on-screen keyboard using deterministic navigation. Pass the FULL text and the current cursor position (identified from the screenshot). Types word by word, checking for autocomplete suggestions after each word. If a suggestion matches, it selects it automatically. You MUST identify the current cursor position from a screenshot before calling this tool.",
  inputSchema,
  execute,
};
