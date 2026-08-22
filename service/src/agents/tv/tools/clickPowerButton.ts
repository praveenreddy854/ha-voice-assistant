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

  // Query the exact remote entity before deciding whether to turn it on/off.
  const remoteState = await getDeviceEntityState(
    parsed.remote_entity_id,
    context
  );
  const isOff = remoteState.state === "off";
  const integration = getDeviceIntegration(parsed.remote_entity_id);

  // Use the integration-specific power service directly for reliability.
  const command = isOff ? "turn_on" : "turn_off";
  await context.waitIfPaused?.();
  context.abortSignal?.throwIfAborted();
  const result = integration === "samsungtv"
    ? await callHAServiceDirect(
        "remote",
        command,
        parsed.remote_entity_id
      )
    : await callHAServiceDirect(
        "remote",
        "send_command",
        parsed.remote_entity_id,
        { command: isOff ? "wakeup" : "suspend" }
      );

  if (!result.success) {
    return {
      observation: `Failed to send "${command}" to ${parsed.remote_entity_id}: ${result.message}. Use web_search to confirm the correct service call for this device.`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  // Poll the same remote entity used for the pre-command state check.
  const offStates = new Set(["off", "standby", "unavailable", "unknown"]);
  const reachedTarget = (state: string | undefined): boolean => {
    if (!state) return false;
    return command === "turn_on" ? !offStates.has(state) : offStates.has(state);
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
    ? "State change confirmed by Home Assistant."
    : "The power service was accepted, but Home Assistant still reports the original state. The command is not verified; inspect the device integration or Home Assistant Core component before retrying.";

  return {
    observation: `${confirmed ? "Successfully completed" : "Sent"} "${command}" to ${parsed.remote_entity_id}. ${parsed.reason}. ${note} Remote state: ${currentState}`,
    needsScreenshot: false,
    toolSuccess: confirmed,
  };
}

export const definition: TvToolDefinition = {
  name: "click_power_button",
  description:
    "Turn the TV or device on/off using the power button. Use this for device power management. Returns updated device state automatically - no screenshot needed for verification.",
  inputSchema,
  execute,
};
