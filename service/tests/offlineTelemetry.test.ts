import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLlmJudge, makeJudge } from "../src/evals/judge";
import { runOfflineAgentLoop } from "../src/evals/loop";
import { EvalRunner } from "../src/evals/runner";
import { EvalStore } from "../src/evals/store";
import {
  aggregateTrialMetrics, captureTrial, EvalExecutionError, EvalGradingError,
  reportedModelUsage, sumUsage, TrialTelemetry,
} from "../src/evals/telemetry";
import type { AgentAdapter, Assessment, EvalRun, EvalRunSummary, Scenario } from "../src/evals/types";
import { configureTestProviders, messageText, readModelRequest, toolResponse } from "./helpers/agentFixtures";

configureTestProviders();

const usage = { inputTokens: 20, outputTokens: 10, totalTokens: 30 };
const scenario: Scenario = {
  id: "fixture", version: "1", request: "Open YouTube", initial: {},
  context: { task: "open", target: "TV", app: "YouTube", startingState: "Home" }, expectations: "App opens",
};
const input = (): Pick<Assessment, "agentId" | "request" | "model" | "promptVersion" | "evidence"> => ({
  agentId: "tv", request: scenario.request, model: "fixture-model", promptVersion: "fixture-prompt",
  evidence: [{ id: "e1", kind: "initial", text: "Home screen" }],
});
const metrics = () => new TrialTelemetry().finish().metrics;
const summary = (id: string, overrides: Partial<EvalRunSummary> = {}): EvalRunSummary => ({
  id, batchId: "batch", agentId: "tv", mode: "simulated", attempt: "scheduled", status: "completed",
  adapterVersion: "1", graderVersion: "1", judgeModel: "judge",
  assessedAt: "2026-09-17T10:00:00Z", gradedAt: "2026-09-17T10:01:00Z",
  metrics: { ...metrics(), assistantTurns: 2, toolCalls: 1 }, usage, judgeUsage: usage, durationMs: 100,
  ...overrides,
});
async function withStore(work: (store: EvalStore) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "eval-telemetry-"));
  try { await work(new EvalStore(directory)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("usage aggregation preserves unknowns, actual zeros and token subsets without double counting", () => {
  assert.deepEqual(sumUsage([usage, usage]), { inputTokens: 40, outputTokens: 20, totalTokens: 60 });
  assert.deepEqual(sumUsage([{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }]), {
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
  });
  assert.deepEqual(sumUsage([usage, { inputTokens: 10 }]), {
    inputTokens: 30, outputTokens: undefined, totalTokens: undefined,
  });
  for (const values of [[], [undefined], [usage, undefined]]) {
    assert.deepEqual(sumUsage(values), { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined });
  }
  assert.deepEqual(sumUsage([{ ...usage, cacheReadTokens: 5, reasoningTokens: 3 }, {
    ...usage, cacheReadTokens: 0, reasoningTokens: 0,
  }]), { inputTokens: 40, outputTokens: 20, totalTokens: 60, cacheReadTokens: 5, reasoningTokens: 3 });
  assert.equal(sumUsage([{ ...usage, cacheReadTokens: 5 }, usage]).cacheReadTokens, undefined);
  for (const invalid of [-1, 1.5, NaN, Infinity]) assert.equal(sumUsage([{ totalTokens: invalid }]).totalTokens, undefined);
  assert.equal(sumUsage([{ totalTokens: Number.MAX_SAFE_INTEGER }, { totalTokens: 1 }]).totalTokens, undefined);
});

test("SDK-defaulted zero detail counts are not mistaken for explicitly reported cache or reasoning usage", () => {
  assert.deepEqual(reportedModelUsage({ ...usage, cacheReadTokens: 0, reasoningTokens: 0 }, {
    input_tokens: 20, output_tokens: 10,
  }), usage);
  assert.deepEqual(reportedModelUsage(usage, {
    input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 4 },
  }), { ...usage, cacheReadTokens: 0, reasoningTokens: 4 });
  assert.equal(reportedModelUsage(usage, { input_tokens_details: { cached_tokens: -1 } }).cacheReadTokens, undefined);
});

test("trial counters and monotonic timings measure responses, tools and user turns independently", async () => {
  let now = 0;
  const telemetry = new TrialTelemetry(() => now);
  telemetry.beginUserTurn();
  const first = telemetry.beginModel("model");
  now = 100;
  const response = telemetry.response(first, { text: "Try opening the app", responseId: "response-1", usage });
  telemetry.endModel(first);
  const tool = telemetry.requestTool(first, response.turn, "launch", "launch_app", { app: "YouTube" });
  const completion = telemetry.requestTool(first, response.turn, "complete", "complete_task", {});
  await telemetry.executeTool(tool, () => { now = 125; return { toolSuccess: false, observation: "Unavailable" }; });
  telemetry.rejectTool(completion, "Research still required");
  now = 150;
  telemetry.beginUserTurn();
  const second = telemetry.beginModel("model");
  now = 175;
  telemetry.response(second, { text: "Cannot open the app.", usage });
  telemetry.endModel(second);
  now = 200;
  telemetry.virtualDeviceTimeMs = 1500;
  const result = telemetry.finish();
  assert.deepEqual(result.metrics, {
    version: 1, userTurns: 2, assistantTurns: 2, modelRequests: 2,
    toolCalls: 2, toolExecutions: 1, toolErrors: 1, rejectedToolCalls: 1, unexecutedToolCalls: 0,
    completionCalls: 1, modelErrors: 0, modelTimeMs: 125, toolTimeMs: 25, timeToFirstResponseMs: 100,
    usageReportedResponses: 2, stopReason: "completed", virtualDeviceTimeMs: 1500,
  });
  assert.equal(result.durationMs, 200);
  assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 20, totalTokens: 60 });
  assert.equal(result.trace.modelCalls[0].responses[0].turn, 1);
  assert.equal(result.trace.modelCalls[1].responses[0].turn, 2);
  assert.equal(result.trace.toolCalls[0].modelCallId, "model-1");
  assert.equal(result.trace.toolCalls[0].status, "error");
  assert.equal(result.trace.toolCalls[1].executed, false);
});

test("a failed tool result differs from honest completion failure and unexecuted requests", async () => {
  const telemetry = new TrialTelemetry();
  telemetry.beginUserTurn();
  const call = telemetry.beginModel();
  const response = telemetry.response(call, { text: "", usage });
  telemetry.endModel(call);
  const tool = telemetry.requestTool(call, response.turn, "tool", "save_memory", {});
  await telemetry.executeTool(tool, () => '{"success":false,"message":"No matching memory"}');
  const complete = telemetry.requestTool(call, response.turn, "complete", "complete_task", { success: false });
  telemetry.completeTool(complete, { completionSuccess: false });
  telemetry.requestTool(call, response.turn, "pending", "get_device_state", {});
  telemetry.stop("iteration_limit");
  const result = telemetry.finish();
  assert.equal(result.metrics.toolCalls, 3);
  assert.equal(result.metrics.toolExecutions, 1);
  assert.equal(result.metrics.toolErrors, 1);
  assert.equal(result.metrics.completionCalls, 1);
  assert.equal(result.metrics.unexecutedToolCalls, 1);
  assert.equal(result.metrics.stopReason, "iteration_limit");
});

test("partial failed requests retain known response usage but never report incomplete totals as complete", async () => {
  await assert.rejects(captureTrial(input(), new AbortController().signal, async telemetry => {
    telemetry.beginUserTurn();
    const first = telemetry.beginModel();
    telemetry.response(first, { text: "First response", usage });
    telemetry.endModel(first);
    telemetry.beginModel();
    throw new Error("Provider failed");
  }), (error: unknown) => {
    assert.ok(error instanceof EvalExecutionError);
    const assessment = error.assessment;
    assert.equal(assessment.coverage, "partial");
    assert.equal(assessment.taskAssertion, undefined);
    assert.equal(assessment.metrics?.stopReason, "error");
    assert.equal(assessment.metrics?.modelRequests, 2);
    assert.equal(assessment.metrics?.modelErrors, 1);
    assert.equal(assessment.metrics?.assistantTurns, 1);
    assert.equal(assessment.metrics?.usageReportedResponses, 1);
    assert.equal(assessment.usage?.totalTokens, undefined);
    assert.equal(assessment.trace?.modelCalls[0].responses[0].usage?.totalTokens, 30);
    assert.match(assessment.trace!.modelCalls[1].error!, /Provider failed/);
    assert.ok(assessment.durationMs! >= assessment.metrics!.modelTimeMs);
    return true;
  });
});

test("cancellation seals a partial tool trace before late results can rewrite it", async () => {
  let now = 0, release!: (result: string) => void;
  const telemetry = new TrialTelemetry(() => now);
  telemetry.beginUserTurn();
  const model = telemetry.beginModel();
  telemetry.response(model, { text: "", usage });
  telemetry.endModel(model);
  const tool = telemetry.requestTool(model, 1, "pending", "web_search", {});
  const pending = telemetry.executeTool(tool, () => new Promise<string>(resolve => { release = resolve; }));
  now = 50;
  const controller = new AbortController();
  controller.abort(new Error("Cancelled tool"));
  const saved = telemetry.finish(controller.signal.reason, controller.signal);
  assert.equal(saved.metrics.stopReason, "aborted");
  assert.equal(saved.metrics.toolErrors, 1);
  assert.equal(saved.metrics.toolTimeMs, 50);
  release('{"success":true}');
  await pending;
  assert.equal(saved.trace.toolCalls[0].status, "error");
  assert.equal(saved.trace.toolCalls[0].result, undefined);
  assert.equal(telemetry.trace.toolCalls[0].status, "error");
});

test("pre-aborted and timed-out trials have explicit stop reasons and do not call the model", async () => {
  for (const [reason, expected] of [[new Error("Cancelled"), "aborted"], [new DOMException("Deadline", "TimeoutError"), "timeout"]] as const) {
    const controller = new AbortController();
    controller.abort(reason);
    await assert.rejects(captureTrial(input(), controller.signal, async () => {
      assert.fail("No execution for an aborted trial");
    }), (error: unknown) => {
      assert.ok(error instanceof EvalExecutionError);
      assert.equal(error.assessment.metrics?.stopReason, expected);
      assert.equal(error.assessment.metrics?.modelRequests, 0);
      assert.equal(error.assessment.metrics?.assistantTurns, 0);
      assert.equal(error.assessment.metrics?.timeToFirstResponseMs, undefined);
      assert.equal(error.assessment.usage?.totalTokens, undefined);
      return true;
    });
  }
  await assert.rejects(captureTrial(input(), new AbortController().signal, async () => { throw undefined; }), (error: unknown) => {
    assert.ok(error instanceof EvalExecutionError);
    assert.equal(error.assessment.metrics?.stopReason, "error");
    return true;
  });
});

test("batch aggregates keep attempts separate, exclude recordings and expose missing measurement coverage", () => {
  const result = aggregateTrialMetrics([
    summary("scheduled-1", { durationMs: 0 }), summary("scheduled-2", { durationMs: 200 }),
    summary("confirmation", { attempt: "confirmation", durationMs: 900, status: "execution_error", judgeUsage: undefined }),
    summary("old", { attempt: "on_demand", metrics: undefined, usage: undefined, durationMs: undefined }),
    summary("new", { attempt: "on_demand", durationMs: 50, status: "grading_error" }),
    summary("real", { mode: "recorded", durationMs: 10000 }),
  ]);
  assert.deepEqual(result.map(item => item.attempt), ["scheduled", "confirmation", "on_demand"]);
  assert.equal(result[0].runCount, 2);
  assert.equal(result[0].assistantTurns, 4);
  assert.equal(result[0].usage.totalTokens, 60);
  assert.equal(result[0].p50DurationMs, 100);
  assert.equal(result[0].p95DurationMs, 200);
  assert.equal(result[1].executionErrors, 1);
  assert.equal(result[1].judgeUsage.totalTokens, undefined);
  assert.equal(result[2].gradingErrors, 1);
  assert.equal(result[2].measuredRuns, 1);
  assert.equal(result[2].assistantTurns, undefined);
  assert.equal(result[2].usage.totalTokens, undefined);
  assert.equal(result[2].latencySamples, 1);
  assert.equal(result[2].p95DurationMs, 50);
  const quantiles = aggregateTrialMetrics(Array.from({ length: 20 }, (_, index) => summary(String(index), { durationMs: index + 1 })))[0];
  assert.equal(quantiles.p50DurationMs, 10.5);
  assert.equal(quantiles.p95DurationMs, 19);
  assert.deepEqual(aggregateTrialMetrics([]), []);
});

test("invalid judge JSON preserves usage and the grading packet omits duplicate diagnostic traces", async t => {
  let requests = 0;
  const assessment: Assessment = {
    ...input(), mode: "simulated", startedAt: "2026-09-17T10:00:00Z", coverage: "complete", finalResponse: "Done",
    metrics: metrics(), trace: { modelCalls: [], toolCalls: [], messages: ["Raw transcript is not a second grading packet"] },
  };
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const request = readModelRequest(url, init);
    requests++;
    const packet: { evidencePacket: Record<string, unknown> } = JSON.parse(messageText(request, "user"));
    assert.equal("metrics" in packet.evidencePacket, false);
    assert.equal("trace" in packet.evidencePacket, false);
    assert.deepEqual(packet.evidencePacket.evidence, assessment.evidence.map(item => ({ ...item, hasImage: false })));
    return Response.json({
      id: "judge-response", created_at: 1, model: "test-model",
      output: [{ type: "message", id: "judge-message", status: "completed", role: "assistant",
        content: [{ type: "output_text", text: "not valid JSON", annotations: [] }] }],
      usage: { input_tokens: 30, output_tokens: 10, input_tokens_details: { cached_tokens: 5 },
        output_tokens_details: { reasoning_tokens: 2 } },
    });
  });
  const judge = await createLlmJudge("test-model");
  await assert.rejects(judge(assessment, [], new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof EvalGradingError);
    assert.deepEqual(error.usage, { inputTokens: 30, outputTokens: 10, totalTokens: 40, cacheReadTokens: 5, reasoningTokens: 2 });
    return true;
  });
  assert.equal(requests, 1);
});

test("recovered completion calls preserve the core loop outcome and SDK rejection evidence", async t => {
  const { createAgentLoop } = await import("../src/agents/core/agentLoop");
  for (const sameResponse of [false, true]) await t.test(sameResponse ? "same response" : "later SDK response", async subtest => {
    let requests = 0;
    const responseCount = sameResponse ? 1 : 2;
    subtest.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      readModelRequest(url, init);
      assert.ok(++requests <= responseCount);
      const recovered = await toolResponse("complete_task", { success: false, message: "Recovered completion" }, "recovered-complete").json();
      if (requests === 1) {
        const invalid = await toolResponse("complete_task", {}, "invalid-complete").json();
        invalid.output[0].arguments = "{";
        if (sameResponse) invalid.output.push(...recovered.output);
        return Response.json(invalid);
      }
      return Response.json(recovered);
    });
    const config = { systemPrompt: "Fixture instructions", tools: [], model: "test-model", maxIterations: 3 };
    const signal = new AbortController().signal;
    const plainLoop = createAgentLoop(config), session = plainLoop.createSession(scenario.request);
    const baseline = await plainLoop.run(session.id, signal);
    plainLoop.deleteSession(session.id);
    assert.equal(baseline.type, "complete");
    assert.equal(requests, responseCount);
    requests = 0;
    const telemetry = new TrialTelemetry();
    const result = await runOfflineAgentLoop({
      ...config, createLoop: createAgentLoop, initialMessage: scenario.request, signal, telemetry,
      record: () => undefined, executeTool: async () => assert.fail("No simulator tool should run"),
    });
    assert.equal(result.finalResponse, baseline.message);
    assert.equal(result.completionSuccess, baseline.success);
    const snapshot = telemetry.finish();
    assert.equal(snapshot.metrics.modelRequests, responseCount);
    assert.equal(snapshot.metrics.assistantTurns, responseCount);
    assert.equal(snapshot.metrics.modelErrors, 0);
    assert.equal(snapshot.metrics.toolCalls, 2);
    assert.equal(snapshot.metrics.toolExecutions, 0);
    assert.equal(snapshot.metrics.rejectedToolCalls, 1);
    assert.equal(snapshot.metrics.stopReason, "completed");
    assert.equal(snapshot.usage.totalTokens, responseCount * 15);
    assert.equal(snapshot.trace.toolCalls[0].modelCallId, "model-1");
    assert.equal(snapshot.trace.toolCalls[0].status, "rejected");
    assert.ok(snapshot.trace.toolCalls[0].error);
  });
});

test("reused completion IDs stay scoped to their external loop request after rejection", async t => {
  const { createAgentLoop } = await import("../src/agents/core/agentLoop");
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    readModelRequest(url, init);
    assert.ok(++requests <= 2);
    return toolResponse("complete_task", { success: true, message: "Complete" }, "reused-complete");
  });
  const telemetry = new TrialTelemetry();
  await runOfflineAgentLoop({
    createLoop: createAgentLoop, systemPrompt: "Fixture instructions", tools: [], model: "test-model",
    maxIterations: 3, initialMessage: scenario.request, signal: new AbortController().signal, telemetry,
    record: () => undefined, executeTool: async () => assert.fail("No simulator tool should run"),
    rejectCompletion: (_result, steps) => steps === 1 ? "Fixture requires a second response" : undefined,
  });
  const snapshot = telemetry.finish();
  assert.equal(requests, 2);
  assert.equal(snapshot.metrics.rejectedToolCalls, 1);
  assert.equal(snapshot.metrics.unexecutedToolCalls, 0);
  assert.equal(snapshot.trace.toolCalls[0].status, "rejected");
  assert.equal(snapshot.trace.toolCalls[1].status, "completed");
  assert.equal(snapshot.trace.toolCalls[1].modelCallId, "model-2");
});

test("runner persists partial execution metrics in lightweight summaries without invoking the judge", () => withStore(async store => {
  let judgeCalls = 0;
  const runner = new EvalRunner(store, async () => { judgeCalls++; throw new Error("Must not grade an execution error"); }, "judge", "1");
  const adapter: AgentAdapter = {
    id: "tv", version: "1", model: "fixture-model", promptVersion: "fixture-prompt", scenarios: [scenario],
    execute: (_scenario, signal) => captureTrial(input(), signal, async telemetry => {
      telemetry.beginUserTurn();
      const call = telemetry.beginModel("fixture-model");
      telemetry.response(call, { text: "Launch", usage });
      telemetry.endModel(call);
      const tool = telemetry.requestTool(call, 1, "launch", "launch_app", {});
      await telemetry.executeTool(tool, () => { throw new Error("Simulator failed"); });
      return { finalResponse: "Must not complete" };
    }),
  };
  const batch = await runner.simulated(adapter, new AbortController().signal);
  const run = (await store.read<EvalRun>("runs", batch.runIds[0]))!;
  const compact = (await store.read<EvalRunSummary>("summaries", run.id))!;
  assert.equal(batch.status, "incomplete");
  assert.equal(judgeCalls, 0);
  assert.equal(run.status, "execution_error");
  assert.equal(run.assessedModel, "fixture-model");
  assert.equal(run.promptVersion, "fixture-prompt");
  assert.equal(run.assessment?.trace?.toolCalls[0].error, "Simulator failed");
  assert.equal(run.assessment?.coverage, "partial");
  assert.equal(run.grade, undefined);
  assert.equal(run.gradingDurationMs, undefined);
  assert.ok(run.durationMs! >= 0);
  assert.ok(run.evaluationDurationMs! >= run.durationMs!);
  assert.deepEqual(compact.metrics, run.assessment?.metrics);
  assert.deepEqual(compact.usage, usage);
  assert.equal("assessment" in compact, false);
  assert.equal("trace" in compact, false);
}));

test("grading errors retain agent metrics and separately preserve reported judge tokens and timing", () => withStore(async store => {
  const judgeUsage = { inputTokens: 300, outputTokens: 100, totalTokens: 400 };
  const judge = makeJudge(async () => ({ output: { invalid: "grade" }, usage: judgeUsage }));
  await assert.rejects(judge({ ...input(), mode: "simulated", startedAt: "", coverage: "complete", finalResponse: "Done" }, [], new AbortController().signal),
    (error: unknown) => error instanceof EvalGradingError && error.usage?.totalTokens === 400);
  const runner = new EvalRunner(store, judge, "judge", "1");
  const adapter: AgentAdapter = {
    id: "tv", version: "1", model: "fixture-model", promptVersion: "fixture-prompt", scenarios: [scenario],
    execute: (_scenario, signal) => captureTrial(input(), signal, async telemetry => {
      telemetry.beginUserTurn();
      const call = telemetry.beginModel();
      telemetry.response(call, { text: "Done", usage });
      telemetry.endModel(call);
      return { finalResponse: "Done" };
    }),
  };
  const batch = await runner.simulated(adapter, new AbortController().signal);
  const run = (await store.read<EvalRun>("runs", batch.runIds[0]))!;
  assert.equal(run.status, "grading_error");
  assert.equal(run.assessment?.metrics?.stopReason, "completed");
  assert.equal(run.assessment?.coverage, "complete");
  assert.equal(run.assessment?.usage?.totalTokens, 30);
  assert.deepEqual(run.judgeUsage, judgeUsage);
  assert.ok(run.gradingDurationMs! >= 0);
  assert.ok(run.evaluationDurationMs! >= run.durationMs! + run.gradingDurationMs!);
  assert.equal(run.grade, undefined);

  const legacyAdapter: AgentAdapter = {
    ...adapter, execute: async () => ({
      ...input(), mode: "simulated", startedAt: "2026-09-17T10:00:00Z", coverage: "complete", finalResponse: "Done",
    }),
  };
  const legacyBatch = await runner.simulated(legacyAdapter, new AbortController().signal);
  const legacyRun = (await store.read<EvalRun>("runs", legacyBatch.runIds[0]))!;
  assert.equal(legacyRun.status, "grading_error");
  assert.equal(legacyRun.durationMs, undefined, "A missing agent duration must not be replaced by failed grading time");
  assert.ok(legacyRun.gradingDurationMs! >= 0);
}));
