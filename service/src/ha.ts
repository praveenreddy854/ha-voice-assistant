import { HOME_ASSISTANT_URL, HOME_ASSISTANT_TOKEN, AI_MODEL_MINI } from "./config";
import fs from "fs";
import path from "path";
import { HassServiceCommandBody, HassServiceCommand, HassState } from "./types/ha";
import { generateCompletion } from "./ai";
import axios from "axios";

const promptCache = new Map();
const homeAssistantCacheKey = "HOMEASSISTANT";

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
  try {
    // Get the HA command body using the existing LLM function
    const haBody = await getHACommandBody(command, messageHistory);
    
    // Handle array of commands (multi-step operations)
    if (Array.isArray(haBody)) {
      return await executeMultipleHACommands(haBody, command);
    }
    
    // Handle single command
    return await executeSingleHACommand(haBody, command);
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    console.error("Error executing HA command:", err);
    return {
      success: false,
      message: `Error executing command: ${err.message}`,
    };
  }
}

/**
 * Execute a single Home Assistant command
 */
async function executeSingleHACommand(
  haBody: HassServiceCommand,
  originalCommand: string
): Promise<{ success: boolean; message: string; data?: any }> {
  let urlPath = haBody.url_path;
  const entityId = haBody.entity_id;

  if (!urlPath || urlPath.split("/").length !== 2) {
    return {
      success: false,
      message:
        "Invalid services home assistant path. Command body must contain a valid 'url_path' in the format '<domain>/<service>'",
    };
  }

  if (!entityId) {
    return {
      success: false,
      message: "Missing entity_id. Command body must contain 'entity_id'",
    };
  }

  // Remove leading and trailing slashes from the URL path
  if (urlPath.startsWith("/")) {
    urlPath = urlPath.substring(1);
  }

  // Prepare the request body
  const requestBody: any = { entity_id: haBody.entity_id };

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
