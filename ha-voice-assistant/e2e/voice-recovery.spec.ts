import { expect, test } from "@playwright/test";
import { mockBackend } from "./backendFixture";

test.beforeEach(async ({ page }) => {
  // Exercise the real React lifecycle with browser APIs under deterministic
  // control. No test speech or device commands reach the household backend.
  await mockBackend(page);
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
