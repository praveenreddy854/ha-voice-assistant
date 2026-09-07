import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { resolveKeyboardLayout, resolveKeyboardPosition } from "../../common/keyboards";
import { sendRemoteCommands } from "./remoteCommands";

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

  const currentPos = resolveKeyboardPosition(parsed.current_cursor_position, layout);
  if (currentPos === undefined) {
    return { observation: "Unknown cursor position. Inspect the keyboard before deleting.", needsScreenshot: true, toolSuccess: false };
  }
  const diff = deletePos - currentPos;
  const commands: string[] = Array(Math.abs(diff)).fill(diff > 0 ? "right" : "left");
  commands.push("select");
  const result = await sendRemoteCommands(parsed.remote_entity_id, commands, context);
  if (!result.success) {
    return {
      observation: `Failed to delete: ${result.message}. The batch may have partly executed; inspect the field and cursor before retrying.`,
      needsScreenshot: true,
      toolSuccess: false,
    };
  }

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
