export interface AgenticStep {
  index: number;
  actionSummary: string;
  reasoning: string;
  observation: string;
  toolName?: string;
  toolCallId?: string;
  toolArguments: Record<string, unknown>;
  toolSuccess?: boolean;
  awaitedScreenshot?: boolean;
  screenshotOutcome?: "none" | "pending" | "captured" | "error";
  screenshotDataUrl?: string;
  screenshotBase64?: string;
  screenshotContentType?: string;
  screenshotError?: string;
  appUiContext?: {
    appName?: string;
    layoutType?: string;
    selectionPosition?: string;
    navigationLandmarks?: string[];
  };
  retryCount?: number;
  maxRetries?: number;
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

// Teaching Mode Types
export interface UIElementDescription {
  elementType: string;
  label?: string;
  description: string;
  position?: string;
  isSelected?: boolean;
  isActionTarget?: boolean;
}

export interface ScreenshotDescription {
  summary: string;
  currentContext: string;
  visibleElements: UIElementDescription[];
  expectedAction?: string;
  screenshotBase64?: string;
  screenshotContentType?: string;
}

export interface TeachingStep {
  stepIndex: number;
  toolName: string;
  toolArguments: Record<string, unknown>;
  actionSummary: string;
  reasoning: string;
  beforeScreenshot?: ScreenshotDescription;
  afterScreenshot?: ScreenshotDescription;
  observation: string;
  timestamp: string;
}

export interface TeachingData {
  id: string;
  taskTitle: string;
  originalPrompt: string;
  normalizedTask: string;
  embedding?: number[];
  steps: TeachingStep[];
  completed: boolean;
  finalMessage?: string;
  deviceContext?: {
    deviceEntityIds: string[];
    deviceNames: string[];
  };
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TeachingModeResponse {
  success: boolean;
  message: string;
  steps: TeachingStep[];
  sessionId: string;
  status: "awaiting_task" | AgenticFlowStatus;
  pendingStep?: TeachingStep;
  screenshotRequest?: {
    prompt: string;
    reason: string;
    stepIndex: number;
  };
  teachingData?: TeachingData;
  savePath?: string;
}

export interface TeachingModeTrigger {
  isTeachingMode: boolean;
  needsTaskDescription?: boolean;
  taskDescription?: string;
  originalPrompt: string;
}
