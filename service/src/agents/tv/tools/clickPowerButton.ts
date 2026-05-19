import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { getKnownDeviceStates, callHAServiceDirect } from "../../../ha";
import { delay } from "../../common/utils";
import { TV_DEFAULT_WAIT_MS } from "../../../config";

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

  const deviceName = parsed.remote_entity_id.replace("remote.", "");

  // Check current state to decide wakeup vs suspend
  const preStates = (await getKnownDeviceStates()).filter((d) =>
    d.entity_id.includes(deviceName)
  );
  const mediaPlayer = preStates.find((s) => s.entity_id.startsWith("media_player."));
  const isOff = mediaPlayer && (mediaPlayer.state === "standby" || mediaPlayer.state === "off");

  // Use direct HA API with wakeup/suspend for speed and reliability
  // (bypasses LLM-mediated command translation)
  const command = isOff !== false ? "wakeup" : "suspend";
  const result = await callHAServiceDirect(
    "remote", "send_command",
    parsed.remote_entity_id,
    { command }
  );

  if (!result.success) {
    return {
      observation: `Failed to send "${command}" to ${parsed.remote_entity_id}: ${result.message}. Use web_search to find the correct service call for this device.`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  // Apple TV (and similar) report stale media_player state for 10-30s after a
  // power transition. Poll until HA reflects the transition or the budget
  // expires so the agent gets ground truth instead of a misleading snapshot.
  const offStates = new Set(["off", "standby", "unavailable", "unknown"]);
  const reachedTarget = (state: string | undefined): boolean => {
    if (!state) return false;
    return command === "wakeup" ? !offStates.has(state) : offStates.has(state);
  };

  await delay(defaultWait);

  const pollBudgetMs = 8000;
  const pollIntervalMs = 750;
  const deadline = Date.now() + pollBudgetMs;
  let deviceStates = (await getKnownDeviceStates()).filter((d) =>
    d.entity_id.includes(deviceName)
  );
  let mediaPlayerState = deviceStates.find((s) =>
    s.entity_id.startsWith("media_player.")
  )?.state;

  while (!reachedTarget(mediaPlayerState) && Date.now() < deadline) {
    await delay(pollIntervalMs);
    deviceStates = (await getKnownDeviceStates()).filter((d) =>
      d.entity_id.includes(deviceName)
    );
    mediaPlayerState = deviceStates.find((s) =>
      s.entity_id.startsWith("media_player.")
    )?.state;
  }

  const confirmed = reachedTarget(mediaPlayerState);
  const stateSummary = JSON.stringify(
    deviceStates.map((s) => ({ entity_id: s.entity_id, state: s.state }))
  );
  const note = confirmed
    ? "State change confirmed by Home Assistant."
    : "Home Assistant has not yet reflected the state change; Apple TV state often lags 10-30s, so the command likely still took effect — proceed and verify via the next action.";

  return {
    observation: `Successfully sent "${command}" to ${parsed.remote_entity_id}. ${parsed.reason}. ${note} Device states: ${stateSummary}`,
    needsScreenshot: false,
  };
}

export const definition: TvToolDefinition = {
  name: "click_power_button",
  description:
    "Turn the TV or device on/off using the power button. Use this for device power management. Returns updated device state automatically - no screenshot needed for verification.",
  inputSchema,
  execute,
};
