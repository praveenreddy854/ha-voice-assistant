// Azure OpenAI Realtime API v2 — frontend WebSocket client with PCM16 audio playback
// Keeps a persistent WebSocket so the same Azure session (and voice) is reused.

let activeWs: WebSocket | null = null;
let activeAudioCtx: AudioContext | null = null;
let nextPlayTime = 0;
let activeMicStream: MediaStream | null = null;
let activeMicCtx: AudioContext | null = null;
let activeProcessor: ScriptProcessorNode | null = null;
let activeMicOutput: GainNode | null = null;
let activeSessionReady = false;
let pendingConnectResolvers: Array<(ws: WebSocket) => void> = [];
let pendingConnectRejectors: Array<(error: Error) => void> = [];

// Per-request callbacks (replaced on each startRealtimeChat call)
let currentOnTranscriptDelta: ((delta: string) => void) | undefined;
let currentOnDone: ((fullText: string) => void) | undefined;
let currentOnError: ((error: string) => void) | undefined;
let currentOnUserTranscript: ((text: string) => void) | undefined;
let currentOnAsyncJobStarted: (() => void) | undefined;
let currentOnAsyncJobFinished: (() => void) | undefined;
let currentOnListeningWindowChange:
  | ((remainingSeconds: number | null) => void)
  | undefined;

// Global handlers for events that arrive outside an active voice turn
// (e.g. async TV-job completion or follow-up question while the wake-word
// listener is active).
export type AsyncJobKind = "completed" | "needs_input" | "error";
let globalOnAsyncJobEvent: ((event: { kind: AsyncJobKind; domain?: string }) => void) | undefined;
let globalOnAsyncAssistantSpeechEnd:
  | ((info: { followupExpected: boolean }) => void)
  | undefined;
let assistantSpeakingOutsideTurn = false;
let assistantSpeakingOutsideTurnFollowup = false;

export function setAsyncJobEventHandler(
  handler: ((event: { kind: AsyncJobKind; domain?: string }) => void) | undefined
): void {
  globalOnAsyncJobEvent = handler;
}

export function setAsyncAssistantSpeechEndHandler(
  handler: ((info: { followupExpected: boolean }) => void) | undefined
): void {
  globalOnAsyncAssistantSpeechEnd = handler;
}
let currentResolve: (() => void) | null = null;
let currentMode: "text" | "voice" | null = null;
let voiceTurnResolved = false;
let audioChunksInResponse = 0;
let loggedAudioDeltaForResponse = false;
let listeningWindowTimer: ReturnType<typeof setTimeout> | null = null;
let listeningWindowInterval: ReturnType<typeof setInterval> | null = null;

const SAMPLE_RATE = 24000;
const LISTENING_WINDOW_MS = 30000;

interface RealtimeVoiceTurnOptions {
  onListeningWindowChange?: (remainingSeconds: number | null) => void;
}

function resolvePendingConnections(ws: WebSocket): void {
  for (const resolve of pendingConnectResolvers.splice(0)) {
    resolve(ws);
  }
  pendingConnectRejectors = [];
}

function rejectPendingConnections(error: Error): void {
  for (const reject of pendingConnectRejectors.splice(0)) {
    reject(error);
  }
  pendingConnectResolvers = [];
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function clearListeningWindow(): void {
  if (listeningWindowTimer) {
    clearTimeout(listeningWindowTimer);
    listeningWindowTimer = null;
  }
  if (listeningWindowInterval) {
    clearInterval(listeningWindowInterval);
    listeningWindowInterval = null;
  }
  currentOnListeningWindowChange?.(null);
}

function resolveCurrentTurn(): void {
  if (currentMode === "voice" && voiceTurnResolved) return;

  if (currentMode === "voice") {
    voiceTurnResolved = true;
  }
  clearListeningWindow();
  stopMicStreaming();
  currentMode = null;
  currentResolve?.();
  currentResolve = null;
}

function startListeningWindow(durationMs: number): void {
  clearListeningWindow();

  let remainingSeconds = Math.ceil(durationMs / 1000);
  currentOnListeningWindowChange?.(remainingSeconds);

  listeningWindowInterval = setInterval(() => {
    remainingSeconds = Math.max(0, remainingSeconds - 1);
    currentOnListeningWindowChange?.(remainingSeconds);
  }, 1000);

  listeningWindowTimer = setTimeout(() => {
    console.log("[RealtimeChat] Follow-up window expired");
    resolveCurrentTurn();
  }, durationMs);
}

function pcm16Base64ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const len = binary.length;
  const samples = new Float32Array(len / 2);
  for (let i = 0; i < samples.length; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    // Little-endian signed 16-bit
    let val = lo | (hi << 8);
    if (val >= 0x8000) val -= 0x10000;
    samples[i] = val / 32768;
  }
  return samples;
}

function playPcm16Chunk(samples: Float32Array): void {
  if (!activeAudioCtx) return;

  // Close the mic while the assistant is speaking so we don't capture its own
  // audio, but leave the listening-window timer alone — it represents
  // "time until the voice turn ends" and shouldn't be reset by every chunk.
  if (currentMode === "voice") {
    stopMicStreaming();
  }

  audioChunksInResponse += 1;
  if (!loggedAudioDeltaForResponse) {
    console.log("[RealtimeChat] Realtime audio playback started");
    loggedAudioDeltaForResponse = true;
  }
  if (activeAudioCtx.state === "suspended") {
    activeAudioCtx.resume().catch((error) => {
      console.error("[RealtimeChat] Failed to resume audio output:", error);
    });
  }

  const buffer = activeAudioCtx.createBuffer(1, samples.length, SAMPLE_RATE);
  buffer.getChannelData(0).set(samples);

  const source = activeAudioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(activeAudioCtx.destination);

  const now = activeAudioCtx.currentTime;
  if (nextPlayTime < now) {
    nextPlayTime = now + 0.05; // small lead to avoid underrun
  }
  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;
}

async function waitForQueuedAudio(): Promise<void> {
  if (!activeAudioCtx || audioChunksInResponse === 0) return;

  if (activeAudioCtx.state === "suspended") {
    try {
      await activeAudioCtx.resume();
    } catch (error) {
      console.error("[RealtimeChat] Failed to resume queued audio:", error);
    }
  }

  const remainingMs = Math.max(
    0,
    Math.ceil((nextPlayTime - activeAudioCtx.currentTime) * 1000)
  );
  if (remainingMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingMs + 100));
  }
}

async function finishResponse(fullText: string, followupExpected: boolean): Promise<void> {
  const isVoiceTurn = currentMode === "voice";
  if (isVoiceTurn) {
    stopMicStreaming();
  }

  await waitForQueuedAudio();
  if (audioChunksInResponse === 0 && fullText.trim()) {
    console.warn("[RealtimeChat] Response completed without audio deltas");
  }

  currentOnDone?.(fullText);
  audioChunksInResponse = 0;
  loggedAudioDeltaForResponse = false;

  if (currentMode !== "voice" || voiceTurnResolved) {
    if (currentMode === "text") {
      currentMode = null;
      currentResolve?.();
      currentResolve = null;
    }
    if (assistantSpeakingOutsideTurn) {
      const info = {
        followupExpected: followupExpected || assistantSpeakingOutsideTurnFollowup,
      };
      assistantSpeakingOutsideTurn = false;
      assistantSpeakingOutsideTurnFollowup = false;
      globalOnAsyncAssistantSpeechEnd?.(info);
    }
    return;
  }

  // Reopen the mic so the user can keep talking, but DO NOT restart the
  // listening window — it was started once when the turn was activated and
  // is a hard 30s cap. Otherwise stray TV/ambient responses would keep
  // resetting the timer and the session would never close.
  void followupExpected;

  // If the hard cap already expired during the response, the turn was
  // already resolved by the listening-window timer; nothing more to do.
  if (voiceTurnResolved) return;

  try {
    await startMicStreaming();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    currentOnError?.(message);
    resolveCurrentTurn();
  }
}

function floatToPcm16Base64(input: Float32Array, inputSampleRate: number): string {
  const ratio = inputSampleRate / SAMPLE_RATE;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const pcm = new Int16Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const sourceIndex = Math.min(input.length - 1, Math.round(i * ratio));
    const sample = Math.max(-1, Math.min(1, input[sourceIndex]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  let binary = "";
  const bytes = new Uint8Array(pcm.buffer);
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function handleMessage(event: MessageEvent): void {
  try {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "session_ready":
        activeSessionReady = true;
        if (activeWs) {
          resolvePendingConnections(activeWs);
        }
        break;

      case "audio_delta":
        if (msg.audio) {
          const samples = pcm16Base64ToFloat32(msg.audio);
          playPcm16Chunk(samples);
        }
        break;

      case "transcript_delta":
        // Assistant is starting to speak — close the mic so we don't capture
        // its own output. The listening window is a hard cap from activation
        // and is intentionally NOT cleared here.
        if (currentMode === "voice") {
          stopMicStreaming();
        }
        currentOnTranscriptDelta?.(msg.text);
        break;

      case "response_done":
        void finishResponse(msg.fullText || "", msg.followupExpected === true);
        break;

      case "user_transcript":
        // Hard-cap window is not cleared here either — it counts down from
        // activation regardless of how many user/assistant exchanges happen.
        currentOnUserTranscript?.(msg.text || "");
        break;

      case "speech_started":
      case "speech_stopped":
        // VAD fires on ambient noise too; do not touch the listening-window
        // timer here or noise will keep the mic open indefinitely.
        break;

      case "async_job_started":
        currentOnAsyncJobStarted?.();
        break;

      case "async_job_finished":
        currentOnAsyncJobFinished?.();
        if (currentMode !== "voice" || voiceTurnResolved) {
          assistantSpeakingOutsideTurn = true;
          assistantSpeakingOutsideTurnFollowup = false;
          globalOnAsyncJobEvent?.({
            kind: msg.status === "error" ? "error" : "completed",
            domain: msg.domain,
          });
        }
        break;

      case "async_job_needs_input":
        if (currentMode !== "voice" || voiceTurnResolved) {
          assistantSpeakingOutsideTurn = true;
          assistantSpeakingOutsideTurnFollowup = true;
          globalOnAsyncJobEvent?.({ kind: "needs_input", domain: msg.domain });
        }
        break;

      case "error":
        console.error("[RealtimeChat] Error:", msg.message);
        rejectPendingConnections(new Error(msg.message || "Realtime API error"));
        currentOnError?.(msg.message);
        stopMicStreaming();
        resolveCurrentTurn();
        break;
    }
  } catch (err) {
    console.error("[RealtimeChat] Error parsing message:", err);
  }
}

async function ensureAudioContext(resetPlaybackQueue = true): Promise<void> {
  if (!activeAudioCtx || activeAudioCtx.state === "closed") {
    activeAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  }

  if (activeAudioCtx.state === "suspended") {
    try {
      await activeAudioCtx.resume();
    } catch (error) {
      console.error("[RealtimeChat] Failed to resume audio output:", error);
    }
  }

  if (resetPlaybackQueue) {
    nextPlayTime = 0;
    audioChunksInResponse = 0;
    loggedAudioDeltaForResponse = false;
  }
}

export function prepareRealtimeAudioOutput(): void {
  ensureAudioContext(false).catch((error) => {
    console.error("[RealtimeChat] Failed to prepare audio output:", error);
  });
}

function isWsOpen(): boolean {
  return activeWs !== null && activeWs.readyState === WebSocket.OPEN;
}

function isWsConnecting(): boolean {
  return activeWs !== null && activeWs.readyState === WebSocket.CONNECTING;
}

function sendJson(payload: Record<string, unknown>): void {
  if (!isWsOpen()) return;
  activeWs!.send(JSON.stringify(payload));
}

async function startMicStreaming(): Promise<void> {
  stopMicStreaming();

  activeMicStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  activeMicCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  if (activeMicCtx.state === "suspended") {
    await activeMicCtx.resume().catch((error) => {
      console.error("[RealtimeChat] Failed to resume microphone context:", error);
    });
  }
  const source = activeMicCtx.createMediaStreamSource(activeMicStream);
  activeProcessor = activeMicCtx.createScriptProcessor(4096, 1, 1);

  // Drop the first 300ms of captured audio so wake-word residue and the
  // mic's initial pop don't seed Azure's input buffer.
  const micOpenedAt = Date.now();
  const WARMUP_MS = 300;

  activeProcessor.onaudioprocess = (event) => {
    if (!isWsOpen() || !activeMicCtx) return;
    if (Date.now() - micOpenedAt < WARMUP_MS) return;
    const input = event.inputBuffer.getChannelData(0);
    sendJson({
      type: "input_audio",
      audio: floatToPcm16Base64(input, activeMicCtx.sampleRate),
    });
  };

  source.connect(activeProcessor);
  activeMicOutput = activeMicCtx.createGain();
  activeMicOutput.gain.value = 0;
  activeProcessor.connect(activeMicOutput);
  activeMicOutput.connect(activeMicCtx.destination);
}

function stopMicStreaming(): void {
  if (activeProcessor) {
    activeProcessor.disconnect();
    activeProcessor.onaudioprocess = null;
    activeProcessor = null;
  }
  if (activeMicOutput) {
    activeMicOutput.disconnect();
    activeMicOutput = null;
  }
  if (activeMicStream) {
    activeMicStream.getTracks().forEach((track) => track.stop());
    activeMicStream = null;
  }
  if (activeMicCtx) {
    activeMicCtx.close().catch(() => {});
    activeMicCtx = null;
  }
}

export function stopRealtimeChat(options: { closeAudioOutput?: boolean } = {}): void {
  stopMicStreaming();
  clearListeningWindow();
  if (activeWs) {
    if (activeWs.readyState === WebSocket.OPEN || activeWs.readyState === WebSocket.CONNECTING) {
      activeWs.close();
    }
    activeWs = null;
  }
  activeSessionReady = false;
  rejectPendingConnections(new Error("Realtime chat stopped"));
  currentMode = null;
  voiceTurnResolved = true;
  if (options.closeAudioOutput && activeAudioCtx) {
    activeAudioCtx.close().catch(() => {});
    activeAudioCtx = null;
  }
  nextPlayTime = 0;
  currentResolve = null;
}

function resetRealtimeSocket(): void {
  activeSessionReady = false;
  if (!activeWs) return;

  activeWs.onclose = null;
  activeWs.onerror = null;
  if (activeWs.readyState === WebSocket.OPEN || activeWs.readyState === WebSocket.CONNECTING) {
    activeWs.close();
  }
  activeWs = null;
}

function connectRealtime(): Promise<WebSocket> {
  if (isWsOpen() && activeSessionReady) {
    return Promise.resolve(activeWs!);
  }

  if (isWsOpen() || isWsConnecting()) {
    return new Promise<WebSocket>((resolve, reject) => {
      pendingConnectResolvers.push(resolve);
      pendingConnectRejectors.push(reject);
    });
  }

  return new Promise<WebSocket>((resolve, reject) => {
    const wsUrl = `ws://localhost:3005/api/realtime-chat`;
    const ws = new WebSocket(wsUrl);
    activeWs = ws;
    activeSessionReady = false;
    pendingConnectResolvers.push(resolve);
    pendingConnectRejectors.push(reject);

    ws.onopen = () => {
      console.log("[RealtimeChat] Connected to backend proxy");
    };

    ws.onmessage = (event) => {
      handleMessage(event);
    };

    ws.onerror = (err) => {
      console.error("[RealtimeChat] WebSocket error:", err);
      rejectPendingConnections(new Error("Realtime websocket error"));
    };

    ws.onclose = () => {
      console.log("[RealtimeChat] WebSocket closed");
      activeWs = null;
      activeSessionReady = false;
      stopMicStreaming();
      rejectPendingConnections(new Error("WebSocket closed before session was ready"));
    };
  });
}

export async function startRealtimeVoiceTurn(
  onTranscriptDelta?: (delta: string) => void,
  onDone?: (fullText: string) => void,
  onError?: (error: string) => void,
  onUserTranscript?: (text: string) => void,
  onAsyncJobStarted?: () => void,
  onAsyncJobFinished?: () => void,
  options: RealtimeVoiceTurnOptions = {}
): Promise<void> {
  currentOnTranscriptDelta = onTranscriptDelta;
  currentOnDone = onDone;
  currentOnError = onError;
  currentOnUserTranscript = onUserTranscript;
  currentOnAsyncJobStarted = onAsyncJobStarted;
  currentOnAsyncJobFinished = onAsyncJobFinished;
  currentOnListeningWindowChange = options.onListeningWindowChange;
  currentMode = "voice";
  voiceTurnResolved = false;
  clearListeningWindow();

  return new Promise<void>((resolve) => {
    currentResolve = resolve;

    const fail = (error: unknown): void => {
      currentOnError?.(errorMessage(error, "Realtime connection error"));
      stopMicStreaming();
      resolveCurrentTurn();
    };

    (async () => {
      try {
        await ensureAudioContext();
        const ws = await connectRealtime();
        // Bare wake-word opens the mic for a real conversation — force the
        // first response to keep the mic open so the user can actually speak,
        // even if the model forgets to call await_user_followup.
        ws.send(JSON.stringify({ type: "force_followup" }));
        await startMicStreaming();
        startListeningWindow(LISTENING_WINDOW_MS);
      } catch (error) {
        fail(error);
      }
    })();
  });
}

export function startRealtimeChat(
  text: string,
  onTranscriptDelta?: (delta: string) => void,
  onDone?: (fullText: string) => void,
  onError?: (error: string) => void
): Promise<void> {
  // Update per-request callbacks
  currentOnTranscriptDelta = onTranscriptDelta;
  currentOnDone = onDone;
  currentOnError = onError;

  currentMode = "text";
  voiceTurnResolved = true;
  clearListeningWindow();

  const sendText = async (): Promise<void> => {
    await ensureAudioContext();
    const ws = await connectRealtime();
    ws.send(JSON.stringify({ type: "user_text", text }));
  };

  return new Promise<void>((resolve) => {
    currentResolve = resolve;
    sendText()
      .catch(async (error) => {
        console.warn("[RealtimeChat] Retrying text turn after connection issue:", error);
        resetRealtimeSocket();
        try {
          await sendText();
        } catch (retryError) {
          currentOnError?.(errorMessage(retryError, "Realtime connection error"));
          currentMode = null;
          currentResolve?.();
          currentResolve = null;
        }
      });
  });
}
