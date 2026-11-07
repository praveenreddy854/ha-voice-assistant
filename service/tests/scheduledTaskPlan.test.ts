import test, { before } from "node:test";
import assert from "node:assert/strict";
import { Databases } from "@azure/cosmos";
import { configureTestProviders } from "./helpers/agentFixtures";
import { withRequestContext } from "../src/requestContext";
import type { ScheduledTask } from "../src/types/scheduledTask";

configureTestProviders();
process.env.AZURE_COSMOS_ENDPOINT = "https://cosmos.invalid";
process.env.AZURE_COSMOS_KEY = "dGVzdA==";
process.env.AZURE_COSMOS_DATABASE = "test";
process.env.AZURE_COSMOS_CONTAINER = "test";
let save: typeof import("../src/agents/scheduled-task/tools/saveScheduledTask");
let cosmos: typeof import("../src/cosmos");
type Row = ScheduledTask & { _etag: string };
const rows = new Map<string, Row>();
let rejectBatch = false, batches = 0, upserts = 0, version = 0;
const container = {
  items: {
    upsert: async (task: ScheduledTask) => { upserts++; const saved = { ...task, _etag: String(++version) }; rows.set(task.id, saved); return { resource: saved }; },
    batch: async (operations: Array<{ operationType: string; id?: string; resourceBody?: ScheduledTask }>, family: string) => {
      batches++;
      if (rejectBatch) return { code: 400, result: operations.map(() => ({ statusCode: 424 })) };
      const next = new Map(rows);
      for (const operation of operations) {
        if (operation.operationType === "Create") {
          assert.equal(operation.resourceBody!.recurrenceFamilyId, family);
          assert.ok(!next.has(operation.resourceBody!.id));
          next.set(operation.resourceBody!.id, { ...operation.resourceBody!, _etag: String(++version) });
        } else { assert.equal(next.get(operation.id!)!.recurrenceFamilyId, family); next.delete(operation.id!); }
      }
      rows.clear(); for (const [id, row] of next) rows.set(id, row);
      return { code: 200, result: operations.map(() => ({ statusCode: 201 })) };
    },
    query: (query: { parameters?: Array<{ name: string; value: string }> }) => ({ fetchAll: async () => ({ resources: [...rows.values()].filter(row => {
      const family = query.parameters?.find(parameter => parameter.name === "@family")?.value;
      const sequence = query.parameters?.find(parameter => parameter.name === "@sequence")?.value;
      return (!family || row.recurrenceFamilyId === family) && (!sequence || row.sequenceId === sequence);
    }) }) }),
  },
  item: (id: string) => ({
    read: async () => ({ resource: rows.has(id) ? structuredClone(rows.get(id)) : undefined }),
    delete: async () => { if (!rows.delete(id)) throw Object.assign(new Error("Missing"), { code: 404 }); },
    replace: async (task: Row, options: { accessCondition: { condition: string } }) => {
      if (rows.get(id)?._etag !== options.accessCondition.condition) throw Object.assign(new Error("Conflict"), { code: 412 });
      rows.set(id, { ...task, _etag: String(++version) }); return { resource: rows.get(id) };
    },
  }),
};
before(async () => {
  // Keep the production Cosmos adapter and transaction/claim paths, replacing transport only.
  Databases.prototype.createIfNotExists = (async () => ({ database: { containers: { createIfNotExists: async () => ({ container }) } } })) as never;
  save = await import("../src/agents/scheduled-task/tools/saveScheduledTask");
  cosmos = await import("../src/cosmos");
});
const base = { title: "Kitchen timer", effect: { kind: "action" as const, command: "turn on kitchen light", entityId: "light.kitchen" }, isRecurring: false, category: "home_automation" as const, priority: "medium" as const };

test("relative delays retain server receipt through latency and retries; expired deadlines do not restart", async t => {
  rows.clear(); t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-07T01:00:00Z") });
  await withRequestContext(new Date().toISOString(), async () => {
    t.mock.timers.setTime(Date.now() + 4000);
    const saved = await save.execute({ ...base, delaySeconds: 5 });
    assert.equal(saved.saved?.dueDate, "2026-11-07T01:00:05.000Z");
    assert.equal(saved.saved?.timing?.requestReceivedAt, "2026-11-07T01:00:00.000Z");
    const writes = upserts;
    t.mock.timers.setTime(Date.now() + 2000);
    for (let retry = 0; retry < 2; retry++) {
      const late = await save.execute({ ...base, delaySeconds: 5 });
      assert.equal(late.toolSuccess, false); assert.match(late.observation, /do not silently restart/);
    }
    assert.equal(upserts, writes);
  });
});

test("an explicit immediate action is persisted now with a durable shutoff at its requested offset", async t => {
  rows.clear(); t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-07T01:00:10Z") });
  const saved = await withRequestContext("2026-11-07T01:00:00Z", () => save.execute({ ...base, delaySeconds: 0, followUpActions: [{ afterSeconds: 300, command: "turn off kitchen light" }] }));
  assert.equal(saved.savedTasks?.length, 2);
  assert.deepEqual(saved.savedTasks?.map(task => task.dueDate), ["2026-11-07T01:00:10.000Z", "2026-11-07T01:05:10.000Z"]);
  assert.equal(new Set(saved.savedTasks?.map(task => task.recurrenceFamilyId)).size, 1);
  assert.equal(new Set(saved.savedTasks?.map(task => task.sequenceId)).size, 1);
  assert.equal(rows.size, 2);
});

test("a failed timed-phase transaction cannot fall back to saving the start alone", async t => {
  rows.clear(); rejectBatch = true; const writes = upserts, transactions = batches;
  try {
    await assert.rejects(save.execute({ ...base, dueDate: new Date(Date.now() + 60_000).toISOString(), followUpActions: [{ afterSeconds: 300, command: "turn off kitchen light" }] }), /transaction failed/);
    assert.equal(rows.size, 0); assert.equal(upserts, writes); assert.equal(batches, transactions + 1);
  } finally { rejectBatch = false; }
});

test("cancel from a later phase removes all remaining sequence rows atomically and preserves other tasks", async () => {
  rows.clear();
  const sequence = await save.execute({ ...base, delaySeconds: 0, followUpActions: [{ afterSeconds: 300, command: "turn off kitchen light" }] });
  const unrelated = await save.execute({ ...base, title: "Unrelated", delaySeconds: 60 });
  const target = sequence.savedTasks![1];
  assert.equal(await cosmos.deleteScheduledTaskOccurrence(target.id, target.recurrenceFamilyId), true);
  assert.deepEqual([...rows.keys()], [unrelated.saved!.id]);
});

test("timed sequences reject partial timing changes and unsupported recurrence", async () => {
  rows.clear();
  const saved = await save.execute({ ...base, delaySeconds: 0, followUpActions: [{ afterSeconds: 300, command: "turn off kitchen light" }] });
  await assert.rejects(cosmos.updateScheduledTask(saved.saved!.id, saved.saved!.recurrenceFamilyId, { dueDate: new Date(Date.now() + 60_000).toISOString() }), /Cancel and recreate/);
  await assert.rejects(save.execute({ ...base, delaySeconds: 60, isRecurring: true, recurringPattern: { type: "daily", interval: 1 }, followUpActions: [{ afterSeconds: 300, command: "turn off kitchen light" }] }));
  await assert.rejects(save.execute({ ...base, delaySeconds: 60, followUpActions: [{ afterSeconds: 300, command: "off" }, { afterSeconds: 200, command: "on" }] }));
  await assert.rejects(save.execute({ ...base, delaySeconds: 60, effect: { ...base.effect, command: "turn on kitchen light, wait five minutes, then turn it off" } }), /Embedded waits/);
});

test("editing cannot erase a dispatch claim after the occurrence begins firing", async () => {
  rows.clear(); const saved = await save.execute({ ...base, delaySeconds: 0 });
  await cosmos.claimScheduledTask(saved.saved!.id, saved.saved!.recurrenceFamilyId);
  await assert.rejects(cosmos.updateScheduledTask(saved.saved!.id, saved.saved!.recurrenceFamilyId, { dueDate: new Date(Date.now() + 60_000).toISOString() }), /already started dispatching/);
  assert.ok(rows.get(saved.saved!.id)?.firing);
});

test("concurrent firers acquire one conditional dispatch claim; recovery never reacquires an executed effect", async () => {
  rows.clear(); const saved = await save.execute({ ...base, delaySeconds: 0 });
  const results = await Promise.all([cosmos.claimScheduledTask(saved.saved!.id, saved.saved!.recurrenceFamilyId), cosmos.claimScheduledTask(saved.saved!.id, saved.saved!.recurrenceFamilyId)]);
  assert.equal(results.filter(result => result && !result.alreadyClaimed).length, 1);
  const recovered = await cosmos.claimScheduledTask(saved.saved!.id, saved.saved!.recurrenceFamilyId);
  assert.equal(recovered?.alreadyClaimed, true);
  assert.equal(recovered?.task.firing?.id, results.find(Boolean)?.task.firing?.id);
});
