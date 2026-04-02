/**
 * TV Typing Agent - Main Export
 *
 * Specialized agent for text input operations on smart TVs including:
 * - navigate: Move cursor on on-screen keyboards
 * - click_select_button: Select characters or confirm input
 * - type_character: Direct character input where supported
 * - request_screenshot: Capture screen to verify keyboard state
 * - go_back: Delete characters (backspace) or exit keyboard
 * - wait: Wait for UI to update
 * - analyze_keyboard: AI-powered keyboard layout analysis
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
  NavigateArgs,
  ClickSelectButtonArgs,
  TypeCharacterArgs,
  RequestScreenshotArgs,
  GoBackArgs,
  WaitArgs,
  AnalyzeKeyboardArgs,
  TypingToolName,
  TypingToolArguments,
  TypingAgentStep,
  TypingAgentSessionState,
  TypingAgenticFlowResult,
  RunTypingAgenticFlowOptions,
  ToolExecutionContext,
  ToolExecutionResult,
  KeyboardLayout,
  CharacterPosition,
  NavigationPath,
} from "./types";
