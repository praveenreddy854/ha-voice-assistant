/**
 * RTSP Capture Module
 *
 * When on-device camera is disabled (CAMERA_ON_DEVICE !== "true"),
 * this module spawns ffmpeg to capture frames from an RTSP stream
 * at 1fps and saves them to out/{sessionId}/{timestamp}.jpg —
 * the same directory structure that screenshotStore.ts reads from.
 *
 * Requires ffmpeg to be installed on the host machine.
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import { promises as fs } from "fs";

const activeCaptures = new Map<string, ChildProcess>();

function buildRtspUrl(): string {
  const base = process.env.RTSP_URL;
  if (!base) throw new Error("RTSP_URL is not set");

  const username = process.env.RTSP_USERNAME;
  const password = process.env.RTSP_PASSWORD;

  if (username && password) {
    // Insert credentials into rtsp://host... → rtsp://user:pass@host...
    return base.replace("rtsp://", `rtsp://${username}:${password}@`);
  }
  return base;
}

function getSessionDir(sessionId: string): string {
  return path.join(process.cwd(), "out", sessionId);
}

export async function startRtspCapture(sessionId: string): Promise<void> {
  if (activeCaptures.has(sessionId)) return; // already running

  const dir = getSessionDir(sessionId);
  await fs.mkdir(dir, { recursive: true });

  const rtspUrl = buildRtspUrl();
  const outputPattern = path.join(dir, "%Y-%m-%dT%H-%M-%S.jpg");

  const proc = spawn("ffmpeg", [
    "-rtsp_transport", "tcp",
    "-i", rtspUrl,
    "-vf", "fps=1",
    "-q:v", "5",
    "-strftime", "1",
    outputPattern,
  ], { stdio: ["ignore", "pipe", "pipe"] });

  activeCaptures.set(sessionId, proc);

  proc.on("error", (err) => {
    activeCaptures.delete(sessionId);
    console.error(`[RTSP ${sessionId}] Failed to spawn ffmpeg: ${err.message}`);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    // Only log real errors, not ffmpeg's verbose progress
    if (msg.toLowerCase().includes("error") || msg.toLowerCase().includes("fatal")) {
      console.error(`[RTSP ${sessionId}] ${msg}`);
    }
  });

  proc.on("close", (code) => {
    activeCaptures.delete(sessionId);
    if (code && code !== 0 && code !== 255) {
      console.error(`[RTSP ${sessionId}] ffmpeg exited with code ${code}`);
    }
  });

  console.log(`[RTSP] Started capture for session ${sessionId}`);
}

export function stopRtspCapture(sessionId: string): void {
  const proc = activeCaptures.get(sessionId);
  if (!proc) return;

  proc.kill("SIGTERM");
  activeCaptures.delete(sessionId);
  console.log(`[RTSP] Stopped capture for session ${sessionId}`);
}

export function isRtspMode(): boolean {
  return process.env.CAMERA_ON_DEVICE !== "true";
}
