/**
 * Server-side Screenshot Saving Utilities
 * Handles saving screenshots to file system with organized directory structure
 */

import { promises as fs } from "fs";
import * as path from "path";

interface SaveScreenshotOptions {
  base64Data: string;
  sessionId: string;
  toolName: string;
  stepIndex?: number;
}

interface ScreenshotSaveResult {
  success: boolean;
  filePath?: string;
  error?: string;
}

// Counter for screenshots within a session/tool combination
const screenshotCounters = new Map<string, number>();

/**
 * Get today's date in YYYY-MM-DD format
 */
function getTodayDateString(): string {
  const today = new Date();
  return today.toISOString().split("T")[0];
}

/**
 * Get the next counter for a given session and tool combination
 */
function getNextCounter(sessionId: string, toolName: string): number {
  const key = `${sessionId}-${toolName}`;
  const current = screenshotCounters.get(key) || 0;
  const next = current + 1;
  screenshotCounters.set(key, next);
  return next;
}

/**
 * Ensure directory exists, create if not
 */
async function ensureDirectoryExists(dirPath: string): Promise<void> {
  try {
    await fs.access(dirPath);
  } catch {
    await fs.mkdir(dirPath, { recursive: true });
  }
}

/**
 * Save screenshot to server file system
 * Directory structure: out/{today's date}/{sessionId}/{tool name}/{counter}.jpg
 */
export async function saveScreenshotToServerFile(
  options: SaveScreenshotOptions
): Promise<ScreenshotSaveResult> {
  const { base64Data, sessionId, toolName, stepIndex } = options;

  try {
    // Generate file structure
    const dateString = getTodayDateString();
    const counter = getNextCounter(sessionId, toolName);
    const fileName = `${counter}.jpg`;

    // Build the directory path
    const baseDir = path.join(process.cwd(), "out");
    const directoryPath = path.join(baseDir, dateString, sessionId, toolName);
    const fullPath = path.join(directoryPath, fileName);

    console.info(`[Screenshot Saver Server] Saving screenshot to: ${fullPath}`);

    // Ensure directory exists
    await ensureDirectoryExists(directoryPath);

    // Convert base64 to buffer and save
    const imageBuffer = Buffer.from(base64Data, "base64");
    await fs.writeFile(fullPath, imageBuffer);

    console.info(
      `[Screenshot Saver Server] Screenshot saved successfully to: ${fullPath}`
    );
    console.info(`[Screenshot Saver Server] Screenshot metadata:`, {
      sessionId,
      toolName,
      stepIndex,
      counter,
      dateString,
      filePath: fullPath,
      size: imageBuffer.length,
    });

    return {
      success: true,
      filePath: fullPath,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error occurred";
    console.error(
      "[Screenshot Saver Server] Failed to save screenshot:",
      errorMessage
    );
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Save processed/cropped screenshot with additional metadata
 */
export async function saveCroppedScreenshotToServerFile(
  options: SaveScreenshotOptions & {
    originalSize?: number;
    croppedSize?: number;
    cropInfo?: string;
  }
): Promise<ScreenshotSaveResult> {
  const result = await saveScreenshotToServerFile({
    base64Data: options.base64Data,
    sessionId: options.sessionId,
    toolName: `${options.toolName}_cropped`,
    stepIndex: options.stepIndex,
  });

  if (result.success && options.originalSize && options.croppedSize) {
    console.info(`[Screenshot Saver Server] Crop statistics:`, {
      originalSize: options.originalSize,
      croppedSize: options.croppedSize,
      compressionRatio: Math.round(
        (options.croppedSize / options.originalSize) * 100
      ),
      cropInfo: options.cropInfo,
    });
  }

  return result;
}

/**
 * Reset screenshot counters (useful for new sessions)
 */
export function resetServerScreenshotCounters(): void {
  screenshotCounters.clear();
  console.info("[Screenshot Saver Server] Screenshot counters reset");
}

/**
 * Get current counter for a session/tool combination
 */
export function getCurrentServerCounter(
  sessionId: string,
  toolName: string
): number {
  const key = `${sessionId}-${toolName}`;
  return screenshotCounters.get(key) || 0;
}
