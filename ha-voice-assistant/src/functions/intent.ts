import { Response } from "../types/response";
import { messageHistoryManager } from "../utils/sessionManager";

export enum Intent {
  HACommand = "HACommand",
  Chat = "Chat",
  Reminder = "Reminder",
  AgenticFlow = "AgenticFlow",
  TeachingMode = "TeachingMode",
}

const INTENT_VALUES = new Set<string>(Object.values(Intent));

const parseIntentFromResponse = (payload: unknown): Intent => {
  if (payload && typeof payload === "object") {
    const candidate = payload as { intent?: unknown; error?: unknown };
    if (typeof candidate.intent === "string" && INTENT_VALUES.has(candidate.intent)) {
      return candidate.intent as Intent;
    }
    if (candidate.error === "no_match") {
      return Intent.Chat;
    }
  }

  if (typeof payload === "string") {
    try {
      const parsed = JSON.parse(payload);
      return parseIntentFromResponse(parsed);
    } catch {
      const normalized = payload.toLowerCase();
      if (normalized.includes("hacommand") || normalized.includes("ha command")) {
        return Intent.HACommand;
      }
      if (normalized.includes("teachingmode") || normalized.includes("teaching mode")) {
        return Intent.TeachingMode;
      }
      if (normalized.includes("agenticflow") || normalized.includes("agentic flow")) {
        return Intent.AgenticFlow;
      }
      if (normalized.includes("reminder")) {
        return Intent.Reminder;
      }
      return Intent.Chat;
    }
  }

  return Intent.Chat;
};

export const getIntent = async (text: string): Promise<Response<Intent>> => {
  try {
    if (!text || typeof text !== "string") {
      return {
        success: false,
        errorMessage: "Invalid input text",
      };
    }

    const response = await fetch("http://localhost:3005/api/classifyIntent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ 
        userPrompt: text, 
        messageHistory: messageHistoryManager.getContextualHistory() 
      }),
    });

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      // Fallback gracefully for classification errors instead of failing the whole voice flow
      console.warn("Intent API non-OK response, defaulting to Chat intent");
      return {
        success: true,
        data: Intent.Chat,
      };
    }
    
    // Add user message to history
    messageHistoryManager.addMessage('user', text);
    
    return {
      success: true,
      data: parseIntentFromResponse(payload),
    };
  } catch (error) {
    console.error("Error fetching intent:", error);
    return {
      // Keep UX responsive even if classification fails
      success: true,
      data: Intent.Chat,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};

export const processReminder = async (text: string, reminders: any[]): Promise<Response<any>> => {
  try {
    if (!text || typeof text !== "string") {
      return {
        success: false,
        errorMessage: "Invalid input text",
      };
    }

    const response = await fetch("http://localhost:3005/api/processReminder", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ 
        userPrompt: text, 
        reminders, 
        messageHistory: messageHistoryManager.getContextualHistory() 
      }),
    });

    if (!response.ok) {
      throw new Error("Network response was not ok");
    }

    const data = await response.json();
    
    // Add user message and assistant response to history
    messageHistoryManager.addMessage('user', text);
    if (data.message) {
      messageHistoryManager.addMessage('assistant', data.message);
    }
    
    return {
      success: true,
      data: data.action === 'CREATE' ? data.reminder : data.reminders,
      message: data.message,
    };
  } catch (error) {
    console.error("Error processing reminder:", error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};
