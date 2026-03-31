/**
 * TV Agent Constants and Configuration
 * Centralized configuration values for the TV automation agent
 */

import { ToolDefinition } from "./agentLoop";
import fs from "fs";
import path from "path";

export const TV_AGENT_NAME = "tv-ui-automation-agent";

export const TV_AGENT_DESCRIPTION =
  "Autonomous home-theater control agent that performs multi-step tasks on smart devices through Home Assistant APIs and visual feedback loops.";

/**
 * Load TV Agent instructions from the TVAGENT.md file
 * This allows for easier maintenance and updates to agent behavior
 */
function loadTvAgentInstructions(): string {
  try {
    const instructionsPath = path.join(
      __dirname,
      "../../prompts",
      "TVAGENT.md"
    );
    return fs.readFileSync(instructionsPath, "utf8");
  } catch (error) {
    console.error(
      "Failed to load TVAGENT.md, using fallback instructions:",
      error
    );
    throw error;
  }
}

export const TV_AGENT_INSTRUCTIONS = loadTvAgentInstructions();

export const TV_AGENT_MAX_ITERATIONS_CAP = (() => {
  const parsed = Number.parseInt(process.env.TV_AGENT_MAX_ITERATIONS ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 20;
  }
  return Math.max(1, Math.trunc(parsed));
})();

export const MIN_RUN_CREATION_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(
    process.env.TV_AGENT_MIN_RUN_INTERVAL_MS ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 3000; // More conservative rate limiting: ~20 requests per minute
  }
  return Math.max(0, Math.trunc(parsed));
})();

// Tool Definitions - Multiple specialized tools instead of one generic tool
export const TV_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "click_power_button",
      description:
        "Turn the TV or device on/off using the power button. Use this for device power management. Returns updated device state automatically - no screenshot needed for verification.",
      parameters: {
        type: "object",
        properties: {
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use (e.g., 'remote.loft_tv', 'remote.family_room_tv', 'remote.appletv', 'remote.77_oled_qn77s90cafxza').",
          },
          reason: {
            type: "string",
            description:
              "Why you're using power button (e.g., 'to turn on TV for user request', 'to turn off TV after completion').",
          },
        },
        required: ["remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "media_control",
      description:
        "Control media playback and audio settings including play, pause, stop, rewind, fast forward, volume up/down, mute/unmute, and seeking. Use this for all media playback and audio control operations. Returns updated device state automatically - no screenshot needed for verification.",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: [
              "play",
              "pause",
              "stop",
              "rewind",
              "fast_forward",
              "volume_up",
              "volume_down",
              "mute",
              "unmute",
              "next",
              "previous",
              "skip_forward",
              "skip_backward",
            ],
            description: "Media control action to perform.",
          },
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use (e.g., 'remote.loft_tv', 'remote.family_room_tv', 'remote.appletv', 'remote.77_oled_qn77s90cafxza').",
          },
          reason: {
            type: "string",
            description:
              "Why you're performing this media control action (e.g., 'user requested to pause video', 'adjusting volume per user request').",
          },
        },
        required: ["action", "remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click_select_button",
      description:
        "Press the select/OK button to confirm selections, enter menus, or activate highlighted items. Use this after navigating to desired menu items or buttons that need to be activated.",
      parameters: {
        type: "object",
        properties: {
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use (e.g., 'remote.loft_tv', 'remote.family_room_tv', 'remote.appletv', 'remote.77_oled_qn77s90cafxza').",
          },
          reason: {
            type: "string",
            description:
              "Why you're pressing select (e.g., 'to open selected app', 'to confirm menu selection', 'to activate search field').",
          },
        },
        required: ["remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_menu",
      description:
        "Open the main menu, settings menu, or context menu depending on the current screen. Use this to access device settings, additional options, or when you need to find menu-specific functionality.",
      parameters: {
        type: "object",
        properties: {
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use (e.g., 'remote.loft_tv', 'remote.family_room_tv', 'remote.appletv', 'remote.77_oled_qn77s90cafxza').",
          },
          reason: {
            type: "string",
            description:
              "Why you're opening menu (e.g., 'to access settings', 'to find additional options', 'to locate specific functionality').",
          },
        },
        required: ["remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_to_typing",
      description:
        "Delegate text input tasks to a specialized Typing Agent. IMPORTANT PREREQUISITES: Only call this tool AFTER: (1) Navigation to search has completed successfully, (2) The search input field has been activated (select button pressed), (3) You have verified via screenshot that an on-screen keyboard is visible. If no keyboard is visible, the typing will fail. The keyboard typically appears after pressing select on a search icon or input field.",
      parameters: {
        type: "object",
        properties: {
          text_to_type: {
            type: "string",
            description: "The text to type into the focused input field (e.g., 'Netflix', 'Breaking Bad', 'comedy movies').",
          },
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use (e.g., 'remote.loft_tv', 'remote.family_room_tv', 'remote.appletv', 'remote.77_oled_qn77s90cafxza').",
          },
          media_player_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the TV/media player (e.g., 'media_player.loft_tv', 'media_player.family_room_tv').",
          },
          reason: {
            type: "string",
            description:
              "Why you're delegating this text input task (e.g., 'to search for a movie', 'to enter username in login field').",
          },
        },
        required: ["text_to_type", "remote_entity_id", "media_player_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_screenshot",
      description:
        "Request a fresh screenshot from the TV camera to see what's currently displayed. Use this when you need visual feedback to make navigation decisions. The screenshot will be included in the next tool response. If there's an active navigation sub-agent session, the screenshot will be automatically routed to that agent.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Why you need a screenshot (e.g., 'to verify search results', 'to locate the next menu item').",
          },
          target_agent: {
            type: "string",
            enum: ["tv", "navigation", "auto"],
            description:
              "Which agent should receive the screenshot. 'auto' (default) automatically determines based on active sessions - routes to navigation agent if there's an active navigation session, otherwise to TV agent. Use 'tv' to force TV agent, 'navigation' to force navigation agent.",
          },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_device_state",
      description:
        "Get the current state of specific Home Assistant devices (TV, media players, etc.). Use this to check power state, playback status, volume, etc. Returns device states immediately without requiring a screenshot.",
      parameters: {
        type: "object",
        properties: {
          device_name: {
            type: "string",
            description:
              "Optional: The device name to get state for (e.g., 'living_room_tv', 'samsung_tv'). This will return all related entities for that device (both remote.* and media_player.* entities). If not provided, returns all TV-related device states.",
          },
          reason: {
            type: "string",
            description:
              "Why you need device state (e.g., 'to check if TV is on', 'to verify playback started').",
          },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "launch_app",
      description:
        "Launch or open a specific app on the TV or media player using simple plain English commands (e.g., 'Launch Netflix on apple_tv', 'Open YouTube on samsung_tv'). The system converts your command to appropriate Home Assistant API calls to open the specified app. Returns updated device state automatically - no screenshot needed for verification. From the given devices state, if the app is already open skip launching it again.",
      parameters: {
        type: "object",
        properties: {
          app_name: {
            type: "string",
            description:
              "Name of the app to launch (e.g., 'Netflix', 'YouTube', 'Spotify', 'Disney+', 'Hulu', 'Amazon Prime Video', 'Apple TV+', 'HBO Max', 'Plex', 'Kodi'). If the app name is not specified make your best guess based on context or use YouTube as default.",
          },
          media_player_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the media player to launch the app on (e.g., 'media_player.appletv', 'media_player.samsung_tv', 'media_player.loft_tv').",
          },
          reason: {
            type: "string",
            description:
              "Why you're launching this app in context of the goal.",
          },
        },
        required: ["app_name", "media_player_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_to_navigation",
      description:
        "Delegate navigation-related tasks to a specialized Navigation Agent. Use this when you need to: (1) navigate to home screen, (2) go back to previous screen, (3) perform directional navigation (up/down/left/right), (4) find and activate search functionality using vision AI or (5) to select user profile after launching an app. The Navigation Agent will handle the complete navigation flow and return the result.",
      parameters: {
        type: "object",
        properties: {
          task_description: {
            type: "string",
            description:
              "Clear description of the navigation task to delegate (e.g., 'go to home screen', 'navigate up 3 times', 'find and activate search', 'go back to previous menu').",
          },
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use (e.g., 'remote.loft_tv', 'remote.family_room_tv', 'remote.appletv', 'remote.77_oled_qn77s90cafxza').",
          },
          media_player_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the TV/media player (e.g., 'media_player.loft_tv', 'media_player.family_room_tv').",
          },
          reason: {
            type: "string",
            description:
              "Why you're delegating this navigation task (e.g., 'user wants to search for content', 'need to return to main menu').",
          },
        },
        required: [
          "task_description",
          "remote_entity_id",
          "media_player_entity_id",
          "reason",
        ],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description:
        "Wait for a specified duration (in milliseconds) to allow UI transitions, loading screens, or animations to complete. Use this before requesting a screenshot if you expect the UI to change.",
      parameters: {
        type: "object",
        properties: {
          duration_ms: {
            type: "integer",
            minimum: 250,
            maximum: 5000,
            description:
              "How long to wait in milliseconds. Default is 1500ms if not specified.",
          },
          reason: {
            type: "string",
            description:
              "Why you're waiting (e.g., 'waiting for search results to load', 'allowing menu animation to complete').",
          },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_screenshot",
      description:
        "Perform detailed AI-powered analysis of the current TV screenshot to identify UI elements, current app, screen context, and navigation options. Use this when you need to understand what's on screen before deciding your next action. Returns structured information about visible UI elements, suggested next actions, and navigation opportunities.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What you're looking for or trying to understand (e.g., 'find search icon location', 'identify current app and screen', 'locate video thumbnails', 'check if keyboard is visible').",
          },
          reason: {
            type: "string",
            description:
              "Why you need this analysis (e.g., 'to determine navigation path to search', 'to verify correct app is open').",
          },
        },
        required: ["query", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify_ui_state",
      description:
        "Verify specific UI state or element visibility on the current TV screen. Use this to confirm that expected UI elements are present before proceeding (e.g., verify search field is focused, confirm app is loaded, check if video is playing). Returns true/false with detailed verification results.",
      parameters: {
        type: "object",
        properties: {
          expected_state: {
            type: "string",
            description:
              "What you expect to see (e.g., 'YouTube app is open', 'search field is focused and keyboard visible', 'video is playing', 'home screen is displayed').",
          },
          reason: {
            type: "string",
            description:
              "Why you're verifying this state (e.g., 'before typing search query', 'to confirm app launched successfully').",
          },
        },
        required: ["expected_state", "reason"],
      },
    },
  },
] as const;
