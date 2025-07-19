import fs from "fs";
import path from "path";
import { openAIService } from "./openai";

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

  try {
    return await openAIService.createReminderCompletion<ReminderRequest>(prompt);
  } catch (error) {
    console.error("Failed to process reminder request:", error);
    throw new Error("Failed to process reminder request");
  }
}
