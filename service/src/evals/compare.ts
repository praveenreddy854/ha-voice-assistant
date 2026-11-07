import { randomUUID } from "node:crypto";
import { EvalStore, digest, processIsRunning } from "./store";
import { EvalRunner } from "./runner";
import { getEvalAgent } from "./registry";
import type { AgentAdapter, EvalAgentId, EvalRun, Judge, StepGroup } from "./types";
import type { EvalJob } from "./worker";

export interface ComparisonInput { agentId: EvalAgentId; baselineModel: string; candidateModel: string; scenarioIds?: string[]; repeats?: number }
export interface ModelComparison {
  id: string; input: ComparisonInput; manifest: string; graderVersion: string; judgeModel: string;
  startedAt: string; finishedAt?: string; status: "running" | "completed" | "incomplete"; error?: string;
  pairs: Array<{ scenarioId: string; repetition: number; baselineRunId: string; candidateRunId: string;
    baselineFulfilled?: boolean; candidateFulfilled?: boolean; outcome: "improved" | "regressed" | "unchanged" | "incomplete" }>;
}

/** Same fixture/prompt/tool versions, fresh environments, fixed judge groups, alternating execution order. */
export async function compareModels(input: ComparisonInput, store: EvalStore, dependencies: {
  createAdapter(model: string): Promise<AgentAdapter>; judge: Judge; judgeModel: string; graderVersion: string;
}, signal: AbortSignal): Promise<ModelComparison> {
  if (input.baselineModel === input.candidateModel || ![input.baselineModel, input.candidateModel].every(model => /^[a-zA-Z0-9._-]+$/.test(model))) throw new Error("Choose two distinct valid model deployments");
  const repeats = input.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error("Choose 1 to 5 repetitions");
  const releaseSubmission = await store.acquire("submission.lock");
  if (!releaseSubmission) throw new Error("Another eval submission is in progress");
  let releaseWorker: (() => Promise<void>) | undefined;
  let report: ModelComparison | undefined;
  try {
    await store.recoverInterruptedJobs();
    if ((await store.list<EvalJob>("jobs")).some(job => ["queued", "running"].includes(job.status || "") && processIsRunning(job.workerPid || job.ownerPid))) throw new Error("Another eval job is active");
    releaseWorker = await store.acquire();
    if (!releaseWorker) throw new Error("Another eval worker is active");
    for (const previous of await store.list<ModelComparison>("model-comparisons")) if (previous.status === "running") {
      await store.write("model-comparisons", { ...previous, status: "incomplete", finishedAt: new Date().toISOString(), error: "Comparison worker interrupted; no model calls were resumed automatically" });
    }
    const baseline = await dependencies.createAdapter(input.baselineModel), candidate = await dependencies.createAdapter(input.candidateModel);
    const manifest = (adapter: AgentAdapter) => digest({ id: adapter.id, version: adapter.version, promptVersion: adapter.promptVersion, scenarios: adapter.scenarios });
    if (baseline.id !== input.agentId || candidate.id !== input.agentId || baseline.model !== input.baselineModel || candidate.model !== input.candidateModel || manifest(baseline) !== manifest(candidate)) throw new Error("Models must share identical agent, prompt/tool versions, requests, fixture state and clocks");
    const selected = input.scenarioIds || baseline.scenarios.map(scenario => scenario.id);
    if (!selected.length || new Set(selected).size !== selected.length || selected.some(id => !baseline.scenarios.some(scenario => scenario.id === id))) throw new Error("Unknown or duplicate scenario selection");
    report = { id: randomUUID(), input: { ...input, repeats }, manifest: manifest(baseline), graderVersion: dependencies.graderVersion, judgeModel: dependencies.judgeModel,
      startedAt: new Date().toISOString(), status: "running", pairs: [] };
    await store.write("model-comparisons", report);
    const groups = (await store.list<StepGroup>("groups")).filter(group => group.agentId === input.agentId);
    const runner = new EvalRunner(store, (assessment, _dynamicGroups, abort) => dependencies.judge(assessment, groups, abort), dependencies.judgeModel, dependencies.graderVersion);
    for (let repetition = 0; repetition < repeats; repetition++) for (const [index, scenarioId] of selected.entries()) {
      signal.throwIfAborted();
      const results: Partial<Record<"baseline" | "candidate", EvalRun>> = {};
      const order = (repetition + index) % 2 ? ["candidate", "baseline"] as const : ["baseline", "candidate"] as const;
      for (const role of order) {
        signal.throwIfAborted();
        const batch = await runner.simulated(role === "baseline" ? baseline : candidate, signal, { scenarioIds: [scenarioId] });
        results[role] = await store.read<EvalRun>("runs", batch.runIds[0]);
      }
      const first = results.baseline!, second = results.candidate!;
      const baselineFulfilled = first?.status === "completed" ? first.assessment?.taskAssertion : undefined;
      const candidateFulfilled = second?.status === "completed" ? second.assessment?.taskAssertion : undefined;
      report.pairs.push({ scenarioId, repetition: repetition + 1, baselineRunId: first.id, candidateRunId: second.id, baselineFulfilled, candidateFulfilled,
        outcome: baselineFulfilled === undefined || candidateFulfilled === undefined ? "incomplete" : baselineFulfilled === candidateFulfilled ? "unchanged" : candidateFulfilled ? "improved" : "regressed" });
      await store.write("model-comparisons", report);
    }
    report.status = report.pairs.some(pair => pair.outcome === "incomplete") ? "incomplete" : "completed";
    return report;
  } catch (error) {
    if (report) { report.status = "incomplete"; report.error = error instanceof Error ? error.message : String(error); }
    throw error;
  } finally {
    try {
      if (report) { report.finishedAt = new Date().toISOString(); await store.write("model-comparisons", report); }
    } finally { await releaseWorker?.(); await releaseSubmission(); }
  }
}

if (require.main === module) {
  (async () => {
    const [agentId, baselineModel, candidateModel, ...scenarioIds] = process.argv.slice(2);
    if (!baselineModel || !candidateModel) throw new Error("Usage: npm run eval:compare -- tv|scheduled_task|realtime baseline-deployment candidate-deployment [scenario-id ...]");
    const registration = getEvalAgent(agentId);
    const config = await import("../config");
    if (!config.AZURE_OPENAI_RESOURCE_NAME) throw new Error("Configure the Azure model endpoint");
    (await import("./network")).installNetworkBoundary(`${config.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com`);
    const { createLlmJudge, GRADER_VERSION } = await import("./judge");
    const judgeModel = process.env.OFFLINE_EVAL_JUDGE_MODEL || config.AI_MODEL_ADVANCED;
    if (!judgeModel) throw new Error("Configure the eval judge model");
    const controller = new AbortController();
    process.once("SIGTERM", () => controller.abort()); process.once("SIGINT", () => controller.abort());
    const report = await compareModels({ agentId: registration.id, baselineModel, candidateModel, scenarioIds: scenarioIds.length ? scenarioIds : undefined }, new EvalStore(), {
      createAdapter: model => registration.createAdapter(model), judge: await createLlmJudge(judgeModel), judgeModel, graderVersion: GRADER_VERSION,
    }, controller.signal);
    console.log(JSON.stringify({ id: report.id, status: report.status, pairs: report.pairs }, null, 2));
    if (report.status !== "completed") process.exitCode = 1;
  })().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
