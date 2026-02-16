/**
 * TV Typing Agent Constants and Configuration
 * Specialized agent for text input operations on smart TVs
 */

import { toToolDefinitions } from "./tools";

export const TYPING_AGENT_NAME = "tv-typing-agent";

export const TYPING_AGENT_DESCRIPTION =
  "Specialized agent for text input operations on smart TVs, including on-screen keyboard navigation and character-by-character text entry.";

export const TYPING_AGENT_INSTRUCTIONS = `You are a sub agent specialized in text input on smart TVs. Your parent agent will perform high-level orchestration, and your job is to handle the complete text input flow including navigating on-screen keyboards and typing text.`;

export const TYPING_AGENT_MAX_ITERATIONS_CAP = (() => {
  const parsed = Number.parseInt(
    process.env.TYPING_AGENT_MAX_ITERATIONS ?? "",
    10,
  );
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 15;
  }
  return Math.max(1, Math.trunc(parsed));
})();

export const MIN_RUN_CREATION_INTERVAL_MS = (() => {
  const parsed = Number.parseInt(
    process.env.TYPING_AGENT_MIN_RUN_INTERVAL_MS ?? "",
    10,
  );
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 1500;
  }
  return Math.max(0, Math.trunc(parsed));
})();

// Export tools in Azure/OpenAI format from the unified registry
export const TYPING_TOOLS = toToolDefinitions();
