import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { callHAServiceDirect } from "../../../ha";
import { delay } from "../../common/utils";
import { resolveKeyboardLayout } from "../../common/keyboards";

const NAV_WAIT_MS = 300;
const SELECT_WAIT_MS = 400;

export const inputSchema = z.object({
  remote_entity_id: z.string().describe(
    "Home Assistant entity ID of the remote control to use."
  ),
  current_cursor_position: z.string().describe(
    "The character currently highlighted on the on-screen keyboard (from the last deterministic_typing result or screenshot). Examples: 'a', 'h', 'space', 'delete'."
  ),
  reason: z.string().describe(
    "Why you're deleting (e.g., 'to delete incorrect character')."
  ),
});

export type DeleteTypedTextInput = z.infer<typeof inputSchema>;

async function execute(
  args: DeleteTypedTextInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const layout = resolveKeyboardLayout();
  const deletePos = layout.positions["delete"];

  if (deletePos === undefined) {
    return {
      observation: "❌ DELETE key not found in keyboard layout. Cannot delete characters.",
      needsScreenshot: false,
    };
  }

  const cursorChar = parsed.current_cursor_position.toLowerCase();
  const currentPos = layout.positions[cursorChar] ?? deletePos;
  const diff = deletePos - currentPos;

  if (diff !== 0) {
    const direction = diff > 0 ? "right" : "left";
    const navResult = await callHAServiceDirect(
      "remote", "send_command", parsed.remote_entity_id,
      { command: direction, num_repeats: Math.abs(diff) }
    );

    if (!navResult.success) {
      return {
        observation: `❌ Failed to navigate to DELETE key: ${navResult.message}`,
        needsScreenshot: true,
        toolSuccess: false,
      };
    }
    await delay(NAV_WAIT_MS);
  }

  const selectResult = await callHAServiceDirect(
    "remote", "send_command", parsed.remote_entity_id,
    { command: "select" }
  );

  if (!selectResult.success) {
    return {
      observation: `❌ Failed to press DELETE: ${selectResult.message}`,
      needsScreenshot: true,
      toolSuccess: false,
    };
  }

  await delay(SELECT_WAIT_MS);

  return {
    observation: `✅ Navigated to DELETE key and deleted last character. Cursor is now on DELETE (position ${deletePos}). ${parsed.reason}`,
    needsScreenshot: true,
  };
}

export const definition: TvToolDefinition = {
  name: "delete_typed_text",
  description:
    "Delete the last typed character by navigating to the DELETE key on the on-screen keyboard strip and pressing select. This does NOT press the TV back/menu button (which would exit the app). Requires the current cursor position from the last typing result or screenshot.",
  inputSchema,
  execute,
};
