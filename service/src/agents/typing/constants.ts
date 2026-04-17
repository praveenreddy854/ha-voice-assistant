/**
 * TV Typing Agent Constants and Configuration
 * Specialized agent for text input operations on smart TVs
 */

import { ToolDefinition } from "../core/agentLoop";

export const TYPING_AGENT_NAME = "tv-typing-agent";

export const TYPING_AGENT_DESCRIPTION =
  "Specialized agent for text input operations on smart TVs using deterministic keyboard navigation.";

export const TYPING_AGENT_INSTRUCTIONS = `You are a sub agent specialized in text input on smart TVs. Your parent agent will perform high-level orchestration, and your job is to handle the text input flow using the deterministic typing tool.

## Screenshot Rules
- If a screenshot is already available, analyze it first — it is the source of truth for cursor position.
- Only request a screenshot when none is available AND you have not received any keyboard layout information.

## CRITICAL: Use deterministic_typing

ALWAYS use the \`deterministic_typing\` tool for typing text. This tool:
- Handles all navigation math deterministically — you do NOT need to calculate counts.
- Accepts the FULL text (including spaces) in a single call.
- Types word by word. After each word it checks if a suggestion pill below the keyboard matches the target — if so, it selects the suggestion automatically and returns early.
- If no suggestion matches after all words, it returns success with the full text typed.

### Your only job:
1. Look at the screenshot and identify which character the cursor is currently on.
2. Call \`deterministic_typing\` with the FULL text and the current cursor position.
3. When it succeeds → call \`complete_task\` immediately. No screenshot needed.

### Examples:
- Full text: \`deterministic_typing(text="latest telugu songs", current_cursor_position="a")\`

### IMPORTANT: current_cursor_position
- When the keyboard first opens, the cursor is usually on 'a'.
- After \`deterministic_typing\` completes (success or error), the observation tells you the final cursor position — use that for any follow-up call.
- If you're unsure, request a screenshot and look at which character is highlighted.

### Error Correction (only if deterministic_typing reports a HA command failure)
- Use \`delete_typed_text\` to delete incorrect characters (this navigates to the DELETE key on the keyboard strip — it does NOT press the TV back button).
- Call \`deterministic_typing\` again with the remaining untyped text. After delete_typed_text, the cursor is on DELETE (position 28) — pass "delete" as current_cursor_position.
- NEVER press the TV back/menu button during typing — that exits the app entirely.
`;

export const TYPING_AGENT_MAX_ITERATIONS_CAP = (() => {
  const parsed = Number.parseInt(
    process.env.TYPING_AGENT_MAX_ITERATIONS ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15; // Deterministic typing handles validation internally; iterations needed only for retries
  }
  return Math.max(1, Math.trunc(parsed));
})();

export const MIN_RUN_CREATION_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(
    process.env.TYPING_AGENT_MIN_RUN_INTERVAL_MS ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 1500;
  }
  return Math.max(0, Math.trunc(parsed));
})();

// Typing Tool Definitions
export const TYPING_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "get_latest_screenshot",
      description:
        "Get the latest screenshot from the TV camera to see the keyboard state, current cursor position, and entered text. The client continuously captures screenshots in the background. Use this to verify your position on the keyboard and confirm text has been entered correctly.",
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
              "Why you need this screenshot (e.g., 'to see current keyboard position', 'to verify entered text').",
          },
        },
        required: ["media_player_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_typed_text",
      description:
        "Delete the last typed character by navigating to the DELETE key on the on-screen keyboard strip and pressing select. This does NOT press the TV back/menu button (which would exit the app). Safe to call repeatedly to delete multiple characters.",
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
              "Why you're deleting (e.g., 'to delete incorrect character').",
          },
        },
        required: ["remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deterministic_typing",
      description:
        "Deterministic keyboard typing with autocomplete suggestion detection. Pass the FULL text and the current cursor position. The tool types word by word, and after each word checks if a matching suggestion pill appeared below the keyboard — if so, it selects the suggestion automatically and returns early. If no suggestion matches, it continues typing. On success, call complete_task immediately — no screenshot needed. You MUST identify the current cursor position from the screenshot before calling this tool.",
      parameters: {
        type: "object",
        properties: {
          text: {
            type: "string",
            description:
              "The FULL text to type on the keyboard (e.g., 'latest telugu songs'). Only lowercase letters and spaces are supported. Pass the complete query — the tool handles word-by-word typing and validation internally.",
          },
          current_cursor_position: {
            type: "string",
            description:
              "The character currently highlighted/selected on the on-screen keyboard. Use the screenshot to identify this. Examples: 'a', 'h', 'space'. When the keyboard first opens, this is usually 'a'.",
          },
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control to use.",
          },
          media_player_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the TV/media player.",
          },
          reason: {
            type: "string",
            description: "Why this text is being typed.",
          },
        },
        required: [
          "text",
          "current_cursor_position",
          "remote_entity_id",
          "media_player_entity_id",
          "reason",
        ],
      },
    },
  },
];
