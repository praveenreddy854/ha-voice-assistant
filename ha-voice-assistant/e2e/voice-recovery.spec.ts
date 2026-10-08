import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { mockBackend } from "./backendFixture";

test.beforeEach(async ({ page }) => {
  // Exercise the real React lifecycle with browser APIs under deterministic
  // control. No test speech or device commands reach the household backend.
  await mockBackend(page);
  await page.routeWebSocket("**/api/realtime-chat", () => {});
  await page.addInitScript(() => {
    class Recognition {
      static instances: Recognition[] = [];
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: ((event: { error: string }) => void) | null = null;
      onresult: ((event: unknown) => void) | null = null;
      results: Array<unknown> = [];
      constructor() { Recognition.instances.push(this); }
      start() { setTimeout(() => this.onstart?.(), 10); }
      abort() { this.onend?.(); }
      emit(text: string) {
        const resultIndex = this.results.length;
        this.results.push(Object.assign([{ transcript: text }], { isFinal: true }));
        this.onresult?.({ resultIndex, results: this.results });
      }
    }
    Object.assign(window, { SpeechRecognition: Recognition, testRecognition: Recognition });
  });
  await page.clock.install();
  await page.goto("/");
});

test("recovers after hours of idle time, then stays stopped after Stop", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "Start Voice Assistant", exact: true }).click();
  await page.clock.runFor(20);
  await expect(page.getByRole("button", { name: "Listening for wake word...", exact: true })).toBeVisible();

  // fastForward models a suspended tab: timers missed during sleep fire once.
  await page.clock.fastForward(3 * 60 * 60 * 1000);
  await page.clock.runFor(1100);
  await expect(page.getByRole("button", { name: "Listening for wake word...", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).testRecognition.instances.length)).toBeGreaterThan(1);

  await page.evaluate(() => (window as any).testRecognition.instances.at(-1).onend());
  await page.clock.runFor(1100);
  await expect(page.getByRole("button", { name: "Listening for wake word...", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Stop Wake Word Detection", exact: true }).click();
  const count = await page.evaluate(() => (window as any).testRecognition.instances.length);
  await page.clock.fastForward(60 * 60 * 1000);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await expect(page.getByRole("button", { name: "Start Voice Assistant", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => (window as any).testRecognition.instances.length)).toBe(count);
  expect(errors).toEqual([]);
});

test("an async completion after the mic cap finishes without reopening command input", async ({ page }) => {
  await mockCommandAudio(page);
  let socket!: WebSocketRoute;
  await page.routeWebSocket("**/api/realtime-chat", (route) => {
    socket = route;
    route.send(JSON.stringify({ type: "session_ready" }));
  });
  await page.reload();
  await page.getByRole("button", { name: "Start Voice Assistant", exact: true }).click();
  await page.clock.runFor(20);
  await page.evaluate(() => (window as any).testRecognition.instances.at(-1).emit("Assistant"));
  await expect.poll(() => page.evaluate(() => (window as any).testAudio.micOpen)).toBe(true);
  socket.send(JSON.stringify({ type: "async_job_started" }));
  await page.clock.runFor(20);
  await page.clock.fastForward(31000);
  await page.clock.runFor(20);
  await expect(page.getByRole("button", { name: "Processing command...", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).testAudio.micOpen)).toBe(false);

  socket.send(JSON.stringify({ type: "async_job_finished", domain: "tv", status: "completed" }));
  socket.send(JSON.stringify({ type: "audio_delta", audio: Buffer.alloc(24000 * 2 * 10).toString("base64") }));
  socket.send(JSON.stringify({ type: "response_done", fullText: "Job completion details" }));
  expect(await page.evaluate(() => (window as any).testAudio.micOpen)).toBe(false);
  socket.send(JSON.stringify({ type: "assistant_interrupted" }));
  socket.send(JSON.stringify({ type: "command_cancelled" }));
  await page.clock.runFor(50);
  await expect(page.getByRole("button", { name: "Listening for wake word...", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).testAudio.stoppedSources)).toBe(1);
  await expect(page.getByText("Job completion details", { exact: true })).toHaveCount(0);
});

test("permission failure is visible and can be retried", async ({ page }) => {
  await page.getByRole("button", { name: "Start Voice Assistant", exact: true }).click();
  await page.clock.runFor(20);
  await page.evaluate(() => (window as any).testRecognition.instances.at(-1).onerror({ error: "not-allowed" }));
  await expect(page.getByRole("alert")).toContainText("Allow microphone access");
  await expect(page.getByRole("button", { name: "Start Voice Assistant", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Start Voice Assistant", exact: true }).click();
  await page.clock.runFor(20);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Listening for wake word...", exact: true })).toBeVisible();
});

test("clearing ordinary speech does not restart recognition and Stop cancels a pending handoff", async ({ page }) => {
  let realtimeConnections = 0;
  await page.routeWebSocket("**/api/realtime-chat", () => { realtimeConnections++; });
  await page.getByRole("button", { name: "Start Voice Assistant", exact: true }).click();
  await page.clock.runFor(20);
  await page.evaluate(() => (window as any).testRecognition.instances.at(-1).emit("ordinary room conversation"));
  await page.clock.runFor(20);
  expect(await page.evaluate(() => (window as any).testRecognition.instances.length)).toBe(1);
  await page.evaluate(() => {
    const recognition = (window as any).testRecognition.instances.at(-1);
    recognition.abort = () => {}; // Reproduce the missing-end handoff hang.
    recognition.emit("Hey assistant");
  });
  await page.getByRole("button", { name: "Stop Voice Assistant", exact: true }).click();
  await page.clock.runFor(2000);
  await expect(page.getByRole("button", { name: "Start Voice Assistant", exact: true })).toBeEnabled();
  expect(realtimeConnections).toBe(0);
});

async function mockCommandAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const state = { micOpen: false, stoppedSources: 0 };
    Object.assign(window, { testAudio: state });
    // Use the browser's audio graph and a silent synthetic microphone stream.
    // The recognizer and proxy events are supplied explicitly by this test.
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (constraints?.video) throw new DOMException("Test camera disabled", "NotAllowedError");
      const context = new AudioContext();
      const destination = context.createMediaStreamDestination();
      state.micOpen = true;
      for (const track of destination.stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { state.micOpen = false; stop(); void context.close(); };
      }
      return destination.stream;
    };
    const stop = AudioBufferSourceNode.prototype.stop;
    AudioBufferSourceNode.prototype.stop = function (when) {
      state.stoppedSources++;
      return stop.call(this, when);
    };
  });
}

test("a same-breath command can be interrupted while its completed response is still playing", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockCommandAudio(page);
  let socket!: WebSocketRoute;
  const requests: Array<{ type: string; text?: string }> = [];
  await page.routeWebSocket("**/api/realtime-chat", (route) => {
    socket = route;
    route.onMessage((data) => requests.push(JSON.parse(String(data))));
    route.send(JSON.stringify({ type: "session_ready" }));
  });
  await page.reload();
  await page.getByRole("button", { name: "Start Voice Assistant", exact: true }).click();
  await page.clock.runFor(20);
  await page.evaluate(() => (window as any).testRecognition.instances.at(-1).emit("Assistant tell me a story"));
  await expect.poll(() => requests.some((event) => event.type === "user_text" && event.text === "tell me a story")).toBe(true);
  expect(await page.evaluate(() => (window as any).testAudio.micOpen)).toBe(true);

  socket.send(JSON.stringify({ type: "audio_delta", audio: Buffer.alloc(24000 * 2 * 10).toString("base64") }));
  socket.send(JSON.stringify({ type: "response_done", fullText: "A long story that should be interrupted" }));
  await page.clock.runFor(500);
  expect(await page.evaluate(() => (window as any).testAudio.micOpen)).toBe(true);
  socket.send(JSON.stringify({ type: "assistant_interrupted" }));
  socket.send(JSON.stringify({ type: "user_transcript", text: "Assistant stop it" }));
  socket.send(JSON.stringify({ type: "command_cancelled" }));
  await page.clock.runFor(50);
  await expect(page.getByRole("button", { name: "Listening for wake word...", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).testAudio.stoppedSources)).toBe(1);
  expect(await page.evaluate(() => (window as any).testAudio.micOpen)).toBe(false);
  await expect(page.getByText("Assistant stop it", { exact: true })).toBeVisible();
  await expect(page.getByText("A long story that should be interrupted", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("speech continues receiving audio after the 30-second mic window", async ({ page }) => {
  await mockCommandAudio(page);
  let socket!: WebSocketRoute;
  const requests: Array<{ type: string }> = [];
  await page.routeWebSocket("**/api/realtime-chat", (route) => {
    socket = route;
    route.onMessage((data) => requests.push(JSON.parse(String(data))));
    route.send(JSON.stringify({ type: "session_ready" }));
  });
  await page.reload();
  await page.getByRole("button", { name: "Start Voice Assistant", exact: true }).click();
  await page.clock.runFor(20);
  await page.evaluate(() => (window as any).testRecognition.instances.at(-1).emit("Assistant tell me a story"));
  await expect.poll(() => page.evaluate(() => (window as any).testAudio.micOpen)).toBe(true);
  socket.send(JSON.stringify({ type: "assistant_work_started", delegationId: "story" }));
  socket.send(JSON.stringify({ type: "audio_delta", audio: Buffer.alloc(4800).toString("base64") }));
  await page.clock.fastForward(31000);
  await page.clock.runFor(20);
  await expect(page.getByRole("button", { name: "Processing command...", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).testAudio.micOpen)).toBe(false);
  expect(requests.some((event) => event.type === "input_end")).toBe(true);
  socket.send(JSON.stringify({ type: "audio_delta", audio: Buffer.alloc(4800).toString("base64") }));
  socket.send(JSON.stringify({ type: "assistant_work_finished", delegationId: "story" }));
  socket.send(JSON.stringify({ type: "response_done", fullText: "The story continued past the microphone limit" }));
  await page.clock.runFor(1000);
  await expect(page.getByText("The story continued past the microphone limit", { exact: true })).toBeVisible();
  await page.clock.runFor(20);
  await expect(page.getByRole("button", { name: "Listening for wake word...", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).testAudio.stoppedSources)).toBe(0);
});
