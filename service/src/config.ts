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

export const AZURE_COSMOS_ENDPOINT = process.env.AZURE_COSMOS_ENDPOINT;
export const AZURE_COSMOS_KEY = process.env.AZURE_COSMOS_KEY;
export const AZURE_COSMOS_DATABASE = process.env.AZURE_COSMOS_DATABASE;
export const AZURE_COSMOS_CONTAINER = process.env.AZURE_COSMOS_CONTAINER;
export const DEVICE_STATE_LOG_CRON =
  process.env.DEVICE_STATE_LOG_CRON || "0 * * * *"; // Top of every hour
