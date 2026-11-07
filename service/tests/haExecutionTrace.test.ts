import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import axios from "axios";
import { createTrace, getAllTraces, getActiveSessionId, telemetrySpanExporter, withTraceSession } from "../src/tracing/agentTraceStore";
import { onlineAssessment } from "../src/evals/online/snapshot";
import { startActiveRun } from "../src/activeRunManager";
import { getRequestContext, withRequestContext } from "../src/requestContext";

test("HA commands retain downstream model, actual request results and parent attribution, including failures", async t => {
  process.env.AI_MODEL_HOME_ASSISTANT = "synthetic-quality-model";
  process.env.HOME_ASSISTANT_DEVICES = "test_light";
  const sdk = new NodeSDK({ autoDetectResources: false, spanProcessors: [new SimpleSpanProcessor(telemetrySpanExporter)] });
  sdk.start();
  const requireModule = createRequire(__filename);
  const previous = new Map<string, NodeModule | undefined>();
  const modelCalls: string[] = [];
  const stubs = {
    "../src/ai": { generateCompletion: async (params: { model: string }) => {
      modelCalls.push(params.model);
      return JSON.stringify({ url_path: "light/turn_off", entity_id: "light.test_light" });
    } },
    "../src/memory": { retrieveMemories: async () => [], formatMemoryContext: () => "" },
  };
  for (const [name, exports] of Object.entries(stubs)) {
    const filename = requireModule.resolve(name); previous.set(filename, requireModule.cache[filename]);
    requireModule.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeModule;
  }
  t.mock.method(axios, "get", async () => ({ status: 200, data: [{ entity_id: "light.test_light", state: "on", attributes: {} }] }));
  let failed = false;
  t.mock.method(axios, "post", async () => {
    if (failed) throw new Error("Synthetic API failure");
    return { status: 200, data: [{ entity_id: "light.test_light", state: "off", attributes: {} }] };
  });
  try {
    const { executeHACommand } = requireModule("../src/ha") as typeof import("../src/ha");
    const existingSessionIds = new Set(getAllTraces().map(trace => trace.sessionId));
    createTrace("voice-parent", "realtime", "Turn off test light");
    await withTraceSession("voice-parent", async () => {
      assert.equal((await executeHACommand("Turn off test light")).success, true);
      assert.equal(getActiveSessionId(), "voice-parent");
      failed = true;
      assert.equal((await executeHACommand("Turn off test light")).success, false);
    });
    const traces = getAllTraces().filter(trace => trace.agentType === "home_assistant" && !existingSessionIds.has(trace.sessionId));
    assert.equal(traces.length, 2); assert.deepEqual(modelCalls, ["synthetic-quality-model", "synthetic-quality-model"]);
    const success = traces.find(trace => trace.status === "completed")!;
    const error = traces.find(trace => trace.status === "error")!;
    assert.equal(success.llmSteps[0].requestModel, "synthetic-quality-model");
    assert.equal(success.toolResults[0].args?.entity_id, "light.test_light");
    assert.equal(success.events.find(event => event.type === "ha.execution.started")?.data?.parentSessionId, "voice-parent");
    assert.equal(error.toolResults[0].toolSuccess, false); assert.match(error.toolResults[0].observation, /Synthetic API failure/);
    const assessment = onlineAssessment(success);
    assert.equal(assessment.agentId, "home_assistant"); assert.match(assessment.promptVersion!, /^ha-template-/);
    assert.equal(assessment.evaluationScope, "execution");
    assert.equal(assessment.taskAssertion, undefined); assert.equal(assessment.coverage, "partial");
    failed = false;
    let done!: () => void;
    const finished = new Promise<void>(resolve => { done = resolve; });
    const receipt = new Date(Date.now() - 5000).toISOString();
    const started = withRequestContext(receipt, () => withTraceSession("voice-parent", () => startActiveRun({
      domain: "home_assistant", prompt: "Turn off test light",
      execute: async run => {
        assert.equal(getRequestContext()?.jobId, run.id);
        assert.equal(getRequestContext()?.receivedAt, receipt);
        return executeHACommand(run.prompt);
      },
      onFinally: () => { done(); },
    })));
    await finished; for (let i = 0; i < 4; i++) await Promise.resolve();
    const job = getAllTraces().find(trace => trace.sessionId === `job-${started.jobId}`)!;
    assert.equal(job.status, "completed");
    assert.equal(job.events.find(event => event.type === "job.accepted")?.data?.originSessionId, "voice-parent");
    const child = job.events.find(event => event.type === "job.child_session.started")?.data?.sessionId;
    assert.ok(typeof child === "string" && child.startsWith("home-assistant-"));
    assert.ok(job.events.some(event => event.type === "job.notification.callback_completed"));
  } finally {
    for (const [filename, module] of previous) { if (module) requireModule.cache[filename] = module; else delete requireModule.cache[filename]; }
    await sdk.shutdown();
  }
});
