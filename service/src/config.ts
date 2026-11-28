import dotenv from "dotenv";
import { MODEL_CATALOG, regionForDeployment } from "./modelCatalog";

dotenv.config();

// ============================================================================
// Azure OpenAI
// ============================================================================

export function foundryConnectionFor(model: string) {
  const suffix = regionForDeployment(model).toUpperCase();
  const resourceVar = `AZURE_OPENAI_RESOURCE_NAME_${suffix}`;
  const keyVar = `AZURE_OPENAI_API_KEY_${suffix}`;
  const resourceName = process.env[resourceVar]?.trim();
  const apiKey = process.env[keyVar]?.trim();
  if (!resourceName || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(resourceName)) {
    throw new Error(`Configure ${resourceVar} with an Azure resource name, not a URL`);
  }
  if (!apiKey) throw new Error(`Configure ${keyVar} for this Foundry region`);
  return { resourceName, apiKey, hostname: `${resourceName.toLowerCase()}.openai.azure.com` };
}

export const AZURE_OPENAI_API_VERSION =
  process.env.AZURE_OPENAI_API_VERSION ?? "2025-01-01-preview";

// ============================================================================
// Three-Tier Model System
// ============================================================================

export const { model: AI_MODEL_NANO, reasoningEffort: AI_MODEL_NANO_REASONING_EFFORT } = MODEL_CATALOG.nano;
export const { model: AI_MODEL_MINI, reasoningEffort: AI_MODEL_MINI_REASONING_EFFORT } = MODEL_CATALOG.mini;
export const { model: AI_MODEL_ADVANCED, reasoningEffort: AI_MODEL_ADVANCED_REASONING_EFFORT } = MODEL_CATALOG.advanced;
export const { model: AI_MODEL_HOME_ASSISTANT, reasoningEffort: AI_MODEL_HOME_ASSISTANT_REASONING_EFFORT } = MODEL_CATALOG.homeAssistant;
// Keep existing vectors in the same model space when migrating Foundry settings.
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL?.trim() || MODEL_CATALOG.embedding.model;
export const AI_MODEL_LIVE = MODEL_CATALOG.live.model;
export const GPT_LIVE_VOICE = process.env.GPT_LIVE_VOICE ?? "marin";

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

export const TV_REMOTE_ENTITY_ID = process.env.TV_REMOTE_ENTITY_ID;
export const TV_DEFAULT_WAIT_MS = Number.parseInt(
  process.env.TV_DEFAULT_WAIT_MS || "1500",
  10
);
// Override HA's 400ms per-key default. Set a small positive value only if a
// particular device drops rapid key presses.
const remoteKeyDelay = Number(process.env.TV_REMOTE_KEY_DELAY_MS ?? "0");
export const TV_REMOTE_KEY_DELAY_MS = Number.isFinite(remoteKeyDelay)
  ? Math.max(0, Math.min(1000, remoteKeyDelay))
  : 0;
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
export const AZURE_COSMOS_CRON_JOBS_CONTAINER =
  process.env.AZURE_COSMOS_CRON_JOBS_CONTAINER || "cron-jobs";
export const AZURE_COSMOS_TV_FLOW_CONTAINER =
  process.env.AZURE_COSMOS_TV_FLOW_CONTAINER;
export const AZURE_COSMOS_MEMORY_CONTAINER =
  process.env.AZURE_COSMOS_MEMORY_CONTAINER || "AgentMemory";
export const AZURE_COSMOS_SCHEDULED_TASKS_CONTAINER =
  process.env.AZURE_COSMOS_SCHEDULED_TASKS_CONTAINER || "scheduled-tasks";
export const AZURE_COSMOS_SCHEDULED_TASKS_HISTORY_CONTAINER =
  process.env.AZURE_COSMOS_SCHEDULED_TASKS_HISTORY_CONTAINER ||
  "scheduled-tasks-history";
export const DEVICE_STATE_LOG_CRON =
  process.env.DEVICE_STATE_LOG_CRON || "0 * * * *";

// ============================================================================
// Proactive Reminders (AI-driven, from device-state history)
// ============================================================================

export const PROACTIVE_REMINDERS_ENABLED =
  (process.env.PROACTIVE_REMINDERS_ENABLED ?? "true").toLowerCase() !== "false";

/** Runs at half past each hour by default, after the top-of-hour state log. */
export const PROACTIVE_REMINDERS_CRON =
  process.env.PROACTIVE_REMINDERS_CRON || "30 * * * *";

/** Minutes a device must stay on/open before it is worth a reminder. */
export const PROACTIVE_REMINDER_ON_MINUTES = Number.parseInt(
  process.env.PROACTIVE_REMINDER_ON_MINUTES || "180",
  10
);

// TV Flow Memory (RAG)
export const TV_FLOW_MEMORY_MIN_SIMILARITY = Number.parseFloat(
  process.env.TV_FLOW_MEMORY_MIN_SIMILARITY || "0.65"
);
export const TV_FLOW_MEMORY_TOP_K = Number.parseInt(
  process.env.TV_FLOW_MEMORY_TOP_K || "5",
  10
);

// Persistent Agent Memory
export const MEMORY_RETRIEVAL_TOP_K = Number.parseInt(
  process.env.MEMORY_RETRIEVAL_TOP_K || "5",
  10
);
export const MEMORY_RETRIEVAL_TIMEOUT_MS = Number.parseInt(
  process.env.MEMORY_RETRIEVAL_TIMEOUT_MS || "900",
  10
);
export const MEMORY_MIN_SIMILARITY = Number.parseFloat(
  process.env.MEMORY_MIN_SIMILARITY || "0.55"
);
export const MEMORY_CONSOLIDATION_ENABLED =
  (process.env.MEMORY_CONSOLIDATION_ENABLED ?? "true").toLowerCase() !== "false";
export const MEMORY_CONSOLIDATION_INTERVAL_MS = Number.parseInt(
  process.env.MEMORY_CONSOLIDATION_INTERVAL_MS || "60000",
  10
);
