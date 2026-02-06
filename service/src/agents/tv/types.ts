/**
 * TV Agent Types and Interfaces
 * Contains all type definitions for the TV automation agent
 */

// New tool-specific argument types
export interface ClickPowerButtonArgs {
  command: string;
  remote_entity_id: string;
  reason: string;
}

export interface MediaControlArgs {
  action:
    | "play"
    | "pause"
    | "stop"
    | "rewind"
    | "fast_forward"
    | "volume_up"
    | "volume_down"
    | "mute"
    | "unmute"
    | "next"
    | "previous"
    | "skip_forward"
    | "skip_backward";
  remote_entity_id: string;
  reason: string;
}

export interface ClickSelectButtonArgs {
  command: string;
  remote_entity_id: string;
  reason: string;
}

export interface OpenMenuArgs {
  remote_entity_id: string;
  reason: string;
}

export interface DelegateToTypingArgs {
  text_to_type: string;
  remote_entity_id: string;
  media_player_entity_id: string;
  reason: string;
}

export interface RequestScreenshotArgs {
  reason: string;
  target_agent?: "tv" | "navigation" | "auto";
}

export interface GetDeviceStateArgs {
  device_name?: string;
  reason: string;
}

export interface LaunchAppArgs {
  command: string;
  app_name: string;
  media_player_entity_id: string;
  reason: string;
}

export interface WaitArgs {
  duration_ms?: number;
  reason: string;
}

export interface FindSearchIconArgs {
  remote_entity_id: string;
  reason: string;
}

export interface DelegateToNavigationArgs {
  task_description: string;
  remote_entity_id: string;
  media_player_entity_id: string;
  reason: string;
}

export interface AnalyzeScreenshotArgs {
  query: string;
  reason: string;
}

export interface VerifyUIStateArgs {
  expected_state: string;
  reason: string;
}

export type TvToolName =
  | "click_power_button"
  | "media_control"
  | "click_select_button"
  | "open_menu"
  | "delegate_to_typing"
  | "request_screenshot"
  | "get_device_state"
  | "launch_app"
  | "delegate_to_navigation"
  | "analyze_screenshot"
  | "verify_ui_state"
  | "wait";

export type TvToolArguments =
  | ClickPowerButtonArgs
  | MediaControlArgs
  | ClickSelectButtonArgs
  | OpenMenuArgs
  | DelegateToTypingArgs
  | RequestScreenshotArgs
  | GetDeviceStateArgs
  | LaunchAppArgs
  | DelegateToNavigationArgs
  | AnalyzeScreenshotArgs
  | VerifyUIStateArgs
  | WaitArgs;

// Legacy types - keeping for backward compatibility
export type PerformActionType =
  | "press"
  | "scroll"
  | "type"
  | "wait"
  | "home"
  | "back";

export interface PerformActionArguments {
  actionType: PerformActionType;
  button?: string;
  direction?: "up" | "down" | "left" | "right";
  count?: number;
  text?: string;
  holdMs?: number;
  waitMs?: number;
  reason: string;
  skipScreenshot?: boolean; // Agent can set this to true for actions that can be verified via device state
  remote_entity_id?: string; // Required for actions that need remote control, kept optional for backward compatibility
}

export interface TvAgentStep {
  index: number;
  actionSummary: string;
  reasoning: string;
  observation: string;
  toolArguments: TvToolArguments | PerformActionArguments;
  toolName?: TvToolName;
  toolCallId?: string;
  screenshotDataUrl?: string;
  screenshotBase64?: string;
  screenshotContentType?: string;
  screenshotError?: string;
  retryCount?: number; // Track how many times this action has been retried
  maxRetries?: number; // Maximum retries allowed (default 3)
}

export type TvAgenticFlowStatus =
  | "awaiting_screenshot"
  | "running"
  | "completed"
  | "error";

export interface TvAgenticFlowResult {
  success: boolean;
  message: string;
  steps: TvAgentStep[];
  finalCommand?: string;
  sessionId: string;
  status: TvAgenticFlowStatus;
  pendingStep?: TvAgentStep;
  screenshotRequest?: {
    prompt: string;
    reason: string;
    stepIndex: number;
  };
}

export interface RunTvAgenticFlowOptions {
  userPrompt?: string;
  sessionId?: string;
  maxSteps?: number;
  messageHistory?: Array<{ role: string; content: string }>;
  screenshotDataUrl?: string;
  screenshotBase64?: string;
  screenshotContentType?: string;
  screenshotError?: string;
}

export interface PendingScreenshotState {
  toolCallId: string;
  args: PerformActionArguments;
  stepIndex: number;
  observation: string;
  retryCount?: number; // Track screenshot capture retry attempts
}

export interface TvAgentSessionState {
  id: string;
  azureSessionId: string; // thread ID
  azureRunId?: string; // run ID for the current iteration
  steps: TvAgentStep[];
  pendingScreenshot?: PendingScreenshotState;
  completed: boolean;
  finalCommand?: string;
  iterations: number;
  maxSteps: number;
  userPrompt: string;
  additionalInstructions?: string;
  closed: boolean;
}

export interface ScreenshotPayload {
  base64?: string;
  contentType?: string;
  dataUrl?: string;
  error?: string;
}

export interface ToolOutputPayload {
  toolCallId: string;
  output: string;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CroppedImage {
  base64: string;
  contentType: string;
  boundingBox?: BoundingBox;
}

export function isPerformActionType(
  value: unknown
): value is PerformActionType {
  return (
    value === "press" ||
    value === "scroll" ||
    value === "type" ||
    value === "wait" ||
    value === "home" ||
    value === "back"
  );
}
