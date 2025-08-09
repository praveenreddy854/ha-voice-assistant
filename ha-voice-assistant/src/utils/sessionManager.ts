interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface MessageHistory {
  messages: Message[];
  lastActivity: number;
}

// Client-side message history management with 10-minute expiration
class MessageHistoryManager {
  private readonly EXPIRY_TIME = 10 * 60 * 1000; // 10 minutes in milliseconds
  private readonly STORAGE_KEY = 'voiceAssistantMessageHistory';
  private readonly MAX_MESSAGES = 20; // Keep last 20 messages for context

  private messageHistory: MessageHistory;

  constructor() {
    this.messageHistory = this.loadFromStorage();
    this.cleanupExpiredMessages();
    
    // Clean up expired messages every 2 minutes
    setInterval(() => {
      this.cleanupExpiredMessages();
    }, 2 * 60 * 1000);
  }

  private loadFromStorage(): MessageHistory {
    try {
      const stored = localStorage.getItem(this.STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as MessageHistory;
        // Check if the stored history is still valid (not expired)
        const now = Date.now();
        if (now - parsed.lastActivity <= this.EXPIRY_TIME) {
          return parsed;
        }
      }
    } catch (error) {
      console.error('Error loading message history from storage:', error);
    }

    // Return fresh history if nothing valid found
    return {
      messages: [],
      lastActivity: Date.now()
    };
  }

  private saveToStorage(): void {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.messageHistory));
    } catch (error) {
      console.error('Error saving message history to storage:', error);
    }
  }

  private cleanupExpiredMessages(): void {
    const now = Date.now();
    
    // Check if entire history is expired
    if (now - this.messageHistory.lastActivity > this.EXPIRY_TIME) {
      this.clearHistory();
      return;
    }

    // Remove messages older than expiry time
    this.messageHistory.messages = this.messageHistory.messages.filter(
      message => now - message.timestamp <= this.EXPIRY_TIME
    );

    // Limit to max messages to prevent unlimited growth
    if (this.messageHistory.messages.length > this.MAX_MESSAGES) {
      this.messageHistory.messages = this.messageHistory.messages.slice(-this.MAX_MESSAGES);
    }

    this.saveToStorage();
  }

  addMessage(role: 'user' | 'assistant', content: string): void {
    const now = Date.now();
    const message: Message = {
      role,
      content,
      timestamp: now
    };

    this.messageHistory.messages.push(message);
    this.messageHistory.lastActivity = now;

    // Clean up and limit messages
    this.cleanupExpiredMessages();
    
    console.log(`Added ${role} message to history`);
  }

  getHistory(): Array<{ role: string; content: string }> {
    this.cleanupExpiredMessages();
    
    return this.messageHistory.messages.map(msg => ({
      role: msg.role,
      content: msg.content
    }));
  }

  clearHistory(): void {
    this.messageHistory = {
      messages: [],
      lastActivity: Date.now()
    };
    localStorage.removeItem(this.STORAGE_KEY);
    console.log('Message history cleared');
  }

  getMessageCount(): number {
    this.cleanupExpiredMessages();
    return this.messageHistory.messages.length;
  }

  isHistoryActive(): boolean {
    const now = Date.now();
    return (now - this.messageHistory.lastActivity) <= this.EXPIRY_TIME;
  }

  // Get contextual history for LLM (last N messages)
  getContextualHistory(maxMessages: number = 10): Array<{ role: string; content: string }> {
    const history = this.getHistory();
    
    if (history.length <= maxMessages) {
      return history;
    }

    return history.slice(-maxMessages);
  }
}

export const messageHistoryManager = new MessageHistoryManager();
export default messageHistoryManager;