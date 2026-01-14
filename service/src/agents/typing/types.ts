/**
 * TV Typing Agent Types and Interfaces
 * Contains all type definitions for the TV typing agent
 */

// Typing tool-specific argument types
export interface NavigateArgs {
  direction: "up" | "down" | "left" | "right";
  count: number;
  remote_entity_id: string;
  reason: string;
}

export interface ClickSelectButtonArgs {
  remote_entity_id: string;
  reason: string;
}

export interface TypeCharacterArgs {
  character: string;
  remote_entity_id: string;
  reason: string;
}

export interface RequestScreenshotArgs {
  media_player_entity_id: string;
  reason: string;
}

export interface GoBackArgs {
  remote_entity_id: string;
  reason: string;
}

export interface WaitArgs {
  duration_ms?: number;
  reason: string;
}

export interface AnalyzeKeyboardArgs {
  target_text: string;
  reason: string;
}

// Union type of all typing tool names
export type TypingToolName =
  | "navigate"
  | "click_select_button"
  | "type_character"
  | "request_screenshot"
  | "go_back"
  | "wait"
  | "analyze_keyboard";

// Union type of all typing tool arguments
export type TypingToolArguments =
  | NavigateArgs
  | ClickSelectButtonArgs
  | TypeCharacterArgs
  | RequestScreenshotArgs
  | GoBackArgs
  | WaitArgs
  | AnalyzeKeyboardArgs;

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
  sessionId?: string;
  activeAgent?: "tv" | "navigation" | "typing";
  targetText?: string; // The full text being typed
  typedSoFar?: string; // Characters already typed
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
  deviceConfig: {
    remoteEntityId: string;
    mediaPlayerEntityId: string;
  };
  screenshotBase64?: string;
  screenshotContentType?: string;
  maxIterations?: number;
}

// Keyboard layout information
export interface KeyboardLayout {
  type: "qwerty" | "alphabetical" | "numeric" | "custom";
  rows: string[][];
  specialKeys?: {
    [key: string]: { row: number; col: number };
  };
}

// Character position on keyboard
export interface CharacterPosition {
  row: number;
  col: number;
  isSpecialKey?: boolean;
}

// Navigation path between characters
export interface NavigationPath {
  from: CharacterPosition;
  to: CharacterPosition;
  moves: Array<{ direction: "up" | "down" | "left" | "right"; count: number }>;
  totalMoves: number;
}
