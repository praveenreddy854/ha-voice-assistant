import fs from "fs";
import path from "path";
import { openAIService } from "./openai";

const promptCache = new Map();
const intentCacheKey = "INTENT";

export interface IntentClassificationResponse {
  intent: "HACommand" | "Reminder" | "Chat";
}
export interface IntentErrorResponse {
  error: "no_match";
}

export async function classifyIntent(userPrompt: string) {
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

  try {
    return await openAIService.createIntentClassification(prompt);
  } catch (error) {
    console.error("Failed to classify intent:", error);
    throw new Error("Failed to classify user intent");
  }
}
