import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { executeHACommand } from "../../../ha";
import { getDeviceIntegration } from "./webSearch";
import { sendRemoteCommands } from "./remoteCommands";

export const inputSchema = z.object({
  direction: z.enum(["up", "down", "left", "right"]).describe(
    "Direction to navigate on screen."
  ),
  count: z.number().int().min(1).max(10).describe(
    "Number of times to press the direction (1-10)."
  ),
  remote_entity_id: z.string().describe(
    "Home Assistant entity ID of the remote control to use."
  ),
  reason: z.string().describe(
    "Why you're navigating (e.g., 'to reach the search icon', 'to move to the first result')."
  ),
});

export type NavigateInput = z.infer<typeof inputSchema>;

async function execute(
  args: NavigateInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const count = Math.min(Math.max(parsed.count, 1), 10);
  const deviceName = parsed.remote_entity_id.replace("remote.", "");

  console.log(`[TV Agent] Executing navigate: ${parsed.direction} x${count} on ${deviceName}`);

  const integration = getDeviceIntegration(parsed.remote_entity_id);
  await context.waitIfPaused?.();
  context.abortSignal?.throwIfAborted();
  const result = integration
    ? await sendRemoteCommands(
        parsed.remote_entity_id,
        integration === "samsungtv" ? `KEY_${parsed.direction.toUpperCase()}` : parsed.direction,
        context,
        count,
      )
    : await executeHACommand(`Scroll ${parsed.direction} ${count} times on ${deviceName}`,
        undefined, { abortSignal: context.abortSignal });
  await context.waitIfPaused?.();
  context.abortSignal?.throwIfAborted();

  if (!result.success) {
    return {
      observation: `Navigation failed: ${result.message}. The batch may have partly executed; verify the cursor from a fresh screenshot before retrying.`,
      needsScreenshot: true,
      toolSuccess: false,
    };
  }

  return {
    observation: `✅ Successfully navigated ${parsed.direction.toUpperCase()} ${count}x on ${deviceName}.\n📍 Reason: ${parsed.reason}`,
    needsScreenshot: true,
  };
}

export const definition: TvToolDefinition = {
  name: "navigate",
  description:
    "Move the cursor/selection on the TV screen in a direction (up/down/left/right). Specify the count for how many times to press. Use this for precise directional navigation on menus, content rows, and keyboard strips.",
  inputSchema,
  execute,
};
