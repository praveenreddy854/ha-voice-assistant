import assert from "node:assert/strict";
import test, { before } from "node:test";
import { Databases } from "@azure/cosmos";
import { dueDateError, dueDateSchema } from "../src/agents/scheduled-task/tools/dueDate";
import type { ScheduledTask } from "../src/types/scheduledTask";
import { configureTestProviders, messageText, readModelRequest, toolResponse } from "./helpers/agentFixtures";

let save: typeof import("../src/agents/scheduled-task/tools/saveScheduledTask");
let update: typeof import("../src/agents/scheduled-task/tools/updateTask");
let tools: typeof import("../src/agents/scheduled-task/tools");
let orchestrator: typeof import("../src/agents/core/orchestrator");

before(async () => {
  configureTestProviders();
  process.env.TZ = "America/New_York";
  process.env.AZURE_COSMOS_ENDPOINT = "https://cosmos.invalid";
  process.env.AZURE_COSMOS_KEY = "dGVzdA==";
  process.env.AZURE_COSMOS_DATABASE = "test";
  process.env.AZURE_COSMOS_CONTAINER = "test";
  save = await import("../src/agents/scheduled-task/tools/saveScheduledTask");
  update = await import("../src/agents/scheduled-task/tools/updateTask");
  tools = await import("../src/agents/scheduled-task/tools");
});

const input = {
  title: "Synthetic task", effect: { kind: "announcement" as const },
  isRecurring: false, category: "task" as const, priority: "medium" as const,
};

test("save/update reject invalid and expired dates before storage and preserve valid offsets", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-01T05:50:00Z") });
  const tasks = new Map<string, ScheduledTask>();
  let writes = 0;
  const container = {
    items: { upsert: async (task: ScheduledTask) => { writes++; tasks.set(task.id, task); return { resource: task }; } },
    item: (id: string) => ({ read: async () => ({ resource: tasks.get(id) }) }),
  };
  const init = t.mock.method(Databases.prototype, "createIfNotExists", async () => ({
    database: { containers: { createIfNotExists: async () => ({ container }) } },
  }) as never);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network expected"); });
  for (const dueDate of ["tomorrow", "2026-11-01", "2026-11-01T07:00:00", "2026-02-30T07:00:00Z", "2026-11-01T07:00:00+25:00"]) {
    await assert.rejects(save.execute({ ...input, dueDate }));
    await assert.rejects(update.execute({ id: "test", recurrenceFamilyId: "test", patch: { dueDate } }));
  }
  for (const dueDate of ["2026-10-01T00:00:00Z", new Date().toISOString(), "2026-11-01T01:30:00-04:00"]) {
    const result = await save.execute({ ...input, dueDate });
    assert.equal(result.toolSuccess, false);
    assert.equal(result.saved, null);
    assert.match(result.observation, /strictly in the future/);
    const changed = await update.execute({ id: "test", recurrenceFamilyId: "test", patch: { dueDate } });
    assert.equal(changed.toolSuccess, false);
    const wrapped = await tools.executeScheduledTaskTool("save_scheduled_task", { ...input, dueDate });
    assert.equal(wrapped.toolSuccess, false);
  }
  assert.equal(init.mock.callCount(), 0);
  assert.equal(writes, 0);

  // The repeated 01:30 after the autumn DST transition is still in the future.
  const saved = await save.execute({ ...input, dueDate: "2026-11-01T01:30:00-05:00" });
  assert.equal(saved.toolSuccess, true);
  assert.ok(saved.saved);
  assert.equal(saved.saved.dueDate, "2026-11-01T01:30:00-05:00");
  assert.equal(writes, 1);
  const ids = { id: saved.saved.id, recurrenceFamilyId: saved.saved.recurrenceFamilyId };
  const changed = await update.execute({ ...ids, patch: { dueDate: "2026-11-01T08:00:00Z" } });
  assert.equal(changed.toolSuccess, true);
  assert.equal(writes, 2);
  assert.equal(tasks.get(ids.id)?.dueDate, "2026-11-01T08:00:00Z");
  t.mock.timers.setTime(Date.parse("2026-11-02T00:00:00Z"));
  assert.equal((await update.execute({ ...ids, patch: { title: "Renamed" } })).toolSuccess, true);
  assert.equal(tasks.get(ids.id)?.dueDate, "2026-11-01T08:00:00Z");
});

test("strict timestamp validation handles DST offsets, leap days, and the exact deadline", () => {
  const spring = new Date("2026-03-08T06:55:00Z");
  const due = "2026-03-08T03:05:00-04:00";
  assert.equal(Date.parse(due) - spring.getTime(), 10 * 60_000);
  assert.equal(dueDateError(due, spring), undefined);
  assert.match(dueDateError(spring.toISOString(), spring)!, /strictly in the future/);
  assert.equal(dueDateSchema.safeParse("2028-02-29T12:00:00Z").success, true);
  assert.equal(dueDateSchema.safeParse("2026-02-29T12:00:00Z").success, false);
  assert.equal(dueDateSchema.safeParse("2026-09-10T12:00:00+05:30").success, true);
});

test("one cached scheduling loop refreshes its clock for new runs and external-input resumes", async (t) => {
  // Memory retrieval uses the real adapter with an empty mocked Cosmos result.
  t.mock.method(Databases.prototype, "createIfNotExists", async () => ({
    database: { containers: { createIfNotExists: async () => ({
      container: { items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } },
    }) } },
  }) as never);
  const { scheduledTaskAgentDefinition: definition } = await import("../src/agents/scheduled-task/definition");
  const { registerAgent } = await import("../src/agents/core/registry");
  orchestrator = await import("../src/agents/core/orchestrator");
  // Register the real scheduling prompt with a harmless external input tool.
  registerAgent({ ...definition, get systemPrompt() { return definition.systemPrompt; },
    tools: [{ type: "function", function: { name: "request_input", parameters: { type: "object", properties: {} } } }],
  });
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-09-01T12:00:00Z") });
  const clocks: string[] = [];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const system = messageText(readModelRequest(url, init), "system");
    const clock = /Current date\/time \(ISO\): (\S+)/.exec(system)?.[1];
    assert.ok(clock, "Model must receive current timing context");
    assert.match(system, /America\/New_York/);
    clocks.push(clock);
    return ++calls === 2
      ? toolResponse("request_input", {}, `clock-${calls}`)
      : toolResponse("complete_task", { success: true, message: "Synthetic completion" }, `clock-${calls}`);
  });
  const first = await orchestrator.runAgent({ agentType: "scheduled_task", userPrompt: "Synthetic ten-minute request" });
  assert.equal(first.status, "completed");
  const cachedLoop = orchestrator.getAgentLoop("scheduled_task");
  t.mock.timers.setTime(Date.parse("2026-09-10T12:00:00Z"));
  const second = await orchestrator.runAgent({ agentType: "scheduled_task", userPrompt: "Another synthetic ten-minute request" });
  assert.equal(second.status, "awaiting_external_input");
  assert.equal(orchestrator.getAgentLoop("scheduled_task"), cachedLoop);
  t.mock.timers.setTime(Date.parse("2026-09-11T12:00:00Z"));
  const resumed = await orchestrator.runAgent({ agentType: "scheduled_task", sessionId: second.sessionId, externalInput: { type: "confirmation", data: { answer: "yes" } } });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(clocks, ["2026-09-01T12:00:00.000Z", "2026-09-10T12:00:00.000Z", "2026-09-11T12:00:00.000Z"]);
});
