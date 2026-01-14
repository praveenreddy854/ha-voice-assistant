import fs from "fs";
import path from "path";
import { openAIService } from "./openai";

const promptCache = new Map();
const intentCacheKey = "INTENT";

export interface IntentClassificationResponse {
  intent: "HACommand" | "Reminder" | "Chat" | "AgenticFlow" | "TeachingMode";
}
export interface IntentErrorResponse {
  error: "no_match";
}

export async function classifyIntent(userPrompt: string, messageHistory?: Array<{ role: string; content: string }>) {
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

  // Combine message history with current prompt
  const messages = [
    ...(messageHistory || []),
    { role: "user", content: prompt }
  ];

  try {
    return await openAIService.createIntentClassification(messages);
  } catch (error) {
    console.error("Failed to classify intent:", error);
    throw new Error("Failed to classify user intent");
  }
}
