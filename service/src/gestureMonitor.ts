/**
 * Optional open-hand detector. Start the camera only after Python reports ready,
 * and release all resources if either the detector or camera fails.
 */
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { startRtspCapture, stopRtspCapture, isRtspMode } from './agents/common/rtspCapture';
import { callHAServiceDirect } from './ha';
import { redactLogText } from './logSanitizer';

const SESSION_ID = 'gesture-monitor';
const FRAME_DIR = path.join(process.cwd(), 'out', SESSION_ID);
const SCRIPT_PATH = path.join(process.cwd(), 'scripts', 'gesture_detector.py');
let pythonProc: ChildProcess | null = null;
let pollTimer: ReturnType<typeof setInterval> | undefined;
let startupTimer: ReturnType<typeof setTimeout> | undefined;
let frameTimer: ReturnType<typeof setTimeout> | undefined;
let output: readline.Interface | undefined;
let errors: readline.Interface | undefined;
let pendingResolve: ((result: GestureResult) => void) | undefined;
let lastProcessedFrame = '';
let lastGestureTime = 0;
let processing = false;

interface GestureResult { gesture: string; confidence?: number; error?: string }

export function startGestureMonitor(): void {
  if (!isRtspMode() || process.env.GESTURE_ENABLED === 'false' || pythonProc) return;
  const venvPython = path.join(process.cwd(), '.venv', 'bin', 'python');
  const python = process.env.GESTURE_PYTHON || (fs.existsSync(venvPython) ? venvPython : 'python3');
  const proc = spawn(python, [SCRIPT_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  pythonProc = proc;
  const fail = (message: string) => {
    if (pythonProc !== proc) return;
    console.error('[Gesture] ' + redactLogText(message));
    stopGestureMonitor();
  };
  let ready = false;
  startupTimer = setTimeout(() => fail('Detector startup timed out. Check GESTURE_PYTHON and run npm run gesture:setup.'), 30000);
  proc.on('error', error => fail('Cannot start detector: ' + error.message + '. Run npm run gesture:setup.'));
  proc.on('close', code => fail('Detector exited with code ' + code + '. Run npm run gesture:setup; set GESTURE_PYTHON if using another environment.'));
  // Broken pipes must not escape as uncaught exceptions.
  proc.stdin?.on('error', error => fail('Detector input failed: ' + error.message));
  errors = readline.createInterface({ input: proc.stderr! });
  errors.on('line', line => {
    if (pythonProc !== proc) return;
    if (line.trim() !== '[gesture_detector] ready') {
      if (line.trim()) console.error('[Gesture] ' + redactLogText(line));
      return;
    }
    if (ready) return;
    ready = true;
    clearTimeout(startupTimer);
    startupTimer = undefined;
    void startRtspCapture(SESSION_ID, { onFailure: message => fail('Camera failed: ' + message) })
      .then(() => {
        if (pythonProc !== proc) return;
        pollTimer = setInterval(() => {
          if (processing) return;
          processing = true;
          void processLatestFrame(proc).catch(error => fail(String(error))).finally(() => {
            if (pythonProc === proc) processing = false;
          });
        }, 1000);
        console.log('[Gesture] Monitor started');
      }).catch(error => fail('Camera failed: ' + String(error)));
  });
  output = readline.createInterface({ input: proc.stdout! });
  output.on('line', line => {
    if (pythonProc !== proc || !pendingResolve) return;
    try {
      const result = JSON.parse(line) as GestureResult;
      const resolve = pendingResolve;
      pendingResolve = undefined;
      clearTimeout(frameTimer);
      frameTimer = undefined;
      resolve(result);
    } catch {
      // Wait for a valid result or the bounded request timeout.
    }
  });
}

export function stopGestureMonitor(): void {
  const proc = pythonProc;
  pythonProc = null;
  clearInterval(pollTimer);
  clearTimeout(startupTimer);
  clearTimeout(frameTimer);
  pollTimer = startupTimer = frameTimer = undefined;
  output?.close();
  errors?.close();
  output = errors = undefined;
  const resolve = pendingResolve;
  pendingResolve = undefined;
  resolve?.({ gesture: 'none', error: 'detector stopped' });
  proc?.kill('SIGTERM');
  stopRtspCapture(SESSION_ID);
  lastProcessedFrame = '';
  lastGestureTime = 0;
  processing = false;
}

function getLatestFrame(): string | null {
  if (!fs.existsSync(FRAME_DIR)) return null;
  const files = fs.readdirSync(FRAME_DIR).filter(file => file.endsWith('.jpg')).sort().reverse();
  return files.length ? path.join(FRAME_DIR, files[0]) : null;
}

function sendToPython(proc: ChildProcess, frame: string): Promise<GestureResult> {
  return new Promise(resolve => {
    if (pythonProc !== proc || !proc.stdin?.writable) {
      resolve({ gesture: 'none', error: 'detector stopped' });
      return;
    }
    pendingResolve = resolve;
    frameTimer = setTimeout(() => {
      // A late response must never be attributed to the next frame.
      if (pythonProc === proc) {
        console.error('[Gesture] Detector response timed out; stopping monitor.');
        stopGestureMonitor();
      }
    }, 5000);
    proc.stdin.write(frame + '\n');
  });
}

async function processLatestFrame(proc: ChildProcess): Promise<void> {
  const frame = getLatestFrame();
  if (!frame || frame === lastProcessedFrame) return;
  lastProcessedFrame = frame;
  const result = await sendToPython(proc, frame);
  if (pythonProc !== proc || result.gesture !== 'open_hand') return;
  const now = Date.now();
  if (now - lastGestureTime < 3000) return;
  lastGestureTime = now;
  const response = await callHAServiceDirect('media_player', 'media_play_pause', 'media_player.appletv');
  if (!response.success) console.error('[Gesture] Failed to toggle TV: ' + redactLogText(response.message));
}
