import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import axios from "axios";

const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

test("stalled startup snapshots time out, later ticks recover, and shutdown cancels the HA read", async t => {
  process.env.DEVICE_STATE_LOG_CRON = "* * * * * *";
  const requireModule = createRequire(__filename);
  const previous = new Map<string, NodeModule | undefined>();
  const saved: unknown[][] = [];
  const stubs = {
    "../src/ai": { generateCompletion: async () => { throw new Error("Unexpected model call"); } },
    "../src/memory": { retrieveMemories: async () => [], formatMemoryContext: () => "" },
    "../src/cosmos": {
      isCosmosConfigured: () => true,
      saveDeviceStatesBatch: async (records: unknown[]) => { saved.push(records); },
    },
  };
  for (const [name, exports] of Object.entries(stubs)) {
    const filename = requireModule.resolve(name);
    previous.set(filename, requireModule.cache[filename]);
    requireModule.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeModule;
  }
  const deadlines: AbortController[] = [];
  t.mock.method(AbortSignal, "timeout", (duration: number) => {
    assert.equal(duration, 10_000);
    const controller = new AbortController();
    deadlines.push(controller);
    return controller.signal;
  });
  const requests: AbortSignal[] = [];
  t.mock.method(axios, "get", async (_url: string, options: { signal: AbortSignal }) => {
    const signal = options.signal;
    requests.push(signal);
    if (requests.length === 2) return { status: 200, data: [{ entity_id: "switch.test", state: "on", attributes: {} }] };
    return new Promise((_resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  t.mock.method(console, "info", () => undefined);
  const errors = t.mock.method(console, "error", () => undefined);
  const { cronJobs } = requireModule("../src/cronJobs") as typeof import("../src/cronJobs");
  try {
    const { startDeviceStateLogging } = requireModule("../src/deviceStateLogger") as typeof import("../src/deviceStateLogger");
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-15T12:00:00Z") });
    startDeviceStateLogging();
    await settle();
    assert.equal(requests.length, 1);
    t.mock.timers.tick(1000); await settle();
    assert.equal(requests.length, 1, "a pending startup capture skips concurrent ticks");
    deadlines[0].abort(new DOMException("HA snapshot deadline exceeded", "TimeoutError"));
    await settle();
    assert.equal(requests[0].aborted, true, "the deadline reaches the actual Axios request");
    assert.equal(saved.length, 0);
    assert.equal(errors.mock.callCount(), 1);
    t.mock.timers.tick(1000); await settle();
    assert.equal(requests.length, 2, "a later tick retries after the timeout");
    assert.equal(saved.length, 1);
    t.mock.timers.tick(1000); await settle();
    assert.equal(requests.length, 3);
    await cronJobs.stop(); await settle();
    assert.equal(requests[2].aborted, true, "shutdown cancels the outstanding Axios request");
    assert.equal(saved.length, 1, "cancelled captures do not persist a snapshot");
    assert.equal(errors.mock.callCount(), 1, "shutdown cancellation is not reported as failure");
    t.mock.timers.tick(1000); await settle();
    assert.equal(requests.length, 3);
  } finally {
    await cronJobs.stop();
    for (const [filename, value] of previous) {
      if (value) requireModule.cache[filename] = value;
      else delete requireModule.cache[filename];
    }
  }
});
