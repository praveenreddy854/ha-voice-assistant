import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

test("reminder model deadlines release non-overlap; shutdown never announces or consumes a cancelled episode", async t => {
  process.env.PROACTIVE_REMINDERS_ENABLED = "true";
  process.env.PROACTIVE_REMINDERS_CRON = "* * * * * *";
  process.env.PROACTIVE_REMINDER_ON_MINUTES = "1";
  process.env.AI_MODEL_MINI = "synthetic-reminder-model";
  const requireModule = createRequire(__filename);
  const previous = new Map<string, NodeModule | undefined>();
  const deadlines: AbortController[] = [];
  const modelSignals: AbortSignal[] = [];
  const announcements: string[] = [];
  let episode = "2026-11-15T10:00:00Z";
  let releaseRead: (() => void) | undefined;
  let stallRead = true;
  const readSignals: AbortSignal[] = [];
  const stubs = {
    "../src/ai": { generateCompletion: async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      modelSignals.push(abortSignal);
      if ([2, 4].includes(modelSignals.length)) return "Synthetic reminder";
      return new Promise<string>((_resolve, reject) => {
        abortSignal.throwIfAborted();
        abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
      });
    } },
    "../src/announcementBus": { emitAnnouncement: (message: string) => announcements.push(message) },
    "../src/cosmos": {
      isCosmosConfigured: () => true,
      queryRecentDeviceStates: async (_since: string, signal: AbortSignal) => {
        readSignals.push(signal);
        if (stallRead) await new Promise<void>((resolve, reject) => {
          releaseRead = resolve;
          signal.throwIfAborted();
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return [{ entityId: "switch.test", domain: "switch", state: "on", friendlyName: "Test lamp", attributes: {}, lastChanged: episode, capturedAt: "2026-11-15T12:00:00Z" }];
      },
    },
  };
  for (const [name, exports] of Object.entries(stubs)) {
    const filename = requireModule.resolve(name);
    previous.set(filename, requireModule.cache[filename]);
    requireModule.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeModule;
  }
  t.mock.method(AbortSignal, "timeout", (duration: number) => {
    assert.equal(duration, 10_000);
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  t.mock.method(console, "info", () => undefined);
  const errors = t.mock.method(console, "error", () => undefined);
  const { cronJobs } = requireModule("../src/cronJobs") as typeof import("../src/cronJobs");
  try {
    const { startProactiveReminders } = requireModule("../src/proactiveReminders") as typeof import("../src/proactiveReminders");
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-15T12:00:00Z") });
    startProactiveReminders();
    t.mock.timers.tick(1000); await settle();
    assert.equal(readSignals.length, 1);
    t.mock.timers.tick(1000); await settle();
    assert.equal(readSignals.length, 1, "a stalled Cosmos query skips overlapping ticks");
    deadlines[0].abort(new DOMException("Cosmos deadline", "TimeoutError"));
    await settle();
    assert.equal(readSignals[0].aborted, true);
    assert.equal(modelSignals.length, 0, "a failed Cosmos query cannot start paid model work");
    stallRead = false;
    t.mock.timers.tick(1000); await settle();
    assert.equal(modelSignals.length, 1);
    assert.equal(deadlines.length, 3);
    t.mock.timers.tick(1000); await settle();
    assert.equal(modelSignals.length, 1, "pending model request skips overlapping ticks");
    deadlines[2].abort(new DOMException("Synthetic deadline", "TimeoutError"));
    await settle();
    assert.equal(modelSignals[0].aborted, true);
    assert.match(announcements[0], /^Reminder:/, "a deadline retains existing fallback behavior");
    episode = "2026-11-15T10:01:00Z";
    t.mock.timers.tick(1000); await settle();
    assert.equal(modelSignals.length, 2, "next episode runs after the deadline");
    assert.equal(announcements[1], "Synthetic reminder");
    episode = "2026-11-15T10:02:00Z";
    t.mock.timers.tick(1000); await settle();
    assert.equal(modelSignals.length, 3);
    await cronJobs.stop(); await settle();
    assert.equal(modelSignals[2].aborted, true, "shutdown reaches the actual model request");
    assert.equal(announcements.length, 2, "shutdown cannot emit fallback");
    assert.equal(errors.mock.callCount(), 2, "only the read deadline and model deadline report errors");
    startProactiveReminders();
    t.mock.timers.tick(1000); await settle();
    assert.equal(modelSignals.length, 4, "cancelled episode remains eligible after restart");
    assert.equal(announcements.length, 3);
    episode = "2026-11-15T10:03:00Z";
    stallRead = true;
    t.mock.timers.tick(1000); await settle();
    await cronJobs.stop();
    releaseRead!(); await settle();
    assert.equal(modelSignals.length, 4, "a state read completing after shutdown cannot start AI work");
    assert.equal(announcements.length, 3);
  } finally {
    await cronJobs.stop();
    for (const [filename, value] of previous) {
      if (value) requireModule.cache[filename] = value;
      else delete requireModule.cache[filename];
    }
  }
});
