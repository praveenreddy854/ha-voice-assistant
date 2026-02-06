/**
 * TV Agent Constants and Configuration
 * Centralized configuration values for the TV automation agent
 */

import fs from "fs";
import path from "path";
import { toToolDefinitions } from "./tools";

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
    return 8;
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

// Export tools in Azure/OpenAI format from the unified registry
export const TV_TOOLS = toToolDefinitions();
