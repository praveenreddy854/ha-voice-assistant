import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { getKnownDeviceStates, executeHACommand } from "../../../ha";
import { delay } from "../../common/utils";
import { TV_DEFAULT_WAIT_MS } from "../../../config";

export const inputSchema = z.object({
  action: z.enum([
    "play", "pause", "stop", "rewind", "fast_forward",
    "volume_up", "volume_down", "mute", "unmute",
    "next", "previous", "skip_forward", "skip_backward",
  ]).describe("Media control action to perform."),
  remote_entity_id: z.string().describe(
    "Home Assistant entity ID of the remote control to use."
  ),
  reason: z.string().describe(
    "Why you're performing this media control action."
  ),
});

export type MediaControlInput = z.infer<typeof inputSchema>;

const ACTION_COMMANDS: Record<string, (device: string) => string> = {
  play: (d) => `Play on ${d}`,
  pause: (d) => `Pause on ${d}`,
  stop: (d) => `Stop on ${d}`,
  rewind: (d) => `Rewind on ${d}`,
  fast_forward: (d) => `Fast forward on ${d}`,
  volume_up: (d) => `Increase volume on ${d}`,
  volume_down: (d) => `Decrease volume on ${d}`,
  mute: (d) => `Mute ${d}`,
  unmute: (d) => `Unmute ${d}`,
  next: (d) => `Next on ${d}`,
  previous: (d) => `Previous on ${d}`,
  skip_forward: (d) => `Skip forward on ${d}`,
  skip_backward: (d) => `Skip backward on ${d}`,
};

async function execute(
  args: MediaControlInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = parsed.remote_entity_id.replace("remote.", "");
  const buildCommand = ACTION_COMMANDS[parsed.action];
  const plainCommand = buildCommand
    ? buildCommand(deviceName)
    : `${parsed.action} on ${deviceName}`;

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    return {
      observation: `Failed to execute "${plainCommand}": ${result.message}. Use web_search to find the correct service call for this device.`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  await delay(defaultWait);

  const deviceStates = (await getKnownDeviceStates()).filter((d) =>
    d.entity_id.includes(deviceName)
  );

  return {
    observation: `Successfully executed "${plainCommand}". ${parsed.reason}. Device states: ${JSON.stringify(
      deviceStates.map((s) => ({
        entity_id: s.entity_id,
        state: s.state,
        attributes: s.attributes,
      }))
    )}`,
    needsScreenshot: false,
  };
}

export const definition: TvToolDefinition = {
  name: "media_control",
  description:
    "Control media playback and audio settings including play, pause, stop, rewind, fast forward, volume up/down, mute/unmute, and seeking. Use this for all media playback and audio control operations. Returns updated device state automatically - no screenshot needed for verification.",
  inputSchema,
  execute,
};
