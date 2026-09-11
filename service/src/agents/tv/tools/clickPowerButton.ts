import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { callHAServiceDirect } from "../../../ha";
import { delay } from "../../common/utils";
import { TV_DEFAULT_WAIT_MS } from "../../../config";
import { getDeviceIntegration } from "./webSearch";
import { getDeviceEntityState } from "./deviceStateGuard";

export const inputSchema = z.object({
  remote_entity_id: z.string().describe(
    "Home Assistant entity ID of the remote control to use (e.g., 'remote.loft_tv', 'remote.family_room_tv', 'remote.appletv')."
  ),
  desired_state: z.enum(["on", "off"]).describe(
    "The requested power state: on to wake/power on, off to sleep/power off. Choose from the user's intent, never by inverting Home Assistant's reported state."
  ),
  reason: z.string().describe(
    "Why you're using power button (e.g., 'to turn on TV for user request')."
  ),
});

export type ClickPowerButtonInput = z.infer<typeof inputSchema>;

async function execute(
  args: ClickPowerButtonInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;

  // Read state for verification only. It can be stale and must never invert
  // the requested action, including when retrying a wake/sleep command.
  const remoteState = await getDeviceEntityState(
    parsed.remote_entity_id,
    context
  );
  const integration = getDeviceIntegration(parsed.remote_entity_id);

  // Use the integration-specific power service directly for reliability.
  const command = parsed.desired_state === "on" ? "turn_on" : "turn_off";
  await context.waitIfPaused?.();
  context.abortSignal?.throwIfAborted();
  const result = integration === "samsungtv"
    ? await callHAServiceDirect(
        "remote",
        command,
        parsed.remote_entity_id,
        undefined,
        context
      )
    : await callHAServiceDirect(
        "remote",
        "send_command",
        parsed.remote_entity_id,
        { command: parsed.desired_state === "on" ? "wakeup" : "suspend" },
        context
      );

  if (!result.success) {
    return {
      observation: `Failed to send "${command}" to ${parsed.remote_entity_id}: ${result.message}. Use web_search to confirm the correct service call for this device.`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  // Poll the same remote entity used for the pre-command state check.
  const reachedTarget = (state: string | undefined): boolean => {
    // Only an explicit remote power state verifies the target. Losing contact
    // with a device is not confirmation that it powered off.
    return state?.toLowerCase() === parsed.desired_state;
  };

  await delay(defaultWait, context.abortSignal);

  const pollBudgetMs = 8000;
  const pollIntervalMs = 750;
  const deadline = Date.now() + pollBudgetMs;
  let currentState = (
    await getDeviceEntityState(parsed.remote_entity_id, context)
  ).state;

  while (!reachedTarget(currentState) && Date.now() < deadline) {
    await delay(pollIntervalMs, context.abortSignal);
    await context.waitIfPaused?.();
    context.abortSignal?.throwIfAborted();
    currentState = (
      await getDeviceEntityState(parsed.remote_entity_id, context)
    ).state;
  }

  const confirmed = reachedTarget(currentState);
  const note = confirmed
    ? "Requested remote power state confirmed by Home Assistant."
    : `The power service was accepted, but Home Assistant has not confirmed the requested "${parsed.desired_state}" state (previously "${remoteState.state}"). The command is not verified; inspect the device integration or Home Assistant Core component before retrying.`;

  return {
    observation: `${confirmed ? "Successfully completed" : "Sent"} "${command}" to ${parsed.remote_entity_id}. ${parsed.reason}. ${note} Remote state: ${currentState}`,
    needsScreenshot: false,
    toolSuccess: confirmed,
  };
}

export const definition: TvToolDefinition = {
  name: "click_power_button",
  description:
    "Set the TV or device to the explicit desired_state (on to wake, off to sleep). Never toggle or infer the target by inverting observed state. Returns Home Assistant's remote state for verification; an accepted command alone does not verify the display.",
  inputSchema,
  execute,
};
