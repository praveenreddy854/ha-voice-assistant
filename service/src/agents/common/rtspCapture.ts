/**
 * Capture RTSP frames for a session. A failed capture is removed and can be
 * restarted; a stopped or superseded process cannot remove its replacement.
 */
import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as readline from 'readline';
import { redactLogText } from '../../logSanitizer';

interface Capture {
  proc?: ChildProcess;
  stopped: boolean;
}
const activeCaptures = new Map<string, Capture>();

function buildRtspUrl(): string {
  if (!process.env.RTSP_URL) throw new Error('RTSP_URL is not set');
  const url = new URL(process.env.RTSP_URL);
  if (!['rtsp:', 'rtsps:'].includes(url.protocol)) throw new Error('RTSP_URL must use rtsp:// or rtsps://');
  if (process.env.RTSP_USERNAME && process.env.RTSP_PASSWORD) {
    url.username = process.env.RTSP_USERNAME;
    url.password = process.env.RTSP_PASSWORD;
  }
  return url.toString();
}

export async function startRtspCapture(
  sessionId: string,
  options: { onFailure?: (message: string) => void } = {}
): Promise<void> {
  if (activeCaptures.has(sessionId)) return;
  const capture: Capture = { stopped: false };
  activeCaptures.set(sessionId, capture);
  try {
    const url = buildRtspUrl();
    const dir = path.join(process.cwd(), 'out', sessionId);
    await fs.mkdir(dir, { recursive: true });
    if (capture.stopped) return;

    const proc = spawn('ffmpeg', [
      '-rtsp_transport', 'tcp',
      '-timeout', '15000000',
      '-i', url,
      '-vf', 'fps=1', '-q:v', '5', '-strftime', '1',
      path.join(dir, '%Y-%m-%dT%H-%M-%S.jpg'),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    capture.proc = proc;
    let failed = false;
    const fail = (message: string) => {
      if (capture.stopped || failed) return;
      failed = true;
      if (activeCaptures.get(sessionId) === capture) activeCaptures.delete(sessionId);
      console.error('[RTSP ' + sessionId + '] ' + redactLogText(message));
      options.onFailure?.(redactLogText(message));
    };
    proc.on('error', error => fail('Failed to spawn ffmpeg: ' + error.message));
    // Buffer whole lines so a credential split across stderr chunks is redacted.
    const lines = readline.createInterface({ input: proc.stderr! });
    lines.on('line', line => {
      if (/error|fatal/i.test(line)) console.error('[RTSP ' + sessionId + '] ' + redactLogText(line));
    });
    proc.on('close', (code, signal) => {
      lines.close();
      if (activeCaptures.get(sessionId) === capture) activeCaptures.delete(sessionId);
      if (!capture.stopped) fail('Capture ended (code ' + code + ', signal ' + signal + '). Check the camera address and connection.');
    });
    console.log('[RTSP] Started capture for session ' + sessionId);
  } catch (error) {
    if (activeCaptures.get(sessionId) === capture) activeCaptures.delete(sessionId);
    throw new Error(redactLogText(error instanceof Error ? error.message : String(error)));
  }
}

export function stopRtspCapture(sessionId: string): void {
  const capture = activeCaptures.get(sessionId);
  if (!capture) return;
  capture.stopped = true;
  activeCaptures.delete(sessionId);
  capture.proc?.kill('SIGTERM');
  console.log('[RTSP] Stopped capture for session ' + sessionId);
}

export function isRtspMode(): boolean {
  return process.env.CAMERA_ON_DEVICE !== 'true';
}
