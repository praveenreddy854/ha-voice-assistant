/**
 * TV Typing Agent Constants and Configuration
 * Specialized agent for text input operations on smart TVs
 */

import { ToolDefinition } from "../tv/agentLoop";

export const TYPING_AGENT_NAME = "tv-typing-agent";

export const TYPING_AGENT_DESCRIPTION =
  "Specialized agent for text input operations on smart TVs, including on-screen keyboard navigation and character-by-character text entry.";

export const TYPING_AGENT_INSTRUCTIONS = `You are a sub agent specialized in text input on smart TVs. Your parent agent will perform high-level orchestration, and your job is to handle the complete text input flow including navigating on-screen keyboards and typing text.

You will be provided a screenshot if not request a screenshot to analyze the keyboard layout and cursor position. Use this information to plan your navigation and typing actions.

Example:
input:
- "Type 'hello world' into the search field"

Output:
Naivagate RIGHT x7 → Then click SELECT        # h
Naivagate LEFT x3 → Then click SELECT         # e
Naivagate RIGHT x7 → Then click SELECT        # l
Click SELECT                  # l Then click
Naivagate RIGHT x3 → Then click SELECT        # o
Naivagate LEFT x15 → Then click SELECT        # space
Naivagate RIGHT x23 → Then click SELECT       # w
Naivagate LEFT x8 → Then click SELECT         # o
Naivagate RIGHT x3 → Then click SELECT        # r
Naivagate LEFT x6 → Then click SELECT         # l
Naivagate LEFT x8 → Then click SELECT         # d
`;

export const TYPING_AGENT_MAX_ITERATIONS_CAP = (() => {
  const parsed = Number.parseInt(
    process.env.TYPING_AGENT_MAX_ITERATIONS ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15; // Text input may require more iterations for longer text
  }
  return Math.max(1, Math.trunc(parsed));
})();

export const MIN_RUN_CREATION_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(
    process.env.TYPING_AGENT_MIN_RUN_INTERVAL_MS ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 1500; // Faster operations for character-by-character input
  }
  return Math.max(0, Math.trunc(parsed));
})();

// Typing Tool Definitions
export const TYPING_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "navigate",
      description:
        "Navigate using directional buttons (up, down, left, right) to move cursor on the on-screen keyboard or UI. Use this to position the cursor on the desired character or button before selecting it.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "Direction to navigate on the keyboard or UI.",
          },
          count: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description:
              "Number of times to press the directional button (1-10). Use count > 1 to quickly move across multiple positions.",
          },
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use (e.g., 'remote.loft_tv', 'remote.family_room_tv', 'remote.appletv').",
          },
          reason: {
            type: "string",
            description:
              "Why you're navigating (e.g., 'to move to letter A', 'to reach the search button').",
          },
        },
        required: ["direction", "count", "remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click_select_button",
      description:
        "Press the select/OK button to type the currently highlighted character on the on-screen keyboard, confirm a selection, or activate a button. Use this after navigating to the desired character or button.",
      parameters: {
        type: "object",
        properties: {
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use (e.g., 'remote.loft_tv', 'remote.family_room_tv', 'remote.appletv').",
          },
          reason: {
            type: "string",
            description:
              "Why you're pressing select (e.g., 'to type letter A', 'to confirm search', 'to select the highlighted character').",
          },
        },
        required: ["remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type_character",
      description:
        "Send a single character or short text string directly to the TV input field using Home Assistant's remote send_command. Use this when the TV supports direct character input without on-screen keyboard navigation. For on-screen keyboards, prefer using navigate + click_select_button instead.",
      parameters: {
        type: "object",
        properties: {
          character: {
            type: "string",
            description:
              "The character or short text to type (e.g., 'a', 'netflix', '123').",
          },
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use (e.g., 'remote.loft_tv', 'remote.family_room_tv', 'remote.appletv').",
          },
          reason: {
            type: "string",
            description:
              "Why you're typing this character (e.g., 'entering first letter of search query').",
          },
        },
        required: ["character", "remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_screenshot",
      description:
        "Capture a screenshot of the current TV display to see the keyboard state, current cursor position, and entered text. CRITICAL: Use this frequently to verify your position on the keyboard and confirm text has been entered correctly.",
      parameters: {
        type: "object",
        properties: {
          media_player_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the TV/media player to screenshot (e.g., 'media_player.loft_tv', 'media_player.family_room_tv').",
          },
          reason: {
            type: "string",
            description:
              "Why you need this screenshot (e.g., 'to see current keyboard position', 'to verify entered text', 'to locate the next character').",
          },
        },
        required: ["media_player_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "go_back",
      description:
        "Press the back button to delete the last character (backspace) or exit the keyboard. Many TV keyboards use the back button as backspace when a text field is focused.",
      parameters: {
        type: "object",
        properties: {
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use.",
          },
          reason: {
            type: "string",
            description:
              "Why you're pressing back (e.g., 'to delete incorrect character', 'to exit keyboard').",
          },
        },
        required: ["remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description:
        "Wait for a specified duration in milliseconds before the next action. Use this when keyboard animations need to complete or to ensure the screen is ready for the next screenshot.",
      parameters: {
        type: "object",
        properties: {
          duration_ms: {
            type: "integer",
            minimum: 100,
            maximum: 5000,
            description:
              "Duration to wait in milliseconds (100-5000ms). Default is 500ms for keyboard operations.",
          },
          reason: {
            type: "string",
            description:
              "Why you're waiting (e.g., 'for keyboard to appear', 'for character to register').",
          },
        },
        required: ["duration_ms", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_keyboard",
      description:
        "Analyze the current TV screenshot to identify the keyboard layout, current cursor position, and optimal navigation path to type the remaining characters. Use this when you need to understand the keyboard structure or plan navigation.",
      parameters: {
        type: "object",
        properties: {
          target_text: {
            type: "string",
            description:
              "The text you're trying to type, so the analysis can suggest the best navigation path.",
          },
          reason: {
            type: "string",
            description:
              "Why you need this analysis (e.g., 'to understand keyboard layout', 'to find optimal path to remaining characters').",
          },
        },
        required: ["target_text", "reason"],
      },
    },
  },
];
