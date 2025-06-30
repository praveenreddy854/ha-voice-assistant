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

    // Replace placeholders in the prompt with actual values
    const response = await fetch(`${HOME_ASSISTANT_URL}/api/states`, {
      headers: {
        Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch devices: ${response.statusText}`);
    }

    const states = (await response.json()) as HassState[];
    const devices: Record<string, HassState[]> = {};

    // Group devices by domain
    states.forEach((state) => {
      const [domain, device] = state.entity_id.split(".");

      if (device === "appletv") {
        if (!devices[domain]) {
          devices[domain] = [];
        }
        devices[domain].push(state);
      }
    });

    prompt = prompt.replace("{{{Devices}}}", JSON.stringify(devices, null, 2));

    promptCache.set(homeAssistantCacheKey, prompt);
  }

  const cachedPrompt = promptCache
    .get(homeAssistantCacheKey)
    .replace("{{{UserCommand}}}", command);
  return cachedPrompt;
}
