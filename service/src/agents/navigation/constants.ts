/**
 * TV Navigation Agent Constants and Configuration
 * Specialized agent for TV navigation operations
 */

import { ToolDefinition } from "../core/agentLoop";

export const NAV_AGENT_NAME = "tv-navigation-agent";

export const NAV_AGENT_DESCRIPTION =
  "Specialized agent for TV navigation operations including directional movement, home/back navigation, and intelligent search icon detection.";

export const NAV_AGENT_INSTRUCTIONS = `You are a specialized Navigation Agent for smart TV control. Your job is to execute navigation tasks on a smart TV or media player via Home Assistant remote control commands.

## Your Capabilities
- Navigate TV interfaces using directional buttons (up, down, left, right)
- Go to home screen or go back to previous screens
- Find and activate search functionality using AI vision analysis
- Press select button to confirm selections

## CRITICAL: Screenshot-Based Navigation
You will receive screenshots of the TV screen. ALWAYS analyze the screenshot FIRST before taking action:
1. **CHECK IF CONTENT IS PLAYING** - If you see a video/media playing (fullscreen video, player controls, movie/show playing), you MUST press go_back FIRST to exit the player before you can navigate!
2. Identify your current position (what is highlighted/selected)
3. Identify your target (where you need to go)
4. Calculate the most efficient navigation path
5. Execute navigation commands
6. Verify the result with a new screenshot

## IMPORTANT: Handling Active Playback
When content is currently playing (YouTube video, Netflix show, etc.):
- The screen will show fullscreen video content or player UI
- Navigation buttons (up/down/left/right) will NOT work as expected during playback
- You MUST press go_back to exit the player first
- After exiting, you'll see the app's browse UI where navigation works
- Then proceed with your navigation task

Signs that content is playing:
- Fullscreen video/movie visible
- Player controls (progress bar, play/pause icons) on screen
- No navigation menu or browse UI visible
- Video thumbnail with "Now Playing" indicator

## Navigation Strategy
- **Finding Search**: Search icons are typically in the TOP-LEFT corner of streaming apps (YouTube, Netflix, etc.)
- **From content area**: Usually need to navigate UP first to reach the top menu bar
- **Navigation bar**: Look for icons like magnifying glass 🔍, profile icons, settings icons
- **Currently selected item**: Usually has a highlight, border, or different background color

## Tool Usage Pattern
1. If you have a screenshot, analyze it to understand current UI state
2. Use navigate tool with appropriate direction and count
3. After navigation, the system will provide a new screenshot automatically
4. Verify you reached the target, if not adjust and try again
5. Use click_select_button when the target is highlighted
6. Call complete_task when the navigation goal is achieved

## Common Patterns
- **YouTube**: Search is top-left, usually 1-2 up + 0-3 left from content
- **Netflix**: Search/Profile in top navigation bar
- **Apple TV**: Search in top row of home screen
- **Prime Video**: Search icon in top-left area

## Device Configuration
The user message includes device entity IDs. Use these in your tool calls:
- remote_entity_id: For sending navigation commands
- media_player_entity_id: For screenshot requests

## Important Rules
1. NEVER guess - always work from visual evidence in screenshots
2. Take small navigation steps (1-3 presses) and verify
3. If lost or confused, use go_home to reset and start over
4. Count visible items to calculate navigation distance
5. Complete your task efficiently - don't over-navigate`;

export const NAV_AGENT_MAX_ITERATIONS_CAP = (() => {
  const parsed = Number.parseInt(
    process.env.NAV_AGENT_MAX_ITERATIONS ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 12; // Increased from 6 to allow more complex navigation sequences
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
export const NAV_TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "go_home",
      description:
        "Press the HOME button to navigate to the main home screen. Use when: (1) you need to reset navigation after getting lost, (2) starting a new task from a known state, (3) the current screen is unrecognizable. After pressing home, always verify with the next screenshot that you reached the home screen.",
      parameters: {
        type: "object",
        properties: {
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv').",
          },
          reason: {
            type: "string",
            description:
              "Why you're going home (e.g., 'to reset after failed navigation', 'to access main app menu').",
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
        "Press the BACK button to return to the previous screen. CRITICAL: Use this FIRST when content is playing (video, movie, show) - you MUST exit the player before navigation will work! Also use when: (1) you entered a wrong menu, (2) need to exit current context, (3) to get from player view to browse view. This is often the FIRST step when given a navigation task if something is currently playing.",
      parameters: {
        type: "object",
        properties: {
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv').",
          },
          reason: {
            type: "string",
            description:
              "Why you're pressing back (e.g., 'to exit playing video before navigation', 'to return to app home').",
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
        "Move the selection cursor using directional buttons (UP/DOWN/LEFT/RIGHT). This is your primary navigation tool. IMPORTANT: Always analyze the screenshot first to understand (1) where you currently are (highlighted item) and (2) where you need to go, then calculate the minimum number of presses needed. After navigation, the result will include a screenshot - always verify you moved to the expected position.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
            description: "Direction to move the selection cursor.",
          },
          count: {
            type: "integer",
            minimum: 1,
            maximum: 10,
            description:
              "Number of button presses (1-10). Start with small counts (1-3) and verify, rather than large jumps.",
          },
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv').",
          },
          reason: {
            type: "string",
            description:
              "Explain your navigation plan (e.g., 'moving up 2 positions to reach top menu bar', 'going left to search icon').",
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
        "ADVANCED TOOL: Uses AI vision to automatically locate and navigate to the search icon, then activates it. This performs multiple steps: (1) analyzes screenshot to find search icon position, (2) calculates navigation path, (3) executes navigation commands, (4) presses select to activate search. REQUIRES a screenshot - if none available, returns guidance for manual navigation. Best for: YouTube, Netflix, Prime Video where search is in top-left area.",
      parameters: {
        type: "object",
        properties: {
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv').",
          },
          reason: {
            type: "string",
            description:
              "Why you need to find search (e.g., 'user wants to search for Breaking Bad').",
          },
        },
        required: ["remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click_select_button",
      description:
        "Press the SELECT/OK button to activate the currently highlighted item. Use this to: (1) open apps, (2) enter menus, (3) confirm selections, (4) activate input fields, (5) select profiles. Always verify the correct item is highlighted before pressing select.",
      parameters: {
        type: "object",
        properties: {
          remote_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv').",
          },
          reason: {
            type: "string",
            description:
              "What you're selecting and why (e.g., 'selecting search icon to open search', 'choosing user profile').",
          },
        },
        required: ["remote_entity_id", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_latest_screenshot",
      description:
        "Request a fresh screenshot of the TV display. The screenshot will be included in the next tool response for analysis. Use this when: (1) you need to see current TV state, (2) verifying a navigation action worked, (3) the previous screenshot is stale after multiple actions.",
      parameters: {
        type: "object",
        properties: {
          media_player_entity_id: {
            type: "string",
            description:
              "Home Assistant entity ID of the TV/media player (e.g., 'media_player.loft_tv', 'media_player.appletv').",
          },
          reason: {
            type: "string",
            description:
              "Why you need a screenshot (e.g., 'to verify search field is active', 'to see current selection').",
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
        "Pause execution for a specified duration. Use when: (1) waiting for UI animations to complete, (2) app is loading, (3) transition between screens. Typical wait times: 500-1000ms for UI animations, 1500-3000ms for app loading.",
      parameters: {
        type: "object",
        properties: {
          duration_ms: {
            type: "integer",
            minimum: 100,
            maximum: 10000,
            description:
              "Wait duration in milliseconds. Recommend: 500-1000 for UI updates, 1500-3000 for loading.",
          },
          reason: {
            type: "string",
            description:
              "Why waiting is needed (e.g., 'app is launching', 'waiting for menu animation').",
          },
        },
        required: ["duration_ms", "reason"],
      },
    },
  },
];