import { httpPost, httpGet, httpDelete } from "./httpUtils";
import { Response } from "../types/response";
import { captureTvScreenshot, tvCameraController } from "../utils/tvCamera";

/**
 * Teaching Mode - Manual step recording for TV navigation
 * 
 * Flow:
 * 1. User says "start tv agent teaching mode"
 * 2. Assistant announces instructions (before task is given)
 * 3. User provides task name (e.g., "Play latest Telugu songs on YouTube")
 * 4. Assistant prints confirmation (no announce) - user stays engaged for 5 mins
 * 5. User describes each step they perform (e.g., "I pressed right twice")
 * 6. Assistant prints step recorded (no announce)
 * 7. User says "done" when finished
 * 8. All steps are saved as a recording
 */

// Types for teaching mode
export interface TeachingSession {
  sessionId: string;
  taskName: string;
  status: "awaiting_task" | "recording" | "completed" | "cancelled";
  currentStepIndex: number;
  stepsRecorded: number;
}

export interface RecordedStep {
  stepNumber: number;
  action: string;
  description: string;
}

export interface TeachingRecording {
  id: string;
  taskName: string;
  totalSteps: number;
  isComplete: boolean;
  createdAt: number;
}

export interface GuidedInstructions {
  matchedTaskName: string;
  confidence: number;
  totalSteps: number;
  steps: Array<{
    instruction: string;
    expectedAction: string;
    screenDescription?: string;
  }>;
}

// State for managing teaching sessions
let activeTeachingSessionId: string | null = null;
let isAwaitingTaskName: boolean = false;
let stepCounter: number = 0;
let teachingTimeoutTimer: NodeJS.Timeout | null = null;

// Teaching mode timeout - 5 minutes max
const TEACHING_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// Callback for auto-timeout notification
let onTeachingTimeout: ((recording: TeachingRecording | null) => void) | null = null;

/**
 * Set callback for teaching timeout notification
 */
export function setTeachingTimeoutCallback(callback: ((recording: TeachingRecording | null) => void) | null): void {
  onTeachingTimeout = callback;
}

/**
 * Check if a prompt triggers teaching mode
 */
export async function checkTeachingTrigger(
  userPrompt: string
): Promise<Response<{ isTeachingTrigger: boolean; triggers: string[] }>> {
  try {
    const response = await httpPost<{ isTeachingTrigger: boolean; triggers: string[] }>(
      "/checkTeachingTrigger",
      { userPrompt },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response?.data) {
      return {
        success: false,
        errorMessage: "Failed to check teaching trigger",
      };
    }

    return {
      success: true,
      data: response.data,
    };
  } catch (error) {
    console.error("Error checking teaching trigger:", error);
    return {
      success: false,
      errorMessage:
        error instanceof Error
          ? error.message
          : "Failed to check teaching trigger",
    };
  }
}

/**
 * Start teaching mode - sets state to await task name from user
 * Returns instructions to be ANNOUNCED to the user
 */
export function initiateTeachingMode(): {
  success: boolean;
  message: string;
  announce: boolean;
} {
  isAwaitingTaskName = true;
  return {
    success: true,
    message: "What is the task for TV agent? After you tell me the task, describe each step you perform on the TV remote. Say 'done' when you're finished.",
    announce: true, // This message should be announced
  };
}

/**
 * Check if we're currently awaiting a task name
 */
export function isAwaitingTeachingTask(): boolean {
  return isAwaitingTaskName;
}

/**
 * Start a teaching session with the provided task name
 * Starts the 5-minute engagement timer (no wake word needed)
 */
export async function startTeachingSession(
  taskName: string
): Promise<Response<TeachingSession>> {
  isAwaitingTaskName = false;
  
  try {
    const response = await httpPost<{
      success: boolean;
      session: TeachingSession;
      message: string;
    }>(
      "/teaching/start",
      { taskName },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response?.data?.success || !response?.data?.session) {
      return {
        success: false,
        errorMessage: response?.data?.message || "Failed to start teaching session",
      };
    }

    activeTeachingSessionId = response.data.session.sessionId;
    stepCounter = 0;
    
    // Start 5-minute timeout timer
    startTeachingTimer();
    
    console.log(`[Teaching] Session started for "${taskName}" - user stays engaged for 5 mins`);
    
    return {
      success: true,
      data: response.data.session,
      message: response.data.message,
    };
  } catch (error) {
    console.error("Error starting teaching session:", error);
    return {
      success: false,
      errorMessage:
        error instanceof Error
          ? error.message
          : "Failed to start teaching session",
    };
  }
}

/**
 * Start the 5-minute teaching engagement timer
 */
function startTeachingTimer(): void {
  // Clear any existing timeout
  if (teachingTimeoutTimer) {
    clearTimeout(teachingTimeoutTimer);
  }
  
  console.log("[Teaching] Starting 5-minute engagement timer");
  
  teachingTimeoutTimer = setTimeout(async () => {
    console.log("[Teaching] 5-minute timeout reached, auto-completing session");
    await handleTeachingTimeout();
  }, TEACHING_TIMEOUT_MS);
}

/**
 * Reset the teaching timer (call when user interacts)
 */
function resetTeachingTimer(): void {
  if (activeTeachingSessionId) {
    startTeachingTimer();
  }
}

/**
 * Clear the teaching timer
 */
function clearTeachingTimer(): void {
  if (teachingTimeoutTimer) {
    clearTimeout(teachingTimeoutTimer);
    teachingTimeoutTimer = null;
  }
}

/**
 * Handle teaching timeout - auto-complete the session
 */
async function handleTeachingTimeout(): Promise<void> {
  if (!activeTeachingSessionId) {
    return;
  }
  
  console.log("[Teaching] Auto-completing due to 5-minute timeout");
  
  // Complete the session
  try {
    const response = await httpPost<{
      success: boolean;
      recording: TeachingRecording;
      message: string;
    }>(
      "/teaching/complete",
      { sessionId: activeTeachingSessionId },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );
    
    activeTeachingSessionId = null;
    clearTeachingTimer();
    
    // Notify UI about timeout
    if (onTeachingTimeout) {
      onTeachingTimeout(response?.data?.recording || null);
    }
    
    console.log(`[Teaching] Session auto-completed due to timeout. ${response?.data?.recording?.totalSteps || stepCounter} steps recorded.`);
  } catch (error) {
    console.error("[Teaching] Error during auto-complete:", error);
    activeTeachingSessionId = null;
    clearTeachingTimer();
    if (onTeachingTimeout) {
      onTeachingTimeout(null);
    }
  }
}

/**
 * Record a step in the active teaching session
 * Called when user describes what they did (e.g., "I pressed right twice")
 */
export async function recordStep(
  stepDescription: string
): Promise<Response<RecordedStep>> {
  if (!activeTeachingSessionId) {
    return {
      success: false,
      errorMessage: "No active teaching session.",
    };
  }

  // Reset the engagement timer since user is active
  resetTeachingTimer();

  try {
    // Optionally capture a screenshot
    let screenshotBase64: string | undefined;
    let contentType: string = "image/jpeg";
    
    try {
      const screenshot = await captureTvScreenshot(stepCounter, true);
      if (screenshot.base64) {
        screenshotBase64 = screenshot.base64;
        contentType = screenshot.contentType || "image/jpeg";
      }
    } catch (error) {
      console.warn("[Teaching] Could not capture screenshot:", error);
      // Continue without screenshot
    }

    stepCounter++;

    const response = await httpPost<{
      success: boolean;
      step: RecordedStep;
      message: string;
    }>(
      "/teaching/step",
      {
        sessionId: activeTeachingSessionId,
        action: stepDescription,
        screenshotBase64,
        contentType,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response?.data?.success || !response?.data?.step) {
      return {
        success: false,
        errorMessage: response?.data?.message || "Failed to record step",
      };
    }

    console.log(`[Teaching] Step ${stepCounter} recorded: ${stepDescription}`);

    return {
      success: true,
      data: response.data.step,
      message: response.data.message,
    };
  } catch (error) {
    console.error("Error recording step:", error);
    return {
      success: false,
      errorMessage:
        error instanceof Error
          ? error.message
          : "Failed to record step",
    };
  }
}

/**
 * Complete the active teaching session
 */
export async function completeTeachingSession(): Promise<Response<TeachingRecording>> {
  clearTeachingTimer();
  
  if (!activeTeachingSessionId) {
    return {
      success: false,
      errorMessage: "No active teaching session to complete.",
    };
  }

  try {
    const response = await httpPost<{
      success: boolean;
      recording: TeachingRecording;
      message: string;
    }>(
      "/teaching/complete",
      { sessionId: activeTeachingSessionId },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    // Clear the active session regardless of outcome
    activeTeachingSessionId = null;

    // Stop the camera if active
    if (tvCameraController.isActive()) {
      await tvCameraController.stop();
    }

    if (!response?.data?.success || !response?.data?.recording) {
      return {
        success: false,
        errorMessage: response?.data?.message || "Failed to complete teaching session",
      };
    }

    return {
      success: true,
      data: response.data.recording,
      message: response.data.message,
    };
  } catch (error) {
    console.error("Error completing teaching session:", error);
    activeTeachingSessionId = null;
    if (tvCameraController.isActive()) {
      await tvCameraController.stop();
    }
    return {
      success: false,
      errorMessage:
        error instanceof Error
          ? error.message
          : "Failed to complete teaching session",
    };
  }
}

/**
 * Cancel the active teaching session
 */
export async function cancelTeachingSession(): Promise<Response<void>> {
  clearTeachingTimer();
  
  if (!activeTeachingSessionId) {
    // Still cleanup even if no session
    if (tvCameraController.isActive()) {
      await tvCameraController.stop();
    }
    isAwaitingTaskName = false;
    return {
      success: true,
      message: "No active session, but cleanup complete",
    };
  }

  try {
    const response = await httpPost<{
      success: boolean;
      message: string;
    }>(
      "/teaching/cancel",
      { sessionId: activeTeachingSessionId },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    activeTeachingSessionId = null;
    isAwaitingTaskName = false;
    
    // Stop the camera
    if (tvCameraController.isActive()) {
      await tvCameraController.stop();
    }

    return {
      success: response?.data?.success || false,
      message: response?.data?.message || "Teaching session cancelled",
    };
  } catch (error) {
    console.error("Error cancelling teaching session:", error);
    activeTeachingSessionId = null;
    isAwaitingTaskName = false;
    if (tvCameraController.isActive()) {
      await tvCameraController.stop();
    }
    return {
      success: false,
      errorMessage:
        error instanceof Error
          ? error.message
          : "Failed to cancel teaching session",
    };
  }
}

/**
 * Check if there's an active teaching session
 */
export function hasActiveTeachingSession(): boolean {
  return activeTeachingSessionId !== null;
}

/**
 * Get the active session ID
 */
export function getActiveSessionId(): string | null {
  return activeTeachingSessionId;
}

/**
 * Get the current step count
 */
export function getStepCount(): number {
  return stepCounter;
}

/**
 * Find guidance for a task (used by TV agent to follow learned steps)
 */
export async function findGuidanceForTask(
  taskDescription: string,
  similarityThreshold?: number
): Promise<Response<GuidedInstructions | null>> {
  try {
    const response = await httpPost<{
      success: boolean;
      hasGuidance: boolean;
      guidance?: GuidedInstructions;
      message?: string;
    }>(
      "/teaching/guidance",
      { taskDescription, similarityThreshold },
      {
        headers: {
          "Content-Type": "application/json",
        },
      }
    );

    if (!response?.data?.success) {
      return {
        success: false,
        errorMessage: "Failed to find guidance",
      };
    }

    return {
      success: true,
      data: response.data.hasGuidance ? response.data.guidance || null : null,
      message: response.data.message,
    };
  } catch (error) {
    console.error("Error finding guidance:", error);
    return {
      success: false,
      errorMessage:
        error instanceof Error
          ? error.message
          : "Failed to find guidance",
    };
  }
}

/**
 * List all saved recordings
 */
export async function listRecordings(): Promise<Response<TeachingRecording[]>> {
  try {
    const response = await httpGet<{
      success: boolean;
      recordings: TeachingRecording[];
      count: number;
    }>("/teaching/recordings");

    if (!response?.data?.success) {
      return {
        success: false,
        errorMessage: "Failed to list recordings",
      };
    }

    return {
      success: true,
      data: response.data.recordings,
    };
  } catch (error) {
    console.error("Error listing recordings:", error);
    return {
      success: false,
      errorMessage:
        error instanceof Error
          ? error.message
          : "Failed to list recordings",
    };
  }
}

/**
 * Delete a recording by ID
 */
export async function deleteRecording(recordingId: string): Promise<Response<void>> {
  try {
    const response = await httpDelete<{
      success: boolean;
      message: string;
    }>(`/teaching/recordings/${recordingId}`);

    return {
      success: response?.data?.success || false,
      message: response?.data?.message,
    };
  } catch (error) {
    console.error("Error deleting recording:", error);
    return {
      success: false,
      errorMessage:
        error instanceof Error
          ? error.message
          : "Failed to delete recording",
    };
  }
}

// Legacy exports for backwards compatibility
export async function runTeachingMode(userPrompt: string): Promise<Response<any>> {
  // Check if this is a teaching trigger
  const triggerCheck = await checkTeachingTrigger(userPrompt);
  
  if (triggerCheck.success && triggerCheck.data?.isTeachingTrigger) {
    // This is a teaching mode trigger, initiate the flow
    const initResult = initiateTeachingMode();
    return {
      success: true,
      data: {
        status: "awaiting_task",
        message: initResult.message,
        announce: initResult.announce,
        steps: [],
      },
      message: initResult.message,
    };
  }

  // Not a teaching trigger, return error
  return {
    success: false,
    errorMessage: "This doesn't appear to be a teaching mode request.",
  };
}

export async function continueTeachingWithTask(
  taskDescription: string,
  _sessionId?: string
): Promise<Response<any>> {
  // Start the actual teaching session with the task name
  const result = await startTeachingSession(taskDescription);
  
  if (result.success && result.data) {
    return {
      success: true,
      data: {
        status: "recording",
        sessionId: result.data.sessionId,
        // NO announce - just print to chat
        message: `Recording steps for "${taskDescription}". Tell me each step you perform.`,
        announce: false,
        steps: [],
        teachingData: {
          taskTitle: taskDescription,
          completed: false,
        },
      },
      message: result.message,
    };
  }

  return {
    success: false,
    errorMessage: result.errorMessage || "Failed to start teaching session",
  };
}