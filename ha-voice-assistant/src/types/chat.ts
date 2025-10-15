import { AgenticStep } from "./agentic";

export interface Message {
  sender: "user" | "assistant";
  text: string;
  messageToAnnounce?: string;
  reminderData?: any; // For passing reminder data from voice processing
  agenticSteps?: AgenticStep[];
  finalCommand?: string;
}
