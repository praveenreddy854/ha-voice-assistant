import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { executeHACommand } from "../../../ha";
import { delay } from "../../common/utils";
import { TV_DEFAULT_WAIT_MS } from "../../../config";

export const inputSchema = z.object({
  remote_entity_id: z.string().describe(
    "Home Assistant entity ID of the remote control to use."
  ),
  reason: z.string().describe(
    "Why you're pressing BACK (e.g., 'to exit playing content before navigation', 'to return to previous screen')."
  ),
});

export type GoBackInput = z.infer<typeof inputSchema>;

async function execute(
  args: GoBackInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(500, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = parsed.remote_entity_id.replace("remote.", "");
  const plainCommand = `Go back on ${deviceName}`;

  console.log(`[TV Agent] Executing go_back: ${plainCommand}`);

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    return {
      observation: `❌ Failed to go back: ${result.message}. Try again or use go_home to reset.`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  await delay(defaultWait, context.abortSignal);
  return {
    observation: `✅ Successfully pressed BACK button on ${deviceName}.\n📍 Reason: ${parsed.reason}\n➡️ The TV should now show the previous screen.`,
    needsScreenshot: true,
  };
}

export const definition: TvToolDefinition = {
  name: "go_back",
  description:
    "Press the BACK/MENU button to go to the previous screen or exit the current player/menu. Use this to exit fullscreen video playback before navigation, or to go back one screen.",
  inputSchema,
  execute,
};
