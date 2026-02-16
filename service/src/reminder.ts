import { ChatMessage } from "./services/homeAssistantService";
import {
  ReminderCreateRequest,
  ReminderListRequest,
  ReminderQueryRequest,
  ReminderRequest,
  reminderService,
} from "./services/reminderService";

export type {
  ReminderCreateRequest,
  ReminderListRequest,
  ReminderQueryRequest,
  ReminderRequest,
};

export async function processReminderRequest(
  userPrompt: string,
  currentReminders?: unknown[],
  messageHistory?: ChatMessage[]
): Promise<ReminderRequest> {
  return reminderService.parseRequest(userPrompt, currentReminders, messageHistory);
}
