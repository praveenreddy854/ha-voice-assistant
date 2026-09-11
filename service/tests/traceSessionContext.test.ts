import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  withTraceSession, getActiveSessionId, getTrace, telemetrySpanExporter,
} from "../src/tracing/agentTraceStore";
import { buildDashboardSnapshot } from "../src/tracing/dashboardAnalytics";
import { configureTestProviders, deferred, messageText, readModelRequest, toolResponse } from "./helpers/agentFixtures";
import type { AgentRunResult } from "../src/agents/core/types";

let runAgent: typeof import("../src/agents/core/orchestrator").runAgent;
const heldTools = new Map<string, { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> }>();
const sdk = new NodeSDK({ spanProcessors: [new SimpleSpanProcessor(telemetrySpanExporter)] });
before(async () => {
  configureTestProviders();
  sdk.start();
  const { tvAgentDefinition } = await import("../src/agents/tv/definition");
  const { registerAgent } = await import("../src/agents/core/registry");
  ({ runAgent } = await import("../src/agents/core/orchestrator"));
  const wait = tvAgentDefinition.tools.find((tool) => tool.function.name === "wait")!;
  const execute = wait.execute!;
  registerAgent({
    ...tvAgentDefinition,
    buildInitialMessage: async (prompt) => prompt,
    processExternalInput: undefined,
    onComplete: undefined,
    tools: [
      { ...wait, execute: async (args, options) => {
        const held = heldTools.get(String(args.reason));
        if (held) { held.entered.resolve(); await held.release.promise; }
        return execute(args, options);
      } },
      { type: "function", function: { name: "request_input", parameters: { type: "object", properties: {} } } },
    ],
    validateCompletion(session) {
      if (session.userPrompt.includes("rejected") && !session.agentData.retried) {
        session.agentData.retried = true;
        return { allowed: false, reason: "Synthetic prerequisite requires another step" };
      }
      return { allowed: true };
    },
  });
});
after(async () => { await sdk.shutdown(); });

test("async trace scopes restore parents after nested callbacks and throws", async () => {
  assert.equal(getActiveSessionId(), null);
  await withTraceSession("parent", async () => {
    await assert.rejects(withTraceSession("child", async () => {
      await Promise.resolve();
      assert.equal(getActiveSessionId(), "child");
      throw new Error("Synthetic failure");
    }), /Synthetic failure/);
    assert.equal(getActiveSessionId(), "parent");
    assert.throws(() => withTraceSession("sync-child", () => { throw new Error("Synchronous failure"); }));
    assert.equal(getActiveSessionId(), "parent");
  });
  assert.equal(getActiveSessionId(), null);
});

for (const mode of ["normal", "cancelled", "tool-error", "external", "rejected"] as const) {
  test(`interleaved ${mode} runs retain their own LLM steps and TV tool results`, { timeout: 10_000 }, async (t) => {
    const calls = new Map<string, number>();
    const a = `synthetic-${mode}-a`;
    const b = `synthetic-${mode}-b`;
    const hold = () => ({ entered: deferred(), release: deferred() });
    const gateA = hold();
    const gateB = hold();
    heldTools.set(a, gateA);
    heldTools.set(b, gateB);
    t.after(() => { gateA.release.resolve(); gateB.release.resolve(); heldTools.clear(); });
    t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      const prompt = messageText(readModelRequest(url, init), "user");
      assert.ok(prompt === a || prompt === b);
      const count = (calls.get(prompt) ?? 0) + 1;
      calls.set(prompt, count);
      if (mode === "external" && prompt === a && count === 1) {
        return toolResponse("request_input", {}, `${prompt}-${count}`);
      }
      const waitStep = mode === "external" && prompt === a ? 2 : 1;
      return count === waitStep
        ? toolResponse("wait", { duration_ms: 250, reason: prompt }, `${prompt}-${count}`)
        : toolResponse("complete_task", { success: true, message: prompt }, `${prompt}-${count}`);
    });
    // Fail inside the real TV executor to exercise its failure attribution path.
    if (mode === "tool-error") {
      const { definition: waitDefinition } = await import("../src/agents/tv/tools/wait");
      // The dispatcher captures this function at import time, so use its schema
      // to raise a controlled failure only for A's tool execution instead.
      const parse = waitDefinition.inputSchema.parse.bind(waitDefinition.inputSchema);
      t.mock.method(waitDefinition.inputSchema, "parse", (value: unknown) => {
        if ((value as { reason?: string }).reason === a) throw new Error("Synthetic tool failure");
        return parse(value);
      });
    }
    let pending: AgentRunResult | undefined;
    if (mode === "external") {
      pending = await runAgent({ agentType: "tv", userPrompt: a });
      assert.equal(pending.status, "awaiting_external_input");
    }
    const cancellation = new AbortController();
    const runA = runAgent({ agentType: "tv", userPrompt: a, abortSignal: cancellation.signal,
      ...(pending ? { sessionId: pending.sessionId, externalInput: { type: "confirmation" as const, data: { answer: "yes" } } } : {}),
    });
    await gateA.entered.promise;
    const runB = runAgent({ agentType: "tv", userPrompt: b });
    await gateB.entered.promise;
    if (mode === "cancelled") cancellation.abort(new Error("Synthetic cancellation"));
    gateA.release.resolve();
    const resultA = await runA;
    assert.equal(getActiveSessionId(), null);
    gateB.release.resolve();
    const resultB = await runB;
    assert.equal(resultA.status, mode === "cancelled" ? "error" : "completed");
    assert.equal(resultB.status, "completed");
    const traceA = getTrace(resultA.sessionId)!;
    const traceB = getTrace(resultB.sessionId)!;
    for (const [trace, prompt] of [[traceA, a], [traceB, b]] as const) {
      for (const step of trace.llmSteps) {
        for (const call of step.toolCalls) {
          if (call.args.reason) assert.equal(call.args.reason, prompt);
          if (call.args.message) assert.equal(call.args.message, prompt);
        }
      }
      for (const result of trace.toolResults) assert.equal(result.args?.reason, prompt);
    }
    const expectedBSteps = mode === "rejected" ? 3 : 2;
    assert.equal(traceB.llmSteps.length, expectedBSteps);
    assert.equal(traceB.toolResults.length, 1);
    // The SDK reports the cancelled tool-call step before propagating abort.
    assert.equal(traceA.llmSteps.length, mode === "cancelled" ? 1 : mode === "external" || mode === "rejected" ? 3 : 2);
    assert.equal(traceA.toolResults.length, mode === "cancelled" ? 0 : 1);
    if (mode === "tool-error") assert.equal(traceA.toolResults[0].toolSuccess, false);
    const snapshot = buildDashboardSnapshot([traceA, traceB], { range: "all" });
    assert.equal(snapshot.overview.modelCalls, traceA.llmSteps.length + traceB.llmSteps.length);
    assert.equal(snapshot.tools[0].calls, traceA.toolResults.length + traceB.toolResults.length);
  });
}

test("a paused tool retains its trace context while another run completes", { timeout: 10_000 }, async (t) => {
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const calls = new Map<string, number>();
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const prompt = messageText(readModelRequest(url, init), "user");
    const count = (calls.get(prompt) ?? 0) + 1;
    calls.set(prompt, count);
    return count === 1
      ? toolResponse("wait", { duration_ms: 250, reason: prompt }, `${prompt}-${count}`)
      : toolResponse("complete_task", { success: true, message: prompt }, `${prompt}-${count}`);
  });
  let checkpoint = 0;
  const paused = runAgent({ agentType: "tv", userPrompt: "synthetic-paused", pauseGate: {
    async waitIfPaused() { if (++checkpoint === 3) { entered.resolve(); await release.promise; } },
  } });
  await entered.promise;
  const other = await runAgent({ agentType: "tv", userPrompt: "synthetic-other" });
  assert.equal(other.status, "completed");
  release.resolve();
  const result = await paused;
  assert.equal(result.status, "completed");
  const trace = getTrace(result.sessionId)!;
  assert.equal(trace.llmSteps.length, 2);
  assert.equal(trace.toolResults.length, 1);
  assert.equal(trace.toolResults[0].args?.reason, "synthetic-paused");
  assert.equal(getActiveSessionId(), null);
});
