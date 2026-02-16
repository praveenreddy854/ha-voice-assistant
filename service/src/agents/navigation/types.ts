/**
 * TV Navigation Agent Types and Interfaces
 * Contains all type definitions for the TV navigation agent
 */

// Navigation tool-specific argument types
export interface GoHomeArgs {
  command: string;
  remote_entity_id: string;
  reason: string;
}

export interface GoBackArgs {
  command: string;
  remote_entity_id: string;
  reason: string;
}

export interface NavigateArgs {
  command: string;
  direction: "up" | "down" | "left" | "right";
  count: number;
  remote_entity_id: string;
  reason: string;
}

export interface FindSearchArgs {
  remote_entity_id: string;
  reason: string;
}

export interface RequestScreenshotArgs {
  media_player_entity_id: string;
  reason: string;
}

export interface WaitArgs {
  duration_ms?: number;
  reason: string;
}

export interface ClickSelectButtonArgs {
  command: string;
  remote_entity_id: string;
  reason: string;
}

// Union type of all navigation tool names
export type NavToolName =
  | "go_home"
  | "go_back"
  | "navigate"
  | "find_search"
  | "click_select_button"
  | "request_screenshot"
  | "wait";

// Union type of all navigation tool arguments
export type NavToolArguments =
  | GoHomeArgs
  | GoBackArgs
  | NavigateArgs
  | FindSearchArgs
  | ClickSelectButtonArgs
  | RequestScreenshotArgs
  | WaitArgs;

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
  sessionId?: string; // Current session ID for context
  activeAgent?: "tv" | "navigation"; // Which agent is actively executing
}

// Navigation agent step tracking
export interface NavAgentStep {
  iteration: number;
  toolName: string;
  toolArgs: Record<string, unknown>;
  observation: string;
  timestamp: Date;
  runId?: string;
  threadId?: string;
}

// Navigation agent session state
export interface NavAgentSessionState {
  threadId: string;
  steps: NavAgentStep[];
  isComplete: boolean;
  lastScreenshotBase64?: string;
  lastScreenshotContentType?: string;
  completionReason?: "success" | "max_iterations" | "error" | "user_cancelled";
  finalMessage?: string;
}

// Navigation agent result
export interface NavAgenticFlowResult {
  success: boolean;
  message: string;
  steps: NavAgentStep[];
  sessionState: NavAgentSessionState;
  error?: string;
}

// Options for running navigation agent
export interface RunNavAgenticFlowOptions {
  userMessage: string;
  deviceConfig: {
    remoteEntityId: string;
    mediaPlayerEntityId: string;
  };
  screenshotBase64?: string;
  screenshotContentType?: string;
  existingThreadId?: string;
  maxIterations?: number;
}

// Screenshot payload from agent
export interface ScreenshotPayload {
  media_player_entity_id: string;
  reason: string;
}

// Tool output payload
export interface ToolOutputPayload {
  observation: string;
  needsScreenshot: boolean;
}
