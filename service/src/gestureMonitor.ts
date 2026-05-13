/**
 * Gesture Monitor
 *
 * Watches RTSP camera frames for fist gestures using a persistent
 * Python + MediaPipe process. When a fist is detected, toggles
 * TV play/pause via Home Assistant.
 *
 * Requires: python3, mediapipe, opencv-python-headless
 */

import { spawn, ChildProcess } from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as readline from "readline";
import { startRtspCapture, stopRtspCapture, isRtspMode } from "./agents/common/rtspCapture";
import { callHAServiceDirect } from "./ha";

const GESTURE_SESSION_ID = "gesture-monitor";
const FRAME_DIR = path.join(process.cwd(), "out", GESTURE_SESSION_ID);
const SCRIPT_PATH = path.join(process.cwd(), "scripts", "gesture_detector.py");
const POLL_INTERVAL_MS = 1000; // Check for new frame every 1s
const COOLDOWN_MS = 3000; // Prevent rapid toggle

// Entity for play/pause — Apple TV media player
const MEDIA_PLAYER_ENTITY = "media_player.appletv";

let pythonProc: ChildProcess | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let lastProcessedFrame = "";
let lastGestureTime = 0;
let pendingResolve: ((result: GestureResult) => void) | null = null;
let rl: readline.Interface | null = null;

interface GestureResult {
  gesture: string;
  confidence?: number;
  error?: string;
}

export function startGestureMonitor(): void {
  if (!isRtspMode()) {
    console.log("[Gesture] Skipping — not in RTSP mode");
    return;
  }

  if (pythonProc) return;

  // Start dedicated RTSP capture for gesture monitoring
  startRtspCapture(GESTURE_SESSION_ID).catch((err) => {
    console.error("[Gesture] Failed to start RTSP capture:", err.message);
  });

  // Spawn persistent Python process
  pythonProc = spawn("python3", [SCRIPT_PATH], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  pythonProc.stderr?.on("data", (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.log(`[Gesture] ${msg}`);
  });

  pythonProc.on("error", (err) => {
    console.error("[Gesture] Python process error:", err.message);
    pythonProc = null;
  });

  pythonProc.on("close", (code) => {
    if (code !== 0) console.error(`[Gesture] Python exited with code ${code}`);
    pythonProc = null;
  });

  // Read JSON results line by line from Python stdout
  rl = readline.createInterface({ input: pythonProc.stdout! });
  rl.on("line", (line) => {
    try {
      const result: GestureResult = JSON.parse(line);
      if (pendingResolve) {
        pendingResolve(result);
        pendingResolve = null;
      }
    } catch {
      // ignore malformed output
    }
  });

  // Start polling for new frames
  pollTimer = setInterval(() => processLatestFrame(), POLL_INTERVAL_MS);

  console.log("[Gesture] Monitor started");
}

export function stopGestureMonitor(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  if (rl) {
    rl.close();
    rl = null;
  }

  if (pythonProc) {
    pythonProc.kill("SIGTERM");
    pythonProc = null;
  }

  stopRtspCapture(GESTURE_SESSION_ID);
  console.log("[Gesture] Monitor stopped");
}

function getLatestFrame(): string | null {
  if (!fs.existsSync(FRAME_DIR)) return null;

  const files = fs.readdirSync(FRAME_DIR)
    .filter((f) => f.endsWith(".jpg"))
    .sort()
    .reverse();

  return files.length > 0 ? path.join(FRAME_DIR, files[0]) : null;
}

function sendToPython(framePath: string): Promise<GestureResult> {
  return new Promise((resolve) => {
    if (!pythonProc || !pythonProc.stdin?.writable) {
      resolve({ gesture: "none", error: "python not running" });
      return;
    }

    pendingResolve = resolve;
    pythonProc.stdin.write(framePath + "\n");

    // Timeout in case Python hangs
    setTimeout(() => {
      if (pendingResolve === resolve) {
        pendingResolve = null;
        resolve({ gesture: "none", error: "timeout" });
      }
    }, 5000);
  });
}

async function processLatestFrame(): Promise<void> {
  const frame = getLatestFrame();
  if (!frame || frame === lastProcessedFrame) return;

  lastProcessedFrame = frame;

  const result = await sendToPython(frame);

  if (result.gesture === "open_hand") {
    const now = Date.now();
    if (now - lastGestureTime < COOLDOWN_MS) return;
    lastGestureTime = now;

    console.log(
      `[Gesture] Open hand detected (confidence=${result.confidence}) — toggling TV play/pause`
    );

    const res = await callHAServiceDirect(
      "media_player",
      "media_play_pause",
      MEDIA_PLAYER_ENTITY
    );

    if (res.success) {
      console.log("[Gesture] TV play/pause toggled");
    } else {
      console.error("[Gesture] Failed to toggle TV:", res.message);
    }
  }
}
