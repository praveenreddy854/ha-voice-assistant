import dotenv from "dotenv";

dotenv.config();

// ============================================================================
// Azure OpenAI
// ============================================================================

export const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;

function extractResourceName(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  const match = endpoint.match(/https?:\/\/([^.]+)\.openai\.azure\.com/);
  return match?.[1];
}

export const AZURE_OPENAI_RESOURCE_NAME =
  process.env.AZURE_OPENAI_RESOURCE_NAME ??
  extractResourceName(process.env.AZURE_OPENAI_ENDPOINT);

export const AZURE_OPENAI_API_VERSION =
  process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview";

// ============================================================================
// Three-Tier Model System
// ============================================================================

/** Nano: intent classification, simple JSON extraction */
export const AI_MODEL_NANO = process.env.AI_MODEL_NANO;

/** Mini: HA commands, reminders, vision helpers */
export const AI_MODEL_MINI = process.env.AI_MODEL_MINI ?? process.env.AI_MODEL_NANO;

/** Advanced: agent loops (TV agent, navigation, typing) */
export const AI_MODEL_ADVANCED = process.env.AI_MODEL_ADVANCED ?? process.env.AI_MODEL_MINI;
export const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL ?? "text-embedding-ada-002";

/** Realtime: voice chat via Azure OpenAI Realtime API v2 */
export const AI_MODEL_REALTIME = process.env.AI_MODEL_REALTIME;
export const AZURE_OPENAI_REALTIME_API_VERSION =
  process.env.AZURE_OPENAI_REALTIME_API_VERSION ?? "2025-04-01-preview";

// ============================================================================
// User / Location
// ============================================================================

export const USER_ADDRESS = process.env.USER_ADDRESS;

// ============================================================================
// Azure Speech Service
// ============================================================================

export const SPEECH_KEY = process.env.AZURE_SPEECH_KEY;
export const SPEECH_REGION = process.env.AZURE_SPEECH_REGION || "eastus";

// ============================================================================
// Home Assistant
// ============================================================================

export const HOME_ASSISTANT_URL =
  process.env.HOME_ASSISTANT_URL || "http://homeassistant.local:8123";
export const HOME_ASSISTANT_TOKEN = process.env.HOME_ASSISTANT_TOKEN;

export const VACUUM_CLEANER_ENTITY_ID = process.env.VACUUM_CLEANER_ENTITY_ID;

export const TV_REMOTE_ENTITY_ID = process.env.TV_REMOTE_ENTITY_ID;
export const TV_DEFAULT_WAIT_MS = Number.parseInt(
  process.env.TV_DEFAULT_WAIT_MS || "1500",
  10
);
export const TV_AGENT_DEVICES = process.env.TV_AGENT_DEVICES
  ? process.env.TV_AGENT_DEVICES.split(",").map((d) => d.trim())
  : [];

// ============================================================================
// Azure Cosmos DB
// ============================================================================

export const AZURE_COSMOS_ENDPOINT = process.env.AZURE_COSMOS_ENDPOINT;
export const AZURE_COSMOS_KEY = process.env.AZURE_COSMOS_KEY;
export const AZURE_COSMOS_DATABASE = process.env.AZURE_COSMOS_DATABASE;
export const AZURE_COSMOS_CONTAINER = process.env.AZURE_COSMOS_CONTAINER;
export const AZURE_COSMOS_TV_FLOW_CONTAINER =
  process.env.AZURE_COSMOS_TV_FLOW_CONTAINER;
export const DEVICE_STATE_LOG_CRON =
  process.env.DEVICE_STATE_LOG_CRON || "0 * * * *";

// TV Flow Memory (RAG)
export const TV_FLOW_MEMORY_MIN_SIMILARITY = Number.parseFloat(
  process.env.TV_FLOW_MEMORY_MIN_SIMILARITY || "0.65"
);
export const TV_FLOW_MEMORY_TOP_K = Number.parseInt(
  process.env.TV_FLOW_MEMORY_TOP_K || "5",
  10
);
