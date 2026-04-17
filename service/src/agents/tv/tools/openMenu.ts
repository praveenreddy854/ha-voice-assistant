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
    "Why you're opening menu (e.g., 'to access settings', 'to find additional options')."
  ),
});

export type OpenMenuInput = z.infer<typeof inputSchema>;

async function execute(
  args: OpenMenuInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = parsed.remote_entity_id.replace("remote.", "");
  const plainCommand = `Open menu on ${deviceName}`;

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    return {
      observation: `Failed to execute "${plainCommand}": ${result.message}. Use web_search to find the correct service call for this device.`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  await delay(defaultWait);
  return {
    observation: `Successfully executed "${plainCommand}". ${parsed.reason}`,
    needsScreenshot: false,
  };
}

export const definition: TvToolDefinition = {
  name: "open_menu",
  description:
    "Open the main menu, settings menu, or context menu depending on the current screen. Use this to access device settings, additional options, or when you need to find menu-specific functionality.",
  inputSchema,
  execute,
};
