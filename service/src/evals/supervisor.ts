import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EvalStore, processIsRunning } from "./store";
import { isDue, localDay } from "./analytics";
import { EVAL_AGENT_IDS, type EvalBatch } from "./types";
import type { EvalJob } from "./worker";
import { getEvalAgent } from "./registry";

function spawnWorker(job: EvalJob, directory: string): ChildProcess {
  const source = __filename.endsWith(".ts");
  return fork(path.join(__dirname, `worker.${source ? "ts" : "js"}`), ["job", job.id], {
    execArgv: source ? ["--import", "tsx"] : [], stdio: "ignore",
    env: { ...process.env, OFFLINE_EVAL_DIR: directory },
  });
}
type JobInput = Pick<EvalJob, "mode" | "agentId" | "sessionIds" | "scenarioIds" | "model" | "scheduledDay" | "requestId">;

export class EvalSupervisor {
  private child?: ChildProcess;
  private launching = false;
  private timer?: NodeJS.Timeout;
  private recovery: Promise<void> = Promise.resolve();
  constructor(readonly store = new EvalStore(), private readonly spawn = spawnWorker) {}
  async busy(): Promise<boolean> {
    await this.recovery;
    await this.store.recoverInterruptedJobs();
    return this.child !== undefined || this.launching || await this.persistedBusy();
  }
  private async persistedBusy(): Promise<boolean> {
    if (await this.store.workerIsActive()) return true;
    return (await this.store.list<EvalJob>("jobs")).some(job =>
      (job.status === "queued" || job.status === "running") && processIsRunning(job.workerPid || job.ownerPid));
  }
  private async previousSubmission(input: JobInput): Promise<EvalJob | undefined> {
    if (!input.requestId) return undefined;
    const previous = await this.store.read<EvalJob>("jobs", input.requestId);
    if (previous && (previous.mode !== input.mode || (previous.agentId || "tv") !== (input.agentId || "tv")
      || JSON.stringify(previous.sessionIds) !== JSON.stringify(input.sessionIds))) {
      throw new Error("This submission ID was already used for a different selection");
    }
    return previous;
  }
  async launch(input: JobInput): Promise<EvalJob> {
    await this.recovery;
    const agent = getEvalAgent(input.agentId);
    input = { ...input, agentId: agent.id };
    if (input.mode === "recorded" && (!input.sessionIds?.length || input.sessionIds.length > 100
      || new Set(input.sessionIds).size !== input.sessionIds.length
      || input.sessionIds.some(id => !/^[a-zA-Z0-9_-]+$/.test(id)))) throw new Error("Select 1 to 100 unique valid session IDs");
    if (input.mode === "simulated" && input.scenarioIds) {
      const scenarios = await agent.scenarios();
      if (!input.scenarioIds.length || new Set(input.scenarioIds).size !== input.scenarioIds.length
        || input.scenarioIds.some(id => !scenarios.some(scenario => scenario.id === id))) throw new Error("Unknown or empty scenario selection for this agent");
    }
    const previous = await this.previousSubmission(input);
    if (previous) return previous;
    if (this.launching) throw new Error("An offline eval submission is already in progress");
    this.launching = true;
    let release: (() => Promise<void>) | undefined;
    let job: EvalJob | undefined;
    try {
      release = await this.store.acquire("submission.lock");
      if (!release) throw new Error("An offline eval submission is already in progress");
      const previous = await this.previousSubmission(input);
      if (previous) return previous;
      await this.store.recoverInterruptedJobs();
      if (this.child || await this.persistedBusy()) throw new Error("An offline eval is already running");
      job = { ...input, id: input.requestId || randomUUID(), status: "queued", createdAt: new Date().toISOString(), ownerPid: process.pid };
      await this.store.write("jobs", job);
      await this.store.queueRecordedAttempts(job);
      const child = this.spawn(job, this.store.directory);
      this.child = child;
      const launchedJob = job;
      const failed = (message: string) => {
        if (this.child === child) this.child = undefined;
        this.recovery = this.store.failJob(launchedJob, message);
        void this.recovery.catch(error => console.error("[Offline eval worker recovery]", error));
      };
      child.once("error", error => failed(error.message));
      child.once("exit", code => {
        if (this.child === child) this.child = undefined;
        this.recovery = this.recovery.then(async () => {
          const saved = await this.store.read<EvalJob>("jobs", launchedJob.id);
          if (saved?.status !== "completed" && saved?.status !== "failed") {
            await this.store.failJob(launchedJob, `Offline eval worker exited before saving completion (exit ${code ?? "signal"})`);
          }
        });
        void this.recovery.catch(error => console.error("[Offline eval worker recovery]", error));
      });
      return job;
    } catch (error) {
      if (job) await this.store.failJob(job, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      try { await release?.(); } finally { this.launching = false; }
    }
  }
  async tick(now = new Date()): Promise<void> {
    if (await this.busy() || !isDue(now)) return;
    const day = localDay(now);
    const [batches, jobs] = await Promise.all([this.store.list<EvalBatch>("batches"), this.store.list<EvalJob>("jobs")]);
    // Failed startup attempts are retained too; never loop on a broken configuration.
    const agentId = EVAL_AGENT_IDS.find(id =>
      !batches.some(b => b.agentId === id && b.attempt === "scheduled" && b.scheduledDay === day)
      && !jobs.some(j => (j.agentId || "tv") === id && j.scheduledDay === day));
    if (agentId) await this.launch({ mode: "simulated", agentId, scheduledDay: day });
  }
  start(): void {
    void this.store.recoverInterruptedJobs().catch(error => console.error("[Offline eval recovery]", error));
    if (this.timer || process.env.OFFLINE_EVAL_ENABLED === "false") return;
    const check = () => { void this.tick().catch(error => console.error("[Offline eval scheduler]", error)); };
    this.timer = setInterval(check, 30_000); this.timer.unref(); check();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.child?.kill("SIGTERM"); }
}
