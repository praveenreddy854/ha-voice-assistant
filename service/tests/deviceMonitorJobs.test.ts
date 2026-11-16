import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDeviceMonitorJobs, parseDeviceMonitorJobs, registerDeviceMonitorJobs } from "../src/deviceMonitorJobs";
import type { CronJob } from "../src/cronJobs";
import type { HassState } from "../src/types/ha";

const now = Date.parse("2026-11-15T12:00:00Z");
const input = {
  id: "test-device", cron: "* * * * * *", entityId: "switch.test_device",
  conditions: [{ field: "state", operator: "equals", value: "on" }],
  announcement: "Check the device", minStateDurationSeconds: 3000,
};

function fixture(overrides: Record<string, unknown> = {}) {
  const registered: CronJob[] = [];
  const announcements: string[] = [];
  let state: HassState = {
    entity_id: input.entityId, state: "on", attributes: {},
    last_changed: new Date(now - 3_000_000).toISOString(),
  };
  const jobs = parseDeviceMonitorJobs([{ ...input, ...overrides }]);
  const controller = new AbortController();
  let reads = 0;
  registerDeviceMonitorJobs(jobs, { register: job => registered.push(job) }, {
    now: () => now,
    readState: async (id, signal) => {
      assert.equal(id, input.entityId);
      assert.equal(signal.aborted, false);
      reads++;
      return state;
    },
    announce: message => announcements.push(message),
  });
  return {
    registered, announcements, controller,
    get reads() { return reads; },
    setState: (next: Partial<HassState>) => { state = { ...state, ...next }; },
    run: () => registered[0].run(controller.signal, "scheduled"),
  };
}

test("no monitors run by default; JSON configuration and the example validate", t => {
  assert.deepEqual(loadDeviceMonitorJobs(), []);
  assert.equal(loadDeviceMonitorJobs(path.join(__dirname, "../device-monitor-jobs.example.json")).length, 2);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "device-monitor-jobs-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "jobs.json");
  fs.writeFileSync(file, JSON.stringify([input]));
  assert.equal(loadDeviceMonitorJobs(file)[0].cron, "* * * * * *");
  fs.writeFileSync(file, "not json");
  assert.throws(() => loadDeviceMonitorJobs(file));
});

test("configuration rejects invalid cron, timezone, IDs, conditions and duplicate IDs", () => {
  for (const overrides of [
    { cron: "61 * * * * *" }, { timezone: "Invalid/Zone" }, { entityId: "../../api/services" },
    { conditions: [] }, { conditions: [{ field: "invalid", operator: "equals", value: "on" }] },
    { minStateDurationSeconds: -1 }, { announcementPolicy: "invalid" }, { typo: true },
  ]) assert.throws(() => parseDeviceMonitorJobs([{ ...input, ...overrides }]));
  assert.throws(() => parseDeviceMonitorJobs([input, input]), /Duplicate job ID/);
});

test("state-duration checks use HA timestamps, cancel on off, and announce once per episode", async () => {
  const f = fixture();
  assert.equal(f.registered[0].expression, "* * * * * *");
  f.setState({ last_changed: new Date(now - 2_999_999).toISOString() });
  await f.run(); assert.deepEqual(f.announcements, []);
  f.setState({ state: "off", last_changed: new Date(now - 3_000_000).toISOString() });
  await f.run(); assert.deepEqual(f.announcements, []);
  f.setState({ state: "on" });
  await f.run(); await f.run(); assert.deepEqual(f.announcements, [input.announcement]);
  // A new off/on cycle can finish entirely between polls; last_changed identifies it.
  f.setState({ last_changed: new Date(now - 3_000_001).toISOString() });
  await f.run(); assert.equal(f.announcements.length, 2);
});

test("unknown, unavailable, wrong-entity and missing/invalid/future timestamps never satisfy a duration", async () => {
  const f = fixture();
  for (const state of ["unknown", "unavailable", "off"]) { f.setState({ state }); await f.run(); }
  f.setState({ state: "on", entity_id: "switch.another_device" }); await f.run();
  f.setState({ entity_id: input.entityId });
  for (const last_changed of [undefined, "invalid", new Date(now + 1000).toISOString()]) {
    f.setState({ last_changed }); await f.run();
  }
  assert.deepEqual(f.announcements, []);
});

test("all state/attribute conditions must match and daily checks may announce on every run", async () => {
  const f = fixture({
    minStateDurationSeconds: 0, announcementPolicy: "everyMatch", timezone: "America/New_York", cron: "0 9 * * *",
    conditions: [
      { field: "state", operator: "notEquals", value: "docked" },
      { field: "attributes.status", operator: "notEquals", value: "Charging" },
    ],
  });
  await f.run(); assert.deepEqual(f.announcements, []); // Missing status.
  f.setState({ attributes: { status: "Charging" } }); await f.run(); assert.deepEqual(f.announcements, []);
  f.setState({ attributes: { status: "Stuck" } }); await f.run(); await f.run();
  assert.deepEqual(f.announcements, [input.announcement, input.announcement]);
  assert.equal(f.registered[0].timezone, "America/New_York");
});

test("disabled jobs do not register and aborted reads cannot announce", async () => {
  const disabled = fixture({ enabled: false });
  assert.equal(disabled.registered.length, 0); assert.equal(disabled.reads, 0);
  const f = fixture();
  // Abort while the asynchronous read is yielding its result.
  const pending = f.run(); f.controller.abort(); await pending;
  assert.deepEqual(f.announcements, []);
});

test("a transient read failure leaves the episode eligible for a later retry", async () => {
  let job!: CronJob;
  let reads = 0, announcements = 0;
  registerDeviceMonitorJobs(parseDeviceMonitorJobs([input]), { register: next => { job = next; } }, {
    now: () => now,
    readState: async () => {
      if (++reads === 1) throw new Error("Temporary HA failure");
      return { entity_id: input.entityId, state: "on", attributes: {}, last_changed: new Date(now - 3_000_000).toISOString() };
    },
    announce: () => { announcements++; },
  });
  const signal = new AbortController().signal;
  await assert.rejects(async () => job.run(signal, "scheduled"), /Temporary HA failure/);
  await job.run(signal, "scheduled"); assert.equal(announcements, 1);
});
