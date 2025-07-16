import { Response } from "../types/response";

export enum Intent {
  HACommand = "HACommand",
  Chat = "Chat",
  Reminder = "Reminder",
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
      body: JSON.stringify({ userPrompt: text }),
    });

    if (!response.ok) {
      throw new Error("Network response was not ok");
    }

    const data = await response.json();
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
      body: JSON.stringify({ userPrompt: text, reminders }),
    });

    if (!response.ok) {
      throw new Error("Network response was not ok");
    }

    const data = await response.json();
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
