import { HOME_ASSISTANT_URL, HOME_ASSISTANT_TOKEN, AI_MODEL_MINI } from "./config";
import fs from "fs";
import path from "path";
import { HassServiceCommandBody, HassServiceCommand, HassState } from "./types/ha";
import { generateCompletion } from "./ai";
import axios from "axios";
import {
  formatMemoryContext,
  retrieveMemories,
  type AgentMemoryDocument,
} from "./memory";
import { getTracer } from "./tracing";

const promptCache = new Map();
const homeAssistantCacheKey = "HOMEASSISTANT";
const LIVING_ROOM_PTZ_PRESET_ENTITY_ID = "select.living_room_ptz_preset";
const LIVING_ROOM_GUARD_SET_BUTTON_ENTITY_ID =
  "button.living_room_guard_set_current_position";
const INTERNAL_WAIT_URL_PATH = "internal/wait";
const GUARD_SET_WAIT_MS = 15000;

export async function getHACommandBody(
  command: string,
  messageHistory?: Array<{ role: string; content: string }>
): Promise<HassServiceCommandBody> {
  const prompt = await getHAPrompt(command);

  // Combine message history with current prompt
  const messages = [
    ...(messageHistory || []),
    { role: "user", content: prompt },
  ];

  try {
    const responseText = await generateCompletion({
      model: AI_MODEL_MINI || "",
      messages,
    });
    return JSON.parse(responseText) as HassServiceCommandBody;
  } catch (error) {
    console.error("Failed to get Home Assistant command:", error);
    throw new Error("Failed to process Home Assistant command");
  }
}

async function getHAPrompt(command: string) {
  if (!promptCache.has(homeAssistantCacheKey)) {
    let prompt = fs.readFileSync(
      path.join(__dirname, "prompts", "HOMEASSISTANT.md"),
      "utf8"
    );
    const deviceStates = await getDeviceStates();

    prompt = prompt.replace(
      "{{{Devices}}}",
      JSON.stringify(deviceStates, null, 2)
    );

    promptCache.set(homeAssistantCacheKey, prompt);
  }

  const cachedPrompt = promptCache
    .get(homeAssistantCacheKey)
    .replace("{{{UserCommand}}}", command);
  return cachedPrompt;
}

export async function fetchAllStates(): Promise<HassState[]> {
  const response = await axios.get(`${HOME_ASSISTANT_URL}/api/states`, {
    headers: {
      Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to fetch devices: ${response.statusText}`);
  }

  return response.data as HassState[];
}

async function getDeviceStates(
  devicesEntities?: string[]
): Promise<Record<string, HassState[]>> {
  const states = await fetchAllStates();

  // Create devices object to devices.json
  // const devicesFilePath = path.join(__dirname, "devices.json");
  // if (!fs.existsSync(devicesFilePath)) {
  //   fs.writeFileSync(devicesFilePath, JSON.stringify(states, null, 2));
  // }

  const devices: Record<string, HassState[]> = {};
  const knownDevices = await getKnownDevices();

  // Group devices by domain
  states.forEach((state) => {
    const [_, device = ""] = state.entity_id.split(".");

    if (matchesKnownDevice(device, knownDevices, state.entity_id)) {
      if (!devices[device]) {
        devices[device] = [];
      }
      devices[device].push(state);
    }
  });

  if (devicesEntities) {
    return Object.keys(devices).reduce((acc, device) => {
      acc[device] = devices[device].filter((state) =>
        devicesEntities.includes(state.entity_id)
      );
      return acc;
    }, {} as Record<string, HassState[]>);
  }
  return devices;
}

export const getKnownDevices = async (): Promise<string[]> => {
  const devices = process.env.HOME_ASSISTANT_DEVICES;
  return devices
    ? devices
        .split(",")
        .map((device) => device.trim())
        .filter(Boolean)
    : [];
};

export const matchesKnownDevice = (
  entityFragment: string,
  knownDevices: string[],
  fullEntityId?: string
): boolean => {
  if (!entityFragment) {
    return false;
  }

  const normalizedFragment = entityFragment.toLowerCase();
  const normalizedFullEntity = (fullEntityId ?? entityFragment).toLowerCase();

  return knownDevices.some((knownDeviceRaw) => {
    const knownDevice = knownDeviceRaw.toLowerCase();

    return (
      normalizedFragment.startsWith(knownDevice) ||
      normalizedFullEntity.startsWith(knownDevice)
    );
  });
};

/**
 * Fetches and filters Home Assistant device states based on known devices configuration.
 * Returns only states that match the configured known devices.
 * If no known devices are configured, returns all states.
 *
 * @returns Promise<HassState[]> - Array of filtered device states
 */
export const getKnownDeviceStates = async (): Promise<HassState[]> => {
  const [states, knownDevices] = await Promise.all([
    fetchAllStates(),
    getKnownDevices(),
  ]);

  const shouldFilter = knownDevices.length > 0;

  if (!shouldFilter) {
    return states;
  }

  return states.filter((state) => {
    const [, entity = ""] = state.entity_id.split(".");
    return matchesKnownDevice(entity, knownDevices, state.entity_id);
  });
};

/**
 * Execute a plain English Home Assistant command by converting it to the appropriate API call.
 * This function wraps the logic from /api/postHACommand endpoint for use within the TV agent tools.
 * Supports both single commands and arrays of commands (for multi-step operations like navigate + select).
 *
 * @param command - Plain English command like "Turn on Apple TV" or "Scroll right 3 times on apple tv"
 * @param messageHistory - Optional message history for context
 * @returns Promise with success status and message
 */
export async function executeHACommand(
  command: string,
  messageHistory?: Array<{ role: string; content: string }>
): Promise<{ success: boolean; message: string; data?: any }> {
  const span = getTracer().startSpan("ha.command.execute", {
    attributes: {
      "ha.command.text": command,
      "telemetry.kind": "ha_command",
    },
  });

  try {
    const memory = await buildMemoryAwareCommand(command);
    span.setAttribute("ha.memory.context_present", Boolean(memory.context));
    span.setAttribute("ha.memory.ids", memory.memories.map((item) => item.id).join(","));

    // Get the HA command body using the existing LLM function
    const generatedHaBody = await getHACommandBody(memory.command, messageHistory);
    const { body: haBody, guardSetApplied } = applyMemoryCommandAugmentations(
      generatedHaBody,
      command,
      memory.memories
    );

    span.setAttribute("ha.command.generated_body", JSON.stringify(generatedHaBody));
    span.setAttribute("ha.command.final_body", JSON.stringify(haBody));
    span.setAttribute("ha.guard_set_current_position.applied", guardSetApplied);
    
    // Handle array of commands (multi-step operations)
    if (Array.isArray(haBody)) {
      const result = await executeMultipleHACommands(haBody, command);
      span.setAttribute("ha.command.success", result.success);
      span.setAttribute("ha.command.result_message", result.message);
      return result;
    }
    
    // Handle single command
    const result = await executeSingleHACommand(haBody, command);
    span.setAttribute("ha.command.success", result.success);
    span.setAttribute("ha.command.result_message", result.message);
    return result;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("Error executing HA command:", err);
    span.setAttribute("ha.command.success", false);
    span.setAttribute("ha.command.error", err.message);
    return {
      success: false,
      message: `Error executing command: ${err.message}`,
    };
  } finally {
    span.end();
  }
}

async function buildMemoryAwareCommand(command: string): Promise<{
  command: string;
  context: string;
  memories: AgentMemoryDocument[];
}> {
  const memories = await retrieveMemories({
    query: command,
    agentType: "realtime",
    limit: 10,
    preferCache: false,
    useEmbedding: false,
  });
  const context = formatMemoryContext(memories);
  if (!context) return { command, context, memories };
  return {
    command: [
      command,
      "",
      "Persistent memory to apply while translating this Home Assistant command:",
      context,
    ].join("\n"),
    context,
    memories,
  };
}

function applyMemoryCommandAugmentations(
  body: HassServiceCommandBody,
  originalCommand: string,
  memories: AgentMemoryDocument[]
): { body: HassServiceCommandBody; guardSetApplied: boolean } {
  if (!shouldSetLivingRoomGuardPosition(body, originalCommand, memories)) {
    return { body, guardSetApplied: false };
  }

  const commands = Array.isArray(body) ? [...body] : [body];
  const alreadySetsGuard = commands.some(
    (command) => command.entity_id === LIVING_ROOM_GUARD_SET_BUTTON_ENTITY_ID
  );
  if (!alreadySetsGuard) {
    commands.push(
      {
        url_path: INTERNAL_WAIT_URL_PATH,
        entity_id: "__internal_wait__",
        service_data: {
          duration_ms: GUARD_SET_WAIT_MS,
          reason: "wait for living room camera PTZ preset movement before setting guard position",
        },
      },
      {
        url_path: "button/press",
        entity_id: LIVING_ROOM_GUARD_SET_BUTTON_ENTITY_ID,
      }
    );
  }

  return { body: commands, guardSetApplied: !alreadySetsGuard };
}

function shouldSetLivingRoomGuardPosition(
  body: HassServiceCommandBody,
  originalCommand: string,
  memories: AgentMemoryDocument[]
): boolean {
  const commands = Array.isArray(body) ? body : [body];
  const selectsLivingRoomPreset = commands.some(
    (command) => command.entity_id === LIVING_ROOM_PTZ_PRESET_ENTITY_ID
  );
  if (!selectsLivingRoomPreset) return false;

  const normalizedCommand = originalCommand.toLowerCase();
  const commandMentionsPresetCamera =
    normalizedCommand.includes("living room") &&
    normalizedCommand.includes("camera") &&
    normalizedCommand.includes("preset");

  const hasGuardPresetMemory = memories.some((memory) => {
    const haystack = [
      memory.text,
      ...(memory.scopes.deviceNames || []),
      ...(memory.scopes.roomNames || []),
      ...(memory.scopes.tags || []),
    ]
      .join(" ")
      .toLowerCase();
    return (
      haystack.includes("living room") &&
      haystack.includes("camera") &&
      haystack.includes("preset") &&
      haystack.includes("guard")
    );
  });

  return commandMentionsPresetCamera && hasGuardPresetMemory;
}

/**
 * Execute a single Home Assistant command
 */
function normalizeHAUrlPath(urlPath: string): string {
  let normalized = urlPath.trim().replace(/^\/+|\/+$/g, "");
  if (normalized.startsWith("api/")) {
    normalized = normalized.substring("api/".length);
  }
  if (normalized.startsWith("services/")) {
    normalized = normalized.substring("services/".length);
  }
  return normalized;
}

function stateLookupEntityId(urlPath: string): string | undefined {
  const parts = urlPath.split("/");
  if (parts.length !== 2 || parts[0] !== "states") {
    return undefined;
  }
  const entityId = decodeURIComponent(parts[1].trim());
  return entityId || undefined;
}

async function executeHAStateLookup(
  entityId: string,
  originalCommand: string
): Promise<{ success: boolean; message: string; data?: any }> {
  const haResponse = await axios.get(
    `${HOME_ASSISTANT_URL}/api/states/${encodeURIComponent(entityId)}`,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
      },
    }
  );

  const state = haResponse.data as HassState;
  const friendlyName = state.attributes?.friendly_name || entityId;
  console.log(`HA State retrieved: ${originalCommand}; Response:`, state);

  return {
    success: true,
    message: `${friendlyName} state is "${state.state}"`,
    data: state,
  };
}

async function executeSingleHACommand(
  haBody: HassServiceCommand,
  originalCommand: string
): Promise<{ success: boolean; message: string; data?: any }> {
  const urlPath = normalizeHAUrlPath(haBody.url_path || "");
  if (urlPath === INTERNAL_WAIT_URL_PATH) {
    const durationMs =
      typeof haBody.service_data?.duration_ms === "number"
        ? Math.max(0, Math.min(haBody.service_data.duration_ms, 30000))
        : 0;
    if (durationMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    }
    return {
      success: true,
      message: `Waited ${durationMs}ms`,
      data: { durationMs, reason: haBody.service_data?.reason },
    };
  }

  const stateEntityId = stateLookupEntityId(urlPath);
  const entityId = stateEntityId || haBody.entity_id;

  if (!urlPath || (!stateEntityId && urlPath.split("/").length !== 2)) {
    return {
      success: false,
      message:
        "Invalid home assistant path. Command body must contain a valid 'url_path' in the format '<domain>/<service>' or 'states/<entity_id>'",
    };
  }

  if (!entityId) {
    return {
      success: false,
      message: "Missing entity_id. Command body must contain 'entity_id'",
    };
  }

  if (stateEntityId) {
    return executeHAStateLookup(entityId, originalCommand);
  }

  // Prepare the request body
  const requestBody: any = { entity_id: entityId };

  // Add service_data if present (for play_media and other services that need additional data)
  if (haBody.service_data) {
    // For Home Assistant API, merge service_data fields directly at the top level
    Object.assign(requestBody, haBody.service_data);
  }

  const haResponse = await axios.post(
    `${HOME_ASSISTANT_URL}/api/services/${urlPath}`,
    requestBody,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
      },
    }
  );

  if (haResponse.status < 200 || haResponse.status >= 300) {
    console.error("Home Assistant error response:", haResponse.data);
    return {
      success: false,
      message: `Home Assistant API returned status ${haResponse.status}`,
      data: haResponse.data,
    };
  }

  console.log(`HA Command executed: ${originalCommand}; Response:`, haResponse.data);
  return {
    success: true,
    message: `Command "${originalCommand}" sent successfully`,
    data: haResponse.data,
  };
}

/**
 * Call a Home Assistant service directly without LLM translation.
 * Use this for known, specific commands where domain/service/entity are already determined
 * (e.g., remote.send_command with wakeup/suspend).
 */
export async function callHAServiceDirect(
  domain: string,
  service: string,
  entityId: string,
  serviceData?: Record<string, unknown>
): Promise<{ success: boolean; message: string; data?: any }> {
  try {
    const requestBody: Record<string, unknown> = { entity_id: entityId };
    if (serviceData) {
      Object.assign(requestBody, serviceData);
    }

    const response = await axios.post(
      `${HOME_ASSISTANT_URL}/api/services/${domain}/${service}`,
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
        },
      }
    );

    if (response.status < 200 || response.status >= 300) {
      return {
        success: false,
        message: `HA API returned status ${response.status}`,
        data: response.data,
      };
    }

    return {
      success: true,
      message: `${domain}.${service} called on ${entityId}`,
      data: response.data,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      success: false,
      message: `Direct HA service call failed: ${err.message}`,
    };
  }
}

/**
 * Execute multiple Home Assistant commands in sequence
 * Used for multi-step operations like "scroll left 3 times then click select"
 */
async function executeMultipleHACommands(
  commands: HassServiceCommand[],
  originalCommand: string
): Promise<{ success: boolean; message: string; data?: any }> {
  console.log(`Executing ${commands.length} HA commands in sequence for: ${originalCommand}`);
  
  const results: any[] = [];
  const errors: string[] = [];
  
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    console.log(`Executing command ${i + 1}/${commands.length}:`, cmd);
    
    const result = await executeSingleHACommand(cmd, `Step ${i + 1}: ${cmd.url_path}`);
    results.push(result.data);
    
    if (!result.success) {
      errors.push(`Step ${i + 1} failed: ${result.message}`);
      // Continue executing remaining commands even if one fails
      console.warn(`Command ${i + 1} failed, continuing with remaining commands...`);
    }
    
    // Add a small delay between commands to allow the device to process
    if (i < commands.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  
  if (errors.length > 0) {
    return {
      success: errors.length < commands.length, // Partial success if some commands succeeded
      message: errors.length === commands.length 
        ? `All ${commands.length} commands failed: ${errors.join('; ')}`
        : `${commands.length - errors.length}/${commands.length} commands succeeded. Errors: ${errors.join('; ')}`,
      data: results,
    };
  }
  
  return {
    success: true,
    message: `All ${commands.length} commands executed successfully for "${originalCommand}"`,
    data: results,
  };
}
