import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureTestProviders, messageText, readModelRequest } from "./helpers/agentFixtures";
import { localDay, shiftDay } from "../src/evals/analytics";
import { referenceAssessments } from "../src/evals/references";
import { evalAgents } from "../src/evals/registry";
import { EvalStore } from "../src/evals/store";
import type { Assessment, EvalBatch, EvalRun, Grade, Scenario, Verdict } from "../src/evals/types";
import { runWorker, type EvalJob } from "../src/evals/worker";

configureTestProviders();

async function withWorkerStore(t: TestContext, work: (store: EvalStore) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "offline-worker-"));
  const original = {
    fetch: globalThis.fetch, httpRequest: http.request, httpGet: http.get,
    httpsRequest: https.request, httpsGet: https.get, judgeModel: process.env.OFFLINE_EVAL_JUDGE_MODEL,
  };
  process.env.OFFLINE_EVAL_JUDGE_MODEL = "offline-test-judge";
  t.after(() => {
    globalThis.fetch = original.fetch; http.request = original.httpRequest; http.get = original.httpGet;
    https.request = original.httpsRequest; https.get = original.httpsGet;
    if (original.judgeModel === undefined) delete process.env.OFFLINE_EVAL_JUDGE_MODEL;
    else process.env.OFFLINE_EVAL_JUDGE_MODEL = original.judgeModel;
  });
  try { await work(new EvalStore(directory)); } finally { await rm(directory, { recursive: true, force: true }); }
}

function judged(input: Assessment, verdicts: Verdict[] = ["pass", "pass", "pass"]): Response {
  const item = (verdict: Verdict) => ({ verdict, reason: "Observed fixture evidence", evidenceIds: [input.evidence[0].id] });
  const grade: Grade = {
    task: item(verdicts[0]), handling: item(verdicts[1]), reporting: item(verdicts[2]), recovery: item("not_applicable"),
    steps: [], gaps: [], context: input.context || { task: "fixture", target: "fixture", app: "none", startingState: "initial" },
  };
  return Response.json({
    id: "judge-response", created_at: 1, model: "offline-test-judge",
    output: [{ type: "message", id: "judge-message", role: "assistant", status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(grade), annotations: [] }] }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

test("worker runs and persists the selected simulated adapter with isolated per-agent skipped days", t => withWorkerStore(t, async store => {
  const day = localDay();
  const scenario: Scenario = { id: "fixture", version: "1", request: "Fixture request",
    initial: null, expectations: "Fixture only", context: { task: "fixture", target: "fixture", app: "none", startingState: "initial" } };
  const create = t.mock.method(evalAgents.scheduled_task, "createAdapter", async () => ({
    id: "scheduled_task", version: "fixture-adapter", model: "assessed-deployment", promptVersion: "fixture-prompt", scenarios: [scenario],
    async execute(selected: Scenario): Promise<Assessment> {
      assert.equal(selected, scenario);
      return { agentId: "scheduled_task", mode: "simulated", request: selected.request, finalResponse: "Done",
        startedAt: new Date().toISOString(), durationMs: 100, model: "assessed-deployment", promptVersion: "fixture-prompt",
        evidence: [{ id: "e1", kind: "assertion", text: "Expected scheduling fixture persisted" }],
        taskAssertion: true, coverage: "complete", context: selected.context };
    },
  }));
  let judgeCalls = 0;
  globalThis.fetch = async (url, init) => {
    const packet = JSON.parse(messageText(readModelRequest(url, init), "user")) as { evidencePacket: Assessment };
    assert.equal(packet.evidencePacket.agentId, "scheduled_task");
    judgeCalls++;
    return judged(packet.evidencePacket);
  };
  for (const [agentId, date] of [["scheduled_task", shiftDay(day, -3)], ["tv", shiftDay(day, -1)]]) {
    await store.write<EvalBatch>("batches", { id: `${agentId}-prior`, agentId, scheduledDay: date, mode: "simulated", attempt: "scheduled",
      startedAt: `${date}T12:00:00Z`, status: "completed", runIds: [] });
  }
  const job: EvalJob = { id: "scheduled-worker", mode: "simulated", agentId: "scheduled_task", scheduledDay: day };
  await runWorker(job, store);
  assert.equal(create.mock.callCount(), 1);
  assert.equal(judgeCalls, 1);
  assert.equal(job.status, "completed");
  const runs = await store.list<EvalRun>("runs");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].agentId, "scheduled_task");
  assert.equal(runs[0].assessedModel, "assessed-deployment");
  assert.equal(runs[0].judgeModel, "offline-test-judge");
  assert.equal(runs[0].adapterVersion, "fixture-adapter");
  const skipped = (await store.list<EvalBatch>("batches")).filter(batch => batch.status === "skipped");
  assert.deepEqual(skipped.map(batch => batch.scheduledDay).sort(), [shiftDay(day, -2), shiftDay(day, -1)]);
  assert.ok(skipped.every(batch => batch.agentId === "scheduled_task"));
  assert.equal(await store.workerIsActive(), false);
}));

test("recorded worker uses the selected retained loader and never constructs a live adapter", t => withWorkerStore(t, async store => {
  const create = t.mock.method(evalAgents.realtime, "createAdapter", async () => { throw new Error("Recorded grading must not run Realtime"); });
  const load = t.mock.method(evalAgents.realtime, "loadRecorded", async (sessionId: string): Promise<Assessment> => ({
    agentId: "realtime", mode: "recorded", sourceSessionId: sessionId, request: "Play Telugu songs on Apple TV", finalResponse: "On it",
    startedAt: "2026-09-14T12:00:00Z", model: "original-realtime-model", coverage: "partial",
    evidence: [{ id: "e1", kind: "tool", toolName: "start_tv_agent", text: "Requested TV job accepted, not completed" }],
  }));
  let judgeCalls = 0;
  globalThis.fetch = async (url, init) => {
    const packet = JSON.parse(messageText(readModelRequest(url, init), "user")) as { evidencePacket: Assessment };
    assert.equal(packet.evidencePacket.mode, "recorded");
    assert.equal(packet.evidencePacket.agentId, "realtime");
    judgeCalls++;
    return judged(packet.evidencePacket);
  };
  const job: EvalJob = { id: "recorded-worker", agentId: "realtime", mode: "recorded", sessionIds: ["voice-source"] };
  await runWorker(job, store);
  assert.equal(create.mock.callCount(), 0);
  assert.deepEqual(load.mock.calls[0].arguments, ["voice-source"]);
  assert.equal(judgeCalls, 1);
  const [result] = await store.list<EvalRun>("runs");
  assert.equal(result.agentId, "realtime");
  assert.equal(result.sourceSessionId, "voice-source");
  assert.equal(result.assessedModel, "original-realtime-model");
  assert.equal(result.adapterVersion, evalAgents.realtime.recordedVersion);
  assert.equal(job.status, "completed");
  assert.equal(await store.workerIsActive(), false);
}));

test("calibration worker grades only this agent's references without constructing its model adapter", t => withWorkerStore(t, async store => {
  const references = referenceAssessments("realtime");
  const create = t.mock.method(evalAgents.realtime, "createAdapter", async () => { throw new Error("Calibration must not start the assessed agent"); });
  let judgeCalls = 0;
  globalThis.fetch = async (url, init) => {
    const packet = JSON.parse(messageText(readModelRequest(url, init), "user")) as { evidencePacket: Assessment };
    const reference = references[judgeCalls++];
    assert.equal(packet.evidencePacket.agentId, "realtime");
    assert.equal(packet.evidencePacket.evidence[0].id, reference.assessment.evidence[0].id);
    return judged(packet.evidencePacket, reference.expected);
  };
  const job: EvalJob = { id: "calibration-worker", agentId: "realtime", mode: "calibrate" };
  await runWorker(job, store);
  assert.equal(create.mock.callCount(), 0);
  assert.equal(judgeCalls, 6);
  assert.equal((await store.list<{ agentId: string; passed: boolean }>("calibrations"))[0].agentId, "realtime");
  assert.equal((await store.list("runs")).length, 0);
  assert.equal(job.status, "completed");
}));
