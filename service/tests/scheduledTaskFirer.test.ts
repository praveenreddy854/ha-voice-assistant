import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { ScheduledTask, ScheduledTaskRun } from "../src/types/scheduledTask";

const requireModule = createRequire(__filename);
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture() {
  const rows = new Map<string, ScheduledTask>(), history = new Map<string, ScheduledTaskRun>();
  const actions: string[] = [], futureIds: string[] = [];
  let deletionFails = false;
  const stubs = {
    "../src/ha": { fetchAllStates: async () => [{ entity_id: "light.test", state: "on", attributes: {} }],
      executeHACommand: async (command: string) => { actions.push(command); return { success: true, message: "Sent" }; } },
    "../src/cosmos": {
      listActiveScheduledTasks: async () => [...rows.values()],
      claimScheduledTask: async (id: string) => {
        const task = rows.get(id); if (!task) return;
        if (task.firing) return { task, alreadyClaimed: true };
        task.firing = { id: `${id}-claim`, claimedAt: new Date().toISOString() };
        return { task, alreadyClaimed: false };
      },
      insertScheduledTaskRun: async (run: ScheduledTaskRun) => { if (!history.has(run.id)) history.set(run.id, run); },
      deleteScheduledTask: async (id: string) => deletionFails ? false : rows.delete(id),
      upsertScheduledTask: async (task: ScheduledTask) => { futureIds.push(task.id); rows.set(task.id, task); return task; },
    },
    "../src/announcementBus": { emitAnnouncement: () => {} },
  };
  const source = requireModule.resolve("../src/scheduledTaskFirer");
  const saved = new Map<string, NodeModule | undefined>([[source, requireModule.cache[source]]]);
  delete requireModule.cache[source];
  for (const [name, exports] of Object.entries(stubs)) {
    const filename = requireModule.resolve(name); saved.set(filename, requireModule.cache[filename]);
    requireModule.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeModule;
  }
  const firer = requireModule(source) as typeof import("../src/scheduledTaskFirer");
  return { rows, history, actions, futureIds, start: firer.startScheduledTaskFirer, failDeletion(value: boolean) { deletionFails = value; },
    close() { firer.stopScheduledTaskFirer(); for (const [filename, previous] of saved) { if (previous) requireModule.cache[filename] = previous; else delete requireModule.cache[filename]; } } };
}
function due(id: string, extra: Partial<ScheduledTask> = {}): ScheduledTask {
  return { id, recurrenceFamilyId: "family", title: id, effect: { kind: "action", command: id, entityId: "light.test" },
    dueDate: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), isRecurring: false,
    category: "home_automation", priority: "medium", status: "active", ...extra };
}

test("a failed cleanup never repeats the physical action or replaces its immutable successful audit", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-07T01:00:00Z") });
  const f = fixture(); t.after(() => f.close()); f.failDeletion(true);
  f.rows.set("turn-on", due("turn-on")); f.start(); await settle();
  assert.deepEqual(f.actions, ["turn-on"]); assert.equal(f.history.get("turn-on-claim")?.outcome, "succeeded");
  f.failDeletion(false); t.mock.timers.tick(30_000); await settle();
  assert.deepEqual(f.actions, ["turn-on"]); assert.equal(f.rows.size, 0);
  assert.equal(f.history.get("turn-on-claim")?.outcome, "succeeded");
});

test("an interrupted persisted claim is audited without repeating an uncertain device effect", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-07T01:00:00Z") });
  const f = fixture(); t.after(() => f.close());
  f.rows.set("uncertain", due("uncertain", { firing: { id: "prior-claim", claimedAt: new Date(Date.now() - 10_000).toISOString() } }));
  f.start(); await settle();
  assert.deepEqual(f.actions, []); assert.equal(f.history.get("prior-claim")?.outcome, "interrupted"); assert.equal(f.rows.size, 0);
});

test("recurring cleanup recovery reuses one future occurrence and clears its dispatch claim", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: new Date("2026-11-07T01:00:00Z") });
  const f = fixture(); t.after(() => f.close()); f.failDeletion(true);
  f.rows.set("daily", due("daily", { isRecurring: true, recurringPattern: { type: "daily", interval: 1 }, _etag: "old-etag" }));
  f.start(); await settle(); f.failDeletion(false); t.mock.timers.tick(30_000); await settle();
  assert.equal(new Set(f.futureIds).size, 1); assert.equal(f.rows.size, 1); assert.deepEqual(f.actions, ["daily"]);
  const next = [...f.rows.values()][0]; assert.equal(next.firing, undefined); assert.equal(next._etag, undefined);
});
