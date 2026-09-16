import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import type { SaveScheduledTaskInput } from "../src/agents/scheduled-task/tools/saveScheduledTask";
import {
  assertScheduledTaskToolCoverage, ScheduledTaskEnvironment, type ScheduledTaskEnvironmentDependencies,
} from "../src/evals/scheduled-task/environment";
import { scheduledTaskScenarios, type ScheduledTaskMemory } from "../src/evals/scheduled-task/scenarios";
import { configureTestProviders } from "./helpers/agentFixtures";

configureTestProviders();
let dependencies: ScheduledTaskEnvironmentDependencies;
const originalFetch = globalThis.fetch;
before(async () => {
  globalThis.fetch = async () => { throw new Error("No network is permitted in the scheduling simulator"); };
  const [{ SCHEDULED_TASK_TOOLS }, { buildMemoryToolDefinitions }, memory, dates] = await Promise.all([
    import("../src/agents/scheduled-task/tools"), import("../src/agents/core/memoryTools"),
    import("../src/memory"), import("../src/agents/scheduled-task/tools/dueDate"),
  ]);
  dependencies = {
    tools: [...SCHEDULED_TASK_TOOLS, ...buildMemoryToolDefinitions("scheduled_task")],
    dueDateError: dates.dueDateError, validateMemoryWrite: memory.validateMemoryWrite,
    normalizeMemoryScopes: memory.normalizeMemoryScopes,
  };
});
after(() => { globalThis.fetch = originalFetch; });

function fixture(id: string) {
  const scenario = scheduledTaskScenarios.find(item => item.id === id);
  assert.ok(scenario, `Missing scenario ${id}`);
  return structuredClone(scenario);
}
function environment(id: string) { return new ScheduledTaskEnvironment(fixture(id), dependencies); }
function createInput(id = "announcement-at-time"): SaveScheduledTaskInput {
  return structuredClone(fixture(id).initial.expected.mutations[0].args) as SaveScheduledTaskInput;
}

test("all 12 fixtures have exact state assertions, fresh data, and no executable live tools", async () => {
  assert.equal(scheduledTaskScenarios.length, 12);
  assert.equal(new Set(scheduledTaskScenarios.map(item => item.id)).size, 12);
  for (const scenario of scheduledTaskScenarios) {
    const before = structuredClone(scenario.initial);
    const first = new ScheduledTaskEnvironment(scenario, dependencies);
    if (scenario.initial.expected.requiresList) await first.execute("list_scheduled_tasks", {});
    if (scenario.id === "recurring-action-dst") await first.execute("find_matching_entities", { query: "Roborock", domain: "vacuum" });
    for (const call of scenario.initial.expected.mutations) await first.execute(call.toolName, call.args);
    assert.equal(first.taskSatisfied(scenario.initial.expected.answer), scenario.initial.expected.fulfillable, scenario.id);
    assert.deepEqual(scenario.initial, before, "Running an attempt must not change its fixture");
    const second = new ScheduledTaskEnvironment(scenario, dependencies);
    assert.deepEqual(second.state, before, "Confirmation starts with fresh state and IDs");
    assert.notEqual(first.state.tasks, second.state.tasks);
    assert.deepEqual(first.evidence.map(event => event.id), first.evidence.map((_, index) => `e${index + 1}`));
    assert.ok(first.evidence.every(event => event.timestamp === scenario.initial.now));
    assert.ok(first.evidence.every(event => event.kind !== "image" && event.image === undefined));
  }
});

test("tool/schema coverage is fail-closed, including every memory capability", async () => {
  assert.doesNotThrow(() => assertScheduledTaskToolCoverage(dependencies.tools));
  for (const omitted of dependencies.tools) {
    assert.throws(() => assertScheduledTaskToolCoverage(dependencies.tools.filter(tool => tool !== omitted)), /Missing offline tool capability/);
  }
  assert.throws(() => assertScheduledTaskToolCoverage(dependencies.tools.map((tool, index) =>
    index === 0 ? { ...tool, function: { ...tool.function, inputSchema: undefined } } : tool)), /Missing production input schema/);
  assert.throws(() => assertScheduledTaskToolCoverage([...dependencies.tools, {
    ...dependencies.tools[0], function: { ...dependencies.tools[0].function, name: "call_home_assistant" },
  }]), /live fallback is forbidden/);
  assert.throws(() => new ScheduledTaskEnvironment(fixture("query-today"), {
    ...dependencies, validateMemoryWrite: undefined as never,
  }), /Missing offline validation capability/);
  const env = environment("announcement-at-time");
  await assert.rejects(env.execute("call_home_assistant", { entityId: "light.kitchen" }), /live fallback is forbidden/);
  await assert.rejects(env.execute("save_scheduled_task", { title: "Missing required fields" }));
  await assert.rejects(env.execute("retrieve_memory", { query: "preference", limit: 100 }));
  assert.equal(env.mutations.length, 0);
  assert.deepEqual(env.state.tasks, fixture("announcement-at-time").initial.tasks);
});

test("production date validation rejects malformed/past dates against the fixture, not the wall clock", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2099-01-01T00:00:00Z") });
  const env = environment("announcement-relative-dst");
  const initial = env.snapshot();
  for (const dueDate of [
    "tomorrow", "2026-03-08T03:05:00", "2026-02-30T12:00:00Z", "2026-03-08T03:05:00+25:00",
  ]) {
    await assert.rejects(env.execute("save_scheduled_task", { ...createInput("announcement-relative-dst"), dueDate }));
    await assert.rejects(env.execute("update_scheduled_task", {
      id: "dentist", recurrenceFamilyId: "family-dentist", patch: { dueDate },
    }));
  }
  for (const dueDate of ["2026-03-07T12:00:00Z", env.state.now]) {
    const saved = await env.execute("save_scheduled_task", { ...createInput(), dueDate });
    assert.equal(saved.toolSuccess, false);
    assert.equal(saved.saved, null);
    assert.match(saved.observation, /strictly in the future/);
    const updated = await env.execute("update_scheduled_task", {
      id: "dentist", recurrenceFamilyId: "family-dentist", patch: { dueDate },
    });
    assert.equal(updated.toolSuccess, false);
  }
  const missingPattern = await env.execute("save_scheduled_task", {
    ...createInput("announcement-relative-dst"), isRecurring: true,
  });
  assert.equal(missingPattern.toolSuccess, false);
  assert.deepEqual(env.snapshot(), initial);
  const saved = await env.execute("save_scheduled_task", createInput("announcement-relative-dst"));
  assert.equal(saved.toolSuccess, true, "2026 fixture time must not become invalid under a 2099 wall clock");
  assert.equal(env.taskSatisfied(), true);
});

test("autumn repeated hours retain explicit offsets and renaming does not reschedule an expired date", async () => {
  const scenario = fixture("announcement-at-time");
  scenario.initial.now = "2026-11-01T05:50:00.000Z";
  const env = new ScheduledTaskEnvironment(scenario, dependencies);
  assert.equal((await env.execute("save_scheduled_task", { ...createInput(), dueDate: "2026-11-01T01:30:00-04:00" })).toolSuccess, false);
  assert.equal((await env.execute("save_scheduled_task", { ...createInput(), dueDate: "2026-11-01T01:30:00-05:00" })).toolSuccess, true);
  assert.equal(env.state.tasks.at(-1)?.dueDate, "2026-11-01T01:30:00-05:00");
  await env.execute("list_scheduled_tasks", {});
  const oldDate = env.state.tasks[0].dueDate;
  assert.equal((await env.execute("update_scheduled_task", {
    id: "dentist", recurrenceFamilyId: "family-dentist", patch: { title: "Renamed appointment" },
  })).toolSuccess, true);
  assert.equal(env.state.tasks[0].dueDate, oldDate);
  assert.equal((await env.execute("update_scheduled_task", {
    id: "dentist", recurrenceFamilyId: "family-dentist", patch: {},
  })).toolSuccess, false);
});

test("creation assertions distinguish wrong entity, effect, command, time, recurrence and other fields", async () => {
  const variations: Array<[string, (input: SaveScheduledTaskInput) => void]> = [
    ["entity", input => { if (input.effect.kind === "action") input.effect.entityId = "vacuum.roborock_upstairs"; }],
    ["effect", input => { input.effect = { kind: "announcement" }; }],
    ["command", input => { if (input.effect.kind === "action") input.effect.command = "stop the downstairs Roborock vacuum"; }],
    ["DST offset", input => { input.dueDate = "2026-03-08T09:00:00-05:00"; }],
    ["day", input => { input.dueDate = "2026-03-09T09:00:00-04:00"; }],
    ["recurrence", input => { input.recurringPattern = { type: "weekly", interval: 1 }; }],
    ["one-shot", input => { input.isRecurring = false; delete input.recurringPattern; }],
    ["priority", input => { input.priority = "urgent"; }],
    ["title", input => { input.title = "Run upstairs Roborock"; }],
  ];
  for (const [label, change] of variations) {
    const env = environment("recurring-action-dst");
    const matches = await env.execute("find_matching_entities", { query: "roborock", domain: "vacuum" });
    assert.equal((matches.matches as unknown[]).length, 2);
    const input = createInput("recurring-action-dst");
    change(input);
    assert.equal((await env.execute("save_scheduled_task", input)).toolSuccess, true, label);
    assert.equal(env.taskSatisfied(), false, `Wrong ${label} must not pass`);
  }
  const unresolved = environment("recurring-action-dst");
  await unresolved.execute("save_scheduled_task", createInput("recurring-action-dst"));
  assert.equal(unresolved.taskSatisfied(), false);
  assert.match(unresolved.policyViolations[0], /not resolved/);
  const equivalent = environment("recurring-action-dst");
  await equivalent.execute("find_matching_entities", { query: "downstairs roborock" });
  await equivalent.execute("save_scheduled_task", { ...createInput("recurring-action-dst"), dueDate: "2026-03-08T13:00:00Z" });
  assert.equal(equivalent.taskSatisfied(), true, "Equivalent UTC and local timestamps identify the same requested instant");
});

test("read/update assertions require lookup and preserve every unrequested field", async () => {
  const read = environment("query-today");
  const answer = fixture("query-today").initial.expected.answer!;
  assert.equal(read.taskSatisfied(answer), false, "An invented answer without a read must not pass");
  const listed = await read.execute("list_scheduled_tasks", {});
  const dates = (listed.tasks as Array<{ dueDate: string }>).map(task => Date.parse(task.dueDate));
  assert.deepEqual(dates, [...dates].sort((a, b) => a - b));
  assert.equal(read.taskSatisfied(answer), true);
  assert.equal(read.taskSatisfied(answer.replace("09:00", "10:00")), false);
  assert.equal(read.taskSatisfied(`${answer}; Run downstairs Roborock at 09:00`), false);

  const expected = fixture("update-preserve-fields").initial.expected.mutations[0];
  const env = environment("update-preserve-fields");
  await env.execute("list_scheduled_tasks", {});
  await env.execute(expected.toolName, {
    ...expected.args, patch: { ...(expected.args.patch as object), priority: "low" },
  });
  assert.equal(env.taskSatisfied(), false);
  assert.equal(env.assertion().storageMatchesExpected, false);

  const unrequested = environment("update-preserve-fields");
  await unrequested.execute("list_scheduled_tasks", {});
  await unrequested.execute(expected.toolName, {
    ...expected.args, patch: { ...(expected.args.patch as object), category: "home_automation" },
  });
  assert.equal(unrequested.assertion().storageMatchesExpected, true);
  assert.equal(unrequested.taskSatisfied(), false, "Even a redundant unrequested field violates the patch policy");

  const guessed = environment("update-preserve-fields");
  await guessed.execute(expected.toolName, expected.args);
  assert.equal(guessed.taskSatisfied(), false);
  assert.match(guessed.policyViolations[0], /not read/);
});

test("cancellation assertions detect occurrence/family mistakes and ambiguous deletion is never task fulfillment", async () => {
  for (const id of ["cancel-occurrence", "cancel-family"]) {
    const env = environment(id);
    await env.execute("list_scheduled_tasks", {});
    const call = fixture(id).initial.expected.mutations[0];
    const args = { ...call.args, scope: id === "cancel-family" ? "occurrence" : "family", id: "vacuum-tomorrow" };
    await env.execute(call.toolName, args);
    assert.equal(env.taskSatisfied(), false, id);
    assert.equal(env.assertion().storageMatchesExpected, false);
  }
  const env = environment("ambiguous-delete");
  await env.execute("list_scheduled_tasks", {});
  assert.equal(env.taskSatisfied("Which vacuum and date?"), false);
  assert.equal(env.assertion().storageMatchesExpected, true);
  await env.execute("delete_scheduled_task", { scope: "occurrence", id: "vacuum-tomorrow", recurrenceFamilyId: "family-downstairs-vacuum" });
  assert.equal(env.assertion().storageMatchesExpected, false);
});

test("failed storage never mutates rows and missing entities cannot be fulfilled by an invented ID", async () => {
  for (const storage of ["unavailable", "write_failure"] as const) {
    const scenario = fixture("storage-failure");
    scenario.initial.storage = storage;
    const env = new ScheduledTaskEnvironment(scenario, dependencies);
    const initial = env.snapshot();
    for (const [name, args] of [
      ["save_scheduled_task", createInput()],
      ["update_scheduled_task", { id: "dentist", recurrenceFamilyId: "family-dentist", patch: { title: "Changed" } }],
      ["delete_scheduled_task", { scope: "family", recurrenceFamilyId: "family-dentist" }],
    ] as const) {
      assert.equal((await env.execute(name, args)).toolSuccess, false);
    }
    assert.equal((await env.execute("list_scheduled_tasks", {})).toolSuccess, storage !== "unavailable");
    assert.deepEqual(env.snapshot(), initial);
    assert.equal(env.mutations.length, 0);
    assert.equal(env.taskSatisfied("Saved successfully"), false);
  }
  const env = environment("missing-entity");
  assert.deepEqual((await env.execute("find_matching_entities", { query: "pool pump" })).matches, []);
  assert.equal(env.taskSatisfied(), false);
  await env.execute("save_scheduled_task", {
    ...createInput(), effect: { kind: "action", command: "start pool pump", entityId: "switch.invented_pool_pump" },
  });
  assert.equal(env.taskSatisfied(), false);
  assert.equal(env.assertion().storageMatchesExpected, false);
  assert.match(env.policyViolations[0], /not resolved/);
});

test("all memory tools use isolated data, respect schemas/validation, and cannot hide unrelated mutations", async () => {
  const env = environment("announcement-at-time");
  assert.deepEqual((await env.execute("retrieve_memory", { query: "quiet" })).memories, []);
  const invalid = await env.execute("save_memory", { text: "Keep the light dim" });
  assert.equal(invalid.toolSuccess, false);
  assert.equal(invalid.clarification_required, true);
  const result = await env.execute("save_memory", { text: "  Prefer quiet reminders.  ", scopes: { global: true }, memoryType: "preference" });
  const saved = result.saved as ScheduledTaskMemory;
  assert.equal(saved.text, "Prefer quiet reminders.");
  assert.equal(saved.updatedAt, env.state.now);
  assert.deepEqual(saved.scopes.agentTypes, ["scheduled_task"]);
  assert.equal((await env.execute("retrieve_memory", { query: "quiet", limit: 1 })).memories instanceof Array, true);
  const updated = await env.execute("update_memory", { query: "quiet", text: "Prefer spoken reminders.", memoryType: "fact" });
  assert.equal((updated.updated as ScheduledTaskMemory).id, saved.id);
  assert.equal((updated.updated as ScheduledTaskMemory).memoryType, "fact");
  assert.equal((await env.execute("update_memory", { id: "absent", text: "Never matches" })).toolSuccess, false);
  assert.equal((await env.execute("delete_memory", { query: "spoken", limit: 1 })).toolSuccess, true);
  assert.equal(env.state.memories.length, 0);
  await env.execute("save_scheduled_task", createInput());
  assert.equal(env.assertion().storageMatchesExpected, true);
  assert.equal(env.assertion().memoryUnchanged, true);
  assert.equal(env.taskSatisfied(), false, "Saving and then deleting unrelated memory must not evade the mutation assertion");

  const fresh = environment("announcement-at-time");
  assert.deepEqual((await fresh.execute("retrieve_memory", { query: "spoken" })).memories, []);
  assert.equal((await fresh.execute("delete_memory", { id: saved.id })).toolSuccess, false);
  const scoped = await fresh.execute("save_memory", { text: "Prefer the kitchen light dim", memoryType: "guidance" });
  assert.deepEqual((scoped.saved as ScheduledTaskMemory).scopes.deviceNames, ["kitchen light"]);
  await fresh.execute("update_memory", { id: (scoped.saved as ScheduledTaskMemory).id, text: "Prefer the kitchen light bright", scopes: { roomNames: ["kitchen"] } });
  assert.equal((await fresh.execute("delete_memory", { id: (scoped.saved as ScheduledTaskMemory).id })).toolSuccess, true);
});
