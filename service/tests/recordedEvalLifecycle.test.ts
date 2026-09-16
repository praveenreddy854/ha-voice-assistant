import test from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import type { AddressInfo } from "node:net";
import { EvalStore } from "../src/evals/store";
import { EvalRunner } from "../src/evals/runner";
import { EvalSupervisor } from "../src/evals/supervisor";
import { recordedHistories, sessionEvaluations } from "../src/evals/history";
import { createEvalRouter } from "../src/evals/api";
import type { EvalJob } from "../src/evals/worker";
import type { Assessment, EvalRun, Grade, RecordedEvalAttempt, RecordedSessionsResponse } from "../src/evals/types";

const judgment = { verdict: "unknown" as const, reason: "Insufficient retained evidence", evidenceIds: ["e1"] };
const grade: Grade = { task: judgment, handling: judgment, reporting: judgment, recovery: judgment, steps: [],
  gaps: ["No verification"], context: { task: "open", app: "YouTube", target: "TV", startingState: "unknown" } };
const assessment = (id: string): Assessment => ({
  agentId: "tv", mode: "recorded", sourceSessionId: id, request: "Open YouTube", finalResponse: "Done",
  startedAt: "2026-09-12T12:00:00Z", coverage: "partial", evidence: [{ id: "e1", kind: "final", text: "Done" }],
});
async function withStore(work: (store: EvalStore) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "recorded-eval-lifecycle-"));
  try { await work(new EvalStore(directory)); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function job(store: EvalStore, sessionIds: string[], createdAt = new Date().toISOString()): Promise<EvalJob> {
  const job: EvalJob = { id: randomUUID(), mode: "recorded", sessionIds, status: "queued", createdAt };
  await store.write("jobs", job);
  await store.queueRecordedAttempts(job);
  return job;
}

test("recorded attempts progress individually and retain source IDs when import fails", () => withStore(async store => {
  const batchJob = await job(store, ["missing", "good"]);
  let calls = 0;
  const runner = new EvalRunner(store, async input => {
    calls++;
    const attempts = await store.list<RecordedEvalAttempt>("attempts");
    assert.equal(attempts.filter(attempt => attempt.status === "running").length, 1);
    assert.equal(attempts.find(attempt => attempt.sourceSessionId === "missing")?.status, "eval_error");
    assert.equal(input.sourceSessionId, "good");
    return { grade };
  }, "judge", "grader");
  const batch = await runner.recorded("tv", [
    { sessionId: "missing", load: async () => { throw new Error("Retained evidence disappeared"); } },
    { sessionId: "good", load: async () => assessment("good") },
  ], new AbortController().signal, { jobId: batchJob.id });
  assert.equal(calls, 1);
  assert.equal(batch.status, "incomplete");
  const statuses = sessionEvaluations(await recordedHistories(store));
  assert.equal(statuses.missing.status, "eval_error");
  assert.equal(statuses.good.status, "evaluated");
  assert.equal(statuses.good.latestCompleted?.grade?.task.verdict, "unknown");
  const failed = await store.read<EvalRun>("runs", statuses.missing.latestAttempt!.runId!);
  assert.equal(failed?.sourceSessionId, "missing");
  assert.equal(failed?.assessment, undefined);
}));

test("latest failed re-evaluation preserves earlier completed verdict and evidence", () => withStore(async store => {
  const first = await job(store, ["session"], "2026-09-12T12:00:00Z");
  const runner = new EvalRunner(store, async () => ({ grade }), "judge", "grader");
  await runner.recorded("tv", [{ sessionId: "session", load: async () => assessment("session") }],
    new AbortController().signal, { jobId: first.id });
  const second = await job(store, ["session"], "2026-09-13T12:00:00Z");
  const failing = new EvalRunner(store, async () => { throw new Error("Judge unavailable"); }, "new-judge", "new-grader");
  await failing.recorded("tv", [{ sessionId: "session", load: async () => ({ ...assessment("session"), finalResponse: "Newly retained response" }) }],
    new AbortController().signal, { jobId: second.id });
  const histories = await recordedHistories(store);
  const status = sessionEvaluations(histories).session;
  assert.equal(status.status, "eval_error");
  assert.equal(status.attemptCount, 2);
  assert.equal(status.latestCompleted?.judgeModel, "judge");
  assert.equal(histories.get("session")?.attempts[0].error, "Judge unavailable");
  const original = await store.read<EvalRun>("runs", status.latestCompleted!.id);
  assert.equal(original?.assessment?.finalResponse, "Done");
}));

test("interruption recovers completed runs and marks unstarted sessions explicitly without retry", () => withStore(async store => {
  const batchJob = await job(store, ["completed", "running", "queued"]);
  const attempts = await store.list<RecordedEvalAttempt>("attempts");
  const completed = attempts.find(attempt => attempt.sourceSessionId === "completed")!;
  const run: EvalRun = { id: "saved-run", batchId: "interrupted-batch", agentId: "tv", mode: "recorded",
    attempt: "on_demand", adapterVersion: "1", graderVersion: "1", judgeModel: "judge", assessedAt: "2026-09-12T12:00:00Z",
    gradedAt: "2026-09-12T13:00:00Z", status: "completed", sourceSessionId: "completed", grade, assessment: assessment("completed") };
  await store.write("runs", run);
  await store.write("attempts", { ...completed, status: "running", startedAt: "2026-09-12T12:30:00Z", runId: run.id });
  await store.write("attempts", { ...attempts.find(attempt => attempt.sourceSessionId === "running")!, status: "running", startedAt: "2026-09-12T12:30:00Z" });
  await store.recoverInterruptedJobs();
  const statuses = sessionEvaluations(await recordedHistories(store));
  assert.equal(statuses.completed.status, "evaluated");
  assert.equal(statuses.completed.latestCompleted?.id, run.id);
  assert.equal(statuses.running.status, "eval_error");
  assert.doesNotMatch(statuses.running.latestAttempt!.error!, /never started/);
  assert.match(statuses.queued.latestAttempt!.error!, /never started/);
  assert.equal((await store.read<EvalJob>("jobs", batchJob.id))?.status, "failed");
  assert.equal((await store.list("runs")).length, 1);
}));

test("an aborted batch marks every queued remainder as interrupted", () => withStore(async store => {
  const batchJob = await job(store, ["first", "second", "third"]);
  const controller = new AbortController();
  const runner = new EvalRunner(store, async () => {
    controller.abort(new Error("Stopped"));
    return { grade };
  }, "judge", "grader");
  const batch = await runner.recorded("tv", batchJob.sessionIds!.map(sessionId => ({ sessionId, load: async () => assessment(sessionId) })),
    controller.signal, { jobId: batchJob.id });
  const statuses = sessionEvaluations(await recordedHistories(store));
  assert.equal(batch.status, "incomplete");
  assert.equal(statuses.first.status, "evaluated");
  assert.equal(statuses.second.status, "eval_error");
  assert.equal(statuses.third.status, "eval_error");
}));

test("legacy summaries and failed jobs contribute history without duplicate attempts", () => withStore(async store => {
  const run: EvalRun = { id: "legacy", batchId: "batch", agentId: "tv", mode: "recorded", attempt: "on_demand",
    adapterVersion: "1", graderVersion: "1", judgeModel: "judge", assessedAt: "2026-09-12T12:00:00Z",
    gradedAt: "2026-09-12T13:00:00Z", status: "completed", grade, assessment: assessment("old-session") };
  await store.saveRun(run);
  await store.write("jobs", { id: "old-job", mode: "recorded", sessionIds: ["old-session", "never-started"], status: "failed", batchId: "batch" });
  await store.write("batches", { id: "batch", startedAt: "2026-09-12T12:00:00Z", runIds: ["legacy"], status: "incomplete" });
  const statuses = sessionEvaluations(await recordedHistories(store));
  assert.equal(statuses["old-session"].attemptCount, 1);
  assert.equal(statuses["old-session"].status, "evaluated");
  assert.equal(statuses["never-started"].status, "eval_error");
}));

test("recovering a legacy interrupted job preserves its completed batch members", () => withStore(async store => {
  const run: EvalRun = { id: "legacy-completed", batchId: "old-batch", agentId: "tv", mode: "recorded", attempt: "on_demand",
    adapterVersion: "1", graderVersion: "1", judgeModel: "judge", assessedAt: "2026-09-12T12:00:00Z",
    gradedAt: "2026-09-12T13:00:00Z", status: "completed", grade, assessment: assessment("old-session") };
  await store.saveRun(run);
  await store.write("jobs", { id: "old-job", mode: "recorded", sessionIds: ["old-session", "unstarted"], status: "running", batchId: "old-batch" });
  await store.write("batches", { id: "old-batch", startedAt: "2026-09-12T12:00:00Z", runIds: [run.id], status: "running" });
  await store.recoverInterruptedJobs();
  const statuses = sessionEvaluations(await recordedHistories(store));
  assert.equal(statuses["old-session"].status, "evaluated");
  assert.equal(statuses["old-session"].attemptCount, 1);
  assert.equal(statuses.unstarted.status, "eval_error");
}));

test("submission is idempotent, queues every selected session, and rejects concurrent batches", () => withStore(async store => {
  let spawns = 0;
  const child = new ChildProcess();
  const supervisor = new EvalSupervisor(store, () => { spawns++; return child; });
  const input = { mode: "recorded" as const, sessionIds: ["one", "two"], requestId: randomUUID() };
  const first = await supervisor.launch(input);
  assert.equal((await store.list<RecordedEvalAttempt>("attempts")).filter(attempt => attempt.status === "queued").length, 2);
  const duplicate = await supervisor.launch(input);
  assert.equal(duplicate.id, first.id);
  assert.equal(spawns, 1);
  await assert.rejects(supervisor.launch({ ...input, requestId: randomUUID() }), /already running/);
  await assert.rejects(supervisor.launch({ ...input, sessionIds: ["other"] }), /different selection/);
  await store.write("jobs", { ...first, status: "completed" });
  child.emit("exit", 0);
  assert.equal((await supervisor.launch(input)).id, first.id);
  assert.equal(spawns, 1);
}));

test("startup failure is visible for every selected session, and live workers are not recovered", () => withStore(async store => {
  const supervisor = new EvalSupervisor(store, () => { throw new Error("Unable to fork"); });
  await assert.rejects(supervisor.launch({ mode: "recorded", sessionIds: ["one", "two"] }), /Unable to fork/);
  let statuses = sessionEvaluations(await recordedHistories(store));
  assert.equal(statuses.one.status, "eval_error");
  assert.equal(statuses.two.status, "eval_error");
  const running = await job(store, ["active"]);
  await store.write("jobs", { ...running, workerPid: process.pid, status: "running" });
  await store.recoverInterruptedJobs();
  statuses = sessionEvaluations(await recordedHistories(store));
  assert.equal(statuses.active.status, "queued");
  assert.equal(await supervisor.busy(), true);
}));

test("a worker exiting without a saved terminal job does not leave sessions queued", () => withStore(async store => {
  const child = new ChildProcess();
  const supervisor = new EvalSupervisor(store, () => child);
  const accepted = await supervisor.launch({ mode: "recorded", sessionIds: ["one"] });
  child.emit("exit", 0);
  assert.equal(await supervisor.busy(), false);
  assert.equal((await store.read<EvalJob>("jobs", accepted.id))?.status, "failed");
  assert.equal(sessionEvaluations(await recordedHistories(store)).one.status, "eval_error");
}));

test("sessions API combines discovery and eval history, and never hides storage errors", () => withStore(async store => {
  const supervisor = new EvalSupervisor(store, () => { throw new Error("No worker expected"); });
  const app = express();
  app.use(express.json());
  app.use(createEvalRouter(supervisor, async () => ({
    sessions: [{ sessionId: "one", agentId: "tv", userPrompt: "Open YouTube", startedAt: "2026-09-12T12:00:00Z",
      status: "error", sources: ["telemetry"] }],
    warnings: ["Session list incomplete: Cosmos unavailable"],
  })));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/api/evals/sessions`);
    const body = await response.json() as RecordedSessionsResponse;
    assert.equal(response.status, 200);
    assert.equal(body.sessions[0].evaluation.status, "not_evaluated");
    assert.equal(body.warnings.length, 1);
    assert.equal(body.busy, false);
    assert.equal((await fetch(`${base}/api/evals/sessions/one/history`)).status, 200);
    for (const sessionIds of [[], ["one", "one"], Array.from({ length: 101 }, (_, index) => `session-${index}`)]) {
      const invalid = await fetch(`${base}/api/evals/jobs`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "recorded", sessionIds }) });
      assert.equal(invalid.status, 400);
    }
    const rejectedOrigin = await fetch(`${base}/api/evals/jobs`, { method: "POST",
      headers: { "content-type": "application/json", origin: "invalid" }, body: JSON.stringify({ mode: "recorded", sessionIds: ["one"] }) });
    assert.equal(rejectedOrigin.status, 403);
    await job(store, ["one"]);
    await writeFile(path.join(store.directory, "attempts", "corrupt.json"), "{");
    assert.equal((await fetch(`${base}/api/evals/session-statuses`)).status, 503);
    assert.equal((await fetch(`${base}/api/evals/sessions`)).status, 503);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}));
