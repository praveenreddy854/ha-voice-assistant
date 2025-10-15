export interface AgenticToolArguments {
  actionType: "press" | "scroll" | "type" | "wait" | "home" | "back";
  button?: string;
  direction?: "up" | "down" | "left" | "right";
  count?: number;
  text?: string;
  holdMs?: number;
  waitMs?: number;
  reason: string;
}

export interface AgenticStep {
  index: number;
  actionSummary: string;
  reasoning: string;
  observation: string;
  toolArguments: AgenticToolArguments;
  screenshotDataUrl?: string;
  screenshotBase64?: string;
  screenshotContentType?: string;
  screenshotError?: string;
}

export type AgenticFlowStatus =
  | "awaiting_screenshot"
  | "running"
  | "completed"
  | "error";

export interface AgenticFlowResponse {
  success: boolean;
  message: string;
  steps: AgenticStep[];
  finalCommand?: string;
  sessionId?: string;
  status: AgenticFlowStatus;
  pendingStep?: AgenticStep;
  screenshotRequest?: {
    prompt: string;
    reason: string;
    stepIndex: number;
  };
}
