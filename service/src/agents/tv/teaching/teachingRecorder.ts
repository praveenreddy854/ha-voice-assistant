/**
 * Teaching Recorder - Records manual steps performed by the user
 * 
 * Flow:
 * 1. User says "start tv agent teaching mode"
 * 2. Assistant asks "what is the task for TV agent?"
 * 3. User provides task name (e.g., "Play latest Telugu songs")
 * 4. User manually performs steps on TV while system records each action
 * 5. System saves complete recording to JSON file
 * 6. Future similar requests use the recording to guide the agent
 */

import { v4 as uuidv4 } from "uuid";
import {
  TeachingSession,
  TeachingRecording,
  RecordedStep,
  GuidedInstructions,
  GuidedStep,
  SimilarRecording,
  SESSION_TIMEOUT_MS,
} from "./types";
import { saveRecording, loadRecording } from "./storage";
import { generateEmbedding, findBestMatch, cosineSimilarity } from "./embeddings";
import { analyzeScreenshot, PreviousStepContext } from "./screenshotAnalyzer";
import { uploadScreenshotToBlob, isBlobStorageAvailable } from "./blobStorage";

// In-memory store for active teaching sessions
const activeSessions = new Map<string, TeachingSession>();

/**
 * Start a new teaching session (after user provides task name)
 */
export async function startTeachingSession(taskName: string): Promise<TeachingSession> {
  const sessionId = uuidv4();
  const now = Date.now();

  // Generate embedding for the task name for future similarity matching
  const embedding = await generateEmbedding(taskName);

  const recording: TeachingRecording = {
    id: uuidv4(),
    taskName,
    embedding,
    steps: [],
    createdAt: now,
    isComplete: false,
  };

  const session: TeachingSession = {
    sessionId,
    taskName,
    recording,
    status: "recording",
    currentStepIndex: 0,
    startedAt: now,
    lastActivityAt: now,
  };

  activeSessions.set(sessionId, session);
  console.log(`[Teaching] Started session ${sessionId} for task: "${taskName}"`);

  return session;
}

/**
 * Record a step performed by the user
 * Called when user performs an action (like pressing a button)
 */
export async function recordStep(
  sessionId: string,
  action: string,
  screenshotBase64?: string,
  contentType: string = "image/png"
): Promise<RecordedStep | null> {
  const session = activeSessions.get(sessionId);
  if (!session) {
    console.error(`[Teaching] Session not found: ${sessionId}`);
    return null;
  }

  if (session.status !== "recording") {
    console.error(`[Teaching] Session ${sessionId} is not in recording status`);
    return null;
  }

  const stepNumber = session.recording.steps.length + 1;

  // Upload screenshot to blob storage if available, otherwise use base64
  let screenshotUrl: string | undefined;
  if (screenshotBase64) {
    if (isBlobStorageAvailable()) {
      const blobUrl = await uploadScreenshotToBlob(
        screenshotBase64,
        contentType,
        session.taskName,
        stepNumber
      );
      screenshotUrl = blobUrl || undefined;
      if (!blobUrl) {
        console.warn(`[Teaching] Blob upload failed for step ${stepNumber}, falling back to base64`);
        screenshotUrl = `data:${contentType};base64,${screenshotBase64}`;
      }
    } else {
      // Fallback to base64 if blob storage not configured
      screenshotUrl = `data:${contentType};base64,${screenshotBase64}`;
    }
  }

  const step: RecordedStep = {
    stepNumber,
    action,
    description: action, // For manual mode, the user's description IS the action
    screenBeforeAction: undefined,
    screenAfterAction: undefined,
    screenshots: {
      before: screenshotUrl,
      after: undefined,
    },
    timestamp: Date.now(),
  };

  session.recording.steps.push(step);
  session.currentStepIndex = stepNumber;
  session.lastActivityAt = Date.now();

  console.log(`[Teaching] Recorded step ${stepNumber} for session ${sessionId}: ${action}`);

  return step;
}

/**
 * Add a screenshot capture to the teaching session
 * Used for automatic screenshot capture mode - client captures every 5 seconds
 * The screenshot is analyzed by AI to infer what action the user performed
 */
export async function addScreenshotCapture(
  sessionId: string,
  screenshotBase64: string,
  contentType: string = "image/png",
  captureIndex: number
): Promise<RecordedStep | null> {
  const session = activeSessions.get(sessionId);
  if (!session) {
    console.error(`[Teaching] Session not found: ${sessionId}`);
    return null;
  }

  if (session.status !== "recording") {
    console.error(`[Teaching] Session ${sessionId} is not in recording status`);
    return null;
  }

  // Build previous steps context for the AI to infer actions
  const previousSteps: PreviousStepContext[] = session.recording.steps.map(step => ({
    stepNumber: step.stepNumber,
    description: step.description,
    focusedElement: step.screenBeforeAction?.includes("Focused:") 
      ? step.screenBeforeAction.split("Focused:")[1]?.trim() 
      : undefined,
    inferredAction: step.action,
  }));

  // Analyze the screenshot with AI, passing previous steps for context
  const analysis = await analyzeScreenshot(
    screenshotBase64,
    contentType,
    session.taskName,
    previousSteps
  );

  const stepNumber = session.recording.steps.length + 1;

  // Upload screenshot to blob storage if available, otherwise use base64
  let screenshotUrl: string;
  if (isBlobStorageAvailable()) {
    const blobUrl = await uploadScreenshotToBlob(
      screenshotBase64,
      contentType,
      session.taskName,
      stepNumber
    );
    screenshotUrl = blobUrl || `data:${contentType};base64,${screenshotBase64}`;
    if (!blobUrl) {
      console.warn(`[Teaching] Blob upload failed for step ${stepNumber}, falling back to base64`);
    }
  } else {
    // Fallback to base64 if blob storage not configured
    screenshotUrl = `data:${contentType};base64,${screenshotBase64}`;
  }

  const step: RecordedStep = {
    stepNumber,
    action: analysis.inferredAction,
    description: analysis.description,
    screenBeforeAction: analysis.focusedElement 
      ? `${analysis.description} (Focused: ${analysis.focusedElement})`
      : analysis.description,
    screenAfterAction: undefined,
    screenshots: {
      before: screenshotUrl,
      after: undefined,
    },
    timestamp: Date.now(),
  };

  session.recording.steps.push(step);
  session.currentStepIndex = stepNumber;
  session.lastActivityAt = Date.now();

  console.log(`[Teaching] Step ${stepNumber}: ${analysis.inferredAction} → ${analysis.description}`);

  return step;
}

/**
 * Complete a teaching session and save the recording
 */
export async function completeTeachingSession(
  sessionId: string
): Promise<TeachingRecording | null> {
  const session = activeSessions.get(sessionId);
  if (!session) {
    console.error(`[Teaching] Session not found: ${sessionId}`);
    return null;
  }

  if (session.recording.steps.length === 0) {
    console.error(`[Teaching] Cannot complete session with no steps`);
    return null;
  }

  session.recording.isComplete = true;
  session.recording.totalSteps = session.recording.steps.length;
  session.status = "completed";

  // Save to file
  const savedPath = await saveRecording(session.recording);
  console.log(`[Teaching] Saved recording to: ${savedPath}`);

  // Clean up the session
  activeSessions.delete(sessionId);

  return session.recording;
}

/**
 * Cancel a teaching session
 */
export function cancelTeachingSession(sessionId: string): boolean {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return false;
  }

  activeSessions.delete(sessionId);
  console.log(`[Teaching] Cancelled session ${sessionId}`);
  return true;
}

/**
 * Get the current state of a teaching session
 */
export function getTeachingSession(sessionId: string): TeachingSession | null {
  return activeSessions.get(sessionId) || null;
}

/**
 * Get all active teaching sessions
 */
export function getActiveSessions(): TeachingSession[] {
  return Array.from(activeSessions.values());
}

/**
 * Check if there's an active teaching session
 */
export function hasActiveSession(): boolean {
  return activeSessions.size > 0;
}

/**
 * Clean up expired sessions
 */
export function cleanupExpiredSessions(): number {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [sessionId, session] of activeSessions.entries()) {
    if (now - session.lastActivityAt > SESSION_TIMEOUT_MS) {
      activeSessions.delete(sessionId);
      cleanedCount++;
      console.log(`[Teaching] Cleaned up expired session ${sessionId}`);
    }
  }

  return cleanedCount;
}

/**
 * Find guidance for a task based on similar recordings
 * This is used when the agent needs to perform a task that might have been taught
 */
export async function findGuidanceForTask(
  taskDescription: string,
  similarityThreshold: number = 0.8
): Promise<GuidedInstructions | null> {
  const embedding = await generateEmbedding(taskDescription);

  // First check for exact/very similar matches
  const bestMatch: SimilarRecording | null = await findBestMatch(embedding);

  if (!bestMatch) {
    console.log(`[Teaching] No recordings found for guidance`);
    return null;
  }

  // Check if similarity is above threshold
  const similarity = cosineSimilarity(embedding, bestMatch.embedding || []);
  console.log(`[Teaching] Best match: "${bestMatch.taskName}" with similarity ${similarity.toFixed(3)}`);

  if (similarity < similarityThreshold) {
    console.log(`[Teaching] Similarity ${similarity.toFixed(3)} below threshold ${similarityThreshold}`);
    return null;
  }

  // Load the full recording
  const recording = await loadRecording(bestMatch.id);
  if (!recording || !recording.isComplete) {
    console.log(`[Teaching] Recording not complete or not found`);
    return null;
  }

  // Convert recording to guidance instructions
  const guidedSteps: GuidedStep[] = recording.steps.map((step) => ({
    stepNumber: step.stepNumber,
    instruction: step.description || step.action,
    expectedAction: step.action,
    screenDescription: step.screenBeforeAction,
  }));

  const instructions: GuidedInstructions = {
    matchedTaskName: recording.taskName,
    confidence: similarity,
    steps: guidedSteps,
    totalSteps: recording.steps.length,
    sourceRecordingId: recording.id,
  };

  console.log(`[Teaching] Generated guidance with ${instructions.steps.length} steps`);

  return instructions;
}

/**
 * Export types and functions
 */
export {
  TeachingSession,
  TeachingRecording,
  RecordedStep,
  GuidedInstructions,
} from "./types";
