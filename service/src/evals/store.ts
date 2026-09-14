import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { EvalAlert, EvalBatch, EvalRun, StepGroup } from "./types";

export function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24);
}
export const defaultEvalDirectory = () => path.resolve(process.env.OFFLINE_EVAL_DIR || path.join(__dirname, "../../generated_data/offline-evals"));
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
    await this.write("summaries", { ...summary, request: assessment?.request, sourceSessionId: assessment?.sourceSessionId, usage: assessment?.usage });
  }
  async acquire(): Promise<(() => Promise<void>) | undefined> {
    await fs.mkdir(this.directory, { recursive: true });
    const lock = path.join(this.directory, "worker.lock");
    try {
      const handle = await fs.open(lock, "wx", 0o600);
      await handle.writeFile(String(process.pid));
      await handle.close();
      return async () => { await fs.unlink(lock).catch(() => {}); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number(await fs.readFile(lock, "utf8").catch(() => ""));
      if (!Number.isInteger(pid) || pid <= 0) return undefined;
      try { process.kill(pid, 0); return undefined; }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== "ESRCH") return undefined; }
      await fs.unlink(lock).catch(() => {});
      return this.acquire();
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
      await this.alert({ id: randomUUID(), key: `${batch.agentId}:incomplete`, batchId: batch.id, createdAt: batch.finishedAt, kind: "incomplete", message: batch.error, runIds: batch.runIds });
    }
  }
}
