/**
 * Screenshot Store for Typing Validation
 *
 * The client continuously captures screenshots (~1/sec) and POSTs them to the server.
 * The server saves them to: out/{sessionId}/{datetime}.jpg
 * The deterministic typing tool reads the latest image when it needs to validate.
 */

import { promises as fs } from "fs";
import * as path from "path";

function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

function getSessionDir(sessionId: string): string {
  return path.join(process.cwd(), "out", sessionId);
}

/**
 * Save a screenshot from the client to disk.
 * Path: out/{sessionId}/{datetime}.jpg
 */
export async function saveScreenshot(
  sessionId: string,
  base64: string,
): Promise<string> {
  const dir = getSessionDir(sessionId);
  await ensureDir(dir);

  const fileName = `${getTimestamp()}.jpg`;
  const filePath = path.join(dir, fileName);

  const buffer = Buffer.from(base64, "base64");
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * Read the latest screenshot from the session's directory.
 * Files are named with ISO timestamps so alphabetical sort gives chronological order.
 */
export async function getLatestScreenshot(
  sessionId: string,
): Promise<{ base64: string; contentType: string; filePath: string } | undefined> {
  const dir = getSessionDir(sessionId);

  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return undefined;
  }

  const jpgFiles = files
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .reverse(); // latest first (ISO timestamp strings sort alphabetically)

  if (jpgFiles.length === 0) return undefined;

  const filePath = path.join(dir, jpgFiles[0]);

  try {
    const buffer = await fs.readFile(filePath);
    return {
      base64: buffer.toString("base64"),
      contentType: "image/jpeg",
      filePath,
    };
  } catch {
    return undefined;
  }
}
