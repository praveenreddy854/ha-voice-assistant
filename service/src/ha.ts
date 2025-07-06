import {
  API_KEY,
  COMPLETIONS_URL,
  HOME_ASSISTANT_URL,
  HOME_ASSISTANT_TOKEN,
  OPEN_AI_BASE_URL,
  OPENAI_RESPONSES_API_VERSION,
  AZURE_OPENAI_API_DEPLOYMENT_NAME,
} from "./config";
import fs from "fs";
import path from "path";
import { HassServiceCommandBody, HassState } from "./types/ha";
import { AzureOpenAI } from "openai";
import axios from "axios";

const promptCache = new Map();
const homeAssistantCacheKey = "HOMEASSISTANT";

export async function getHACommandBody(
  command: string
): Promise<HassServiceCommandBody> {
  if (!COMPLETIONS_URL || !API_KEY) {
    throw new Error("Configuration missing required values");
  }
  const prompt = await getHAPrompt(command);

  fs.writeFileSync("temp.log", prompt);
  // Make LLM call to get the command body
  const client = new AzureOpenAI({
    baseURL: OPEN_AI_BASE_URL,
    apiKey: API_KEY,
    apiVersion: OPENAI_RESPONSES_API_VERSION,
  });

  let response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: JSON.stringify({
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      max_tokens: 1000,
      temperature: 0.5,
    }),
  });

  while (response.status === "queued" || response.status === "in_progress") {
    console.log(`Current status: ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    response = await client.responses.retrieve(response.id);
  }

  console.log(response);

  return JSON.parse(response.output_text);
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

async function getDeviceStates(
  devicesEntities?: string[]
): Promise<Record<string, HassState[]>> {
  // Replace placeholders in the prompt with actual values
  const response = await axios.get(`${HOME_ASSISTANT_URL}/api/states`, {
    headers: {
      Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
      "Content-Type": "application/json",
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to fetch devices: ${response.statusText}`);
  }

  const states = response.data as HassState[];

  // Create devices object to devices.json
  // const devicesFilePath = path.join(__dirname, "devices.json");
  // if (!fs.existsSync(devicesFilePath)) {
  //   fs.writeFileSync(devicesFilePath, JSON.stringify(states, null, 2));
  // }

  const devices: Record<string, HassState[]> = {};
  const knownDevices = await getKnownDevices();

  // Group devices by domain
  states.forEach((state) => {
    const [domain, device] = state.entity_id.split(".");

    if (knownDevices.includes(device)) {
      if (!devices[domain]) {
        devices[domain] = [];
      }
      devices[domain].push(state);
    }
  });

  if (devicesEntities) {
    return Object.keys(devices).reduce((acc, domain) => {
      acc[domain] = devices[domain].filter((state) =>
        devicesEntities.includes(state.entity_id)
      );
      return acc;
    }, {} as Record<string, HassState[]>);
  }
  return devices;
}

export const getKnownDevices = async (): Promise<string[]> => {
  const devices = process.env.HOME_ASSISTANT_DEVICES;
  return devices ? devices.split(",") : [];
};
