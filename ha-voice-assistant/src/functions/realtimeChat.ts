// Azure OpenAI Realtime API v2 — frontend WebSocket client with PCM16 audio playback
// Keeps a persistent WebSocket so the same Azure session (and voice) is reused.

let activeWs: WebSocket | null = null;
let activeAudioCtx: AudioContext | null = null;
let nextPlayTime = 0;

// Per-request callbacks (replaced on each startRealtimeChat call)
let currentOnTranscriptDelta: ((delta: string) => void) | undefined;
let currentOnDone: ((fullText: string) => void) | undefined;
let currentOnError: ((error: string) => void) | undefined;
let currentResolve: (() => void) | null = null;

const SAMPLE_RATE = 24000;

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

function handleMessage(event: MessageEvent): void {
  try {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      case "session_ready":
        // Session is ready — if there's a pending text, it was already sent in startRealtimeChat
        break;

      case "audio_delta":
        if (msg.audio) {
          const samples = pcm16Base64ToFloat32(msg.audio);
          playPcm16Chunk(samples);
        }
        break;

      case "transcript_delta":
        currentOnTranscriptDelta?.(msg.text);
        break;

      case "response_done":
        currentOnDone?.(msg.fullText || "");
        currentResolve?.();
        currentResolve = null;
        break;

      case "error":
        console.error("[RealtimeChat] Error:", msg.message);
        currentOnError?.(msg.message);
        currentResolve?.();
        currentResolve = null;
        break;
    }
  } catch (err) {
    console.error("[RealtimeChat] Error parsing message:", err);
  }
}

function ensureAudioContext(): void {
  if (!activeAudioCtx || activeAudioCtx.state === "closed") {
    activeAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
  }
  nextPlayTime = 0;
}

function isWsOpen(): boolean {
  return activeWs !== null && activeWs.readyState === WebSocket.OPEN;
}

export function stopRealtimeChat(): void {
  if (activeWs) {
    if (activeWs.readyState === WebSocket.OPEN || activeWs.readyState === WebSocket.CONNECTING) {
      activeWs.close();
    }
    activeWs = null;
  }
  if (activeAudioCtx) {
    activeAudioCtx.close().catch(() => {});
    activeAudioCtx = null;
  }
  nextPlayTime = 0;
  currentResolve = null;
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

  ensureAudioContext();

  // Reuse existing connection if still open
  if (isWsOpen()) {
    return new Promise<void>((resolve) => {
      currentResolve = resolve;
      activeWs!.send(JSON.stringify({ type: "user_text", text }));
    });
  }

  // Create new connection
  return new Promise<void>((resolve) => {
    currentResolve = resolve;

    const wsUrl = `ws://localhost:3005/api/realtime-chat`;
    const ws = new WebSocket(wsUrl);
    activeWs = ws;

    ws.onopen = () => {
      console.log("[RealtimeChat] Connected to backend proxy");
    };

    ws.onmessage = (event) => {
      // On first session_ready, send the pending text
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "session_ready") {
          ws.send(JSON.stringify({ type: "user_text", text }));
        }
      } catch { /* handled by handleMessage */ }

      handleMessage(event);
    };

    ws.onerror = (err) => {
      console.error("[RealtimeChat] WebSocket error:", err);
      currentOnError?.("WebSocket connection error");
      currentResolve?.();
      currentResolve = null;
    };

    ws.onclose = () => {
      console.log("[RealtimeChat] WebSocket closed");
      activeWs = null;
    };
  });
}
