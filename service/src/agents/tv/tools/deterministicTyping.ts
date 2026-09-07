import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { resolveKeyboardLayout, computeTypingSequence, resolveKeyboardPosition } from "../../common/keyboards";
import { sendRemoteCommands } from "./remoteCommands";

export const inputSchema = z.object({
  text: z.string().describe(
    "The FULL, shortest search phrase that preserves the user's intent, using lowercase letters and spaces. For 'Play latest telugu songs', use 'latest telugu songs'; do not add 'music video', 'official', or other unrequested words. Preserve titles, artists, language, and requested qualifiers."
  ),
  current_cursor_position: z.string().describe(
    "The character highlighted on the visible keyboard, identified from a screenshot. Examples: 'a', 'h', 'space', 'delete'."
  ),
  remote_entity_id: z.string().describe("Home Assistant entity ID of the remote control to use."),
  already_typed: z.string().optional().describe(
    "Text already visible in the search field. The tool reuses the matching prefix, deletes extra characters, and types only the remainder."
  ),
  reason: z.string().describe("Why this text is being typed."),
});

export type DeterministicTypingInput = z.infer<typeof inputSchema>;

async function execute(
  args: DeterministicTypingInput,
  context: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const layout = resolveKeyboardLayout();
  let cursorPos = resolveKeyboardPosition(parsed.current_cursor_position, layout);
  const fullText = parsed.text.toLowerCase().trim().replace(/\s+/g, " ");
  if (cursorPos === undefined || !/^[a-z ]+$/.test(fullText)) {
    return {
      observation: cursorPos === undefined
        ? `Unknown cursor position "${parsed.current_cursor_position}". Inspect the keyboard before retrying.`
        : "This keyboard supports letters and spaces only. No keys were sent; use the appropriate keyboard mode for numbers or symbols.",
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  const existingText = (parsed.already_typed ?? "").toLowerCase();
  let commonLen = 0;
  while (commonLen < existingText.length && commonLen < fullText.length &&
    existingText[commonLen] === fullText[commonLen]) commonLen++;
  let visibleText = existingText;
  let requests = 0;

  // A failed batch may have partly executed. Never guess the cursor or retry
  // blindly; require a fresh screenshot and reconciliation instead.
  const send = async (commands: string[]): Promise<ToolExecutionResult | undefined> => {
    const result = await sendRemoteCommands(parsed.remote_entity_id, commands, context);
    requests++;
    if (result.success) return undefined;
    return {
      observation: `Typing stopped: ${result.message}. Last confirmed text: "${visibleText}". ` +
        "The last batch may have partly executed. Read the field and cursor from a fresh screenshot, then pass the full target and already_typed to retry.",
      needsScreenshot: true,
      toolSuccess: false,
    };
  };

  for (let i = existingText.length; i > commonLen; i--) {
    const deletePos = layout.positions.delete;
    const diff = deletePos - cursorPos;
    const commands: string[] = Array(Math.abs(diff)).fill(diff > 0 ? "right" : "left");
    commands.push("select");
    const failure = await send(commands);
    if (failure) return failure;
    cursorPos = deletePos;
    visibleText = visibleText.slice(0, -1);
  }

  // One ordered HA request per character removes the navigation/select round
  // trip while keeping pause/cancel checkpoints at every character. No vision
  // requests or sleeps interrupt typing; the caller verifies the final screen.
  for (const character of fullText.slice(commonLen)) {
    const { steps, finalPosition } = computeTypingSequence(character, cursorPos, layout);
    const commands = steps.flatMap((step) => step.action === "navigate"
      ? Array<string>(step.count!).fill(step.direction!)
      : ["select"]);
    const failure = await send(commands);
    if (failure) return failure;
    visibleText += character;
    cursorPos = finalPosition;
  }

  const cursor = Object.entries(layout.positions).find(([, pos]) => pos === cursorPos)?.[0];
  return {
    observation: requests === 0
      ? `Search field already contains "${fullText}". No typing needed.`
      : `Typing complete: "${visibleText}" (${requests} requests). Cursor on '${cursor === " " ? "SPACE" : cursor}'. Verify the final field in the screenshot before selecting results.`,
    needsScreenshot: true,
  };
}

export const definition: TvToolDefinition = {
  name: "deterministic_typing",
  description: "Type the shortest search phrase preserving the user's intent on the visible keyboard. Pass the FULL target and screenshot-confirmed cursor. Use already_typed to reuse a matching prefix and correct extras. Sends ordered key batches without per-word AI checks; verify the final screenshot before selecting results.",
  inputSchema,
  execute,
};
