import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { onlineEvalConfig, type OnlineEvalConfig } from "./config";
import { EvalStore } from "../store";

export function spawnOnlineWorker(config: OnlineEvalConfig): ChildProcess {
  const source = __filename.endsWith(".ts");
  return fork(path.join(__dirname, `worker.${source ? "ts" : "js"}`), [], {
    execArgv: source ? ["--import", "tsx"] : [], stdio: "ignore",
    env: { ...process.env, ONLINE_EVAL_DIR: config.directory },
  });
}

export class OnlineEvalSupervisor {
  private child?: ChildProcess;
  private timer?: NodeJS.Timeout;
  private killing?: NodeJS.Timeout;
  lastError?: string;
  constructor(readonly config = onlineEvalConfig(), private readonly spawn = spawnOnlineWorker) {}
  get running(): boolean { return Boolean(this.child); }
  start(): void {
    if (!this.config.enabled || this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref();
  }
  private tick(): void {
    if (this.child) return;
    try {
      const child = this.spawn(this.config);
      this.child = child;
      child.once("error", error => { this.lastError = error.message; if (this.child === child) this.child = undefined; });
      child.once("exit", (code, signal) => {
        if (this.child === child) this.child = undefined;
        if (code || signal) this.lastError = `Online worker exited (${signal || code}); interrupted grading requires explicit retry`;
      });
    } catch (error) { this.lastError = error instanceof Error ? error.message : String(error); }
  }
  stop(): void {
    clearInterval(this.timer); this.timer = undefined;
    const child = this.child;
    if (!child) return;
    child.kill("SIGTERM");
    this.killing = setTimeout(() => { if (this.child === child) child.kill("SIGKILL"); }, 5_000);
    this.killing.unref();
    child.once("exit", () => clearTimeout(this.killing));
  }
}

export const onlineSupervisor = new OnlineEvalSupervisor();
export const onlineStore = new EvalStore(onlineSupervisor.config.directory);
