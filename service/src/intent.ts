import fs from "fs";
import path from "path";
import {
  COMPLETIONS_URL,
  API_KEY,
  OPEN_AI_BASE_URL,
  AZURE_OPENAI_API_DEPLOYMENT_NAME,
  OPENAI_RESPONSES_API_VERSION,
} from "./config";
import { AzureOpenAI } from "openai";

const promptCache = new Map();
const intentCacheKey = "INTENT";

export async function classifyIntent(userPrompt: string) {
  console.log(`Completions, api key ${COMPLETIONS_URL}, ${API_KEY}`);
  if (!COMPLETIONS_URL || !API_KEY) {
    throw new Error("Configuration missing required values");
  }

  if (!promptCache.has(intentCacheKey)) {
    const prompt = fs.readFileSync(
      path.join(__dirname, "prompts", "INTENT.md"),
      "utf8"
    );
    promptCache.set(intentCacheKey, prompt);
  }
  const prompt = promptCache
    .get(intentCacheKey)
    .replace("{{{UserPrompt}}}", userPrompt);

  const client = new AzureOpenAI({
    baseURL: OPEN_AI_BASE_URL,
    apiKey: API_KEY,
    apiVersion: OPENAI_RESPONSES_API_VERSION,
  });

  let response = await client.responses.create({
    model: AZURE_OPENAI_API_DEPLOYMENT_NAME,
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
    await new Promise((resolve) => setTimeout(resolve, 50));
    response = await client.responses.retrieve(response.id);
  }
  return response.output_text;
}
