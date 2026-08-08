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
    "Why you're pressing HOME (e.g., 'to reset to home screen', 'to start navigation from a known state')."
  ),
});

export type GoHomeInput = z.infer<typeof inputSchema>;

async function execute(
  args: GoHomeInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(500, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = parsed.remote_entity_id.replace("remote.", "");
  const plainCommand = `Go home on ${deviceName}`;

  console.log(`[TV Agent] Executing go_home: ${plainCommand}`);

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    return {
      observation: `❌ Failed to go home: ${result.message}. Try again or use an alternative approach.`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  await delay(defaultWait, context.abortSignal);
  return {
    observation: `✅ Successfully pressed HOME button on ${deviceName}.\n📍 Reason: ${parsed.reason}\n➡️ The TV should now show the home screen.`,
    needsScreenshot: true,
  };
}

export const definition: TvToolDefinition = {
  name: "go_home",
  description:
    "Press the HOME button to return to the device's home screen. Use this to reset to a known state when navigation gets stuck or you need to start over.",
  inputSchema,
  execute,
};
