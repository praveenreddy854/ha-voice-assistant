import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { WakeWordListener, type WakeWordStatus } from "./wakeWordListener";

class FakeRecognition {
  continuous = false;
  interimResults = false;
  lang = "";
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  onaudioend: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  start = vi.fn(() => this.onstart?.());
  abort = vi.fn(() => this.onend?.());
}

let instances: FakeRecognition[];
let listener: WakeWordListener;
let onStatus = vi.fn<(status: WakeWordStatus) => void>();
let onTranscript = vi.fn<(text: string) => void>();
let onError = vi.fn<(message: string) => void>();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T12:00:00Z"));
  instances = [];
  onStatus = vi.fn();
  onTranscript = vi.fn();
  onError = vi.fn();
  vi.stubGlobal("SpeechRecognition", FakeRecognition);
  listener = new WakeWordListener({ onStatus, onTranscript, onError }, () => {
    const recognition = new FakeRecognition();
    instances.push(recognition);
    return recognition as unknown as SpeechRecognition;
  });
});

afterEach(async () => {
  const stopped = listener.stop();
  await vi.advanceTimersByTimeAsync(1000);
  await stopped;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("recovers after unexpected end without another user gesture", async () => {
  listener.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(onStatus).toHaveBeenLastCalledWith("listening");
  instances[0].onend?.();
  expect(onStatus).toHaveBeenLastCalledWith("reconnecting");
  await vi.advanceTimersByTimeAsync(500);
  expect(instances).toHaveLength(2);
  expect(onStatus).toHaveBeenLastCalledWith("listening");
});

test("renews idle recognition over eight hours without opening the paid command mic", async () => {
  listener.start();
  await vi.advanceTimersByTimeAsync(8 * 60 * 60 * 1000 + 10);
  expect(instances.length).toBeGreaterThanOrEqual(90);
  expect(onStatus).toHaveBeenLastCalledWith("listening");
  expect(onError).not.toHaveBeenCalled();
  expect(onTranscript).not.toHaveBeenCalled();
  expect(instances.slice(0, -1).every((recognition) => recognition.abort.mock.calls.length === 1)).toBe(true);
});

test("stop resolves even if the browser never delivers end, and cannot restart", async () => {
  listener.start();
  await vi.advanceTimersByTimeAsync(0);
  instances[0].abort.mockImplementation(() => {});
  const stopped = listener.stop();
  await vi.advanceTimersByTimeAsync(1000);
  await stopped;
  window.dispatchEvent(new Event("online"));
  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(instances).toHaveLength(1);
  expect(onStatus).toHaveBeenLastCalledWith("stopped");
});

test("network and capture errors recover with bounded backoff, then online retries promptly", async () => {
  listener.start();
  await vi.advanceTimersByTimeAsync(0);
  instances[0].onerror?.({ error: "network" });
  await vi.advanceTimersByTimeAsync(500);
  instances[1].onerror?.({ error: "audio-capture" });
  await vi.advanceTimersByTimeAsync(500);
  expect(instances).toHaveLength(2);
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  expect(instances).toHaveLength(3);
  expect(onError).not.toHaveBeenCalled();
});

test("permission denial stops retries and lets the user explicitly retry", async () => {
  listener.start();
  await vi.advanceTimersByTimeAsync(0);
  instances[0].onerror?.({ error: "not-allowed" });
  await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
  expect(instances).toHaveLength(1);
  expect(onError).toHaveBeenCalledWith(expect.stringContaining("Allow microphone access"));
  listener.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(instances).toHaveLength(2);
});

test("a missing start event times out instead of claiming to be listening", async () => {
  listener = new WakeWordListener({ onStatus, onTranscript, onError }, () => {
    const recognition = new FakeRecognition();
    recognition.start.mockImplementation(() => {});
    instances.push(recognition);
    return recognition as unknown as SpeechRecognition;
  });
  listener.start();
  await vi.advanceTimersByTimeAsync(10001);
  expect(onStatus).not.toHaveBeenCalledWith("listening");
  expect(onStatus).toHaveBeenCalledWith("reconnecting");
  expect(instances).toHaveLength(2);
});

test("duplicate results and retired recognizer callbacks cannot trigger a command", async () => {
  listener.start();
  await vi.advanceTimersByTimeAsync(0);
  const oldResult = instances[0].onresult!;
  const result = Object.assign([{ transcript: "Hey assistant" }], { isFinal: true });
  const event = { resultIndex: 0, results: [result] };
  oldResult(event);
  oldResult(event);
  expect(onTranscript).toHaveBeenCalledTimes(1);
  instances[0].onend?.();
  await vi.advanceTimersByTimeAsync(500);
  oldResult(event);
  expect(onTranscript).toHaveBeenCalledTimes(1);
  instances[1].onresult?.(event);
  expect(onTranscript).toHaveBeenCalledTimes(2);
});

test("returning from laptop sleep refreshes a stale session", async () => {
  listener.start();
  await vi.advanceTimersByTimeAsync(0);
  vi.setSystemTime(Date.now() + 3 * 60 * 60 * 1000);
  window.dispatchEvent(new Event("pageshow"));
  await vi.advanceTimersByTimeAsync(1);
  expect(instances).toHaveLength(2);
});

test("idle renewal waits for recent speech and audio loss recovers without end", async () => {
  listener.start();
  await vi.advanceTimersByTimeAsync(299000);
  instances[0].onspeechstart?.();
  await vi.advanceTimersByTimeAsync(6000);
  expect(instances).toHaveLength(1);
  instances[0].onaudioend?.();
  await vi.advanceTimersByTimeAsync(10000);
  expect(instances).toHaveLength(2);
});
