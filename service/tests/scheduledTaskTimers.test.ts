import test from "node:test";
import assert from "node:assert/strict";
import { ScheduledTaskTimers } from "../src/scheduledTaskTimers";
import type { ScheduledTask } from "../src/types/scheduledTask";

const settle = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const row = (id: string, dueIn: number, extra: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id, recurrenceFamilyId: "family", title: id, effect: { kind: "announcement" }, dueDate: new Date(Date.now() + dueIn).toISOString(),
  isRecurring: false, status: "active", category: "general", priority: "medium", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...extra,
});

test("five-second deadlines and newly saved tasks fire without waiting for the thirty-second poll", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-07T01:00:00Z") });
  const tasks = new Map<string, ScheduledTask>(); const fired: string[] = [];
  let changed!: () => void;
  const timers = new ScheduledTaskTimers({ list: async () => [...tasks.values()], fire: async task => { fired.push(task.id); tasks.delete(task.id); }, skip: async () => {}, error: assert.fail, changed: listener => { changed = listener; return () => {}; } });
  timers.start(); t.after(() => timers.stop()); await settle();
  tasks.set("new", row("new", 5000)); changed(); await settle();
  t.mock.timers.tick(4999); await settle(); assert.deepEqual(fired, []);
  t.mock.timers.tick(1); await settle(); assert.deepEqual(fired, ["new"]);
});

test("editing and cancellation replace old timers; stopping removes all scheduled callbacks", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-07T01:00:00Z") });
  const tasks = new Map([ ["task", row("task", 1000)] ]); const fired: string[] = [];
  const timers = new ScheduledTaskTimers({ list: async () => [...tasks.values()], fire: async task => { fired.push(task.id); tasks.delete(task.id); }, skip: async () => {}, error: assert.fail, changed: () => () => {} });
  timers.start(); await settle();
  tasks.set("task", row("task", 5000)); await timers.refresh();
  t.mock.timers.tick(1000); await settle(); assert.deepEqual(fired, []);
  tasks.clear(); await timers.refresh(); t.mock.timers.tick(4000); await settle(); assert.deepEqual(fired, []);
  tasks.set("stopped", row("stopped", 1000)); await timers.refresh(); timers.stop();
  t.mock.timers.tick(1000); await settle(); assert.deepEqual(fired, []);
});

test("restart skips obsolete starts when a later shutoff is already due", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-07T01:10:00Z") });
  const tasks = new Map([ ["start", row("start", -600_000, { sequenceId: "sequence", sequenceStep: 0 })], ["stop", row("stop", -300_000, { sequenceId: "sequence", sequenceStep: 1 })] ]);
  const fired: string[] = [], skipped: string[] = [];
  const timers = new ScheduledTaskTimers({ list: async () => [...tasks.values()], fire: async task => { fired.push(task.id); tasks.delete(task.id); }, skip: async task => { skipped.push(task.id); tasks.delete(task.id); }, error: assert.fail, changed: () => () => {} });
  timers.start(); t.after(() => timers.stop()); await settle();
  assert.deepEqual(skipped, ["start"]); assert.deepEqual(fired, ["stop"]); assert.equal(tasks.size, 0);
});

test("later phases cannot overtake a running start, even if model execution crosses their due time", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-07T01:00:00Z") });
  const tasks = new Map([ ["start", row("start", 1000, { sequenceId: "sequence" })], ["stop", row("stop", 2000, { sequenceId: "sequence" })] ]);
  const fired: string[] = []; let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const timers = new ScheduledTaskTimers({ list: async () => [...tasks.values()], fire: async task => { fired.push(task.id); if (task.id === "start") await held; tasks.delete(task.id); }, skip: async () => {}, error: assert.fail, changed: () => () => {} });
  timers.start(); t.after(() => timers.stop()); await settle();
  t.mock.timers.tick(1000); await settle(); t.mock.timers.tick(3000); await settle(); assert.deepEqual(fired, ["start"]);
  release(); await settle(); assert.deepEqual(fired, ["start", "stop"]);
});

test("failed storage or an active foreign claim waits for reconciliation instead of spinning", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-07T01:00:00Z") });
  let attempts = 0, errors = 0;
  const task = row("blocked", -1000);
  const timers = new ScheduledTaskTimers({ list: async () => [task], fire: async () => { attempts++; if (attempts === 1) throw new Error("Storage down"); return false; }, skip: async () => {}, error: () => { errors++; }, changed: () => () => {} });
  timers.start(); t.after(() => timers.stop()); await settle(); assert.equal(attempts, 1); assert.equal(errors, 1);
  t.mock.timers.tick(30_000); await settle(); assert.equal(attempts, 2);
  await settle(); assert.equal(attempts, 2);
});
