/**
 * Teaching Mode Types
 * For recording manual user steps and using them to guide future agent execution
 */

// Constants
export const TEACHING_TRIGGERS = [
  "start tv agent teaching mode",
  "teach tv agent",
  "teaching mode",
  "start teaching",
  "tv teaching mode",
];

export const SIMILARITY_THRESHOLD = 0.8;
export const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * A single step recorded during teaching
 * Screenshots can be either:
 * - A blob storage URL (preferred for fine-tuning): https://hatvagent.blob.core.windows.net/ftimages/...
 * - A base64 data URL (fallback): data:image/png;base64,...
 */
export interface RecordedStep {
  stepNumber: number;
  action: string;
  description: string;
  screenBeforeAction?: string;
  screenAfterAction?: string;
  screenshots?: {
    /** URL to the screenshot (blob storage URL or base64 data URL) */
    before?: string;
    after?: string;
  };
  timestamp: number;
}

/**
 * A complete teaching recording saved to a JSON file
 */
export interface TeachingRecording {
  id: string;
  taskName: string;
  embedding?: number[];
  steps: RecordedStep[];
  createdAt: number;
  isComplete: boolean;
  totalSteps?: number;
}

/**
 * Active teaching session state (in-memory)
 */
export interface TeachingSession {
  sessionId: string;
  taskName: string;
  recording: TeachingRecording;
  status: "awaiting_task" | "recording" | "completed" | "cancelled";
  currentStepIndex: number;
  startedAt: number;
  lastActivityAt: number;
}

/**
 * Entry in the teaching index file for quick lookups
 */
export interface TeachingIndexEntry {
  id: string;
  taskName: string;
  filePath: string;
  embedding?: number[];
  totalSteps: number;
  createdAt: number;
  isComplete: boolean;
}

/**
 * Guidance instructions for the TV agent to follow learned steps
 */
export interface GuidedStep {
  stepNumber: number;
  instruction: string;
  expectedAction: string;
  screenDescription?: string;
}

export interface GuidedInstructions {
  matchedTaskName: string;
  confidence: number;
  steps: GuidedStep[];
  totalSteps: number;
  sourceRecordingId: string;
}

/**
 * Similar recording result from search
 */
export interface SimilarRecording {
  id: string;
  taskName: string;
  similarity: number;
  embedding?: number[];
  filePath?: string;
}

/**
 * Teaching trigger detection result
 */
export interface TeachingTrigger {
  isTeachingTrigger: boolean;
  triggers: string[];
}
