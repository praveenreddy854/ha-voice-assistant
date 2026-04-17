/**
 * TV Typing Agent Types and Interfaces
 * Contains all type definitions for the TV typing agent
 */

// Typing tool-specific argument types

export interface GetLatestScreenshotArgs {
  media_player_entity_id: string;
  reason: string;
}

export interface DeleteTypedTextArgs {
  remote_entity_id: string;
  reason: string;
}

export interface DeterministicTypingArgs {
  text: string;
  current_cursor_position: string;
  remote_entity_id: string;
  media_player_entity_id: string;
  reason: string;
}

// Union type of all typing tool names
export type TypingToolName =
  | "get_latest_screenshot"
  | "delete_typed_text"
  | "deterministic_typing";

// Union type of all typing tool arguments
export type TypingToolArguments =
  | GetLatestScreenshotArgs
  | DeleteTypedTextArgs
  | DeterministicTypingArgs;

// Tool execution result
export interface ToolExecutionResult {
  observation: string;
  needsScreenshot: boolean;
}

// Tool execution context
export interface ToolExecutionContext {
  homeAssistantUrl: string;
  homeAssistantToken: string;
  screenshotBase64?: string;
  screenshotContentType?: string;
  keyboardHints?: string;
  sessionId?: string;
  activeAgent?: "tv" | "navigation" | "typing";
  targetText?: string; // The full text being typed
  typedSoFar?: string; // Characters already typed
  currentCursorPosition?: number; // Current cursor position index on the keyboard strip
}

// Typing agent step tracking
export interface TypingAgentStep {
  iteration: number;
  toolName: string;
  toolArgs: Record<string, unknown>;
  observation: string;
  timestamp: Date;
  runId?: string;
  threadId?: string;
}

// Typing agent session state
export interface TypingAgentSessionState {
  threadId: string;
  steps: TypingAgentStep[];
  isComplete: boolean;
  lastScreenshotBase64?: string;
  lastScreenshotContentType?: string;
  completionReason?: "success" | "max_iterations" | "error" | "user_cancelled";
  finalMessage?: string;
  targetText?: string;
  typedText?: string;
  resumeSessionKey?: string;
  pendingToolCallId?: string;
  pendingToolName?: string;
  awaitingScreenshot?: boolean;
  awaitingValidation?: boolean;
}

// Typing agent result
export interface TypingAgenticFlowResult {
  success: boolean;
  message: string;
  steps: TypingAgentStep[];
  sessionState: TypingAgentSessionState;
}

// Options for running the typing agent
export interface RunTypingAgenticFlowOptions {
  userMessage: string;
  textToType: string;
  keyboardHints?: string;
  resumeSessionKey?: string;
  deviceConfig: {
    remoteEntityId: string;
    mediaPlayerEntityId: string;
  };
  screenshotBase64?: string;
  screenshotContentType?: string;
  maxIterations?: number;
}
