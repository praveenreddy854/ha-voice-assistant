import { intentService } from "./services/intentService";
import { ChatMessage } from "./services/homeAssistantService";

export interface IntentClassificationResponse {
  intent: "HACommand" | "Reminder" | "Chat" | "AgenticFlow" | "TeachingMode";
}

export interface IntentErrorResponse {
  error: "no_match";
}

export async function classifyIntent(
  userPrompt: string,
  messageHistory?: ChatMessage[]
): Promise<IntentClassificationResponse | IntentErrorResponse> {
  return intentService.classify(userPrompt, messageHistory);
}
