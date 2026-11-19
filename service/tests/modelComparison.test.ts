import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { compareModels, type ModelComparison } from "../src/evals/compare";
import { EvalStore } from "../src/evals/store";
import { modelSettingsIdentity } from "../src/modelSettings";
import type { AgentAdapter, Assessment, Judge } from "../src/evals/types";

const scenarios = ["first", "second"].map(id => ({ id, version: "1", request: id, expectations: "Fixture state determines fulfillment", initial: { clock: "fixed", count: 0 }, context: { task: id, target: "fixture", app: "fixture", startingState: "fixture" } }));
const judge: Judge = async (assessment, groups) => {
  assert.equal(groups.length, 0, "Judge grouping context must not change after grading the first model");
  const item = { verdict: "pass" as const, reason: "Synthetic observation", evidenceIds: ["e1"] };
  return { grade: { task: item, handling: item, reporting: item, recovery: item,
    steps: [{ ...item, objective: "fixture_ready", startingState: "fixture", alreadySatisfied: false }], gaps: [], context: assessment.context! } };
};
async function fixture(work: (store: EvalStore) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "paired-evals-"));
  try { await work(new EvalStore(directory)); } finally { await rm(directory, { recursive: true, force: true }); }
}
function adapter(model: string, calls: string[]): AgentAdapter {
  return { id: "tv", version: "fixture", model, promptVersion: "same-prompt-tools", scenarios: structuredClone(scenarios),
    async execute(scenario): Promise<Assessment> {
      assert.equal((scenario.initial as { count: number }).count, 0);
      calls.push(`${model}:${scenario.id}`);
      return { agentId: "tv", mode: "simulated", request: scenario.request, model, startedAt: new Date().toISOString(), finalResponse: "Done", coverage: "complete", context: scenario.context,
        taskAssertion: (scenario.id === "first") === (model === "candidate"), evidence: [{ id: "e1", kind: "assertion", text: "Independent simulator state" }] };
    } };
}

test("controlled comparisons preserve paired fixtures, alternate order and hold judge context fixed", async () => fixture(async store => {
  const calls: string[] = [];
  const report = await compareModels({ agentId: "tv", baselineModel: "baseline", candidateModel: "candidate", repeats: 2 }, store,
    { createAdapter: async model => adapter(model, calls), judge, judgeModel: "judge", graderVersion: "grader" }, new AbortController().signal);
  assert.equal(report.status, "completed");
  assert.deepEqual(report.pairs.map(pair => pair.outcome), ["improved", "regressed", "improved", "regressed"]);
  assert.deepEqual(calls, ["baseline:first", "candidate:first", "candidate:second", "baseline:second", "candidate:first", "baseline:first", "baseline:second", "candidate:second"]);
  assert.ok((await store.read<ModelComparison>("model-comparisons", report.id))?.finishedAt);
  assert.equal(await store.workerIsActive(), false); assert.equal(await store.submissionIsActive(), false);
}));

test("comparisons accept different efforts on one deployment and reject equivalent settings", async () => fixture(async store => {
  const baselineModel = '{"model":"same-deployment","reasoningEffort":"low"}';
  const candidateModel = '{"model":"same-deployment","reasoningEffort":"high"}';
  const calls: string[] = [];
  const dependencies = { createAdapter: async (model: string) => adapter(modelSettingsIdentity(model)!, calls), judge, judgeModel: "judge", graderVersion: "grader" };
  const report = await compareModels({ agentId: "tv", baselineModel: '{ "reasoningEffort": "low", "model": "same-deployment" }',
    candidateModel: '{"model": "same-deployment", "reasoningEffort": "high"}', scenarioIds: ["first"] }, store, dependencies, new AbortController().signal);
  assert.equal(report.status, "completed");
  assert.deepEqual(calls, [`${baselineModel}:first`, `${candidateModel}:first`]);
  assert.equal(report.input.baselineModel, baselineModel);
  assert.equal(report.input.candidateModel, candidateModel);
  await assert.rejects(compareModels({ agentId: "tv", baselineModel: "same-deployment", candidateModel: '{"model":"same-deployment"}' }, store, dependencies, new AbortController().signal), /distinct valid model settings/);
  await assert.rejects(compareModels({ agentId: "tv", baselineModel, candidateModel: '{"reasoningEffort":"low", "model":"same-deployment"}' }, store, dependencies, new AbortController().signal), /distinct valid model settings/);
  assert.equal(calls.length, 2, "Equivalent settings must be rejected before model execution");
}));

test("comparisons accept JSON settings with only a deployment name", async () => fixture(async store => {
  const dependencies = { createAdapter: async (model: string) => adapter(modelSettingsIdentity(model)!, []), judge, judgeModel: "judge", graderVersion: "grader" };
  const plain = await compareModels({ agentId: "tv", baselineModel: '{"model":"same-deployment"}',
    candidateModel: '{"model":"same-deployment","reasoningEffort":"high"}', scenarioIds: ["first"] },
  store, dependencies, new AbortController().signal);
  assert.equal(plain.status, "completed");
  assert.equal(plain.input.baselineModel, "same-deployment");
}));

test("different prompts or fixtures fail before either model is called", async () => fixture(async store => {
  const calls: string[] = [];
  await assert.rejects(compareModels({ agentId: "tv", baselineModel: "baseline", candidateModel: "candidate" }, store,
    { createAdapter: async model => ({ ...adapter(model, calls), promptVersion: model }), judge, judgeModel: "judge", graderVersion: "grader" }, new AbortController().signal), /identical agent/);
  assert.deepEqual(calls, []);
}));

test("grading errors are incomplete comparisons and never counted as model task failures", async () => fixture(async store => {
  const report = await compareModels({ agentId: "tv", baselineModel: "baseline", candidateModel: "candidate", scenarioIds: ["first"] }, store,
    { createAdapter: async model => adapter(model, []), judge: async () => { throw new Error("Judge unavailable"); }, judgeModel: "judge", graderVersion: "grader" }, new AbortController().signal);
  assert.equal(report.status, "incomplete"); assert.equal(report.pairs[0].outcome, "incomplete");
  assert.equal(report.pairs[0].baselineFulfilled, undefined);
}));

test("comparisons respect an active portal job and never start a parallel worker", async () => fixture(async store => {
  await store.write("jobs", { id: "active", status: "queued", ownerPid: process.pid });
  await assert.rejects(compareModels({ agentId: "tv", baselineModel: "baseline", candidateModel: "candidate" }, store,
    { createAdapter: async model => adapter(model, []), judge, judgeModel: "judge", graderVersion: "grader" }, new AbortController().signal), /Another eval job/);
}));
