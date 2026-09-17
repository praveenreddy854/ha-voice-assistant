import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { EvalAlert, EvalBatch, EvalRun, RecordedEvalAttempt, StepGroup } from "./types";
import type { EvalJob } from "./worker";
import { updateRecordedDailyOutcome } from "./scheduling";

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}
export const defaultEvalDirectory = () => path.resolve(process.env.OFFLINE_EVAL_DIR || path.join(__dirname, "../../generated_data/offline-evals"));
export function processIsRunning(pid?: number): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}
export class EvalStore {
  constructor(readonly directory = defaultEvalDirectory()) {}
  private filename(kind: string, id: string) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid eval identifier");
    return path.join(this.directory, kind, `${id}.json`);
  }
  async write<T extends { id: string }>(kind: string, item: T): Promise<void> {
    const filename = this.filename(kind, item.id);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(item), { mode: 0o600 });
    await fs.rename(temporary, filename);
  }
  async writeOnce<T extends { id: string }>(kind: string, item: T): Promise<T> {
    const filename = this.filename(kind, item.id);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(item), { mode: 0o600 });
    try {
      // Linking publishes a complete record without replacing another startup's cutoff.
      try { await fs.link(temporary, filename); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const saved = await this.read<T>(kind, item.id);
      if (!saved) throw new Error(`Persisted eval ${kind} record disappeared`);
      return saved;
    } finally {
      await fs.unlink(temporary);
    }
  }
  async read<T>(kind: string, id: string): Promise<T | undefined> {
    try { return JSON.parse(await fs.readFile(this.filename(kind, id), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async list<T>(kind: string): Promise<T[]> {
    let names: string[];
    try { names = await fs.readdir(path.join(this.directory, kind)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    return Promise.all(names.filter(n => n.endsWith(".json")).map(async name => JSON.parse(await fs.readFile(path.join(this.directory, kind, name), "utf8"))));
  }
  async saveRun(run: EvalRun): Promise<void> {
    if (run.grade) for (const step of run.grade.steps) {
      const fields = { agentId: run.agentId, objective: step.objective, target: run.grade.context.target, app: run.grade.context.app, startingState: step.startingState };
      const group: StepGroup = { id: digest(fields), ...fields };
      step.groupId = group.id;
      await this.write("groups", group);
    }
    await this.write("runs", run);
    // Summary reads never load screenshots or complete source traces in the backend.
    const { assessment, ...summary } = run;
    await this.write("summaries", {
      ...summary, request: assessment?.request, sourceSessionId: run.sourceSessionId || assessment?.sourceSessionId,
      usage: assessment?.usage, metrics: assessment?.metrics,
      ...(run.mode === "simulated" && assessment?.taskAssertion != null ? { taskAssertion: assessment.taskAssertion } : {}),
    });
  }
  async workerIsActive(): Promise<boolean> {
    return this.lockIsActive("worker.lock");
  }
  async submissionIsActive(): Promise<boolean> {
    return this.lockIsActive("submission.lock");
  }
  private async lockIsActive(name: "worker.lock" | "submission.lock"): Promise<boolean> {
    try {
      const pid = Number(await fs.readFile(path.join(this.directory, name), "utf8"));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid offline eval ${name === "worker.lock" ? "worker" : "submission"} lock`);
      return processIsRunning(pid);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  async acquire(name: "worker.lock" | "submission.lock" = "worker.lock"): Promise<(() => Promise<void>) | undefined> {
    await fs.mkdir(this.directory, { recursive: true });
    const lock = path.join(this.directory, name);
    try {
      const handle = await fs.open(lock, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => {
        try { await fs.unlink(lock); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: number;
      try { pid = Number(await fs.readFile(lock, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.acquire(name);
        throw error;
      }
      if (!Number.isInteger(pid) || pid <= 0) throw new Error(`Invalid offline eval ${name}`);
      if (processIsRunning(pid)) return undefined;
      try { await fs.unlink(lock); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      return this.acquire(name);
    }
  }
  async queueRecordedAttempts(job: EvalJob): Promise<RecordedEvalAttempt[]> {
    if (job.mode !== "recorded") return [];
    const attempts: RecordedEvalAttempt[] = [];
    const batch = job.batchId ? await this.read<EvalBatch>("batches", job.batchId) : undefined;
    for (const sessionId of new Set(job.sessionIds)) {
      const id = digest([job.id, sessionId]);
      const previous = await this.read<RecordedEvalAttempt>("attempts", id);
      const legacyRunId = !previous ? batch?.runIds[job.sessionIds!.indexOf(sessionId)] : undefined;
      const legacyRun = legacyRunId ? await this.read<EvalRun>("runs", legacyRunId) : undefined;
      if (legacyRun) await this.saveRun({ ...legacyRun, sourceSessionId: sessionId });
      const attempt: RecordedEvalAttempt = previous || {
        id, jobId: job.id, agentId: job.agentId || "tv", sourceSessionId: sessionId,
        status: legacyRun ? legacyRun.status === "completed" ? "evaluated" : "eval_error" : "queued",
        requestedAt: job.createdAt || batch?.startedAt || new Date().toISOString(),
        runId: legacyRun?.id, finishedAt: legacyRun?.gradedAt, error: legacyRun?.error,
      };
      if (!previous) await this.write("attempts", attempt);
      attempts.push(attempt);
    }
    return attempts;
  }
  async finishRecordedAttempts(job: EvalJob, reason: string): Promise<void> {
    const attempts = await this.queueRecordedAttempts(job);
    for (const attempt of attempts) {
      if (attempt.status !== "queued" && attempt.status !== "running") continue;
      const run = attempt.runId ? await this.read<EvalRun>("runs", attempt.runId) : undefined;
      if (run) await this.saveRun(run);
      await this.write<RecordedEvalAttempt>("attempts", {
        ...attempt, status: run?.status === "completed" ? "evaluated" : "eval_error",
        finishedAt: run?.gradedAt || new Date().toISOString(),
        error: run?.status === "completed" ? undefined : run?.error || `${reason}${attempt.startedAt ? "" : " (evaluation never started)"}`,
      });
    }
  }
  async failJob(job: EvalJob, reason: string): Promise<void> {
    const saved = await this.read<EvalJob>("jobs", job.id);
    if (saved?.status === "completed") return;
    const failed: EvalJob = { ...job, ...saved, status: "failed", error: reason, finishedAt: new Date().toISOString() };
    await this.finishRecordedAttempts(failed, reason);
    for (const batch of await this.list<EvalBatch>("batches")) {
      if (batch.status === "running" && (batch.jobId === job.id || batch.id === failed.batchId)) {
        await this.write<EvalBatch>("batches", { ...batch, status: "incomplete", error: reason, finishedAt: failed.finishedAt });
      }
    }
    await this.write("jobs", failed);
    await updateRecordedDailyOutcome(this, failed);
    await this.alert({ id: randomUUID(), agentId: failed.agentId || "tv", key: `${failed.agentId || "tv"}:worker-failure`, batchId: failed.batchId || failed.id, createdAt: failed.finishedAt!,
      kind: "incomplete", message: reason, runIds: [] });
  }
  async recoverInterruptedJobs(): Promise<void> {
    if (await this.workerIsActive()) return;
    for (const job of await this.list<EvalJob>("jobs")) {
      if ((job.status === "queued" || job.status === "running") && !processIsRunning(job.workerPid || job.ownerPid)) {
        await this.failJob(job, "Eval worker stopped before finishing; retry explicitly");
      }
    }
  }
  async alert(alert: EvalAlert): Promise<void> {
    const previous = (await this.list<EvalAlert>("alerts")).find(a => a.key === alert.key && !a.resolvedAt);
    if (!previous) await this.write("alerts", alert);
  }
  async resolveAlert(key: string): Promise<void> {
    for (const alert of await this.list<EvalAlert>("alerts")) if (alert.key === key && !alert.resolvedAt) {
      await this.write("alerts", { ...alert, resolvedAt: new Date().toISOString() } as EvalAlert);
    }
  }
  async recoverInterruptedBatches(): Promise<void> {
    for (const batch of await this.list<EvalBatch>("batches")) if (batch.status === "running") {
      batch.status = "incomplete"; batch.error = "Eval worker stopped before finishing"; batch.finishedAt = new Date().toISOString();
      await this.write("batches", batch);
      await this.alert({ id: randomUUID(), agentId: batch.agentId, key: `${batch.agentId}:incomplete`, batchId: batch.id, createdAt: batch.finishedAt, kind: "incomplete", message: batch.error, runIds: batch.runIds });
    }
  }
}
