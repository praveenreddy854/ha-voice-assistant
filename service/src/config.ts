import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// Define constants for Azure OpenAI API
export const SESSIONS_URL = process.env.AZURE_OPENAI_SESSIONS_URL;
export const API_KEY = process.env.AZURE_OPENAI_API_KEY;

export const COMPLETIONS_URL = process.env.AZURE_OPENAI_COMPLETION_URL;

export const OPEN_AI_BASE_URL = process.env.AZURE_OPENAI_ENDPOINT;
export const AZURE_OPENAI_API_DEPLOYMENT_NAME =
  process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME;

export const OPENAI_RESPONSES_API_VERSION =
  process.env.OPENAI_RESPONSES_API_VERSION;

export const HA_COMMAND_PROCESS_MODEL = process.env.HA_COMMAND_PROCESS_MODEL;

// Azure Speech Service credentials
// For demo purposes only, you should use environment variables in production
export const SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
export const SPEECH_REGION = process.env.AZURE_SPEECH_REGION || "eastus";

export const HOME_ASSISTANT_URL =
  process.env.HOME_ASSISTANT_URL || "http://homeassistant.local:8123";
export const HOME_ASSISTANT_TOKEN = process.env.HOME_ASSISTANT_TOKEN;

export const VACUUM_CLEANER_ENTITY_ID = process.env.VACUUM_CLEANER_ENTITY_ID;
export const LAUNDRY_SWITCH_ENTITY_ID =
  process.env.LAUNDRY_SWITCH_ENTITY_ID || "switch.laundry_switch";
export const HOME_ASSISTANT_NOTIFY_SERVICE =
  process.env.HOME_ASSISTANT_NOTIFY_SERVICE || "notify/notify";
export const HOME_CHECKS_ENABLED = process.env.HOME_CHECKS_ENABLED !== "false";
export const HOME_CHECKS_CRON = process.env.HOME_CHECKS_CRON || "0 9 * * *";
export const LAUNDRY_ALERT_MINUTES = Number.parseInt(
  process.env.LAUNDRY_ALERT_MINUTES || "50",
  10
);

export const TV_REMOTE_ENTITY_ID = process.env.TV_REMOTE_ENTITY_ID;
export const TV_DEFAULT_WAIT_MS = Number.parseInt(
  process.env.TV_DEFAULT_WAIT_MS || "1500",
  10,
);

export const AZURE_AI_AGENT_KEY = process.env.AZURE_AI_AGENT_KEY;
export const AZURE_AI_AGENT_MODEL =
  process.env.AZURE_AI_AGENT_MODEL || process.env.HA_COMMAND_PROCESS_MODEL;

export const AZURE_OPENAI_MODEL_ADVANCED =
  process.env.AZURE_OPENAI_MODEL_ADVANCED ||
  process.env.HA_COMMAND_PROCESS_MODEL;

export const AZURE_OPENAI_EMBEDDING_MODEL =
  process.env.AZURE_OPENAI_EMBEDDING_MODEL || "text-embedding-ada-002";

export const AZURE_AI_AGENT_KEY_HEADER_NAME =
  process.env.AZURE_AI_AGENT_KEY_HEADER_NAME || "api-key";

// Azure AI Agents retry configuration
export const AZURE_AGENTS_MAX_RETRIES = Number.parseInt(
  process.env.AZURE_AGENTS_MAX_RETRIES || "3",
  10,
);
export const AZURE_AGENTS_BASE_RETRY_DELAY = Number.parseInt(
  process.env.AZURE_AGENTS_BASE_RETRY_DELAY || "1000",
  10,
);
export const AZURE_AGENTS_RETRY_ENABLED =
  process.env.AZURE_AGENTS_RETRY_ENABLED !== "false"; // Enabled by default
export const AZURE_AGENTS_TIMEOUT_MS = Number.parseInt(
  process.env.AZURE_AGENTS_TIMEOUT_MS || "30000", // 30 seconds default
  10,
);

export const TV_AGENT_DEVICES = process.env.TV_AGENT_DEVICES
  ? process.env.TV_AGENT_DEVICES.split(",").map((d) => d.trim())
  : [];
export const AZURE_COSMOS_ENDPOINT = process.env.AZURE_COSMOS_ENDPOINT;
export const AZURE_COSMOS_KEY = process.env.AZURE_COSMOS_KEY;
export const AZURE_COSMOS_DATABASE = process.env.AZURE_COSMOS_DATABASE;
export const AZURE_COSMOS_CONTAINER = process.env.AZURE_COSMOS_CONTAINER;
export const DEVICE_STATE_LOG_CRON =
  process.env.DEVICE_STATE_LOG_CRON || "0 * * * *"; // Top of every hour

export const HOME_ASSISTANT_SKILL_MATCHERS: Record<string, string[]> = (() => {
  process.env.HOME_ASSISTANT_SKILL_MATCHERS =
    process.env.HOME_ASSISTANT_SKILL_MATCHERS?.trim();
  if (!process.env.HOME_ASSISTANT_SKILL_MATCHERS) {
    return {};
  }

  // Try to parse as JSON first
  try {
    const parsed = JSON.parse(process.env.HOME_ASSISTANT_SKILL_MATCHERS);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed;
    }
  } catch {
    // Ignore JSON parse errors
    console.warn(
      "Failed to parse HOME_ASSISTANT_SKILL_MATCHERS   as JSON, trying delimited format...",
    );
  }
})();
