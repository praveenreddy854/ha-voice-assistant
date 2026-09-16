import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Databases } from "@azure/cosmos";
import type { Scenario } from "../src/evals/types";
import { scheduledTaskScenarios, type ScheduledTaskState } from "../src/evals/scheduled-task/scenarios";
import {
  configureTestProviders, messageText, readModelRequest, toolResponse, type ModelRequest,
} from "./helpers/agentFixtures";

configureTestProviders();
process.env.AZURE_COSMOS_ENDPOINT = "https://cosmos.invalid";
process.env.AZURE_COSMOS_KEY = "dGVzdA==";
process.env.AZURE_COSMOS_DATABASE = "test";
process.env.AZURE_COSMOS_CONTAINER = "test";

interface RequestWithTools extends ModelRequest {
  model: string;
  tools: Array<{ name: string; description: string; parameters: { properties: Record<string, unknown> } }>;
}
interface Call {
  name: string;
  args: Record<string, unknown>;
  omitUsage?: boolean;
}
function fixture(id: string): Scenario<ScheduledTaskState> {
  const found = scheduledTaskScenarios.find(scenario => scenario.id === id);
  assert.ok(found);
  return found;
}
function script(t: TestContext, calls: Call[], inspect?: (request: RequestWithTools, step: number) => void) {
  const requests: RequestWithTools[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = readModelRequest(input, init) as RequestWithTools;
    assert.ok(Array.isArray(request.input));
    assert.ok(Array.isArray(request.tools), "Only model tool-loop requests are allowed, never embeddings/storage/HA");
    const step = requests.length;
    assert.ok(calls[step], `Unexpected model request ${step + 1}`);
    requests.push(request);
    inspect?.(request, step);
    const call = calls[step];
    const response = toolResponse(call.name, call.args, `call-${step}`);
    if (!call.omitUsage) return response;
    const body = await response.json();
    delete body.usage;
    return Response.json(body);
  });
  return requests;
}
const complete = (message = "Scheduled.", success = true): Call => ({ name: "complete_task", args: { success, message } });
const save = (): Call => ({ name: "save_scheduled_task", args: fixture("announcement-at-time").initial.expected.mutations[0].args });
const loadAdapter = async (model?: string) => (await import("../src/evals/scheduled-task/adapter")).createScheduledTaskAdapter(model);

test("ScheduledTask adapter uses production loop, schemas and rendered prompt without any live execution or setup I/O", async (t) => {
  const cosmos = t.mock.method(Databases.prototype, "createIfNotExists", async () => {
    assert.fail("No live storage or memory initialization is permitted");
  });
  const [{ SCHEDULED_TASK_TOOLS }, { buildMemoryToolDefinitions }, { renderScheduledTaskSystemPrompt }] = await Promise.all([
    import("../src/agents/scheduled-task/tools"), import("../src/agents/core/memoryTools"),
    import("../src/agents/scheduled-task/prompt"),
  ]);
  const executors = SCHEDULED_TASK_TOOLS.map(tool => t.mock.method(tool, "execute", async () => {
    assert.fail("Production tool executor was not stripped");
  }));
  const template = await fs.readFile(path.join(__dirname, "../src/prompts/SCHEDULEDTASK.md"), "utf8");
  const scenario = fixture("announcement-at-time");
  const expectedPrompt = renderScheduledTaskSystemPrompt(template, new Date(scenario.initial.now), scenario.initial.timeZone);
  const contracts = [...SCHEDULED_TASK_TOOLS, ...buildMemoryToolDefinitions("scheduled_task")];
  const requests = script(t, [save(), complete()], (request, step) => {
    assert.match(messageText(request, "user"), /offline scheduling fixture/i);
    assert.ok(messageText(request, "system").includes(expectedPrompt));
    assert.match(messageText(request, "system"), /Persistent agent memory/);
    assert.equal(request.model, "test-model");
    assert.deepEqual(new Set(request.tools.map(tool => tool.name)), new Set([...contracts.map(tool => tool.function.name), "complete_task"]));
    for (const contract of contracts) {
      const sent = request.tools.find(tool => tool.name === contract.function.name)!;
      assert.equal(sent.description, contract.function.description);
      assert.deepEqual(sent.parameters.properties, contract.function.inputSchema!.toJSONSchema().properties);
    }
    if (step === 1) assert.match(JSON.stringify(request), /eval-task-1/);
  });
  const adapter = await loadAdapter();
  assert.equal(requests.length, 0, "Constructing an adapter must not call a model or write anything");
  assert.equal(cosmos.mock.callCount(), 0);
  assert.equal(adapter.id, "scheduled_task");
  assert.equal(adapter.model, "test-model");
  const result = await adapter.execute(scenario, new AbortController().signal);
  assert.equal(result.taskAssertion, true);
  assert.equal(result.finalResponse, "Scheduled.");
  assert.equal(result.agentId, "scheduled_task");
  assert.equal(result.mode, "simulated");
  assert.equal(result.coverage, "complete");
  assert.equal(result.expectations, scenario.expectations);
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10, totalTokens: 30 });
  assert.equal(requests.length, 2);
  assert.equal(cosmos.mock.callCount(), 0);
  assert.ok(executors.every(executor => executor.mock.callCount() === 0));
  assert.deepEqual(result.evidence.map(item => item.id), result.evidence.map((_, index) => `e${index + 1}`));
  for (const kind of ["initial", "tool", "context", "final", "assertion"]) assert.ok(result.evidence.some(item => item.kind === kind));
  assert.ok(result.evidence.every(item => !item.image && item.kind !== "image"));
  const assertion = JSON.parse(result.evidence.at(-1)!.text);
  assert.equal(assertion.actualFinalState.tasks.length, 2);
  assert.equal(assertion.storageMatchesExpected, true);
  assert.equal(assertion.mutationsMatchExpected, true);
});

test("scripted model calls exercise all scheduling scenarios with independent fulfillment assertions", async (t) => {
  const adapter = await loadAdapter();
  for (const scenario of scheduledTaskScenarios) {
    await t.test(scenario.id, async (subtest) => {
      const calls: Call[] = [];
      if (scenario.initial.expected.requiresList) calls.push({ name: "list_scheduled_tasks", args: { reason: "Find the user's requested tasks" } });
      if (scenario.id === "recurring-action-dst") calls.push({ name: "find_matching_entities", args: { query: "Roborock", domain: "vacuum" } });
      if (scenario.id === "missing-entity") calls.push({ name: "find_matching_entities", args: { query: "pool pump" } });
      if (scenario.id === "past-date") calls.push({ ...save(), args: { ...save().args, dueDate: "2026-03-06T09:00:00-05:00" } });
      if (scenario.id === "storage-failure") calls.push(save());
      calls.push(...scenario.initial.expected.mutations.map(call => ({ name: call.toolName, args: call.args })));
      calls.push(complete(scenario.initial.expected.answer || (scenario.initial.expected.fulfillable ? "Done." : "Unable to schedule or cancel without clarification."), scenario.initial.expected.fulfillable));
      const requests = script(subtest, calls);
      const assessment = await adapter.execute(scenario, new AbortController().signal);
      assert.equal(assessment.taskAssertion, scenario.initial.expected.fulfillable);
      assert.equal(requests.length, calls.length);
      const assertion = JSON.parse(assessment.evidence.at(-1)!.text);
      assert.equal(assertion.storageMatchesExpected, true, "Every final row, including unrelated rows, is checked");
      assert.equal(assertion.mutationsMatchExpected, true);
      if (!scenario.initial.expected.fulfillable) assert.equal(assertion.taskSatisfied, false, "Honest handling is not the same as fulfillment");
      if (scenario.id === "past-date") assert.match(JSON.stringify(assessment.evidence), /strictly in the future/);
      if (scenario.id === "storage-failure") assert.match(JSON.stringify(assessment.evidence), /Task not saved/);
    });
  }
});

test("confirmation runs share a fixed prompt hash and clock but never task or memory state", async (t) => {
  const adapter = await loadAdapter("override-model");
  const hash = adapter.promptVersion;
  t.mock.timers.enable({ apis: ["Date"], now: new Date("2099-01-01T00:00:00Z") });
  assert.equal((await loadAdapter("override-model")).promptVersion, hash);
  const scenario = fixture("announcement-at-time");
  const initial = structuredClone(scenario.initial);
  await t.test("first run writes only its private memory", async (subtest) => {
    script(subtest, [
      { name: "save_memory", args: { text: "Prefer quiet reminders.", scopes: { global: true } } }, save(), complete(),
    ]);
    const result = await adapter.execute(scenario, new AbortController().signal);
    assert.equal(result.taskAssertion, false, "Unrequested memory mutation is not allowed");
    assert.equal(JSON.parse(result.evidence.at(-1)!.text).actualFinalState.memories.length, 1);
  });
  t.mock.timers.setTime(Date.parse("2100-01-01T00:00:00Z"));
  await t.test("confirmation cannot see that memory or saved task", async (subtest) => {
    const requests = script(subtest, [
      { name: "retrieve_memory", args: { query: "quiet" } }, save(), complete(),
    ], (request, step) => {
      assert.match(messageText(request, "system"), /2026-03-07T12:00:00\.000Z/);
      assert.doesNotMatch(messageText(request, "system"), /2099|2100/);
      assert.equal(request.model, "override-model");
      if (step === 1) assert.match(JSON.stringify(request), /No relevant Persistent agent memory found/);
    });
    const result = await adapter.execute(scenario, new AbortController().signal);
    assert.equal(result.taskAssertion, true);
    assert.equal(result.promptVersion, hash);
    assert.equal(requests.length, 3);
    const initialState = JSON.parse(result.evidence[0].text);
    assert.deepEqual(initialState.memories, []);
    assert.equal(initialState.tasks.length, 1);
  });
  assert.deepEqual(scenario.initial, initial);
});

test("schema-invalid and unsupported model tool calls fail closed before simulated effects", async (t) => {
  const adapter = await loadAdapter();
  for (const call of [
    { name: "call_home_assistant", args: { service: "turn_off", entity_id: "light.kitchen" } },
    { name: "save_scheduled_task", args: { ...save().args, dueDate: "2026-02-30T09:00:00Z" } },
    { name: "save_scheduled_task", args: { ...save().args, effect: { kind: "action" } } },
    { name: "retrieve_memory", args: { query: "quiet", limit: -1 } },
  ]) {
    await t.test(call.name + JSON.stringify(call.args), async (subtest) => {
      subtest.mock.method(console, "error", () => {});
      const requests = script(subtest, [call]);
      await assert.rejects(adapter.execute(fixture("announcement-at-time"), new AbortController().signal));
      assert.equal(requests.length, 1);
    });
  }
});

test("missing token usage remains unknown instead of turning into a fabricated zero", async (t) => {
  const requests = script(t, [{ ...save(), omitUsage: true }, complete()]);
  const result = await (await loadAdapter()).execute(fixture("announcement-at-time"), new AbortController().signal);
  assert.equal(result.taskAssertion, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(result.usage, { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined });
});

test("iteration cap stops before executing the last pending tool and does not claim completion", async (t) => {
  const { SCHEDULED_TASK_AGENT_MAX_ITERATIONS: cap } = await import("../src/agents/scheduled-task/constants");
  const requests = script(t, Array.from({ length: cap }, () => ({ name: "list_scheduled_tasks", args: {} })));
  const result = await (await loadAdapter()).execute(fixture("query-today"), new AbortController().signal);
  assert.equal(requests.length, cap);
  assert.equal(result.evidence.filter(item => item.kind === "tool").length, cap - 1);
  assert.match(result.finalResponse, /iteration limit reached without completion/);
  assert.equal(result.taskAssertion, false);
  assert.equal(result.usage?.inputTokens, cap * 10);
  assert.equal(JSON.parse(result.evidence.at(-1)!.text).stoppedAtIterationLimit, true);
});

test("provider errors and cancellation are propagated, never synthesized as successful assessments", async (t) => {
  t.mock.method(console, "error", () => {});
  const adapter = await loadAdapter();
  await t.test("aborted before a request", async (subtest) => {
    const requests = script(subtest, []);
    const controller = new AbortController();
    controller.abort(new Error("Cancelled before start"));
    await assert.rejects(adapter.execute(fixture("announcement-at-time"), controller.signal), /Cancelled before start/);
    assert.equal(requests.length, 0);
  });
  await t.test("aborted while requesting a model turn", async (subtest) => {
    const controller = new AbortController();
    let calls = 0;
    subtest.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      readModelRequest(input, init);
      calls++;
      controller.abort(new Error("Cancelled during request"));
      throw controller.signal.reason;
    });
    await assert.rejects(adapter.execute(fixture("announcement-at-time"), controller.signal), /Cancelled during request/);
    assert.equal(calls, 1);
  });
  await t.test("provider execution failure", async (subtest) => {
    subtest.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      readModelRequest(input, init);
      return Response.json({ error: { message: "Offline model failed", type: "invalid_request_error" } }, { status: 400 });
    });
    await assert.rejects(adapter.execute(fixture("announcement-at-time"), new AbortController().signal), /Offline model failed/);
  });
});

test("a successful completion claim after a failed write or a wrong state never satisfies the task", async (t) => {
  const adapter = await loadAdapter();
  await t.test("failed write", async (subtest) => {
    script(subtest, [save(), complete("Saved successfully.", true)]);
    const result = await adapter.execute(fixture("storage-failure"), new AbortController().signal);
    assert.equal(result.taskAssertion, false);
    assert.equal(result.finalResponse, "Saved successfully.");
    assert.match(JSON.stringify(result.evidence), /Task not saved/);
  });
  await t.test("wrong due time", async (subtest) => {
    script(subtest, [{ ...save(), args: { ...save().args, dueDate: "2026-03-07T10:00:00-05:00" } }, complete()]);
    const result = await adapter.execute(fixture("announcement-at-time"), new AbortController().signal);
    assert.equal(result.taskAssertion, false);
    assert.equal(JSON.parse(result.evidence.at(-1)!.text).storageMatchesExpected, false);
  });
});
