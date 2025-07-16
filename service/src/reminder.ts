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
const reminderCacheKey = "REMINDER";

export interface ReminderCreateRequest {
  action: "CREATE";
  title: string;
  description?: string;
  dueDate: string; // ISO string
  category:
    | "general"
    | "medication"
    | "meeting"
    | "task"
    | "appointment"
    | "birthday"
    | "bill"
    | "exercise"
    | "meal";
  priority: "low" | "medium" | "high" | "urgent";
  isRecurring: boolean;
  recurringPattern?: {
    type: "daily" | "weekly" | "monthly" | "yearly";
    interval: number;
  };
}

export interface ReminderListRequest {
  action: "LIST";
  limit?: number;
  prioritizeOverdue?: boolean;
  categoryBreakdown?: boolean;
  intelligentSuggestion?: string;
}

export interface ReminderQueryRequest {
  action: "QUERY";
  category?:
    | "general"
    | "medication"
    | "meeting"
    | "task"
    | "appointment"
    | "birthday"
    | "bill"
    | "exercise"
    | "meal";
  dateFilter?: string;
  searchTerm?: string;
  intelligentSuggestion?: string;
}

export type ReminderRequest =
  | ReminderCreateRequest
  | ReminderListRequest
  | ReminderQueryRequest;

export async function processReminderRequest(
  userPrompt: string,
  currentReminders?: any[]
): Promise<ReminderRequest> {
  console.log(`Processing reminder request: ${userPrompt}`);

  if (!COMPLETIONS_URL || !API_KEY) {
    throw new Error("Configuration missing required values");
  }

  if (!promptCache.has(reminderCacheKey)) {
    const prompt = fs.readFileSync(
      path.join(__dirname, "prompts", "REMINDER.md"),
      "utf8"
    );
    promptCache.set(reminderCacheKey, prompt);
  }

  const currentDateTime = new Date().toISOString();
  const remindersContext = currentReminders
    ? JSON.stringify(currentReminders, null, 2)
    : "No current reminders available";

  const prompt = promptCache
    .get(reminderCacheKey)
    .replace("{{{UserPrompt}}}", userPrompt)
    .replace("{{{CurrentDateTime}}}", currentDateTime)
    .replace("{{{CurrentReminders}}}", remindersContext);

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
  try {
    return JSON.parse(response.output_text) as ReminderRequest;
  } catch (error) {
    console.error("Failed to parse response:", error);
    throw new Error("Invalid response format from AI model");
  }
}
