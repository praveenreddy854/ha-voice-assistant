import { AgenticStep } from "./agentic";
import { SessionLogEntry } from "../components/AgentSessionLog";

export interface Message {
  sender: "user" | "assistant";
  text: string;
  messageToAnnounce?: string;
  reminderData?: any; // For passing reminder data from voice processing
  agenticSteps?: AgenticStep[];
  finalCommand?: string;
  sessionLog?: SessionLogEntry[];
}
