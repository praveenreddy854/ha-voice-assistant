import cron, { type ScheduledTask } from "node-cron";
import { safeErrorDetails } from "./logSanitizer";

export interface CronJob {
  id: string;
  expression: string;
  timezone?: string;
  runOnStart?: boolean;
  run(signal: AbortSignal, reason: "startup" | "scheduled"): void | Promise<void>;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Shared process-local scheduler for recurring service work, including six-field cron. */
export class CronJobScheduler {
  private readonly jobs = new Map<string, { task: ScheduledTask; controller: AbortController }>();

  constructor(private readonly onError = (id: string, error: unknown): void => {
    console.error(`[CronJobs] ${id} failed`, safeErrorDetails(error));
  }) {}

  register(job: CronJob): void {
    if (this.jobs.has(job.id)) return;
    if (!cron.validate(job.expression)) throw new Error(`Invalid cron expression for ${job.id}`);
    if (job.timezone && !isValidTimezone(job.timezone)) throw new Error(`Invalid timezone for ${job.id}`);

    const controller = new AbortController();
    let running = false;
    const run = async (reason: "startup" | "scheduled"): Promise<void> => {
      // This guard also covers the optional startup run, which isn't a cron tick.
      if (running || controller.signal.aborted) return;
      running = true;
      try {
        await job.run(controller.signal, reason);
      } catch (error) {
        if (!controller.signal.aborted) this.onError(job.id, error);
      } finally {
        running = false;
      }
    };
    const task = cron.schedule(job.expression, () => run("scheduled"), {
      name: job.id,
      timezone: job.timezone,
      noOverlap: true,
      unref: true,
    });
    this.jobs.set(job.id, { task, controller });
    if (job.runOnStart) void run("startup");
  }

  async stop(): Promise<void> {
    const jobs = [...this.jobs.values()];
    this.jobs.clear();
    for (const { controller } of jobs) controller.abort();
    await Promise.all(jobs.map(({ task }) => task.destroy()));
  }
}

export const cronJobs = new CronJobScheduler();
