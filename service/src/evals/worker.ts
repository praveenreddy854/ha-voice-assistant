import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { EvalStore } from "./store";
import { installNetworkBoundary } from "./network";
import { localDay, shiftDay } from "./analytics";
import type { EvalBatch } from "./types";
import { getEvalAgent } from "./registry";

export interface EvalJob {
  id: string;
  agentId?: string;
  mode: "simulated" | "recorded" | "calibrate";
  scenarioIds?: string[];
  sessionIds?: string[];
  model?: string;
  scheduledDay?: string;
  status?: "queued" | "running" | "completed" | "failed";
  batchId?: string;
  error?: string;
  requestId?: string;
  createdAt?: string;
  finishedAt?: string;
  ownerPid?: number;
  workerPid?: number;
}
export async function runWorker(job: EvalJob, store = new EvalStore()): Promise<void> {
  dotenv.config({ quiet: true });
  const release = await store.acquire();
  if (!release) throw new Error("Another offline eval worker is active");
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Eval worker cancelled"));
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
  try {
    await store.recoverInterruptedBatches();
    const registration = getEvalAgent(job.agentId);
    job.agentId = registration.id;
    job.status = "running"; job.workerPid = process.pid; job.createdAt ||= new Date().toISOString();
    await store.write("jobs", job);
    await store.queueRecordedAttempts(job);
    const config = await import("../config");
    if (!config.AZURE_OPENAI_RESOURCE_NAME) throw new Error("Azure model endpoint is not configured");
    installNetworkBoundary(`${config.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com`, job.mode === "recorded" && registration.id === "tv" && config.AZURE_COSMOS_ENDPOINT ? new URL(config.AZURE_COSMOS_ENDPOINT).hostname : undefined);
    const [{ createLlmJudge, GRADER_VERSION }, { EvalRunner }, { calibrateJudge }] = await Promise.all([
      import("./judge"), import("./runner"), import("./references"),
    ]);
    const judgeModel = process.env.OFFLINE_EVAL_JUDGE_MODEL || config.AI_MODEL_ADVANCED;
    if (!judgeModel) throw new Error("Configure OFFLINE_EVAL_JUDGE_MODEL or AI_MODEL_ADVANCED");
    const scenarios = await registration.scenarios();
    const judge = await createLlmJudge(judgeModel, scenarios.map(s => s.context));
    if (job.mode === "calibrate") {
      const result = await calibrateJudge(store, judge, judgeModel, GRADER_VERSION, controller.signal, registration.id);
      if (!result.passed) throw new Error("Judge disagreed with the selected agent's reference cases; inspect calibration results");
    } else {
      const runner = new EvalRunner(store, judge, judgeModel, GRADER_VERSION);
      let batch: EvalBatch;
      if (job.mode === "recorded") {
        if (!job.sessionIds?.length) throw new Error("Select completed session IDs for recorded evaluation");
        batch = await runner.recorded(registration.id, [...new Set(job.sessionIds)].map(sessionId => ({ sessionId, load: () => registration.loadRecorded(sessionId) })),
          controller.signal, { jobId: job.id, adapterVersion: registration.recordedVersion });
      } else {
        if (job.mode !== "simulated") throw new Error("Unknown offline evaluation mode");
        const adapter = await registration.createAdapter(job.model);
        if (adapter.id !== registration.id) throw new Error("Registered adapter returned a different agent identity");
        if (job.scheduledDay && job.scheduledDay !== localDay()) throw new Error("Scheduled evals only run for the current local day");
        if (job.scheduledDay) {
          const days = (await store.list<EvalBatch>("batches")).filter(b => b.agentId === registration.id && b.attempt === "scheduled" && b.scheduledDay).map(b => b.scheduledDay!).sort();
          for (let day = days.length ? shiftDay(days[days.length - 1], 1) : job.scheduledDay; day < job.scheduledDay; day = shiftDay(day, 1)) {
            await store.write<EvalBatch>("batches", { id: `skipped-${registration.id}-${day}`, agentId: registration.id, mode: "simulated", attempt: "scheduled", scheduledDay: day,
              startedAt: new Date().toISOString(), status: "skipped", runIds: [] });
          }
        }
        batch = await runner.simulated(adapter, controller.signal, { scheduledDay: job.scheduledDay, scenarioIds: job.scenarioIds, jobId: job.id });
      }
      job.batchId = batch.id;
      if (batch.status === "incomplete") throw new Error(batch.error || "Batch contains incomplete evals");
    }
    job.status = "completed";
  } catch (error) {
    job.status = "failed"; job.error = error instanceof Error ? error.message : String(error);
    await store.alert({ id: randomUUID(), agentId: job.agentId || "tv", key: `${job.agentId || "tv"}:worker-failure`, batchId: job.batchId || job.id, kind: "incomplete", createdAt: new Date().toISOString(), message: job.error, runIds: [] });
    throw error;
  } finally {
    try {
      const saved = await store.read<EvalJob>("jobs", job.id);
      job.batchId ||= saved?.batchId;
      job.finishedAt = new Date().toISOString();
      if (job.status === "failed") await store.failJob(job, job.error || "Eval worker failed");
      else await store.write("jobs", job);
    } finally {
      await release();
      process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop);
    }
  }
}
export function parseEvalArguments(args: string[]): Pick<EvalJob, "mode" | "agentId" | "scenarioIds" | "sessionIds" | "model"> {
  const [mode, ...rest] = args;
  if (mode !== "simulated" && mode !== "recorded" && mode !== "calibrate") {
    throw new Error("Usage: npm run eval -- simulated [--agent tv|scheduled_task|realtime] [--model deployment] [scenario-id ...] | recorded [--agent id] <session-id ...> | calibrate [--agent id]");
  }
  const flags = new Map<string, string>(), identifiers: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--agent" || arg === "--model") {
      const value = rest[++index];
      if (!value || value.startsWith("--") || flags.has(arg)) throw new Error(`Provide ${arg} exactly once with a value`);
      flags.set(arg, value);
    } else if (arg.startsWith("--")) throw new Error(`Unknown evaluation option ${arg}`);
    else identifiers.push(arg);
  }
  const agentId = getEvalAgent(flags.get("--agent")).id;
  const model = flags.get("--model");
  if (model && (mode !== "simulated" || !/^[a-zA-Z0-9._-]+$/.test(model))) throw new Error("A valid --model deployment is supported only for simulations");
  if (mode === "calibrate" && identifiers.length) throw new Error("Judge calibration does not accept scenario or session IDs");
  if (mode === "recorded" && (!identifiers.length || identifiers.length > 100 || identifiers.some(id => !/^[a-zA-Z0-9_-]+$/.test(id)))) {
    throw new Error("Select 1 to 100 valid completed session IDs");
  }
  if (mode === "simulated" && identifiers.some(id => !/^[a-z0-9-]+$/.test(id))) throw new Error("Invalid scenario identifier");
  if (new Set(identifiers).size !== identifiers.length) throw new Error("Evaluation identifiers must be unique");
  return { mode, agentId, model, scenarioIds: mode === "simulated" && identifiers.length ? identifiers : undefined,
    sessionIds: mode === "recorded" ? identifiers : undefined };
}
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2), mode = args[0];
    if (mode === "job") {
      const job = await new EvalStore().read<EvalJob>("jobs", args[1]);
      if (!job) throw new Error("Eval job not found");
      await runWorker(job);
    } else {
      await runWorker({ id: randomUUID(), ...parseEvalArguments(args) });
    }
  })().then(() => { process.exitCode = 0; }, error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
