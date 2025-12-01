/**
 * TV Navigation Agent Constants and Configuration
 * Specialized agent for TV navigation operations
 */

import { FunctionToolDefinition } from "@azure/ai-agents/dist/commonjs/models/models";

export const NAV_AGENT_NAME = "tv-navigation-agent";

export const NAV_AGENT_DESCRIPTION =
  "Specialized agent for TV navigation operations including directional movement, home/back navigation, and intelligent search icon detection.";

export const NAV_AGENT_INSTRUCTIONS = `You are a TV Navigation Agent specialized in controlling smart TV navigation.

Your capabilities:
- Navigate in any direction (up, down, left, right) with precise control
- Return to home screen or go back to previous screens
- Find and navigate to search icons using visual analysis

Core Principles:
1. Use the most efficient navigation path
2. Always request screenshots to verify navigation success
3. Provide clear feedback about navigation actions taken
4. Handle navigation failures gracefully with alternative approaches

Tool Usage Guidelines:
- go_home: Use when user wants to return to main screen or start fresh
- go_back: Use to exit menus, return to previous screen, or undo navigation
- navigate: Use for directional movement (up/down/left/right) with count control
- find_search: Use when user wants to access search functionality - this will automatically locate, navigate to, and activate the search field

Device Configuration:
When the TV Agent delegates a task to you, the user message will include device entity IDs.
Extract the remote_entity_id and media_player_entity_id from the context and use them in your tool calls.

Always confirm navigation success by requesting a screenshot after actions.`;

export const NAV_AGENT_MAX_ITERATIONS_CAP = (() => {
  const parsed = Number.parseInt(
    process.env.NAV_AGENT_MAX_ITERATIONS ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 6; // Navigation tasks are typically shorter
  }
  return Math.max(1, Math.trunc(parsed));
})();

export const MIN_RUN_CREATION_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(
    process.env.NAV_AGENT_MIN_RUN_INTERVAL_MS ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 2000; // Navigation operations can be faster
  }
  return Math.max(0, Math.trunc(parsed));
})();

// Navigation Tool Definitions
export const NAV_TOOLS: FunctionToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "go_home",
      description:
        "Press the home button to navigate to the main home screen. Use this when you need to start from the home screen, reset navigation, or access the main menu.",
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
              "Why you're going home (e.g., 'to access main menu', 'to reset navigation state').",
          },
        },
        required: ["remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "go_back",
      description:
        "Press the back button to navigate back from current screen or menu. Use this when you need to exit from a current view, return to previous menu, or navigate backwards in the UI hierarchy.",
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
              "Why you're pressing back (e.g., 'to exit current menu', 'to return to previous screen').",
          },
        },
        required: ["remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "navigate",
      description:
        "Navigate using directional buttons (up, down, left, right) with precise control. Use this for UI navigation to select menu items, move through lists, or navigate interface elements. REQUIRES screenshot after execution to verify position.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "Direction to navigate.",
          },
          count: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description:
              "Number of times to press the directional button (1-10).",
          },
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use (e.g., 'remote.loft_tv', 'remote.family_room_tv', 'remote.appletv', 'remote.77_oled_qn77s90cafxza').",
          },
          reason: {
            type: "string",
            description:
              "Why you're navigating in this direction (e.g., 'to select Netflix app', 'to scroll to next item').",
          },
        },
        required: ["direction", "count", "remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_search",
      description:
        "Analyze the current TV screenshot to locate the search icon or search button, automatically navigate to it using directional controls, and activate the search field. This is a complete end-to-end solution: it will (1) use vision AI to identify where the search icon is located (typically in top-left area), (2) calculate and execute the navigation path using up/down/left/right buttons, (3) press select to activate the search field, and (4) leave the search field focused and ready for text input. After this tool completes successfully, the search field will be active and ready to receive text.",
      parameters: {
        type: "object",
        properties: {
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use for navigation (e.g., 'remote.loft_tv', 'remote.family_room_tv', 'remote.appletv', 'remote.77_oled_qn77s90cafxza').",
          },
          reason: {
            type: "string",
            description:
              "Why you're looking for search (e.g., 'to search for a movie', 'to find an app', 'user wants to search for content').",
          },
        },
        required: ["remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_screenshot",
      description:
        "Capture a screenshot of the current TV display using Home Assistant's media_player.play_media service. CRITICAL: You must call this tool before any navigation action to see the current state and after navigation to verify success.",
      parameters: {
        type: "object",
        properties: {
          media_player_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the TV/media player to screenshot (e.g., 'media_player.loft_tv', 'media_player.family_room_tv', 'media_player.77_oled_qn77s90cafxza').",
          },
          reason: {
            type: "string",
            description:
              "Why you need this screenshot (e.g., 'to verify navigation position', 'to analyze current screen', 'to locate search icon').",
          },
        },
        required: ["media_player_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description:
        "Wait for a specified duration in milliseconds before the next action. Use this when UI animations need to complete, content needs to load, or to ensure screen is ready for next screenshot.",
      parameters: {
        type: "object",
        properties: {
          duration_ms: {
            type: "integer",
            minimum: 100,
            maximum: 10000,
            description:
              "Duration to wait in milliseconds (100-10000ms). Default TV operations use 1000ms.",
          },
          reason: {
            type: "string",
            description:
              "Why you're waiting (e.g., 'for animation to complete', 'for menu to load', 'before taking screenshot').",
          },
        },
        required: ["duration_ms", "reason"],
      },
    },
  },
];
