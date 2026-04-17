import { z } from "zod";
import { TvToolDefinition, ToolExecutionResult } from "./types";
import { getKnownDeviceStates } from "../../../ha";
import { TV_AGENT_DEVICES } from "../../../config";

export const inputSchema = z.object({
  device_name: z.string().optional().describe(
    "Optional: The device name to get state for (e.g., 'living_room_tv', 'samsung_tv'). If not provided, returns all TV-related device states."
  ),
  reason: z.string().describe(
    "Why you need device state (e.g., 'to check if TV is on', 'to verify playback started')."
  ),
});

export type GetDeviceStateInput = z.infer<typeof inputSchema>;

async function execute(args: GetDeviceStateInput): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const allDeviceStates = await getKnownDeviceStates();
  let deviceStates;
  let observationPrefix;

  if (parsed.device_name) {
    deviceStates = allDeviceStates.filter((s) => {
      const entityParts = s.entity_id.split(".");
      if (entityParts.length < 2) return false;
      const entityName = entityParts[1];
      // Match exact name or related sensors (e.g., "appletv" matches "appletv_keyboard_focused")
      return entityName === parsed.device_name || entityName.startsWith(parsed.device_name + "_");
    });

    observationPrefix = `Device states for ${parsed.device_name}`;

    if (deviceStates.length === 0) {
      const availableDevices = allDeviceStates
        .filter((s) => {
          const name = s.entity_id.split(".")[1];
          return TV_AGENT_DEVICES.some((d) => name === d || name.startsWith(d + "_"));
        })
        .map((s) => s.entity_id.split(".")[1])
        .filter((name, index, arr) => arr.indexOf(name) === index)
        .join(", ");

      return {
        observation: `Device with name '${parsed.device_name}' not found. Available device names: ${availableDevices}`,
        needsScreenshot: false,
      };
    }
  } else {
    deviceStates = allDeviceStates.filter((s) => {
      const entityName = s.entity_id.split(".")[1];
      return TV_AGENT_DEVICES.some((d) => entityName === d || entityName.startsWith(d + "_"));
    });
    observationPrefix = "TV device states";
  }

  return {
    observation: `${observationPrefix} retrieved: ${JSON.stringify(
      deviceStates.map((s) => ({
        entity_id: s.entity_id,
        state: s.state,
        attributes: s.attributes,
      })),
      null,
      2
    )}`,
    needsScreenshot: false,
  };
}

export const definition: TvToolDefinition = {
  name: "get_device_state",
  description:
    "Get the current state of specific Home Assistant devices (TV, media players, etc.). Use this to check power state, playback status, volume, etc. Returns device states immediately without requiring a screenshot.",
  inputSchema,
  execute,
};
