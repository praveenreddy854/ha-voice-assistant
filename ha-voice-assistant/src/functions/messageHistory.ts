import { messageHistoryManager } from "../utils/sessionManager";

export interface MessageHistoryStats {
  messageCount: number;
  isActive: boolean;
  expiryTime: string;
}

export interface MessageHistory {
  history: Array<{
    role: string;
    content: string;
  }>;
}

export const getMessageHistory = (): MessageHistory => {
  return {
    history: messageHistoryManager.getHistory()
  };
};

export const clearMessageHistory = (): boolean => {
  try {
    messageHistoryManager.clearHistory();
    return true;
  } catch (error) {
    console.error("Error clearing message history:", error);
    return false;
  }
};

export const getMessageHistoryStats = (): MessageHistoryStats => {
  return {
    messageCount: messageHistoryManager.getMessageCount(),
    isActive: messageHistoryManager.isHistoryActive(),
    expiryTime: "10 minutes"
  };
};

export const addUserMessage = (content: string): void => {
  messageHistoryManager.addMessage('user', content);
};

export const addAssistantMessage = (content: string): void => {
  messageHistoryManager.addMessage('assistant', content);
};

export const getContextualHistory = (maxMessages?: number): Array<{ role: string; content: string }> => {
  return messageHistoryManager.getContextualHistory(maxMessages);
};