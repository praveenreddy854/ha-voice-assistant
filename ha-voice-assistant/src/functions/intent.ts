import { Response } from "../types/response";
import { messageHistoryManager } from "../utils/sessionManager";

export enum Intent {
  HACommand = "HACommand",
  Chat = "Chat",
  ScheduledTask = "ScheduledTask",
  AgenticFlow = "AgenticFlow",
  TeachingMode = "TeachingMode",
}

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

    if (!response.ok) {
      throw new Error("Network response was not ok");
    }

    const data = await response.json();
    
    // Add user message to history
    messageHistoryManager.addMessage('user', text);
    
    return {
      success: true,
      data: data.intent as Intent,
    };
  } catch (error) {
    console.error("Error fetching intent:", error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};

