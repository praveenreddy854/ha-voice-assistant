import assert from "node:assert/strict";
import test, { before, after, mock } from "node:test";
import { Databases } from "@azure/cosmos";
import axios from "axios";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createTrace, completeTrace, getTrace, withTraceSession, telemetrySpanExporter } from "../src/tracing/agentTraceStore";
import { buildDashboardSnapshot } from "../src/tracing/dashboardAnalytics";
import type { ScheduledTask } from "../src/types/scheduledTask";
import type { AgentToolExecutionOptions } from "../src/agents/core/agentLoop";
import { configureTestProviders, deferred, messageText, readModelRequest, toolResponse } from "./helpers/agentFixtures";

let tools: typeof import("../src/agents/scheduled-task/tools");
let runAgent: typeof import("../src/agents/core/orchestrator").runAgent;
const tasks = new Map<string, ScheduledTask>();
const container = {
  items: {
    upsert: async (task: ScheduledTask) => { tasks.set(task.id, task); return { resource: task }; },
    query: () => ({ fetchAll: async () => ({ resources: [...tasks.values()] }) }),
  },
  item: (id: string) => ({
    read: async () => ({ resource: tasks.get(id) }),
    delete: async () => { if (!tasks.delete(id)) throw new Error("Not found"); },
  }),
};
const processor = new SimpleSpanProcessor(telemetrySpanExporter);
const sdk = new NodeSDK({ spanProcessors: [processor] });
before(async () => {
  configureTestProviders();
  process.env.AZURE_COSMOS_ENDPOINT = "https://cosmos.invalid";
  process.env.AZURE_COSMOS_KEY = "dGVzdA==";
  process.env.AZURE_COSMOS_DATABASE = "test";
  process.env.AZURE_COSMOS_CONTAINER = "test";
  process.env.AZURE_COSMOS_SCHEDULED_TASKS_CONTAINER = "ScheduledTasks";
  mock.method(Databases.prototype, "createIfNotExists", async () => ({
    database: { containers: { createIfNotExists: async ({ id }: { id: string }) => ({
      container: id === "ScheduledTasks" ? container : { items: { query: () => ({ fetchAll: async () => ({ resources: [] }) }) } },
    }) } },
  }) as never);
  sdk.start();
  tools = await import("../src/agents/scheduled-task/tools");
  const { registerAgent } = await import("../src/agents/core/registry");
  const { scheduledTaskAgentDefinition } = await import("../src/agents/scheduled-task/definition");
  registerAgent(scheduledTaskAgentDefinition);
  ({ runAgent } = await import("../src/agents/core/orchestrator"));
});
after(async () => { mock.restoreAll(); await sdk.shutdown(); });

const input = () => ({
  title: "Synthetic task", dueDate: new Date(Date.now() + 3_600_000).toISOString(),
  effect: { kind: "announcement" }, isRecurring: false, category: "task", priority: "medium",
});
function options(toolCallId: string, extra: Partial<AgentToolExecutionOptions> = {}): AgentToolExecutionOptions {
  return { toolCallId, messages: [], context: {}, ...extra };
}
async function execute(session: string, name: string, args: Record<string, unknown>, extra: Partial<AgentToolExecutionOptions> = {}) {
  createTrace(session, "scheduled_task", "Synthetic telemetry test");
  try {
    return await withTraceSession(session, () => tools.executeScheduledTaskTool(name, args, options(`${session}-call`, extra)));
  } finally { completeTrace(session, true, "Synthetic test finished"); await processor.forceFlush(); }
}

test("all scheduling tools record semantic results, sanitized args, and call IDs", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No model network expected"); });
  t.mock.method(axios, "get", async (url: string) => {
    assert.equal(url, "http://ha.invalid/api/states");
    return { status: 200, data: [{ entity_id: "light.test", state: "on", attributes: { friendly_name: "Test light" } }] };
  });
  const saved = await execute("saved", "save_scheduled_task", { ...input(), password: "must-not-be-traced" });
  assert.equal(saved.toolSuccess, true);
  const task = (saved.raw as { saved: ScheduledTask }).saved;
  assert.ok(tasks.has(task.id));
  const ids = { id: task.id, recurrenceFamilyId: task.recurrenceFamilyId };
  assert.equal((await execute("listed", "list_scheduled_tasks", {})).toolSuccess, true);
  assert.equal((await execute("updated", "update_scheduled_task", { ...ids, patch: { title: "Changed" } })).toolSuccess, true);
  assert.equal((await execute("searched", "find_matching_entities", { query: "test" })).toolSuccess, true);
  assert.equal((await execute("deleted", "delete_scheduled_task", { ...ids, scope: "occurrence" })).toolSuccess, true);
  assert.equal(tasks.has(task.id), false);
  assert.equal((await execute("missing-delete", "delete_scheduled_task", { ...ids, scope: "occurrence" })).toolSuccess, false);
  assert.equal((await execute("invalid-delete", "delete_scheduled_task", { recurrenceFamilyId: "test", scope: "occurrence" })).toolSuccess, false);
  assert.equal((await execute("empty-family", "delete_scheduled_task", { recurrenceFamilyId: "test", scope: "family" })).toolSuccess, true);
  const traces = ["saved", "listed", "updated", "searched", "deleted", "missing-delete", "invalid-delete"].map((id) => getTrace(id)!);
  for (const trace of traces) {
    assert.equal(trace.toolResults.length, 1);
    assert.equal(trace.toolResults[0].toolCallId, `${trace.sessionId}-call`);
    assert.ok(trace.toolResults[0].durationMs >= 0);
    assert.doesNotMatch(JSON.stringify(trace.toolResults), /must-not-be-traced|password/);
  }
  assert.equal(getTrace("missing-delete")!.toolResults[0].toolSuccess, false);
  const dashboard = buildDashboardSnapshot(traces, { range: "all" });
  assert.equal(dashboard.tools.length, 5);
  assert.equal(dashboard.tools.find((tool) => tool.toolName === "delete_scheduled_task")!.failures, 2);
});

test("SDK auto-execution records one result and preserves fresh model usage end to end", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    readModelRequest(url, init);
    return ++calls === 1
      ? toolResponse("save_scheduled_task", input(), "fresh-save")
      : toolResponse("complete_task", { success: true, message: "Saved synthetic task" }, "fresh-complete");
  });
  const result = await runAgent({ agentType: "scheduled_task", userPrompt: "Synthetic save" });
  await processor.forceFlush();
  assert.equal(result.status, "completed");
  const trace = getTrace(result.sessionId)!;
  assert.equal(trace.toolResults.length, 1);
  assert.equal(trace.toolResults[0].toolCallId, "fresh-save");
  assert.equal(trace.toolResults[0].toolSuccess, true);
  assert.equal(trace.llmSteps[0].toolCalls[0].toolCallId, "fresh-save");
  assert.equal(trace.llmSteps.length, 2);
  for (const step of trace.llmSteps) {
    assert.equal(step.requestModel, "test-model");
    assert.equal(step.responseModel, "test-model");
    assert.equal(step.provider, "azure.ai.openai");
    assert.ok(step.responseId?.startsWith("response-fresh-"));
    assert.equal(step.inputTokens, 10);
    assert.equal(step.outputTokens, 5);
    assert.equal(step.totalTokens, 15);
    assert.ok(typeof step.responseTimeMs === "number" && step.responseTimeMs >= 0);
    assert.ok(typeof step.stepTimeMs === "number" && step.stepTimeMs >= 0);
  }
  const dashboard = buildDashboardSnapshot([trace], { range: "all" });
  assert.equal(dashboard.overview.totalTokens, 30);
  assert.equal(dashboard.overview.tokenUsageCoverage.totalTokenCalls, 2);
  assert.equal(dashboard.models[0].tokensPerSuccessfulSession, 30);
});

test("persistence errors and partial family deletes record failures without SDK error payloads", async (t) => {
  t.mock.method(container.items, "upsert", async () => { throw new Error("Synthetic storage error secret=test-key"); });
  const result = await execute("storage-error", "save_scheduled_task", input());
  assert.equal(result.toolSuccess, false);
  assert.equal(result.raw, null);
  const sample = [...tasks.values()][0];
  const family = [{ ...sample, id: "family-one" }, { ...sample, id: "family-two" }];
  t.mock.method(container.items, "query", () => ({ fetchAll: async () => ({ resources: family }) }));
  const deletes: string[] = [];
  t.mock.method(container, "item", (id: string) => ({ read: async () => ({ resource: undefined }), delete: async () => {
    deletes.push(id);
    if (id === "family-two") throw new Error("Synthetic delete failure");
  } }));
  const deleted = await execute("family-error", "delete_scheduled_task", { scope: "family", recurrenceFamilyId: "synthetic-family" });
  assert.equal(deleted.toolSuccess, false);
  assert.deepEqual(deletes, ["family-one", "family-two"]);
  for (const id of ["storage-error", "family-error"]) {
    const trace = getTrace(id)!;
    assert.equal(trace.toolResults.length, 1);
    assert.equal(trace.toolResults[0].toolSuccess, false);
    assert.doesNotMatch(JSON.stringify(trace.toolResults), /secret=|test-key/);
  }
});

test("concurrent SDK saves correlate results to their originating call and session", { timeout: 10_000 }, async (t) => {
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const upsert = container.items.upsert;
  t.mock.method(container.items, "upsert", async (task: ScheduledTask) => {
    if (task.title === "concurrent-a") { entered.resolve(); await release.promise; }
    return upsert(task);
  });
  const calls = new Map<string, number>();
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const prompt = messageText(readModelRequest(url, init), "user");
    const count = (calls.get(prompt) ?? 0) + 1; calls.set(prompt, count);
    return count === 1 ? toolResponse("save_scheduled_task", { ...input(), title: prompt }, `${prompt}-save`)
      : toolResponse("complete_task", { success: true, message: prompt }, `${prompt}-complete`);
  });
  const a = runAgent({ agentType: "scheduled_task", userPrompt: "concurrent-a" });
  await entered.promise;
  const b = await runAgent({ agentType: "scheduled_task", userPrompt: "concurrent-b" });
  release.resolve();
  const first = await a;
  await processor.forceFlush();
  for (const [result, prompt] of [[first, "concurrent-a"], [b, "concurrent-b"]] as const) {
    assert.equal(result.status, "completed");
    const trace = getTrace(result.sessionId)!;
    assert.equal(trace.toolResults.length, 1);
    assert.equal(trace.toolResults[0].toolCallId, `${prompt}-save`);
    assert.equal(trace.toolResults[0].args?.title, prompt);
    assert.equal(trace.llmSteps[0].toolCalls[0].toolCallId, `${prompt}-save`);
  }
});

test("cancellation before execution has no result; cancellation after a write preserves its outcome", async (t) => {
  const before = new AbortController(); before.abort(new Error("Cancelled"));
  await assert.rejects(execute("pre-cancel", "save_scheduled_task", input(), { abortSignal: before.signal }), /Cancelled/);
  assert.equal(getTrace("pre-cancel")!.toolResults.length, 0);
  const after = new AbortController();
  const upsert = container.items.upsert;
  t.mock.method(container.items, "upsert", async (task: ScheduledTask) => {
    const result = await upsert(task); after.abort(new Error("Cancelled after write")); return result;
  });
  await assert.rejects(execute("post-cancel", "save_scheduled_task", input(), { abortSignal: after.signal }), /Cancelled after write/);
  const result = getTrace("post-cancel")!.toolResults[0];
  assert.equal(getTrace("post-cancel")!.toolResults.length, 1);
  assert.equal(result.toolSuccess, true);
});

test("cancellation during a failed operation records failure and propagates abort", async (t) => {
  const abort = new AbortController();
  t.mock.method(container.items, "upsert", async () => { abort.abort(new Error("Cancelled during write")); throw abort.signal.reason; });
  await assert.rejects(execute("during-cancel", "save_scheduled_task", input(), { abortSignal: abort.signal }), /Cancelled during write/);
  const trace = getTrace("during-cancel")!;
  assert.equal(trace.toolResults.length, 1);
  assert.equal(trace.toolResults[0].toolSuccess, false);
  assert.match(trace.toolResults[0].observation, /cancelled during execution/);
});
