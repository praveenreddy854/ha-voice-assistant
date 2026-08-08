import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { executeHACommand } from "../../../ha";
import { delay } from "../../common/utils";
import { TV_DEFAULT_WAIT_MS } from "../../../config";

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
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(300, TV_DEFAULT_WAIT_MS)
    : 1000;
  const count = Math.min(Math.max(parsed.count, 1), 10);
  const deviceName = parsed.remote_entity_id.replace("remote.", "");

  console.log(`[TV Agent] Executing navigate: ${parsed.direction} x${count} on ${deviceName}`);

  let successCount = 0;
  let lastError = "";

  for (let i = 0; i < count; i++) {
    await context.waitIfPaused?.();
    context.abortSignal?.throwIfAborted();
    const plainCommand = `Scroll ${parsed.direction} on ${deviceName}`;
    const result = await executeHACommand(plainCommand);

    if (result.success) {
      successCount++;
      if (i < count - 1) {
        await delay(200, context.abortSignal);
      }
    } else {
      lastError = result.message;
      console.warn(`[TV Agent] Navigation press ${i + 1}/${count} failed: ${lastError}`);
    }
  }

  await delay(defaultWait, context.abortSignal);

  if (successCount === 0) {
    return {
      observation: `❌ Failed to navigate ${parsed.direction}: ${lastError}. The UI may be unresponsive or the remote entity may be incorrect.`,
      needsScreenshot: true,
      toolSuccess: false,
    };
  }

  if (successCount < count) {
    return {
      observation: `⚠️ Partial navigation: Pressed ${parsed.direction.toUpperCase()} ${successCount}/${count} times on ${deviceName}.\n📍 Reason: ${parsed.reason}\n⚠️ Some commands failed, verify position in screenshot.`,
      needsScreenshot: true,
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
