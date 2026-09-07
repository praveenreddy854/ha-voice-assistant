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
