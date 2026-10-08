import { afterEach, beforeEach, expect, test, vi } from "vitest";

class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => { this.readyState = 3; });
  constructor() { FakeWebSocket.instances.push(this); }
  ready() {
    this.readyState = 1;
    this.onmessage?.({ data: JSON.stringify({ type: "session_ready" }) });
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  constructor() { FakeAudioContext.instances.push(this); }
  state = "running";
  sampleRate = 48000;
  currentTime = 0;
  destination = {};
  close = vi.fn(async () => { this.state = "closed"; });
  resume = vi.fn(async () => { this.state = "running"; });
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  createScriptProcessor = vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null }));
  createGain = vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }));
  createBuffer = vi.fn((_channels: number, length: number, sampleRate: number) => ({
    duration: length / sampleRate,
    getChannelData: () => new Float32Array(length),
  }));
  createBufferSource = vi.fn(() => ({
    buffer: null, onended: null, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn(),
  }));
}

let chat: typeof import("./realtimeChat");
let stopTrack = vi.fn();
let getUserMedia = vi.fn<() => Promise<MediaStream>>();
const makeStream = () => ({
  active: true,
  getTracks: () => [{ stop: stopTrack, readyState: "live" }],
  getAudioTracks: () => [{ stop: stopTrack, readyState: "live" }],
}) as unknown as MediaStream;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  FakeWebSocket.instances = [];
  FakeAudioContext.instances = [];
  stopTrack = vi.fn();
  getUserMedia = vi.fn(async () => makeStream());
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  chat = await import("./realtimeChat");
});

afterEach(() => {
  chat.stopRealtimeChat({ closeAudioOutput: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("a dropped text connection resolves the turn and allows a fresh connection", async () => {
  const onError = vi.fn();
  const turn = chat.startRealtimeChat("test", undefined, undefined, onError);
  await vi.advanceTimersByTimeAsync(0);
  const first = FakeWebSocket.instances[0];
  first.ready();
  await vi.advanceTimersByTimeAsync(0);
  const oldClose = first.onclose!;
  oldClose();
  await turn;
  expect(onError).toHaveBeenCalledTimes(1);

  const next = chat.startRealtimeChat("next");
  await vi.advanceTimersByTimeAsync(0);
  const second = FakeWebSocket.instances[1];
  oldClose(); // A late close from the old socket must not tear down the new one.
  second.ready();
  await vi.advanceTimersByTimeAsync(0);
  expect(second.send).toHaveBeenCalledWith(JSON.stringify({ type: "user_text", text: "next" }));
  chat.stopRealtimeChat();
  await next;
});

test("session setup times out and resolves instead of leaving the mic stuck", async () => {
  const onError = vi.fn();
  const turn = chat.startRealtimeVoiceTurn(undefined, undefined, onError);
  await vi.advanceTimersByTimeAsync(15001);
  await turn;
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0][0]).toContain("timed out");
  expect(getUserMedia).not.toHaveBeenCalled();
});

test("stopping during getUserMedia releases a late stream and does not restart the turn", async () => {
  let release!: (stream: MediaStream) => void;
  getUserMedia.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const turn = chat.startRealtimeVoiceTurn();
  await vi.advanceTimersByTimeAsync(0);
  FakeWebSocket.instances[0].ready();
  await vi.advanceTimersByTimeAsync(0);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  chat.stopRealtimeChat();
  await turn;
  release(makeStream());
  await vi.advanceTimersByTimeAsync(0);
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

test("the command mic closes after 30 seconds and a disconnect resolves it immediately", async () => {
  const turn = chat.startRealtimeVoiceTurn();
  await vi.advanceTimersByTimeAsync(0);
  FakeWebSocket.instances[0].ready();
  await vi.advanceTimersByTimeAsync(30001);
  await turn;
  expect(stopTrack).toHaveBeenCalledTimes(1);

  const next = chat.startRealtimeVoiceTurn();
  await vi.advanceTimersByTimeAsync(0);
  FakeWebSocket.instances[0].onclose?.();
  await next;
  expect(stopTrack).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("stopping before audio preparation finishes creates no late websocket", async () => {
  const turn = chat.startRealtimeVoiceTurn();
  chat.stopRealtimeChat();
  await vi.advanceTimersByTimeAsync(0);
  await turn;
  expect(FakeWebSocket.instances).toHaveLength(0);
  expect(getUserMedia).not.toHaveBeenCalled();
});

test("a suspended command audio context is resumed for a follow-up", async () => {
  const turn = chat.startRealtimeVoiceTurn();
  await vi.advanceTimersByTimeAsync(0);
  const socket = FakeWebSocket.instances[0];
  socket.ready();
  await vi.advanceTimersByTimeAsync(0);
  const microphone = FakeAudioContext.instances[1];
  microphone.state = "suspended";
  socket.onmessage?.({ data: JSON.stringify({ type: "assistant_interrupted" }) });
  await vi.advanceTimersByTimeAsync(0);
  expect(microphone.resume).toHaveBeenCalledTimes(1);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  chat.stopRealtimeChat();
  await turn;
});

test("an asynchronous job response error releases the paused wake-word listener", async () => {
  const turn = chat.startRealtimeVoiceTurn();
  await vi.advanceTimersByTimeAsync(0);
  const socket = FakeWebSocket.instances[0];
  socket.ready();
  await vi.advanceTimersByTimeAsync(30001);
  await turn;
  const onJob = vi.fn();
  const onSpeechEnd = vi.fn();
  chat.setAsyncJobEventHandler(onJob);
  chat.setAsyncAssistantSpeechEndHandler(onSpeechEnd);
  socket.onmessage?.({ data: JSON.stringify({ type: "async_job_finished", status: "completed" }) });
  expect(onJob).toHaveBeenCalledTimes(1);
  socket.onmessage?.({ data: JSON.stringify({ type: "error", message: "Upstream disconnected" }) });
  expect(onSpeechEnd).toHaveBeenCalledWith({ followupExpected: false });
  expect(vi.getTimerCount()).toBe(0);
});

function receive(message: Record<string, unknown>) {
  FakeWebSocket.instances[0].onmessage?.({ data: JSON.stringify(message) });
}

async function beginVoice(onDone = vi.fn(), initialText?: string) {
  const turn = chat.startRealtimeVoiceTurn(undefined, onDone, undefined, undefined, undefined, undefined, { initialText });
  await vi.advanceTimersByTimeAsync(0);
  FakeWebSocket.instances[0].ready();
  await vi.advanceTimersByTimeAsync(0);
  return { turn, output: FakeAudioContext.instances[0] };
}

function queueSpeech(seconds: number) {
  receive({ type: "audio_delta", audio: btoa("\0".repeat(24000 * 2 * seconds)) });
}

test("a command captured with the wake phrase opens the mic before requesting its spoken response", async () => {
  let release!: (stream: MediaStream) => void;
  getUserMedia.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
  const { turn } = await beginVoice(vi.fn(), "tell me a story");
  const socket = FakeWebSocket.instances[0];
  const request = JSON.stringify({ type: "user_text", text: "tell me a story" });
  expect(socket.send).not.toHaveBeenCalledWith(request);
  release(makeStream());
  await vi.advanceTimersByTimeAsync(0);
  expect(socket.send).toHaveBeenCalledWith(request);
  expect(stopTrack).not.toHaveBeenCalled();
  chat.stopRealtimeChat();
  await turn;
});

test("generation completion keeps the same microphone streaming through buffered playback and follow-up", async () => {
  const onDone = vi.fn();
  const { turn } = await beginVoice(onDone);
  queueSpeech(10);
  receive({ type: "response_done", fullText: "A long answer" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(stopTrack).not.toHaveBeenCalled();
  expect(onDone).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(10000);
  expect(onDone).toHaveBeenCalledWith("A long answer");
  expect(stopTrack).not.toHaveBeenCalled();
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  chat.stopRealtimeChat();
  await turn;
});

test.each(["assistant_interrupted", "speech_started"])("%s stops every buffered chunk after generation and invalidates the old completion", async (type) => {
  const onDone = vi.fn();
  const { turn, output } = await beginVoice(onDone);
  queueSpeech(10);
  queueSpeech(10);
  receive({ type: "response_done", fullText: "The interrupted answer" });
  await vi.advanceTimersByTimeAsync(1000);
  receive({ type });
  await vi.advanceTimersByTimeAsync(0);
  for (const source of output.createBufferSource.mock.results) {
    expect(source.value.stop).toHaveBeenCalledTimes(1);
  }
  expect(onDone).not.toHaveBeenCalled();
  expect(stopTrack).not.toHaveBeenCalled();
  expect(getUserMedia).toHaveBeenCalledTimes(1);

  queueSpeech(1);
  receive({ type: "response_done", fullText: "A new answer" });
  await vi.advanceTimersByTimeAsync(1200);
  expect(onDone).toHaveBeenCalledExactlyOnceWith("A new answer");
  await vi.advanceTimersByTimeAsync(20000);
  expect(onDone).toHaveBeenCalledTimes(1);
  chat.stopRealtimeChat();
  await turn;
});

test("stop acknowledgement drains playback and resolves the voice turn without a late completion", async () => {
  const onDone = vi.fn();
  const { turn, output } = await beginVoice(onDone);
  queueSpeech(10);
  receive({ type: "response_done", fullText: "Unheard answer" });
  receive({ type: "command_cancelled" });
  await turn;
  expect(output.createBufferSource.mock.results[0].value.stop).toHaveBeenCalledTimes(1);
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(onDone).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

test("the mic cap stops input while speech keeps streaming and waits for the playback tail", async () => {
  const onDone = vi.fn();
  const { turn, output } = await beginVoice(onDone);
  let resolved = false;
  void turn.then(() => { resolved = true; });
  queueSpeech(40);
  await vi.advanceTimersByTimeAsync(30001);
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(resolved).toBe(false);
  expect(FakeWebSocket.instances[0].close).not.toHaveBeenCalled();
  expect(output.createBufferSource.mock.results[0].value.stop).not.toHaveBeenCalled();
  output.currentTime = 30;
  queueSpeech(5); // More speech arrives after the microphone deadline.
  receive({ type: "response_done", fullText: "The whole answer" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(resolved).toBe(false);
  expect(onDone).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(14200);
  await turn;
  expect(onDone).toHaveBeenCalledExactlyOnceWith("The whole answer");
  expect(resolved).toBe(true);
  expect(getUserMedia).toHaveBeenCalledTimes(1);
  for (const source of output.createBufferSource.mock.results) expect(source.value.stop).not.toHaveBeenCalled();
});

test("GPT Live audio uses server timing gaps while leaving the microphone open", async () => {
  const { turn, output } = await beginVoice();
  const audio = btoa("\0".repeat(4800));
  receive({ type: "audio_delta", audio, startMs: 1000, endMs: 1100 });
  receive({ type: "audio_delta", audio, startMs: 2000, endMs: 2100 });
  const first = output.createBufferSource.mock.results[0].value;
  const second = output.createBufferSource.mock.results[1].value;
  expect(second.start.mock.calls[0][0] - first.start.mock.calls[0][0]).toBeCloseTo(1);
  expect(stopTrack).not.toHaveBeenCalled();
  receive({ type: "response_done", fullText: "Short answer" });
  await vi.advanceTimersByTimeAsync(30001);
  await turn;
  expect(FakeWebSocket.instances[0].send).toHaveBeenCalledWith(JSON.stringify({ type: "input_end" }));
});

test("the mic cap waits for delegated reasoning before its speech begins", async () => {
  const onDone = vi.fn();
  const { turn } = await beginVoice(onDone);
  let resolved = false;
  void turn.then(() => { resolved = true; });
  receive({ type: "assistant_work_started", delegationId: "d1" });
  await vi.advanceTimersByTimeAsync(30001);
  expect(stopTrack).toHaveBeenCalledTimes(1);
  expect(resolved).toBe(false);
  receive({ type: "assistant_work_finished", delegationId: "d1" });
  await vi.advanceTimersByTimeAsync(0);
  expect(resolved).toBe(false);
  queueSpeech(1);
  receive({ type: "response_done", fullText: "The final result" });
  await vi.advanceTimersByTimeAsync(1200);
  await turn;
  expect(onDone).toHaveBeenCalledExactlyOnceWith("The final result");
  expect(getUserMedia).toHaveBeenCalledTimes(1);
});

test("a Stop action still cuts speech and resolves an expired microphone turn immediately", async () => {
  const { turn, output } = await beginVoice();
  queueSpeech(40);
  await vi.advanceTimersByTimeAsync(30001);
  chat.stopRealtimeChat({ closeAudioOutput: true });
  await turn;
  expect(output.createBufferSource.mock.results[0].value.stop).toHaveBeenCalledTimes(1);
  expect(FakeWebSocket.instances[0].close).toHaveBeenCalledTimes(1);
});
