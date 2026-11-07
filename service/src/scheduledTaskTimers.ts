import type { ScheduledTask } from "./types/scheduledTask";

interface TimerDependencies {
  list(): Promise<ScheduledTask[]>;
  fire(task: ScheduledTask): Promise<void | boolean>;
  skip(task: ScheduledTask, reason: string): Promise<void | boolean>;
  changed(listener: () => void): () => void;
  error(error: unknown): void;
  now?: () => number;
}

/** Durable rows own timing; local timers are rebuilt on startup, mutations and reconciliation. */
export class ScheduledTaskTimers {
  private stopped = true;
  private timers: NodeJS.Timeout[] = [];
  private interval?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private refreshing?: Promise<void>;
  private again = false;
  private active = new Set<string>();
  private readonly now: () => number;
  constructor(private readonly dependencies: TimerDependencies) { this.now = dependencies.now || (() => Date.now()); }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.unsubscribe = this.dependencies.changed(() => { void this.refresh().catch(this.dependencies.error); });
    this.interval = setInterval(() => { void this.refresh().catch(this.dependencies.error); }, 30_000);
    this.interval.unref?.();
    void this.refresh().catch(this.dependencies.error);
  }
  stop(): void {
    this.stopped = true; this.unsubscribe?.(); clearInterval(this.interval);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  async refresh(): Promise<void> {
    if (this.stopped) return;
    if (this.refreshing) { this.again = true; return this.refreshing; }
    this.refreshing = (async () => {
      do {
        this.again = false;
        const tasks = await this.dependencies.list();
        if (this.stopped) return;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers = [];
        const groups = new Map<string, ScheduledTask[]>();
        for (const task of tasks) {
          if (!Number.isFinite(Date.parse(task.dueDate))) { this.dependencies.error(new Error(`Invalid due date for task ${task.id}`)); continue; }
          const key = `${task.recurrenceFamilyId}/${task.sequenceId || task.id}`;
          groups.set(key, [...(groups.get(key) || []), task]);
        }
        for (const [key, group] of groups) {
          if (this.active.has(key)) continue;
          group.sort((a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate));
          const due = group.filter(task => Date.parse(task.dueDate) <= this.now());
          // After downtime, never replay an obsolete start after its shutoff is already due.
          const target = due.at(-1) || group[0];
          const obsolete = due.slice(0, -1);
          const milliseconds = Date.parse(target.dueDate) - this.now();
          if (milliseconds <= 0) this.execute(key, target, obsolete);
          else {
            const timer = setTimeout(() => {
              if (this.stopped) return;
              if (Date.parse(target.dueDate) > this.now()) void this.refresh().catch(this.dependencies.error);
              else this.execute(key, target, []);
            }, Math.min(milliseconds, 2_147_483_647));
            timer.unref?.(); this.timers.push(timer);
          }
        }
      } while (this.again && !this.stopped);
    })();
    try { await this.refreshing; } finally { this.refreshing = undefined; }
  }

  private execute(key: string, task: ScheduledTask, obsolete: ScheduledTask[]): void {
    if (this.stopped || this.active.has(key)) return;
    this.active.add(key);
    let completed = false;
    void (async () => {
      for (const older of obsolete) if (await this.dependencies.skip(older, "A later timed phase is already due; this obsolete phase was not replayed") === false) return;
      completed = await this.dependencies.fire(task) !== false;
    })().catch(this.dependencies.error).finally(() => {
      this.active.delete(key);
      // A storage failure is retried by reconciliation, not a tight execution loop.
      if (completed && !this.stopped) void this.refresh().catch(this.dependencies.error);
    });
  }
}
