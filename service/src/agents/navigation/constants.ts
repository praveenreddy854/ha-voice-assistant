/**
 * TV Navigation Agent Constants and Configuration
 * Specialized agent for TV navigation operations
 */

import { toToolDefinitions } from "./tools";

export const NAV_AGENT_NAME = "tv-navigation-agent";

export const NAV_AGENT_DESCRIPTION =
  "Specialized agent for TV navigation operations including directional movement, home/back navigation, and intelligent search icon detection.";

export const NAV_AGENT_INSTRUCTIONS = `You are a specialized Navigation Agent for smart TV control. Your job is to execute navigation tasks on a smart TV or media player via Home Assistant remote control commands.
You will be provided with screenshots of the TV display to analyze the current state and determine the best navigation actions. Use the available tools to move the selection cursor, go home, go back, click select, find the search icon, and request screenshots as needed.`;

export const NAV_AGENT_MAX_ITERATIONS_CAP = (() => {
  const parsed = Number.parseInt(
    process.env.NAV_AGENT_MAX_ITERATIONS ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 12;
  }
  return Math.max(1, Math.trunc(parsed));
})();

export const MIN_RUN_CREATION_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(
    process.env.NAV_AGENT_MIN_RUN_INTERVAL_MS ?? "",
    10
  );
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 2000;
  }
  return Math.max(0, Math.trunc(parsed));
})();

// Export tools in Azure/OpenAI format from the unified registry
export const NAV_TOOLS = toToolDefinitions();
