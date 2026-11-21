import assert from "node:assert/strict";
import test from "node:test";
import cron from "node-cron";
import { CronJobScheduler } from "../src/cronJobs";

const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

test("six-field cron fires every second and duplicate registration does not create another task", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-15T12:00:00Z") });
  const scheduler = new CronJobScheduler((_id, error) => assert.fail(String(error)));
  t.after(() => scheduler.stop());
  let runs = 0;
  const job = { id: "per-second", expression: "* * * * * *", timezone: "UTC", run: () => { runs++; } };
  scheduler.register(job);
  scheduler.register(job);
  assert.equal([...cron.getTasks().values()].filter(task => task.name === job.id).length, 1);
  t.mock.timers.tick(999); await settle(); assert.equal(runs, 0);
  t.mock.timers.tick(1); await settle(); assert.equal(runs, 1);
  t.mock.timers.tick(1000); await settle(); assert.equal(runs, 2);
  t.mock.timers.tick(1000); await settle(); assert.equal(runs, 3);
  await scheduler.stop();
  t.mock.timers.tick(2000); await settle(); assert.equal(runs, 3);
});

test("slow startup work skips ticks, errors recover, and stop aborts outstanding work", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-15T12:00:00Z") });
  const failures: unknown[] = [];
  const scheduler = new CronJobScheduler((_id, error) => failures.push(error));
  t.after(() => scheduler.stop());
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let releaseScheduled!: () => void;
  const pendingScheduled = new Promise<void>(resolve => { releaseScheduled = resolve; });
  let runs = 0;
  let signal!: AbortSignal;
  scheduler.register({
    id: "slow", expression: "* * * * * *", timezone: "UTC", runOnStart: true,
    run: async currentSignal => {
      signal = currentSignal;
      runs++;
      if (runs === 1) { await pending; throw new Error("Temporary failure"); }
      if (runs === 2) await pendingScheduled;
    },
  });
  assert.equal(runs, 1);
  t.mock.timers.tick(1000); await settle(); assert.equal(runs, 1);
  t.mock.timers.tick(1000); await settle(); assert.equal(runs, 1);
  release(); await settle(); assert.equal(failures.length, 1);
  t.mock.timers.tick(1000); await settle(); assert.equal(runs, 2);
  t.mock.timers.tick(1000); await settle(); assert.equal(runs, 2);
  await scheduler.stop(); assert.equal(signal.aborted, true);
  releaseScheduled(); await settle();
  t.mock.timers.tick(1000); await settle(); assert.equal(runs, 2);
});

test("five-field schedules keep minute precision and respect the configured timezone", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: new Date("2026-11-15T12:00:00Z") });
  const scheduler = new CronJobScheduler();
  t.after(() => scheduler.stop());
  scheduler.register({ id: "daily", expression: "0 9 * * *", timezone: "America/New_York", run: () => {} });
  const task = [...cron.getTasks().values()].find(task => task.name === "daily")!;
  assert.equal(task.getNextRun()?.toISOString(), "2026-11-15T14:00:00.000Z");
  assert.equal(task.match(new Date("2026-11-15T14:00:01Z")), false);
});

test("invalid cron expressions and timezones are rejected without registering work", async () => {
  const scheduler = new CronJobScheduler();
  assert.throws(() => scheduler.register({ id: "bad-cron", expression: "61 * * * * *", run: () => {} }), /Invalid cron/);
  assert.throws(() => scheduler.register({ id: "bad-zone", expression: "* * * * * *", timezone: "Invalid/Zone", run: () => {} }), /Invalid timezone/);
  await scheduler.stop();
});
