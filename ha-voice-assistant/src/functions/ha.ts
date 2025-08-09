import { httpPost } from "./httpUtils";
import { messageHistoryManager } from "../utils/sessionManager";

export async function postHaCommand(command: string): Promise<any> {
  try {
    const response = await httpPost(
      "/postHACommand",
      { 
        command, 
        messageHistory: messageHistoryManager.getContextualHistory() 
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // Add user command to history
    messageHistoryManager.addMessage('user', command);
    
    // Add success response to history if available
    if (response.data?.success && response.data?.message) {
      messageHistoryManager.addMessage('assistant', response.data.message);
    }

    return response.data;
  } catch (error) {
    console.error("Error posting command to Home Assistant:", error);
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
