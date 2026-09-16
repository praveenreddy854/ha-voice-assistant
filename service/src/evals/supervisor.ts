import { fork, type ChildProcess } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EvalStore, processIsRunning } from "./store";
import { EVAL_TIMEZONE, isDue, localDay } from "./analytics";
import { discoverRecordedSessions, type SessionDiscovery } from "./sessions";
import { recordedHistories } from "./history";
import {
  outcomeForJob, recordedSelection, scheduleConfiguration, scheduledIdentity,
  type EvalScheduleConfiguration, type EvalScheduleStatus, type RecordedDailyOutcome, type RecordedScheduleEnablement,
} from "./scheduling";
import type { EvalBatch } from "./types";
import type { EvalJob } from "./worker";

function spawnWorker(job: EvalJob, directory: string): ChildProcess {
  const source = __filename.endsWith(".ts");
  return fork(path.join(__dirname, `worker.${source ? "ts" : "js"}`), ["job", job.id], {
    execArgv: source ? ["--import", "tsx"] : [], stdio: "ignore",
    env: { ...process.env, OFFLINE_EVAL_DIR: directory },
  });
}
type JobInput = Pick<EvalJob, "mode" | "sessionIds" | "scenarioIds" | "model" | "scheduledDay" | "requestId">;
export interface EvalSupervisorDependencies {
  now?: () => Date;
  discover?: () => Promise<SessionDiscovery>;
  configuration?: () => EvalScheduleConfiguration;
}
interface ScheduledAdmission { now: Date; enabledAt?: string }

export class EvalSupervisor {
  private child?: ChildProcess;
  private launching = false;
  private timer?: NodeJS.Timeout;
  private recovery: Promise<void> = Promise.resolve();
  private initialization: Promise<void> = Promise.resolve();
  private enabledAt?: string;
  private polling = false;
  private readonly now: () => Date;
  private readonly discover: () => Promise<SessionDiscovery>;
  private readonly configuration: () => EvalScheduleConfiguration;
  constructor(readonly store = new EvalStore(), private readonly spawn = spawnWorker, dependencies: EvalSupervisorDependencies = {}) {
    this.now = dependencies.now || (() => new Date());
    this.discover = dependencies.discover || discoverRecordedSessions;
    this.configuration = dependencies.configuration || scheduleConfiguration;
  }
  private async initializeRecordedSchedule(now: Date): Promise<void> {
    if (!this.configuration().recorded || this.enabledAt) return;
    const saved = await this.store.writeOnce<RecordedScheduleEnablement>("schedules", {
      id: "recorded", enabledAt: now.toISOString(),
    });
    if (!Number.isFinite(Date.parse(saved.enabledAt))) throw new Error("Invalid persisted recorded scheduling cutoff");
    this.enabledAt = saved.enabledAt;
  }
  async scheduleStatus(): Promise<EvalScheduleStatus> {
    const configuration = this.configuration();
    const [enablement, outcomes] = await Promise.all([
      this.store.read<RecordedScheduleEnablement>("schedules", "recorded"),
      this.store.list<RecordedDailyOutcome>("schedule-days"),
    ]);
    let latest = outcomes.filter(outcome => outcome.mode === "recorded").sort((a, b) => b.day.localeCompare(a.day))[0];
    if (latest?.jobId) {
      const job = await this.store.read<EvalJob>("jobs", latest.jobId);
      latest = outcomeForJob(latest, job, !job && (this.launching || await this.store.submissionIsActive()));
    }
    return {
      timezone: EVAL_TIMEZONE, simulated: { enabled: configuration.simulated, hour: 3 },
      recorded: { enabled: configuration.recorded, hour: 1, enabledAt: enablement?.enabledAt, latest },
    };
  }
  async busy(): Promise<boolean> {
    await this.recovery;
    await this.store.recoverInterruptedJobs();
    return this.child !== undefined || this.launching || await this.store.submissionIsActive() || await this.persistedBusy();
  }
  private async persistedBusy(): Promise<boolean> {
    if (await this.store.workerIsActive()) return true;
    return (await this.store.list<EvalJob>("jobs")).some(job =>
      (job.status === "queued" || job.status === "running") && processIsRunning(job.workerPid || job.ownerPid));
  }
  private async previousSubmission(input: JobInput): Promise<EvalJob | undefined> {
    if (!input.requestId) return undefined;
    const previous = await this.store.read<EvalJob>("jobs", input.requestId);
    if (previous && (previous.mode !== input.mode || JSON.stringify(previous.sessionIds) !== JSON.stringify(input.sessionIds))) {
      throw new Error("This submission ID was already used for a different selection");
    }
    return previous;
  }
  async launch(input: JobInput): Promise<EvalJob> {
    if (input.mode === "recorded" && (!input.sessionIds?.length || input.sessionIds.length > 100
      || new Set(input.sessionIds).size !== input.sessionIds.length
      || input.sessionIds.some(id => !/^[a-zA-Z0-9_-]+$/.test(id)))) throw new Error("Select 1 to 100 unique valid session IDs");
    const job = await this.submit(input);
    if (!job) throw new Error("Offline eval submission was not accepted");
    return job;
  }
  private async alreadyScheduled(mode: "simulated" | "recorded", day: string): Promise<boolean> {
    const [batches, jobs] = await Promise.all([this.store.list<EvalBatch>("batches"), this.store.list<EvalJob>("jobs")]);
    return batches.some(batch => batch.mode === mode && batch.attempt === "scheduled" && batch.scheduledDay === day) ||
      jobs.some(job => job.mode === mode && job.scheduledDay === day);
  }
  private scheduleIsCurrent(mode: "simulated" | "recorded", day: string): boolean {
    const now = this.now();
    return this.configuration()[mode] && day === localDay(now) && isDue(now, mode === "recorded" ? 1 : 3);
  }
  private async submit(input: JobInput, schedule?: ScheduledAdmission): Promise<EvalJob | undefined> {
    const previous = await this.previousSubmission(input);
    if (previous) return previous;
    if (this.launching) {
      if (schedule) return;
      throw new Error("An offline eval submission is already in progress");
    }
    this.launching = true;
    let release: (() => Promise<void>) | undefined;
    let job: EvalJob | undefined;
    let outcome: RecordedDailyOutcome | undefined;
    try {
      release = await this.store.acquire("submission.lock");
      if (!release) {
        if (schedule) return;
        throw new Error("An offline eval submission is already in progress");
      }
      if (schedule && (input.mode === "calibrate" || !this.scheduleIsCurrent(input.mode, input.scheduledDay!))) return;
      const previous = await this.previousSubmission(input);
      if (previous) return previous;
      if (schedule && input.mode === "recorded") {
        const id = scheduledIdentity("recorded", input.scheduledDay!);
        const previousOutcome = await this.store.read<RecordedDailyOutcome>("schedule-days", id);
        if (previousOutcome) {
          if (previousOutcome.status === "queued" || previousOutcome.status === "running") {
            await this.recovery;
            await this.store.recoverInterruptedJobs();
            const savedJob = previousOutcome.jobId ? await this.store.read<EvalJob>("jobs", previousOutcome.jobId) : undefined;
            const resolved = outcomeForJob(previousOutcome, savedJob);
            if (resolved.status !== previousOutcome.status) await this.store.write("schedule-days", resolved);
          }
          return;
        }
        outcome = {
          id, mode: "recorded", day: input.scheduledDay!, status: "queued", selectedCount: 0,
          sessionIds: [], warnings: [], createdAt: schedule.now.toISOString(),
        };
      }
      await this.recovery;
      if (schedule && input.mode !== "calibrate" && await this.alreadyScheduled(input.mode, input.scheduledDay!)) return;
      await this.store.recoverInterruptedJobs();
      if (this.child || await this.persistedBusy()) {
        if (schedule) return;
        throw new Error("An offline eval is already running");
      }
      if (outcome) {
        const discovery = await this.discover();
        outcome.warnings = [...discovery.warnings];
        // Read resolved history under the same lock as portal admission, never its cached UI status.
        const histories = await recordedHistories(this.store);
        if (!this.scheduleIsCurrent("recorded", input.scheduledDay!)) return;
        const { sessionIds, warnings } = recordedSelection(discovery, histories, schedule!.enabledAt!, this.now());
        outcome.warnings = warnings;
        outcome.sessionIds = sessionIds;
        outcome.selectedCount = sessionIds.length;
        if (!sessionIds.length) {
          outcome.status = outcome.warnings.length ? "incomplete_discovery" : "empty";
          outcome.finishedAt = this.now().toISOString();
          await this.store.write("schedule-days", outcome);
          return;
        }
        input = { ...input, sessionIds };
      }
      if (schedule && (input.mode === "calibrate" || !this.scheduleIsCurrent(input.mode, input.scheduledDay!))) return;
      job = {
        ...input, id: input.requestId || (schedule ? `scheduled-${input.mode}-${input.scheduledDay}` : randomUUID()),
        attempt: input.scheduledDay ? "scheduled" : "on_demand",
        status: "queued", createdAt: this.now().toISOString(), ownerPid: process.pid,
      };
      if (outcome) {
        outcome.jobId = job.id;
        await this.store.write("schedule-days", outcome);
      }
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
      const message = error instanceof Error ? error.message : String(error);
      try {
        if (job) await this.store.failJob(job, message);
      } finally {
        if (outcome) await this.store.write<RecordedDailyOutcome>("schedule-days", {
          ...outcome, status: "failed", error: message, finishedAt: this.now().toISOString(),
        });
      }
      if (outcome) return;
      throw error;
    } finally {
      try { await release?.(); } finally { this.launching = false; }
    }
  }
  async tick(now = this.now()): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      await this.initialization;
      await this.initializeRecordedSchedule(now);
      const configuration = this.configuration(), day = localDay(now);
      if (configuration.recorded && isDue(now, 1)) {
        await this.submit({ mode: "recorded", scheduledDay: day }, { now, enabledAt: this.enabledAt });
      }
      if (configuration.simulated && isDue(now)) await this.submit({ mode: "simulated", scheduledDay: day }, { now });
    } finally {
      this.polling = false;
    }
  }
  start(): void {
    if (this.timer) return;
    // Capture the first effectively enabled startup, even when nothing is due or the worker is busy.
    this.initialization = this.initializeRecordedSchedule(this.now());
    void this.initialization.catch(error => console.error("[Offline eval schedule initialization]", error));
    this.recovery = this.recovery.then(() => this.store.recoverInterruptedJobs());
    void this.recovery.catch(error => console.error("[Offline eval recovery]", error));
    const configuration = this.configuration();
    if (!configuration.simulated && !configuration.recorded) return;
    const check = () => { void this.tick().catch(error => console.error("[Offline eval scheduler]", error)); };
    this.timer = setInterval(check, 30_000); this.timer.unref(); check();
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.child?.kill("SIGTERM");
  }
}
