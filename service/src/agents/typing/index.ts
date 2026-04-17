/**
 * TV Typing Agent - Main Export
 *
 * Specialized agent for text input operations on smart TVs:
 * - deterministic_typing: Type full text with background validation
 * - delete_typed_text: Navigate to DELETE key on keyboard strip
 * - get_latest_screenshot: Get screenshot to identify cursor position
 */

export { runTypingAgent } from "./typingAgent";

export {
  TYPING_AGENT_NAME,
  TYPING_AGENT_DESCRIPTION,
  TYPING_AGENT_INSTRUCTIONS,
  TYPING_AGENT_MAX_ITERATIONS_CAP,
  TYPING_TOOLS,
} from "./constants";

export type {
  GetLatestScreenshotArgs,
  DeleteTypedTextArgs,
  DeterministicTypingArgs,
  TypingToolName,
  TypingToolArguments,
  TypingAgentStep,
  TypingAgentSessionState,
  TypingAgenticFlowResult,
  RunTypingAgenticFlowOptions,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types";
