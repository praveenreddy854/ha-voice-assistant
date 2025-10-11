import {
  HOME_ASSISTANT_URL,
  HOME_ASSISTANT_TOKEN,
} from "./config";
import fs from "fs";
import path from "path";
import { HassServiceCommandBody, HassState } from "./types/ha";
import { openAIService } from "./openai";
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
    { role: "user", content: prompt }
  ];
  
  try {
    const responseText = await openAIService.createHomeAssistantCompletion(messages);
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
