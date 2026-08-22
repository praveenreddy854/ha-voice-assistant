import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { getKnownDeviceStates, executeHACommand } from "../../../ha";
import { delay } from "../../common/utils";
import { TV_DEFAULT_WAIT_MS } from "../../../config";

export const inputSchema = z.object({
  app_name: z.string().describe(
    "Name of the app to launch (e.g., 'Netflix', 'YouTube', 'Spotify', 'Disney+'). If not specified make your best guess based on context or use YouTube as default."
  ),
  media_player_entity_id: z.string().describe(
    "Home Assistant entity ID of the media player to launch the app on (e.g., 'media_player.appletv')."
  ),
  reason: z.string().describe(
    "Why you're launching this app in context of the goal."
  ),
});

export type LaunchAppInput = z.infer<typeof inputSchema>;

async function execute(
  args: LaunchAppInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;

  const deviceName = parsed.media_player_entity_id.replace("media_player.", "");
  const plainCommand = `Launch ${parsed.app_name} on ${deviceName}`;

  const result = await executeHACommand(plainCommand);

  if (!result.success) {
    return {
      observation: `Failed to launch ${parsed.app_name}: ${result.message}. Use web_search to find the correct service call for this device (e.g. query the component name).`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  await delay(defaultWait, context.abortSignal);

  const allDeviceStates = await getKnownDeviceStates();
  const mediaPlayerStates = allDeviceStates.filter(
    (s) => s.entity_id === parsed.media_player_entity_id
  );

  let appLaunchStatus = "unknown";
  let currentApp = "unknown";
  let deviceState = "unknown";

  if (mediaPlayerStates.length > 0) {
    const mediaPlayer = mediaPlayerStates[0];
    deviceState = mediaPlayer.state;

    const attributes = mediaPlayer.attributes || {};
    currentApp =
      attributes.app_name ||
      attributes.media_title ||
      attributes.source ||
      attributes.app_id ||
      "unknown";

    if (currentApp && typeof currentApp === "string") {
      const normalizedCurrentApp = currentApp.toLowerCase();
      const normalizedRequestedApp = parsed.app_name.toLowerCase();

      if (
        normalizedCurrentApp.includes(normalizedRequestedApp) ||
        normalizedRequestedApp.includes(normalizedCurrentApp)
      ) {
        appLaunchStatus = "success";
      } else {
        appLaunchStatus = "different_app";
      }
    }
  }

  let observation = `App "${parsed.app_name}" launch command sent to ${parsed.media_player_entity_id}. `;

  if (appLaunchStatus === "success") {
    observation += `✅ SUCCESS: ${parsed.app_name} is now active on the device.`;
  } else if (appLaunchStatus === "different_app") {
    observation += `⚠️ PARTIAL: Launch command sent, but device shows "${currentApp}" instead of "${parsed.app_name}". Device state: ${deviceState}.`;
  } else {
    observation += `❓ UNKNOWN: Launch command sent, but unable to verify app status. Device state: ${deviceState}, Current app: ${currentApp}.`;
  }

  observation += ` ${parsed.reason}`;

  if (mediaPlayerStates.length > 0) {
    observation += ` Device details: ${JSON.stringify({
      entity_id: mediaPlayerStates[0].entity_id,
      state: mediaPlayerStates[0].state,
      attributes: {
        app_name: mediaPlayerStates[0].attributes?.app_name,
        media_title: mediaPlayerStates[0].attributes?.media_title,
        source: mediaPlayerStates[0].attributes?.source,
        app_id: mediaPlayerStates[0].attributes?.app_id,
      },
    })}`;
  }

  const verified = appLaunchStatus === "success";
  if (!verified) {
    observation +=
      " Command verification failed; inspect the device integration documentation or Home Assistant Core component source before retrying.";
  }

  return { observation, needsScreenshot: false, toolSuccess: verified };
}

export const definition: TvToolDefinition = {
  name: "launch_app",
  description:
    "Launch or open a specific app on the TV or media player using simple plain English commands. The system converts your command to appropriate Home Assistant API calls. Returns updated device state automatically - no screenshot needed for verification. From the given devices state, if the app is already open skip launching it again.",
  inputSchema,
  execute,
};
