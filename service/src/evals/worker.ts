import dotenv from "dotenv";
import { randomUUID } from "node:crypto";
import { EvalStore } from "./store";
import { installNetworkBoundary } from "./network";
import { localDay, shiftDay } from "./analytics";
import type { EvalBatch } from "./types";

export interface EvalJob {
  id: string;
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
    job.status = "running"; job.workerPid = process.pid; job.createdAt ||= new Date().toISOString();
    await store.write("jobs", job);
    await store.queueRecordedAttempts(job);
    const config = await import("../config");
    if (!config.AZURE_OPENAI_RESOURCE_NAME) throw new Error("Azure model endpoint is not configured");
    installNetworkBoundary(`${config.AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com`, job.mode === "recorded" && config.AZURE_COSMOS_ENDPOINT ? new URL(config.AZURE_COSMOS_ENDPOINT).hostname : undefined);
    const [{ createTvAdapter }, { createLlmJudge, GRADER_VERSION }, { EvalRunner }, { calibrateJudge }] = await Promise.all([
      import("./tv/adapter"), import("./judge"), import("./runner"), import("./references"),
    ]);
    const adapter = await createTvAdapter(job.model);
    const judgeModel = process.env.OFFLINE_EVAL_JUDGE_MODEL || config.AI_MODEL_ADVANCED;
    if (!judgeModel) throw new Error("Configure OFFLINE_EVAL_JUDGE_MODEL or AI_MODEL_ADVANCED");
    const judge = await createLlmJudge(judgeModel, adapter.scenarios.map(s => s.context));
    if (job.mode === "calibrate") {
      const result = await calibrateJudge(store, judge, judgeModel, GRADER_VERSION, controller.signal);
      if (!result.passed) throw new Error("Judge disagreed with reviewed reference cases; inspect calibration results");
    } else {
      const runner = new EvalRunner(store, judge, judgeModel, GRADER_VERSION);
      let batch: EvalBatch;
      if (job.mode === "recorded") {
        if (!job.sessionIds?.length) throw new Error("Select completed session IDs for recorded evaluation");
        const { loadRecordedAssessment } = await import("./recorded");
        batch = await runner.recorded("tv", [...new Set(job.sessionIds)].map(sessionId => ({ sessionId, load: () => loadRecordedAssessment(sessionId) })),
          controller.signal, { jobId: job.id });
      } else {
        if (job.scheduledDay && job.scheduledDay !== localDay()) throw new Error("Scheduled evals only run for the current local day");
        if (job.scheduledDay) {
          const days = (await store.list<EvalBatch>("batches")).filter(b => b.attempt === "scheduled" && b.scheduledDay).map(b => b.scheduledDay!).sort();
          for (let day = days.length ? shiftDay(days[days.length - 1], 1) : job.scheduledDay; day < job.scheduledDay; day = shiftDay(day, 1)) {
            await store.write("batches", { id: `skipped-${day}`, agentId: "tv", mode: "simulated", attempt: "scheduled", scheduledDay: day,
              startedAt: new Date().toISOString(), status: "skipped", runIds: [] } as EvalBatch);
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
    await store.alert({ id: randomUUID(), key: "tv:worker-failure", batchId: job.batchId || job.id, kind: "incomplete", createdAt: new Date().toISOString(), message: job.error, runIds: [] });
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
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2), mode = args[0];
    if (mode === "job") {
      const job = await new EvalStore().read<EvalJob>("jobs", args[1]);
      if (!job) throw new Error("Eval job not found");
      await runWorker(job);
    } else {
      if (!["simulated", "recorded", "calibrate"].includes(mode)) throw new Error("Usage: npm run eval -- simulated [scenario-id ...] | recorded <session-id ...> | calibrate");
      await runWorker({ id: randomUUID(), mode: mode as EvalJob["mode"], scenarioIds: mode === "simulated" && args.length > 1 ? args.slice(1) : undefined,
        sessionIds: mode === "recorded" ? args.slice(1) : undefined });
    }
  })().then(() => { process.exitCode = 0; }, error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
