/**
 * Storage for teaching recordings
 * Saves/loads recordings as JSON files in the teaching/tvagent directory
 */

import * as fs from "fs/promises";
import * as path from "path";
import { TeachingRecording, TeachingIndexEntry } from "./types";

// Directory to store teaching recordings
export const TEACHING_DIR = path.join(
  process.cwd(),
  "teaching",
  "tvagent"
);

// Index file for quick lookups
const INDEX_FILE = path.join(TEACHING_DIR, "_index.json");

/**
 * Ensure the teaching directory exists
 */
async function ensureDirectory(): Promise<void> {
  try {
    await fs.mkdir(TEACHING_DIR, { recursive: true });
  } catch (error) {
    // Directory may already exist
  }
}

/**
 * Generate a safe filename from task name
 */
function sanitizeFilename(taskName: string): string {
  return taskName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 100);
}

/**
 * Load the index file
 */
export async function loadIndex(): Promise<TeachingIndexEntry[]> {
  try {
    const content = await fs.readFile(INDEX_FILE, "utf-8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * Save the index file
 */
async function saveIndex(entries: TeachingIndexEntry[]): Promise<void> {
  await ensureDirectory();
  await fs.writeFile(INDEX_FILE, JSON.stringify(entries, null, 2));
}

/**
 * Save a teaching recording to a JSON file
 */
export async function saveRecording(recording: TeachingRecording): Promise<string> {
  await ensureDirectory();

  const filename = `${sanitizeFilename(recording.taskName)}.json`;
  const filePath = path.join(TEACHING_DIR, filename);

  // Save the recording
  await fs.writeFile(filePath, JSON.stringify(recording, null, 2));

  // Update the index
  const index = await loadIndex();
  const existingIdx = index.findIndex((e) => e.id === recording.id);

  const entry: TeachingIndexEntry = {
    id: recording.id,
    taskName: recording.taskName,
    filePath: filename,
    embedding: recording.embedding,
    totalSteps: recording.steps.length,
    createdAt: recording.createdAt,
    isComplete: recording.isComplete,
  };

  if (existingIdx >= 0) {
    index[existingIdx] = entry;
  } else {
    index.push(entry);
  }

  await saveIndex(index);

  console.log(`[Teaching Storage] Saved recording: ${filePath}`);
  return filePath;
}

/**
 * Load a recording by ID
 */
export async function loadRecording(id: string): Promise<TeachingRecording | null> {
  const index = await loadIndex();
  const entry = index.find((e) => e.id === id);

  if (!entry) {
    return null;
  }

  try {
    const filePath = path.join(TEACHING_DIR, entry.filePath);
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch (error) {
    console.error(`[Teaching Storage] Error loading recording ${id}:`, error);
    return null;
  }
}

/**
 * Load a recording by task name
 */
export async function loadRecordingByTaskName(
  taskName: string
): Promise<TeachingRecording | null> {
  const index = await loadIndex();
  const normalizedTask = taskName.toLowerCase();
  const entry = index.find(
    (e) => e.taskName.toLowerCase() === normalizedTask
  );

  if (!entry) {
    return null;
  }

  return loadRecording(entry.id);
}

/**
 * List all recordings (returns index entries for quick listing)
 */
export async function listAllRecordings(): Promise<TeachingIndexEntry[]> {
  return loadIndex();
}

/**
 * Delete a recording by ID
 */
export async function deleteRecording(id: string): Promise<boolean> {
  const index = await loadIndex();
  const entryIdx = index.findIndex((e) => e.id === id);

  if (entryIdx === -1) {
    return false;
  }

  const entry = index[entryIdx];

  try {
    // Delete the file
    const filePath = path.join(TEACHING_DIR, entry.filePath);
    await fs.unlink(filePath);
  } catch (error) {
    console.warn(`[Teaching Storage] Could not delete file for ${id}:`, error);
  }

  // Remove from index
  index.splice(entryIdx, 1);
  await saveIndex(index);

  console.log(`[Teaching Storage] Deleted recording: ${id}`);
  return true;
}
