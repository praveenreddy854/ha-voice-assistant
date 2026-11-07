import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { EvalStore } from "../src/evals/store";
import { onlineEvalConfig } from "../src/evals/online/config";
import { OnlineEvalEngine, onlineRecordId, isSampled, type OnlineRecord, type OnlineSnapshot, type OnlineResult } from "../src/evals/online/engine";
import { onlineAssessment } from "../src/evals/online/snapshot";
import { evaluateOnline } from "../src/evals/online/quality";
import { onlineSummary, createOnlineRouter } from "../src/evals/online/api";
import { OnlineEvalSupervisor } from "../src/evals/online/supervisor";
import type { AgentTrace } from "../src/tracing/agentTraceStore";
import type { Assessment, Grade, Judge, Verdict } from "../src/evals/types";
import { calibrationReferenceAssessments } from "../src/evals/references";
import express from "express";

const now = () => new Date("2026-11-07T01:00:00Z");
function trace(id = "session", options: Partial<AgentTrace> = {}): AgentTrace {
  return {
    sessionId: id, agentType: "realtime", userPrompt: "Turn off Samsung TV", startedAt: "2026-11-07T00:59:00Z",
    completedAt: "2026-11-07T00:59:50Z", status: "completed", finalMessage: "On it.",
    events: [], toolResults: [{ toolCallId: "call", toolName: "execute_home_assistant_command", durationMs: 20, observation: "Job accepted", args: { command: "Turn off Samsung TV" } }],
    llmSteps: [], screenshots: [], ...options,
  };
}
function grade(assessment: Assessment, task: Verdict = "pass"): Grade {
  const fact = (verdict: Verdict) => ({ verdict, reason: "Grounded in retained tool evidence", evidenceIds: [assessment.evidence[0].id] });
  return { task: fact(task), handling: fact("pass"), reporting: fact("pass"), recovery: fact("not_applicable"),
    steps: [], gaps: [], context: { task: "routing", target: "Samsung TV", app: "unknown", startingState: "unknown" } };
}
const good: Judge = async assessment => ({ grade: grade(assessment), usage: { totalTokens: 10 } });
async function fixture(fn: (store: EvalStore, engine: OnlineEvalEngine) => Promise<void>, options: { judge?: Judge; config?: Partial<ReturnType<typeof onlineEvalConfig>> } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "online-evals-"));
  const config = { ...onlineEvalConfig(), directory, ...options.config };
  const store = new EvalStore(directory);
  const engine = new OnlineEvalEngine(store, config, async () => ({ primary: options.judge || good, reviewer: good, judgeModel: "primary", reviewerModel: "reviewer" }), now);
  try { await fn(store, engine); } finally { await rm(directory, { recursive: true, force: true }); }
}
const cutoff = "2026-11-07T00:00:00Z";

test("online enrollment survives restart; discovery excludes history, incomplete runs and unsupported agents", async () => fixture(async (store, engine) => {
  assert.equal((await engine.enroll()).enabledAt, now().toISOString());
  await engine.discover([trace("old", { startedAt: "2026-10-01T00:00:00Z" }), trace("running", { status: "running" }),
    trace("no-terminal", { completedAt: undefined }), trace("unsupported", { agentType: "unknown" }), trace("new"), trace("ha", { agentType: "home_assistant" })], cutoff);
  assert.equal((await store.list("records")).length, 2);
  await engine.discover([trace("new"), trace("ha", { agentType: "home_assistant" })], cutoff);
  await engine.discover([trace("new", { startedAt: "2026-11-07T00:58:59Z" })], cutoff);
  assert.equal((await store.list("records")).length, 2);
  assert.equal((await engine.enroll()).enabledAt, now().toISOString());
}));

test("capture is separate from grading; one in-flight call and oldest-first durable queue", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  const calls: string[] = [];
  await fixture(async (store, engine) => {
    await engine.discover([trace("newer"), trace("older", { startedAt: "2026-11-07T00:55:00Z" })], cutoff);
    assert.deepEqual(calls, []);
    const run = engine.runNext(new AbortController().signal);
    await started;
    assert.equal(await engine.runNext(new AbortController().signal), false);
    assert.deepEqual(calls, ["older"]);
    release(); await run;
    const record = await store.read<OnlineRecord>("records", onlineRecordId(trace("older", { startedAt: "2026-11-07T00:55:00Z" })));
    assert.equal(record?.status, "completed"); assert.equal(record?.judgeUsage?.totalTokens, 20);
    assert.equal(record?.judgeModel, "primary"); assert.equal(record?.reviewerModel, "reviewer");
  }, { judge: async assessment => { calls.push(assessment.sourceSessionId!); entered(); await gate; return good(assessment, [], new AbortController().signal); } });
});

test("independent disagreement stays unknown, both judgments and evidence are retained", async () => {
  const assessment = onlineAssessment(trace());
  assert.equal(assessment.evaluationScope, "routing");
  const result = await evaluateOnline(assessment, good, async input => ({ grade: grade(input, "fail") }), new AbortController().signal);
  assert.equal(result.verdicts.task, "unknown"); assert.equal(result.verdicts.reporting, "pass");
  assert.equal(result.reviewRequired, true); assert.equal(result.score, null);
  assert.equal(result.primary.task.verdict, "pass"); assert.equal(result.reviewer.task.verdict, "fail");
  assert.deepEqual(result.disagreements, ["task"]);
});

test("a fabricated citation fails evaluation rather than producing a pass", async () => {
  await assert.rejects(evaluateOnline(onlineAssessment(trace()), async input => {
    const output = grade(input); output.task.evidenceIds = ["fabricated"];
    return { grade: output };
  }, good, new AbortController().signal), /nonexistent evidence/);
});

test("shared conversation evidence preserves every distinct message and image without quadratic snapshots", () => {
  const messages = [{ role: "user", content: "Use Samsung TV, not the active Apple TV" }, { role: "user", content: [{ type: "image", image: "aW1hZ2U=", mediaType: "image/png" }] }];
  const assessment = onlineAssessment(trace("history", { llmSteps: [1, 2].map(stepNumber => ({
    stepNumber, timestamp: now().toISOString(), finishReason: "tool-calls", text: "", toolCalls: [], messages,
  })) }));
  assert.equal(assessment.evidence.filter(item => item.source === "deduplicated_conversation_snapshot").length, 2);
  assert.equal(assessment.evidence.filter(item => item.id.startsWith("image-")).length, 1);
  assert.ok(assessment.evidence.some(item => item.text.includes("Use Samsung TV, not the active Apple TV")));
  assert.ok(assessment.evidence.filter(item => item.source?.includes(":llm:")).every(item => item.text.includes("messageEvidenceIds")));
});

test("corrupt snapshot fails closed before any judge call", async () => {
  let calls = 0;
  await fixture(async (store, engine) => {
    await engine.discover([trace()], cutoff);
    const id = onlineRecordId(trace());
    const snapshot = (await store.read<OnlineSnapshot>("snapshots", id))!;
    snapshot.assessment.finalResponse = "tampered"; await store.write("snapshots", snapshot);
    await engine.runNext(new AbortController().signal);
    assert.equal(calls, 0); assert.equal((await store.read<OnlineRecord>("records", id))?.status, "eval_error");
  }, { judge: async (...args) => { calls++; return good(...args); } });
});

test("timeouts are terminal evaluation errors, not assistant failures or automatic paid retries", async () => fixture(async (store, engine) => {
  await engine.discover([trace()], cutoff);
  // Keep the event loop alive to exercise AbortSignal.timeout against a noncooperative provider.
  const keepAlive = setInterval(() => {}, 100);
  try { await engine.runNext(new AbortController().signal); } finally { clearInterval(keepAlive); }
  assert.equal((await store.read<OnlineRecord>("records", onlineRecordId(trace())))?.status, "eval_error");
  await engine.discover([trace()], cutoff);
  assert.equal(await engine.runNext(new AbortController().signal), false);
}, { judge: async () => new Promise(() => {}), config: { timeoutMs: 15 } }));

test("restart recovers published results and marks interrupted paid attempts as errors", async () => fixture(async (store, engine) => {
  await engine.discover([trace("saved"), trace("interrupted")], cutoff);
  await engine.runNext(new AbortController().signal);
  const records = await store.list<OnlineRecord>("records");
  const completed = records.find(record => record.status === "completed")!;
  assert.ok(await store.read<OnlineResult>("results", completed.id));
  for (const record of records) await store.write("records", { ...record, status: "running" });
  await engine.recover();
  const recovered = await store.list<OnlineRecord>("records");
  assert.equal(recovered.find(record => record.id === completed.id)?.status, "completed");
  assert.equal(recovered.find(record => record.id !== completed.id)?.status, "eval_error");
}));

test("queue overflow, sampling and oversized evidence are explicit coverage gaps", async () => {
  assert.equal(isSampled("stable", 0), false); assert.equal(isSampled("stable", 1), true);
  assert.equal(isSampled("stable", .5), isSampled("stable", .5));
  await fixture(async (store, engine) => {
    await engine.discover([trace("a"), trace("b")], cutoff);
    const records = await store.list<OnlineRecord>("records");
    assert.equal(records.filter(record => record.status === "queued").length, 1);
    assert.equal(records.filter(record => record.status === "skipped").length, 1);
  }, { config: { maxPending: 1 } });
  await fixture(async (store, engine) => {
    await engine.discover([trace()], cutoff);
    assert.equal((await store.list<OnlineRecord>("records"))[0].status, "eval_error");
    assert.equal(await engine.runNext(new AbortController().signal), false);
  }, { config: { maxTextBytes: 1 } });
});

test("API retries preserve the previous attempt and are idempotent; summaries exclude eval errors from task outcomes", async () => fixture(async (store, engine) => {
  await engine.discover([trace()], cutoff); await engine.runNext(new AbortController().signal);
  const supervisor = new OnlineEvalSupervisor(engine.config);
  const app = express(); app.use(express.json()); app.use(createOnlineRouter(supervisor, store));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/api/evals/online`), body = await response.json() as any;
    assert.equal(body.summary.completed, 1); assert.ok(!("assessment" in body.records[0]));
    const requestId = "f02b1942-aebb-4d47-93cb-a900774b7732";
    for (let i = 0; i < 2; i++) {
      const retry = await fetch(`${base}/api/evals/online/${body.records[0].id}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId }) });
      assert.equal(retry.status, 202);
    }
    assert.equal((await store.list("records")).length, 2);
    assert.equal((await store.read<OnlineRecord>("records", body.records[0].id))?.status, "completed");
    assert.equal((await fetch(`${base}/api/evals/online?agentId=bad`)).status, 400);
    assert.equal((await fetch(`${base}/api/evals/online/missing`)).status, 404);
    const summary = onlineSummary([{ ...body.records[0], status: "eval_error", verdicts: undefined }]);
    assert.equal(summary.completed, 0); assert.equal(summary.states.eval_error, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}));

test("calibration includes paired guard-preference examples, wrong-device routing and timed-phase failures", () => {
  const realtime = calibrationReferenceAssessments("realtime"), scheduling = calibrationReferenceAssessments("scheduled_task");
  assert.equal(realtime.find(reference => reference.id === "LOG-R2")?.expected[0], "pass");
  assert.equal(realtime.find(reference => reference.id === "LOG-R3")?.expected[0], "fail");
  assert.equal(realtime.find(reference => reference.id === "LOG-R1")?.expected[0], "fail");
  assert.equal(scheduling.find(reference => reference.id === "LOG-S1")?.expected[0], "fail");
  assert.equal(scheduling.find(reference => reference.id === "LOG-S2")?.expected[0], "fail");
});
