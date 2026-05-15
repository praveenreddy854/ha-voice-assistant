import { AgenticStep } from "./agentic";
import { SessionLogEntry } from "../components/AgentSessionLog";

export interface Message {
  sender: "user" | "assistant";
  text: string;
  messageToAnnounce?: string;
  agenticSteps?: AgenticStep[];
  finalCommand?: string;
  sessionLog?: SessionLogEntry[];
}
