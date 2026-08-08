import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { callHAServiceDirect } from "../../../ha";
import { delay } from "../../common/utils";
import { AI_MODEL_MINI } from "../../../config";
import { resolveKeyboardLayout, computeTypingSequence, KeyboardLayoutMap } from "../../common/keyboards";
import { generateVisionText } from "../../../ai";
import { getLatestScreenshot } from "../../common/screenshotStore";

// ============================================================================
// Constants
// ============================================================================

const NAV_WAIT_MS = 10;
const SELECT_WAIT_MS = 10;
const SCREENSHOT_SETTLE_MS = 1000;

// ============================================================================
// Module-level typing state (persists across tool calls within a session)
// ============================================================================

let typingCursorPosition: number | undefined;

type PauseCheckpoint = () => Promise<void>;

async function waitForRunPermission(
  abortSignal?: AbortSignal,
  waitIfPaused?: PauseCheckpoint
): Promise<void> {
  await waitIfPaused?.();
  abortSignal?.throwIfAborted();
}

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
  already_typed: z.string().optional().describe(
    "Text already visible in the search field (read from the screenshot). If provided, the tool will reuse the matching prefix, delete any extra characters, and only type the remaining text."
  ),
  reason: z.string().describe(
    "Why this text is being typed."
  ),
});

export type DeterministicTypingInput = z.infer<typeof inputSchema>;

// ============================================================================
// Remote helpers
// ============================================================================

/** Send a remote command, return an error string on failure or undefined on success. */
async function sendRemote(
  entityId: string,
  command: string,
  repeats?: number,
  abortSignal?: AbortSignal,
  waitIfPaused?: PauseCheckpoint,
): Promise<string | undefined> {
  await waitForRunPermission(abortSignal, waitIfPaused);
  const data: Record<string, unknown> = { command };
  if (repeats && repeats > 1) data.num_repeats = repeats;
  const r = await callHAServiceDirect("remote", "send_command", entityId, data);
  await waitForRunPermission(abortSignal, waitIfPaused);
  return r.success ? undefined : r.message;
}

/** Navigate on the keyboard strip and press select for each step. */
async function runSteps(
  steps: ReturnType<typeof computeTypingSequence>["steps"],
  entityId: string,
  abortSignal?: AbortSignal,
  waitIfPaused?: PauseCheckpoint,
): Promise<{ error?: string; typed: string[]; actions: number }> {
  const typed: string[] = [];
  let actions = 0;
  for (const step of steps) {
    await waitForRunPermission(abortSignal, waitIfPaused);
    if (step.action === "navigate" && step.direction && step.count) {
      const err = await sendRemote(
        entityId,
        step.direction,
        step.count,
        abortSignal,
        waitIfPaused
      );
      if (err) return { error: `Navigation failed at '${step.character}': ${err}`, typed, actions };
      await delay(NAV_WAIT_MS, abortSignal);
    } else if (step.action === "select") {
      const err = await sendRemote(
        entityId,
        "select",
        undefined,
        abortSignal,
        waitIfPaused
      );
      if (err) return { error: `Select failed for '${step.character}': ${err}`, typed, actions };
      typed.push(step.character);
      await delay(SELECT_WAIT_MS, abortSignal);
    }
    actions++;
  }
  return { typed, actions };
}

// ============================================================================
// Suggestion detection
// ============================================================================

async function checkSuggestion(
  sessionId: string,
  targetText: string,
  typedSoFar: string,
  abortSignal?: AbortSignal,
  waitIfPaused?: PauseCheckpoint,
): Promise<{ position: number; text: string } | undefined> {
  await delay(SCREENSHOT_SETTLE_MS, abortSignal);
  await waitForRunPermission(abortSignal, waitIfPaused);
  const shot = await getLatestScreenshot(sessionId);
  if (!shot) return undefined;

  try {
    const raw = await generateVisionText({
      model: AI_MODEL_MINI || "gpt-4o-mini",
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
      imageBase64: shot.base64,
      imageContentType: shot.contentType,
      maxTokens: 100,
      temperature: 0,
    });
    await waitForRunPermission(abortSignal, waitIfPaused);

    const parsed = JSON.parse(raw.replace(/```json\s*|\s*```/g, "").trim());
    if (parsed.found && parsed.position !== undefined) {
      return { position: parsed.position, text: parsed.text || "" };
    }
  } catch (err) {
    if (abortSignal?.aborted) throw abortSignal.reason ?? err;
    console.warn(`[Typing] Suggestion check failed:`, err instanceof Error ? err.message : err);
  }
  return undefined;
}

async function selectSuggestion(
  entityId: string,
  position: number,
  abortSignal?: AbortSignal,
  waitIfPaused?: PauseCheckpoint,
): Promise<string | undefined> {
  // Down from keyboard strip → suggestion row
  let err = await sendRemote(
    entityId,
    "down",
    undefined,
    abortSignal,
    waitIfPaused
  );
  if (err) return `Failed to navigate down to suggestions: ${err}`;

  // Right to the correct pill
  if (position > 0) {
    await delay(NAV_WAIT_MS, abortSignal);
    err = await sendRemote(
      entityId,
      "right",
      position,
      abortSignal,
      waitIfPaused
    );
    if (err) return `Failed to navigate right to suggestion: ${err}`;
  }

  // Select the pill
  await delay(NAV_WAIT_MS, abortSignal);
  err = await sendRemote(
    entityId,
    "select",
    undefined,
    abortSignal,
    waitIfPaused
  );
  if (err) return `Failed to select suggestion: ${err}`;

  return undefined;
}

// ============================================================================
// Reconcile already-typed text
// ============================================================================

/** Delete chars from the end and return remaining text to type. */
async function reconcileExistingText(
  alreadyTyped: string,
  fullText: string,
  entityId: string,
  cursorPos: number,
  layout: KeyboardLayoutMap,
  abortSignal?: AbortSignal,
  waitIfPaused?: PauseCheckpoint,
): Promise<{ textToType: string; cursorPos: number; actions: number; error?: string }> {
  // Find common prefix
  let commonLen = 0;
  while (
    commonLen < alreadyTyped.length &&
    commonLen < fullText.length &&
    alreadyTyped[commonLen] === fullText[commonLen]
  ) {
    commonLen++;
  }

  const charsToDelete = alreadyTyped.length - commonLen;
  const textToType = fullText.slice(commonLen);
  let actions = 0;

  console.log(
    `[Typing] Already typed: "${alreadyTyped}", prefix match: ${commonLen} chars, ` +
    `deleting: ${charsToDelete}, remaining: "${textToType}"`
  );

  if (charsToDelete > 0) {
    const deletePos = layout.positions["delete"];
    const diff = deletePos - cursorPos;

    // Navigate to DELETE key
    if (diff !== 0) {
      const err = await sendRemote(
        entityId,
        diff > 0 ? "right" : "left",
        Math.abs(diff),
        abortSignal,
        waitIfPaused
      );
      if (err) return { textToType, cursorPos, actions, error: `Failed to navigate to DELETE: ${err}` };
      await delay(NAV_WAIT_MS, abortSignal);
      actions++;
    }

    // Press select N times to delete N chars
    for (let i = 0; i < charsToDelete; i++) {
      await waitForRunPermission(abortSignal, waitIfPaused);
      const err = await sendRemote(
        entityId,
        "select",
        undefined,
        abortSignal,
        waitIfPaused
      );
      if (err) return { textToType, cursorPos: deletePos, actions, error: `Failed to delete char ${i + 1}/${charsToDelete}: ${err}` };
      await delay(SELECT_WAIT_MS, abortSignal);
      actions++;
    }

    cursorPos = deletePos;
  }

  return { textToType, cursorPos, actions };
}

// ============================================================================
// Word-by-word typing loop
// ============================================================================

interface TypeWordsResult {
  typed: string[];
  cursorPos: number;
  actions: number;
  error?: string;
  suggestion?: { position: number; text: string };
}

async function typeWords(
  text: string,
  startPos: number,
  entityId: string,
  layout: KeyboardLayoutMap,
  sessionId: string,
  fullTargetText: string,
  prefixLen: number,
  abortSignal?: AbortSignal,
  waitIfPaused?: PauseCheckpoint,
): Promise<TypeWordsResult> {
  const words = text.split(" ").filter((w) => w.length > 0);
  const typed: string[] = [];
  let pos = startPos;
  let actions = 0;
  let pendingCheck: Promise<void> | undefined;
  let match: { position: number; text: string } | undefined;

  // If the remaining text starts with a space, type it first
  if (text.startsWith(" ")) {
    const { steps, finalPosition } = computeTypingSequence(" ", pos, layout);
    const result = await runSteps(
      steps,
      entityId,
      abortSignal,
      waitIfPaused
    );
    if (result.error) return { typed: result.typed, cursorPos: pos, actions: result.actions, error: result.error };
    typed.push(...result.typed);
    actions += result.actions;
    pos = finalPosition;
    text = text.slice(1);
  }

  for (let i = 0; i < words.length; i++) {
    await waitForRunPermission(abortSignal, waitIfPaused);
    // Check if a prior background suggestion check found a match
    if (match) break;
    if (pendingCheck) {
      await pendingCheck;
      pendingCheck = undefined;
      if (match) break;
    }

    // Type inter-word space
    if (i > 0) {
      const { steps, finalPosition } = computeTypingSequence(" ", pos, layout);
      const r = await runSteps(steps, entityId, abortSignal, waitIfPaused);
      if (r.error) return { typed: [...typed, ...r.typed], cursorPos: pos, actions: actions + r.actions, error: r.error };
      typed.push(...r.typed);
      actions += r.actions;
      pos = finalPosition;
    }

    // Type the word
    const { steps, finalPosition } = computeTypingSequence(words[i], pos, layout);
    const r = await runSteps(steps, entityId, abortSignal, waitIfPaused);
    typed.push(...r.typed);
    actions += r.actions;
    if (r.error) return { typed, cursorPos: pos, actions, error: r.error };
    pos = finalPosition;

    // Launch background suggestion check
    const typedSoFar = fullTargetText.slice(0, prefixLen) + typed.join("");
    pendingCheck = (async () => {
      console.log(`[Typing] Checking suggestions after word "${words[i]}" (typed: "${typedSoFar}")`);
      const found = await checkSuggestion(
        sessionId,
        fullTargetText,
        typedSoFar,
        abortSignal,
        waitIfPaused
      );
      if (found) {
        console.log(`[Typing] Suggestion match: "${found.text}" at position ${found.position}`);
        match = found;
      }
    })();
  }

  // Wait for any final pending check
  if (pendingCheck) await pendingCheck;

  return { typed, cursorPos: pos, actions, suggestion: match };
}

// ============================================================================
// Result builders
// ============================================================================

function cursorLabel(pos: number, layout: KeyboardLayoutMap): string {
  const char = Object.entries(layout.positions).find(([, p]) => p === pos)?.[0] || "?";
  return char === " " ? "SPACE" : char;
}

// ============================================================================
// Main execute
// ============================================================================

async function execute(
  args: DeterministicTypingInput,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const layout = resolveKeyboardLayout();
  const cursorChar = parsed.current_cursor_position.toLowerCase();
  const startPos = layout.positions[cursorChar];

  if (startPos === undefined) {
    return {
      observation:
        `Unknown cursor position "${parsed.current_cursor_position}". ` +
        `Valid: ${Object.keys(layout.positions).map((k) => (k === " " ? "SPACE" : k)).join(", ")}`,
      needsScreenshot: false,
    };
  }

  const fullText = parsed.text.toLowerCase();
  const entityId = parsed.remote_entity_id;
  const sessionId = context.sessionId || "typing";
  let cursorPos = startPos;

  // --- Reconcile already-typed text ---
  let textToType = fullText;
  let prefixLen = 0;

  if (parsed.already_typed) {
    const reconciled = await reconcileExistingText(
      parsed.already_typed.toLowerCase(),
      fullText,
      entityId,
      cursorPos,
      layout,
      context.abortSignal,
      context.waitIfPaused,
    );
    if (reconciled.error) {
      return { observation: `❌ ${reconciled.error}`, needsScreenshot: true, toolSuccess: false };
    }
    textToType = reconciled.textToType;
    cursorPos = reconciled.cursorPos;
    prefixLen = fullText.length - textToType.length;

    if (textToType.length === 0) {
      return {
        observation: `✅ Search field already contains "${fullText}". No typing needed.`,
        needsScreenshot: true,
      };
    }
  }

  console.log(`[Typing] Typing "${textToType}" (prefix reused: ${prefixLen} chars) from pos ${cursorPos}`);

  // --- Type remaining text ---
  const result = await typeWords(
    textToType,
    cursorPos,
    entityId,
    layout,
    sessionId,
    fullText,
    prefixLen,
    context.abortSignal,
    context.waitIfPaused
  );
  cursorPos = result.cursorPos;
  typingCursorPosition = cursorPos;

  if (result.error) {
    return {
      observation:
        `⚠️ Typing stopped: ${result.error}\n` +
        `Typed so far: "${result.typed.join("")}"\n` +
        `Cursor on '${cursorLabel(cursorPos, layout)}' (pos ${cursorPos})`,
      needsScreenshot: true,
    };
  }

  // --- Auto-select suggestion if found ---
  if (result.suggestion) {
    const { position, text } = result.suggestion;
    console.log(`[Typing] Auto-selecting suggestion "${text}" at position ${position}`);

    const err = await selectSuggestion(
      entityId,
      position,
      context.abortSignal,
      context.waitIfPaused
    );
    if (err) {
      return {
        observation: `⚠️ Found suggestion "${text}" but failed to select it: ${err}\nTyped: "${result.typed.join("")}"`,
        needsScreenshot: true,
      };
    }

    return {
      observation: `✅ Autocomplete suggestion "${text}" selected! Typed "${result.typed.join("")}", then picked suggestion at position ${position}.`,
      needsScreenshot: true,
    };
  }

  return {
    observation:
      `✅ Typing complete: "${result.typed.join("")}" (${result.actions} commands)\n` +
      `Cursor on '${cursorLabel(cursorPos, layout)}' (pos ${cursorPos})`,
    needsScreenshot: true,
  };
}

// ============================================================================
// Definition
// ============================================================================

export const definition: TvToolDefinition = {
  name: "deterministic_typing",
  description:
    "Type text on the on-screen keyboard using deterministic navigation. Pass the FULL text and the current cursor position (identified from the screenshot). If text is already in the search field, pass it as already_typed — the tool will reuse the matching prefix, delete extras, and type only the remainder. Types word by word, checking for autocomplete suggestions after each word. If a suggestion matches, it selects it automatically.",
  inputSchema,
  execute,
};
