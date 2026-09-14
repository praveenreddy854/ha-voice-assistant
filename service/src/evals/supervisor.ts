import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EvalStore } from "./store";
import { isDue, localDay } from "./analytics";
import type { EvalBatch } from "./types";
import type { EvalJob } from "./worker";

export class EvalSupervisor {
  private child?: ChildProcess;
  private launching = false;
  private timer?: NodeJS.Timeout;
  constructor(readonly store = new EvalStore()) {}
  async launch(input: Omit<EvalJob, "id" | "status">): Promise<EvalJob> {
    if (this.child || this.launching) throw new Error("An offline eval is already running");
    this.launching = true;
    try {
      const job: EvalJob = { ...input, id: randomUUID(), status: "queued" };
      await this.store.write("jobs", job);
      const source = __filename.endsWith(".ts");
      const child = fork(path.join(__dirname, `worker.${source ? "ts" : "js"}`), ["job", job.id], {
        execArgv: source ? ["--import", "tsx"] : [], stdio: "ignore",
        env: { ...process.env, OFFLINE_EVAL_DIR: this.store.directory },
      });
      this.child = child;
      child.once("error", error => { void this.failedJob(job, error.message); });
      child.once("exit", code => {
        this.child = undefined;
        if (code !== 0) void this.failedJob(job, "Offline eval worker exited before successful completion");
      });
      return job;
    } finally { this.launching = false; }
  }
  private async failedJob(job: EvalJob, message: string) {
    const saved = await this.store.read<EvalJob>("jobs", job.id);
    if (saved?.status === "failed" || saved?.status === "completed") return;
    await this.store.write("jobs", { ...saved, ...job, status: "failed", error: message } as EvalJob);
    await this.store.alert({ id: randomUUID(), key: "tv:worker-failure", batchId: job.id, createdAt: new Date().toISOString(), kind: "incomplete", message, runIds: [] });
  }
  async tick(now = new Date()): Promise<void> {
    if (this.child || this.launching || !isDue(now)) return;
    const day = localDay(now);
    if ((await this.store.list<EvalBatch>("batches")).some(b => b.attempt === "scheduled" && b.scheduledDay === day)) return;
    // Failed startup attempts are retained too; never loop on a broken configuration.
    if ((await this.store.list<EvalJob>("jobs")).some(j => j.scheduledDay === day)) return;
    await this.launch({ mode: "simulated", scheduledDay: day });
  }
  start(): void {
    if (this.timer || process.env.OFFLINE_EVAL_ENABLED === "false") return;
    const check = () => { void this.tick().catch(error => console.error("[Offline eval scheduler]", error)); };
    this.timer = setInterval(check, 30_000); this.timer.unref(); check();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.child?.kill("SIGTERM"); }
}
