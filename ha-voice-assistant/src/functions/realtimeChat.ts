// GPT Live backend proxy client with continuous 24 kHz PCM16 audio playback.

let activeWs: WebSocket | null = null;
let activeAudioCtx: AudioContext | null = null;
let nextPlayTime = 0;
let audioTimelineOrigin: number | null = null;
const playbackSources = new Set<AudioBufferSourceNode>();
const playbackWaits = new Set<() => void>();
let playbackVersion = 0;
let activeMicStream: MediaStream | null = null;
let activeMicCtx: AudioContext | null = null;
let activeProcessor: ScriptProcessorNode | null = null;
let activeMicOutput: GainNode | null = null;
let activeMicStart: Promise<void> | null = null;
let micLifecycleVersion = 0;
let activeSessionReady = false;
let activeConnectTimer: ReturnType<typeof setTimeout> | null = null;
let turnLifecycleVersion = 0;
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
// (e.g. async active-run completion or follow-up question while the wake-word
// listener is active).
export type AsyncJobKind = "completed" | "cancelled" | "needs_input" | "error";
let globalOnAsyncJobEvent: ((event: { kind: AsyncJobKind; domain?: string }) => void) | undefined;
let globalOnAsyncAssistantSpeechEnd:
  | ((info: { followupExpected: boolean }) => void)
  | undefined;
let assistantSpeakingOutsideTurn = false;
let assistantSpeakingOutsideTurnFollowup = false;
let globalOnAgentRunPaused:
  | ((info: { domain?: string; jobId?: string }) => void)
  | undefined;

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

export function setAgentRunPausedHandler(
  handler:
    | ((info: { domain?: string; jobId?: string }) => void)
    | undefined
): void {
  globalOnAgentRunPaused = handler;
}

let globalOnCommandCancelled:
  | ((info: { tvJobId: string | null }) => void)
  | undefined;

export function setCommandCancelledHandler(
  handler: ((info: { tvJobId: string | null }) => void) | undefined
): void {
  globalOnCommandCancelled = handler;
}

function stopAndResetAudioPlayback(): void {
  playbackVersion++;
  for (const source of playbackSources) {
    source.onended = null;
    source.stop();
    source.disconnect();
  }
  playbackSources.clear();
  for (const finish of playbackWaits) finish();
  nextPlayTime = 0;
  audioTimelineOrigin = null;
  audioChunksInResponse = 0;
  loggedAudioDeltaForResponse = false;
}
let currentResolve: (() => void) | null = null;
let currentMode: "text" | "voice" | null = null;
let voiceTurnResolved = false;
let listeningWindowExpired = false;
let assistantResponsePending = false;
let responseActivityVersion = 0;
const pendingAssistantWork = new Set<string>();
const activeAgentJobs = new Set<string>();
let audioChunksInResponse = 0;
let loggedAudioDeltaForResponse = false;
let listeningWindowTimer: ReturnType<typeof setTimeout> | null = null;
let listeningWindowInterval: ReturnType<typeof setInterval> | null = null;

const SAMPLE_RATE = 24000;
const LISTENING_WINDOW_MS = 30000;

interface RealtimeVoiceTurnOptions {
  onListeningWindowChange?: (remainingSeconds: number | null) => void;
  /** A command captured together with the browser wake phrase. */
  initialText?: string;
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
  turnLifecycleVersion++;
  clearListeningWindow();
  stopMicStreaming();
  currentMode = null;
  currentResolve?.();
  currentResolve = null;
}

function failCurrentTurn(message: string): void {
  stopAndResetAudioPlayback();
  currentOnError?.(message);
  resolveCurrentTurn();
  if (assistantSpeakingOutsideTurn) {
    assistantSpeakingOutsideTurn = false;
    assistantSpeakingOutsideTurnFollowup = false;
    globalOnAsyncAssistantSpeechEnd?.({ followupExpected: false });
  }
}

function resolveExpiredTurnWhenFinished(): void {
  if (currentMode === "voice" && listeningWindowExpired && !assistantResponsePending &&
      pendingAssistantWork.size === 0 && activeAgentJobs.size === 0) resolveCurrentTurn();
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
    listeningWindowExpired = true;
    clearListeningWindow();
    stopMicStreaming();
    // The microphone cap does not end reasoning, streaming, or playback.
    resolveExpiredTurnWhenFinished();
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

function playPcm16Chunk(samples: Float32Array, startMs?: number, endMs?: number): void {
  if (!activeAudioCtx) return;

  // Keep the mic open during playback so the user can barge in with the wake
  // phrase. Browser echo cancellation suppresses the assistant's own audio.

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
  playbackSources.add(source);
  source.onended = () => {
    playbackSources.delete(source);
    source.disconnect();
  };

  const now = activeAudioCtx.currentTime;
  if (nextPlayTime < now) {
    nextPlayTime = now + 0.05; // small lead to avoid underrun
  }
  if (typeof startMs === "number") {
    if (audioTimelineOrigin === null) audioTimelineOrigin = nextPlayTime - startMs / 1000;
    nextPlayTime = Math.max(nextPlayTime, audioTimelineOrigin + startMs / 1000);
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
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        playbackWaits.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, remainingMs + 100);
      playbackWaits.add(finish);
    });
  }
}

async function finishResponse(fullText: string, followupExpected: boolean): Promise<void> {
  const lifecycleVersion = turnLifecycleVersion;
  const responsePlaybackVersion = playbackVersion;
  const activityVersion = responseActivityVersion;

  // response_done means generation ended, not playback. Keep capturing speech
  // while queued audio drains, and discard this completion if interrupted.
  await waitForQueuedAudio();
  if (lifecycleVersion !== turnLifecycleVersion || responsePlaybackVersion !== playbackVersion ||
      activityVersion !== responseActivityVersion) return;
  if (audioChunksInResponse === 0 && fullText.trim()) {
    console.warn("[RealtimeChat] Response completed without audio deltas");
  }

  currentOnDone?.(fullText);
  audioChunksInResponse = 0;
  loggedAudioDeltaForResponse = false;
  assistantResponsePending = false;

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

  // Keep the mic available, but DO NOT restart the
  // listening window — it was started once when the turn was activated and
  // is a hard 30s cap. Otherwise stray TV/ambient responses would keep
  // resetting the timer and the session would never close.
  void followupExpected;

  if (listeningWindowExpired) {
    resolveExpiredTurnWhenFinished();
    return;
  }

  await ensureMicStreamingForFollowUp();
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
        if (activeConnectTimer) clearTimeout(activeConnectTimer);
        activeConnectTimer = null;
        activeSessionReady = true;
        if (activeWs) {
          resolvePendingConnections(activeWs);
        }
        break;

      case "audio_delta":
        if (msg.audio) {
          assistantResponsePending = true;
          responseActivityVersion++;
          const samples = pcm16Base64ToFloat32(msg.audio);
          playPcm16Chunk(samples, msg.startMs, msg.endMs);
        }
        break;

      case "transcript_delta":
        assistantResponsePending = true;
        responseActivityVersion++;
        // Mic stays open while the assistant speaks so the user can interrupt;
        // browser echoCancellation suppresses the assistant's own audio.
        currentOnTranscriptDelta?.(msg.text);
        break;

      case "assistant_interrupted":
        console.log("[RealtimeChat] User interrupted assistant — stopping playback");
        stopAndResetAudioPlayback();
        void ensureAudioContext(false);
        if (currentMode === "voice" && !voiceTurnResolved) {
          void ensureMicStreamingForFollowUp();
        }
        break;

      case "response_done":
        void finishResponse(msg.fullText || "", msg.followupExpected === true);
        break;

      case "session_ended":
        resetRealtimeSocket();
        {
          const lifecycle = turnLifecycleVersion;
          void waitForQueuedAudio().then(() => {
            if (lifecycle === turnLifecycleVersion) resolveCurrentTurn();
          });
        }
        break;

      case "assistant_work_started":
        pendingAssistantWork.add(msg.delegationId ?? "text-request");
        assistantResponsePending = true;
        break;

      case "assistant_work_finished":
        pendingAssistantWork.delete(msg.delegationId ?? "text-request");
        resolveExpiredTurnWhenFinished();
        break;

      case "user_transcript":
        // Hard-cap window is not cleared here either — it counts down from
        // activation regardless of how many user/assistant exchanges happen.
        currentOnUserTranscript?.(msg.text || "");
        break;

      case "speech_started":
        // Generation can be finished while several seconds of audio remain
        // queued locally. VAD must stop that tail too.
        if (playbackSources.size > 0) stopAndResetAudioPlayback();
        break;
      case "speech_stopped":
        // VAD fires on ambient noise too; do not touch the listening-window
        // timer here or noise will keep the mic open indefinitely.
        break;

      case "async_job_started":
        activeAgentJobs.add(msg.domain ?? "agent");
        currentOnAsyncJobStarted?.();
        break;

      case "async_job_finished":
        activeAgentJobs.delete(msg.domain ?? "agent");
        assistantResponsePending = true;
        currentOnAsyncJobFinished?.();
        if (currentMode !== "voice" || voiceTurnResolved) {
          assistantSpeakingOutsideTurn = true;
          assistantSpeakingOutsideTurnFollowup = false;
          globalOnAsyncJobEvent?.({
            kind:
              msg.status === "error"
                ? "error"
                : msg.status === "cancelled"
                  ? "cancelled"
                  : "completed",
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

      case "agent_run_paused":
        console.log(
          "[RealtimeChat] Active agent run paused",
          msg.jobId ?? null
        );
        if (currentMode === "voice" && !voiceTurnResolved) {
          startListeningWindow(LISTENING_WINDOW_MS);
          void ensureMicStreamingForFollowUp();
        }
        globalOnAgentRunPaused?.({
          domain: msg.domain,
          jobId: msg.jobId,
        });
        break;

      case "command_cancelled":
        console.log(
          "[RealtimeChat] Server cancelled current command",
          msg.cancelledTvJobId ?? null
        );
        stopAndResetAudioPlayback();
        globalOnCommandCancelled?.({
          tvJobId: msg.cancelledTvJobId ?? null,
        });
        resolveCurrentTurn();
        break;

      case "error":
        console.error("[RealtimeChat] Error:", msg.message);
        resetRealtimeSocket();
        rejectPendingConnections(new Error(msg.message || "Realtime API error"));
        failCurrentTurn(msg.message || "Realtime API error");
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

/** Pause the active server-owned specialist run before collecting a new turn. */
export async function pauseActiveAgentRun(): Promise<void> {
  const ws = await connectRealtime();
  ws.send(JSON.stringify({ type: "pause_active_agent" }));
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
  if (isWsOpen()) sendJson({ type: "input_start" });
  if (activeMicStart) return activeMicStart;

  stopMicStreaming();
  const lifecycleVersion = micLifecycleVersion;

  const startPromise = (async (): Promise<void> => {
    let stream: MediaStream | null = null;
    let micContext: AudioContext | null = null;

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      if (lifecycleVersion !== micLifecycleVersion) return;

      micContext = new (
        window.AudioContext || (window as any).webkitAudioContext
      )();
      if (micContext.state === "suspended") {
        await micContext.resume().catch((error) => {
          console.error(
            "[RealtimeChat] Failed to resume microphone context:",
            error
          );
        });
      }

      if (lifecycleVersion !== micLifecycleVersion) return;

      const source = micContext.createMediaStreamSource(stream);
      const processor = micContext.createScriptProcessor(4096, 1, 1);
      const inputSampleRate = micContext.sampleRate;

      // Drop the first 300ms of captured audio so wake-word residue and the
      // mic's initial pop don't seed Azure's input buffer.
      const micOpenedAt = Date.now();
      const WARMUP_MS = 300;

      processor.onaudioprocess = (event) => {
        if (Date.now() - micOpenedAt < WARMUP_MS) return;
        if (!isWsOpen() || lifecycleVersion !== micLifecycleVersion) return;
        const input = event.inputBuffer.getChannelData(0);
        sendJson({
          type: "input_audio",
          audio: floatToPcm16Base64(input, inputSampleRate),
        });
      };

      const micOutput = micContext.createGain();
      micOutput.gain.value = 0;
      source.connect(processor);
      processor.connect(micOutput);
      micOutput.connect(micContext.destination);

      activeMicStream = stream;
      activeMicCtx = micContext;
      activeProcessor = processor;
      activeMicOutput = micOutput;
      stream = null;
      micContext = null;
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      await micContext?.close().catch(() => {});
    }
  })();

  activeMicStart = startPromise;
  try {
    await startPromise;
  } finally {
    if (activeMicStart === startPromise) {
      activeMicStart = null;
    }
  }
}

async function ensureMicStreamingForFollowUp(): Promise<void> {
  if (listeningWindowExpired) return;
  const lifecycleVersion = turnLifecycleVersion;
  const micIsActive =
    activeMicStream?.active === true &&
    activeMicStream.getAudioTracks().some((track) => track.readyState === "live") &&
    activeProcessor !== null &&
    activeMicCtx?.state !== "closed";
  try {
    if (micIsActive && activeMicCtx) {
      if (activeMicCtx.state !== "running") await activeMicCtx.resume();
    } else {
      await startMicStreaming();
    }
  } catch (error) {
    if (lifecycleVersion !== turnLifecycleVersion) return;
    const message = errorMessage(error, "Unable to reopen the microphone");
    currentOnError?.(message);
    resolveCurrentTurn();
  }
}

function stopMicStreaming(): void {
  if (activeProcessor && isWsOpen()) sendJson({ type: "input_end" });
  micLifecycleVersion++;
  activeMicStart = null;
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
  resolveCurrentTurn();
  // Expiring the command-mic window may leave a long answer queued. Let that
  // audio finish; the explicit Stop button must silence it immediately.
  if (options.closeAudioOutput) stopAndResetAudioPlayback();
  resetRealtimeSocket();
  rejectPendingConnections(new Error("Realtime chat stopped"));
  currentMode = null;
  voiceTurnResolved = true;
  if (options.closeAudioOutput && activeAudioCtx) {
    activeAudioCtx.close().catch(() => {});
    activeAudioCtx = null;
  }
  nextPlayTime = 0;
  currentResolve = null;
  assistantSpeakingOutsideTurn = false;
  assistantSpeakingOutsideTurnFollowup = false;
  pendingAssistantWork.clear();
  activeAgentJobs.clear();
  assistantResponsePending = false;
}

function resetRealtimeSocket(): void {
  if (activeConnectTimer) clearTimeout(activeConnectTimer);
  activeConnectTimer = null;
  activeSessionReady = false;
  if (!activeWs) return;

  activeWs.onclose = null;
  activeWs.onerror = null;
  activeWs.onmessage = null;
  activeWs.onopen = null;
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

    const disconnected = (message: string): void => {
      if (activeWs !== ws) return;
      resetRealtimeSocket();
      rejectPendingConnections(new Error(message));
      failCurrentTurn(message);
    };
    activeConnectTimer = setTimeout(() => {
      disconnected("Realtime connection timed out. Please try again.");
    }, 15000);

    ws.onopen = () => {
      console.log("[RealtimeChat] Connected to backend proxy");
    };

    ws.onmessage = (event) => {
      if (activeWs === ws) handleMessage(event);
    };

    ws.onerror = (err) => {
      console.error("[RealtimeChat] WebSocket error:", err);
      disconnected("Realtime websocket error");
    };

    ws.onclose = () => {
      console.log("[RealtimeChat] WebSocket closed");
      disconnected("Realtime connection closed. Listening can be restarted.");
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
  resolveCurrentTurn();
  // A new wake phrase also interrupts audio left after the previous mic window.
  // Async speech is already arriving for this turn, so preserve its queue.
  if (!assistantSpeakingOutsideTurn) stopAndResetAudioPlayback();
  const lifecycleVersion = ++turnLifecycleVersion;
  currentOnTranscriptDelta = onTranscriptDelta;
  currentOnDone = onDone;
  currentOnError = onError;
  currentOnUserTranscript = onUserTranscript;
  currentOnAsyncJobStarted = onAsyncJobStarted;
  currentOnAsyncJobFinished = onAsyncJobFinished;
  currentOnListeningWindowChange = options.onListeningWindowChange;
  currentMode = "voice";
  voiceTurnResolved = false;
  listeningWindowExpired = false;
  assistantResponsePending = false;
  clearListeningWindow();

  return new Promise<void>((resolve) => {
    currentResolve = resolve;

    const fail = (error: unknown): void => {
      if (lifecycleVersion !== turnLifecycleVersion) return;
      currentOnError?.(errorMessage(error, "Realtime connection error"));
      stopMicStreaming();
      resolveCurrentTurn();
    };

    (async () => {
      try {
        await ensureAudioContext(!assistantSpeakingOutsideTurn);
        if (lifecycleVersion !== turnLifecycleVersion) return;
        const ws = await connectRealtime();
        if (lifecycleVersion !== turnLifecycleVersion) return;
        // Bare wake-word opens the mic for a real conversation — force the
        // first response to keep the mic open so the user can actually speak,
        // even if the model forgets to call await_user_followup.
        ws.send(JSON.stringify({ type: "force_followup" }));
        await startMicStreaming();
        if (lifecycleVersion !== turnLifecycleVersion) return;
        startListeningWindow(LISTENING_WINDOW_MS);
        if (options.initialText?.trim()) {
          ws.send(JSON.stringify({ type: "user_text", text: options.initialText.trim() }));
        }
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
  resolveCurrentTurn();
  const lifecycleVersion = ++turnLifecycleVersion;
  // Update per-request callbacks
  currentOnTranscriptDelta = onTranscriptDelta;
  currentOnDone = onDone;
  currentOnError = onError;

  currentMode = "text";
  voiceTurnResolved = true;
  clearListeningWindow();

  const sendText = async (): Promise<void> => {
    await ensureAudioContext();
    if (lifecycleVersion !== turnLifecycleVersion) return;
    const ws = await connectRealtime();
    if (lifecycleVersion !== turnLifecycleVersion) return;
    ws.send(JSON.stringify({ type: "user_text", text }));
  };

  return new Promise<void>((resolve) => {
    currentResolve = resolve;
    sendText()
      .catch(async (error) => {
        if (lifecycleVersion !== turnLifecycleVersion) return;
        console.warn("[RealtimeChat] Retrying text turn after connection issue:", error);
        resetRealtimeSocket();
        try {
          await sendText();
        } catch (retryError) {
          if (lifecycleVersion !== turnLifecycleVersion) return;
          currentOnError?.(errorMessage(retryError, "Realtime connection error"));
          currentMode = null;
          currentResolve?.();
          currentResolve = null;
        }
      });
  });
}
