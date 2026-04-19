/**
 * Teaching Module Exports
 */

// Types
export {
  RecordedStep,
  TeachingRecording,
  TeachingSession,
  GuidedInstructions,
  GuidedStep,
  TeachingTrigger,
  TeachingIndexEntry,
  SimilarRecording,
  TEACHING_TRIGGERS,
  SIMILARITY_THRESHOLD,
  SESSION_TIMEOUT_MS,
} from "./types";

// Storage
export {
  saveRecording,
  loadRecording,
  loadRecordingByTaskName,
  loadIndex,
  listAllRecordings,
  deleteRecording,
  TEACHING_DIR,
} from "./storage";

// Blob Storage for screenshots
export {
  uploadScreenshotToBlob,
  isBlobStorageAvailable,
  getBlobBaseUrl,
} from "./blobStorage";

// Embeddings
export {
  generateEmbedding,
  cosineSimilarity,
  findSimilarRecordings,
  findBestMatch,
  updateMissingEmbeddings,
} from "./embeddings";

// Screenshot Analyzer
export { analyzeScreenshot, PreviousStepContext } from "./screenshotAnalyzer";

// Teaching Recorder (main interface)
export {
  startTeachingSession,
  recordStep,
  addScreenshotCapture,
  completeTeachingSession,
  cancelTeachingSession,
  getTeachingSession,
  getActiveSessions,
  hasActiveSession,
  cleanupExpiredSessions,
  findGuidanceForTask,
} from "./teachingRecorder";
