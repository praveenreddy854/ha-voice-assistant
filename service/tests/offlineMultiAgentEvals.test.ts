import test from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import { createEvalRouter } from "../src/evals/api";
import { baselineFor, fidelityPairs } from "../src/evals/analytics";
import { recordedHistories, sessionEvaluations } from "../src/evals/history";
import { assessmentFromRecord } from "../src/evals/recorded";
import { calibrateJudge, referenceAssessments } from "../src/evals/references";
import { evalAgentCatalog, getEvalAgent, isEvalAgentId } from "../src/evals/registry";
import { EvalRunner } from "../src/evals/runner";
import { EvalStore } from "../src/evals/store";
import { EvalSupervisor } from "../src/evals/supervisor";
import { parseEvalArguments, type EvalJob } from "../src/evals/worker";
import { EVAL_AGENT_IDS, type Assessment, type EvalAlert, type EvalBatch, type EvalRun, type Grade, type RecordedEvalAttempt, type RecordedSessionsResponse } from "../src/evals/types";
import type { AgentTrace } from "../src/tracing/agentTraceStore";

const context = { task: "request", target: "fixture", app: "none", startingState: "initial" };
const fact = { verdict: "pass" as const, reason: "Fixture evidence", evidenceIds: ["e1"] };
const grade: Grade = {
  task: fact, handling: fact, reporting: fact, recovery: { ...fact, verdict: "not_applicable" },
  context, gaps: [], steps: [{ ...fact, objective: "request_fulfilled", startingState: "initial", alreadySatisfied: false }],
};
function assessment(agentId: string, mode: Assessment["mode"] = "simulated"): Assessment {
  return { agentId, mode, request: "Fixture request", finalResponse: "Done", startedAt: "2026-09-15T12:00:00Z",
    evidence: [{ id: "e1", kind: "final", text: "Fixture outcome" }], coverage: "partial", sourceSessionId: "source" };
}
function run(agentId: string, id = `${agentId}-run`, overrides: Partial<EvalRun> = {}): EvalRun {
  return { id, agentId, batchId: `${agentId}-batch`, mode: "simulated", attempt: "scheduled", scheduledDay: "2026-09-14",
    scenarioId: "same-scenario", scenarioVersion: "1", adapterVersion: "1", graderVersion: "1", judgeModel: "judge",
    assessedAt: "2026-09-14T12:00:00Z", gradedAt: "2026-09-14T13:00:00Z", assessedModel: "model", promptVersion: "prompt",
    durationMs: 1000, status: "completed", assessment: assessment(agentId), grade: structuredClone(grade), ...overrides };
}
function trace(agentType: string, overrides: Partial<AgentTrace> = {}): AgentTrace {
  return { agentType, sessionId: "source", userPrompt: "Fixture request", startedAt: "2026-09-15T12:00:00Z",
    completedAt: "2026-09-15T12:01:00Z", status: "completed", finalMessage: "On it", llmSteps: [], toolResults: [],
    events: [], screenshots: [], ...overrides };
}
async function withStore(work: (store: EvalStore) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "multi-agent-evals-"));
  try { await work(new EvalStore(directory)); } finally { await rm(directory, { recursive: true, force: true }); }
}

test("eval registry enumerates bounded suites without constructing live agents", async () => {
  const catalog = await evalAgentCatalog();
  assert.deepEqual(catalog.map(agent => agent.id), [...EVAL_AGENT_IDS]);
  assert.equal(catalog.find(agent => agent.id === "tv")?.scenarioCount, 12);
  assert.equal(catalog.find(agent => agent.id === "scheduled_task")?.scenarioCount, 12);
  for (const agent of catalog) {
    assert.ok(agent.scenarioCount > 0 && agent.scenarioCount <= 12);
    assert.equal(new Set(agent.scenarios.map(scenario => scenario.id)).size, agent.scenarioCount);
    assert.equal(getEvalAgent(agent.id).id, agent.id);
  }
  assert.equal(getEvalAgent().id, "tv");
  for (const id of ["__proto__", "scheduled-task", "home_assistant", "unknown", ""]) {
    assert.equal(isEvalAgentId(id), false);
    assert.throws(() => getEvalAgent(id), /not registered/);
  }
});

test("CLI explicitly selects each agent and preserves legacy TV defaults", () => {
  assert.equal(parseEvalArguments(["simulated"]).agentId, "tv");
  assert.deepEqual(parseEvalArguments(["simulated", "--agent", "scheduled_task", "--model", "candidate", "announcement-at-time"]), {
    mode: "simulated", agentId: "scheduled_task", model: "candidate", scenarioIds: ["announcement-at-time"], sessionIds: undefined,
  });
  assert.equal(parseEvalArguments(["calibrate", "--agent", "realtime"]).agentId, "realtime");
  assert.deepEqual(parseEvalArguments(["recorded", "source", "--agent", "realtime"]).sessionIds, ["source"]);
  for (const args of [
    ["simulated", "--agent"], ["simulated", "--agent", "unknown"], ["simulated", "--all"],
    ["recorded", "--agent", "scheduled_task"], ["recorded", "one", "one"], ["recorded", "../secret"],
    ["calibrate", "scenario"], ["recorded", "source", "--model", "wrong"], ["simulated", "--model", "bad/model"],
    ["simulated", "--agent", "tv", "--agent", "realtime"],
  ]) assert.throws(() => parseEvalArguments(args), undefined, args.join(" "));
});

test("recorded import accepts terminal nonvisual agents and preserves incomplete evidence honestly", () => {
  for (const id of ["scheduled_task", "realtime"]) {
    const result = assessmentFromRecord(trace(id), undefined, id);
    assert.equal(result.agentId, id);
    assert.equal(result.mode, "recorded");
    assert.equal(result.coverage, "partial");
    assert.equal(result.taskAssertion, undefined);
    assert.equal(result.evidence.some(evidence => evidence.kind === "image"), false);
    assert.ok(result.expectations?.length);
    assert.throws(() => assessmentFromRecord(trace(id), undefined, "tv"), /belongs to/);
    assert.throws(() => assessmentFromRecord(trace(id, { completedAt: undefined })), /terminal/);
    assert.throws(() => assessmentFromRecord(trace(id, { status: "running" })), /completed/);
  }
  assert.throws(() => assessmentFromRecord(trace("unknown")), /not registered/);
});

test("retained system and lifecycle context remains available to non-TV grading", () => {
  const input = trace("realtime", {
    llmSteps: [{ stepNumber: 1, timestamp: "2026-09-15T12:00:01Z", finishReason: "stop", requestModel: "realtime-model",
      text: "On it", toolCalls: [], systemMessages: ["Paused active run: original-tv-job"], messages: [{ role: "user", content: "Continue" }] }],
    events: [{ type: "realtime.context", timestamp: "2026-09-15T12:00:00Z", message: "User-confirmed context", data: { confirmed: false } }],
  });
  const result = assessmentFromRecord(input);
  assert.ok(result.evidence.some(item => item.text.includes("Paused active run: original-tv-job")));
  assert.ok(result.evidence.some(item => item.text.includes("User-confirmed context")));
  assert.equal(result.model, "realtime-model");
  assert.match(result.promptVersion!, /^retained-system-/);
});

test("runner never grades an assessment under another agent, mode or selected source", () => withStore(async store => {
  let calls = 0;
  const runner = new EvalRunner(store, async () => { calls++; return { grade: structuredClone(grade) }; }, "judge", "1");
  for (const input of [
    assessment("tv", "recorded"), assessment("scheduled_task", "simulated"),
    { ...assessment("scheduled_task", "recorded"), sourceSessionId: "different" },
  ]) {
    const batch = await runner.recorded("scheduled_task", [{ sessionId: "source", load: async () => input }], new AbortController().signal);
    assert.equal(batch.status, "incomplete");
    const result = await store.read<EvalRun>("runs", batch.runIds[0]);
    assert.equal(result?.agentId, "scheduled_task");
    assert.equal(result?.status, "execution_error");
    assert.equal(result?.assessment, undefined);
  }
  assert.equal(calls, 0);
}));

test("scheduled batches run every agent once, sequentially, without a persistent queue", () => withStore(async store => {
  const launches: EvalJob[] = [], children: ChildProcess[] = [];
  const supervisor = new EvalSupervisor(store, job => {
    launches.push(job);
    const child = new ChildProcess(); children.push(child); return child;
  });
  const now = new Date("2026-09-15T12:00:00Z");
  await supervisor.tick(new Date("2026-09-15T06:59:00Z"));
  assert.equal(launches.length, 0);
  for (const [index, agentId] of EVAL_AGENT_IDS.entries()) {
    await supervisor.tick(now);
    assert.equal(launches.length, index + 1);
    assert.equal(launches[index].agentId, agentId);
    await supervisor.tick(now);
    assert.equal(launches.length, index + 1);
    await store.write("jobs", { ...launches[index], status: index === 0 ? "failed" : "completed" });
    children[index].emit("exit", 0);
    assert.equal(await supervisor.busy(), false);
  }
  await supervisor.tick(now);
  assert.equal(launches.length, 3);
  assert.ok(launches.every(job => job.scheduledDay === "2026-09-15"));
}));

test("legacy TV scheduled history does not suppress scheduled-task or realtime batches", () => withStore(async store => {
  await store.write("jobs", { id: "legacy-tv", mode: "simulated", scheduledDay: "2026-09-15", status: "failed" });
  let launched: EvalJob | undefined;
  const supervisor = new EvalSupervisor(store, job => { launched = job; return new ChildProcess(); });
  await supervisor.tick(new Date("2026-09-15T12:00:00Z"));
  assert.equal(launched?.agentId, "scheduled_task");
}));

test("scenario selection and recorded idempotency are scoped to the chosen agent", () => withStore(async store => {
  const supervisor = new EvalSupervisor(store, () => new ChildProcess());
  await assert.rejects(supervisor.launch({ mode: "simulated", agentId: "scheduled_task", scenarioIds: ["telugu-fresh-search"] }), /selection/);
  await assert.rejects(supervisor.launch({ mode: "simulated", agentId: "unknown" }), /not registered/);
  assert.equal((await store.list("jobs")).length, 0);
  const requestId = randomUUID();
  const job = await supervisor.launch({ mode: "recorded", agentId: "scheduled_task", sessionIds: ["source"], requestId });
  assert.equal((await supervisor.launch({ mode: "recorded", agentId: "scheduled_task", sessionIds: ["source"], requestId })).id, job.id);
  await assert.rejects(supervisor.launch({ mode: "recorded", agentId: "realtime", sessionIds: ["source"], requestId }), /different selection/);
  const attempts = await store.list<RecordedEvalAttempt>("attempts");
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].agentId, "scheduled_task");
}));

test("failed jobs and completed recorded histories retain each agent's identity", () => withStore(async store => {
  for (const agentId of ["scheduled_task", "realtime"]) {
    const job: EvalJob = { id: `${agentId}-job`, agentId, mode: "recorded", sessionIds: [`${agentId}-source`], status: "queued" };
    await store.write("jobs", job);
    await store.failJob(job, "Import unavailable");
  }
  const alerts = await store.list<EvalAlert>("alerts");
  assert.deepEqual(new Set(alerts.map(alert => alert.key)), new Set(["scheduled_task:worker-failure", "realtime:worker-failure"]));
  const statuses = sessionEvaluations(await recordedHistories(store));
  assert.equal(statuses["realtime-source"].latestAttempt?.agentId, "realtime");
  assert.equal(statuses["scheduled_task-source"].status, "eval_error");
}));

test("baseline, fidelity and semantic step groups never pool different agents", () => withStore(async store => {
  const tv = run("tv");
  const scheduled = run("scheduled_task", "scheduled", { scheduledDay: "2026-09-15" });
  assert.equal(baselineFor(scheduled, ["2026-09-12", "2026-09-13", "2026-09-14"].map(day => ({ ...tv, id: day, scheduledDay: day }))).baselineCount, 0);
  const recorded = run("realtime", "real", { mode: "recorded" });
  assert.deepEqual(fidelityPairs([tv, recorded])[0].recordedIds, []);
  await store.saveRun(tv); await store.saveRun(scheduled);
  assert.notEqual(tv.grade?.steps[0].groupId, scheduled.grade?.steps[0].groupId);
}));

test("judge calibration runs only the selected agent's reference set and persists separate reports", () => withStore(async store => {
  const all = referenceAssessments();
  assert.equal(all.length, 18);
  assert.equal(new Set(all.map(reference => reference.id)).size, 18);
  for (const agentId of EVAL_AGENT_IDS) {
    const seen: string[] = [];
    const report = await calibrateJudge(store, async input => {
      seen.push(input.agentId);
      const reference = all.find(example => example.assessment.evidence[0].id === input.evidence[0].id)!;
      const item = (verdict: typeof reference.expected[number]) => ({ verdict, reason: "Reference fixture", evidenceIds: [input.evidence[0].id] });
      return { grade: { ...structuredClone(grade), task: item(reference.expected[0]), handling: item(reference.expected[1]), reporting: item(reference.expected[2]) } };
    }, "judge", "1", new AbortController().signal, agentId);
    assert.equal(report.agentId, agentId);
    assert.equal(report.results.length, 6);
    assert.equal(report.passed, true);
    assert.ok(seen.every(id => id === agentId));
  }
  assert.equal((await store.list("calibrations")).length, 3);
}));

test("API scopes runs, alerts, jobs, calibrations and discovery, and rejects unknown agents", () => withStore(async store => {
  const supervisor = new EvalSupervisor(store, () => new ChildProcess());
  for (const agentId of EVAL_AGENT_IDS) {
    await store.saveRun(run(agentId));
    await store.write<EvalBatch>("batches", { id: `${agentId}-batch`, agentId, mode: "simulated", attempt: "scheduled",
      startedAt: "2026-09-14T12:00:00Z", status: "completed", runIds: [`${agentId}-run`] });
    await store.write("alerts", { id: `${agentId}-alert`, key: `${agentId}:incomplete`, message: agentId });
    await store.write("jobs", { id: `${agentId}-job`, agentId, status: "completed", mode: "simulated" });
    await store.write("calibrations", { id: `${agentId}-calibration`, agentId, results: [] });
  }
  await store.write("calibrations", { id: "legacy-calibration", results: [] });
  const discoveries: Array<string | undefined> = [];
  const app = express();
  app.use(express.json());
  app.use(createEvalRouter(supervisor, async (_dependencies, agentId) => {
    discoveries.push(agentId);
    return { warnings: [], sessions: EVAL_AGENT_IDS.map(id => ({
      sessionId: `${id}-source`, agentId: id, userPrompt: id, startedAt: "2026-09-14T12:00:00Z",
      status: "completed" as const, sources: ["telemetry" as const],
    })) };
  }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const agentId of EVAL_AGENT_IDS) {
      const response = await fetch(`${base}/api/evals?agentId=${agentId}`);
      assert.equal(response.status, 200);
      const data = await response.json() as Record<string, Array<{ agentId?: string; id: string }>>;
      assert.equal(data.runs.length, 1);
      assert.equal(data.runs[0].agentId, agentId);
      for (const key of ["batches", "alerts", "jobs"]) assert.equal(data[key].length, 1);
      assert.ok(data.groups.every(group => group.agentId === agentId));
      assert.equal(data.calibrations.length, agentId === "tv" ? 2 : 1);
      const sessions = await (await fetch(`${base}/api/evals/sessions?agentId=${agentId}`)).json() as RecordedSessionsResponse;
      assert.deepEqual(sessions.sessions.map(session => session.agentId), [agentId]);
      await fetch(`${base}/api/evals/sessions?agentId=${agentId}`);
    }
    assert.deepEqual(discoveries, [...EVAL_AGENT_IDS]);
    await fetch(`${base}/api/evals/sessions?agentId=realtime&refresh=true`);
    assert.equal(discoveries.length, 4);
    const statuses = await (await fetch(`${base}/api/evals/session-statuses`)).json() as { agents: string[] };
    assert.deepEqual(statuses.agents, [...EVAL_AGENT_IDS]);
    assert.equal((await fetch(`${base}/api/evals?agentId=unknown`)).status, 400);
    assert.equal((await fetch(`${base}/api/evals/sessions?agentId=unknown`)).status, 400);
    assert.equal((await fetch(`${base}/api/evals/jobs`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "simulated", agentId: "unknown" }) })).status, 400);
    const accepted = await fetch(`${base}/api/evals/jobs`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "recorded", agentId: "realtime", sessionIds: ["realtime-source"] }) });
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json() as EvalJob).agentId, "realtime");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}));
