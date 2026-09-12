import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createTrace, completeTrace, getTrace, withTraceSession, telemetrySpanExporter } from "../src/tracing/agentTraceStore";
import { configureTestProviders } from "./helpers/agentFixtures";

const processor = new SimpleSpanProcessor(telemetrySpanExporter);
const sdk = new NodeSDK({ spanProcessors: [processor] });
before(() => {
  configureTestProviders();
  sdk.start();
});
after(() => sdk.shutdown());

test("missing Cosmos configuration produces failed results for every storage tool", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("No network expected"); });
  const { SCHEDULED_TASK_TOOLS } = await import("../src/agents/scheduled-task/tools");
  const inputs = [
    ["save_scheduled_task", { title: "Synthetic", dueDate: new Date(Date.now() + 60_000).toISOString(),
      effect: { kind: "announcement" }, isRecurring: false, category: "task", priority: "medium" }],
    ["list_scheduled_tasks", {}],
    ["update_scheduled_task", { id: "test", recurrenceFamilyId: "test", patch: { title: "Updated" } }],
    ["delete_scheduled_task", { scope: "family", recurrenceFamilyId: "test" }],
  ] as const;
  for (const [name, args] of inputs) {
    const tool = SCHEDULED_TASK_TOOLS.find((tool) => tool.function.name === name)!;
    createTrace(name, "scheduled_task", "Synthetic missing storage test");
    const result = await withTraceSession(name, () => tool.execute!({ ...args }, { toolCallId: name, messages: [], context: {} })) as { toolSuccess: boolean; saved?: unknown };
    completeTrace(name, false, "Unavailable storage");
    await processor.forceFlush();
    assert.equal(result.toolSuccess, false);
    if (name === "save_scheduled_task") assert.equal(result.saved, null);
    const trace = getTrace(name)!;
    assert.equal(trace.toolResults.length, 1);
    assert.equal(trace.toolResults[0].toolSuccess, false);
    assert.equal(trace.toolResults[0].toolCallId, name);
  }
});
