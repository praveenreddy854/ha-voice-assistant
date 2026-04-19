import fs from "fs";
import path from "path";
import { generateJsonCompletion } from "./ai";
import { AI_MODEL_NANO } from "./config";

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

  const messages = [
    ...(messageHistory || []),
    { role: "user", content: prompt }
  ];

  try {
    return await generateJsonCompletion<IntentClassificationResponse | IntentErrorResponse>({
      model: AI_MODEL_NANO || "",
      messages,
    });
  } catch (error) {
    console.error("Failed to classify intent:", error);
    throw new Error("Failed to classify user intent");
  }
}
