import { EVAL_TIMEZONE, shiftDay } from "./analytics";
import type { EvalStore } from "./store";
import type { SessionDiscovery } from "./sessions";
import type { EvalBatch, RecordedSessionHistory } from "./types";
import type { EvalJob } from "./worker";

export interface RecordedScheduleEnablement {
  id: "recorded";
  enabledAt: string;
}

export interface RecordedDailyOutcome {
  id: string;
  mode: "recorded";
  day: string;
  status: "queued" | "running" | "completed" | "failed" | "empty" | "incomplete_discovery";
  selectedCount: number;
  sessionIds: string[];
  warnings: string[];
  createdAt: string;
  finishedAt?: string;
  jobId?: string;
  error?: string;
}

export interface EvalScheduleStatus {
  timezone: typeof EVAL_TIMEZONE;
  simulated: { enabled: boolean; hour: 3 };
  recorded: { enabled: boolean; hour: 1; enabledAt?: string; latest?: RecordedDailyOutcome };
}

export interface EvalScheduleConfiguration {
  simulated: boolean;
  recorded: boolean;
}

export function scheduleConfiguration(env: NodeJS.ProcessEnv = process.env): EvalScheduleConfiguration {
  const enabled = env.OFFLINE_EVAL_ENABLED !== "false";
  return { simulated: enabled, recorded: enabled && env.OFFLINE_RECORDED_EVAL_ENABLED !== "false" };
}

export function scheduledIdentity(mode: "simulated" | "recorded", day: string): string {
  return `${mode}-${day}`;
}

export function recordedSelection(
  discovery: SessionDiscovery,
  histories: Map<string, RecordedSessionHistory>,
  enabledAt: string,
  now: Date,
): { sessionIds: string[]; warnings: string[] } {
  const cutoff = Date.parse(enabledAt), current = now.getTime();
  if (!Number.isFinite(cutoff) || !Number.isFinite(current)) throw new Error("Invalid recorded scheduling timestamp");
  const warnings = [...discovery.warnings];
  const eligible = discovery.sessions.filter(session => {
    if (session.agentId !== "tv") return false;
    const started = Date.parse(session.startedAt);
    if (!Number.isFinite(started)) {
      warnings.push(`Skipping session ${JSON.stringify(session.sessionId)}: invalid or missing start time; automatic eligibility is unknown.`);
      return false;
    }
    return started >= cutoff && started <= current &&
      ["completed", "error", "failed"].includes(session.status) &&
      /^[a-zA-Z0-9_-]+$/.test(session.sessionId) &&
      !histories.get(session.sessionId)?.attempts.some(attempt => (attempt.agentId || attempt.run?.agentId || "tv") === "tv");
  }).sort((left, right) =>
    Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.sessionId.localeCompare(right.sessionId));
  return { sessionIds: [...new Set(eligible.map(session => session.sessionId))].slice(0, 100), warnings };
}

export function simulatedSkippedDays(batches: EvalBatch[], scheduledDay: string, agentId = "tv"): string[] {
  const days = batches.filter(batch => (batch.agentId || "tv") === agentId && batch.mode === "simulated" && batch.attempt === "scheduled" &&
    batch.scheduledDay && batch.scheduledDay < scheduledDay).map(batch => batch.scheduledDay!).sort();
  const skipped: string[] = [];
  for (let day = days.length ? shiftDay(days[days.length - 1], 1) : scheduledDay; day < scheduledDay; day = shiftDay(day, 1)) {
    skipped.push(day);
  }
  return skipped;
}

export function outcomeForJob(outcome: RecordedDailyOutcome, job?: EvalJob, admissionInProgress = false): RecordedDailyOutcome {
  if (!outcome.jobId || !["queued", "running"].includes(outcome.status)) return outcome;
  if (!job && outcome.status === "queued" && admissionInProgress) return outcome;
  if (!job) return {
    ...outcome, status: "failed", error: "Recorded schedule was interrupted before its job was saved; retry explicitly",
  };
  return {
    ...outcome, status: job.status || outcome.status, error: job.error,
    finishedAt: job.finishedAt || outcome.finishedAt,
  };
}

export async function updateRecordedDailyOutcome(store: EvalStore, job: EvalJob): Promise<void> {
  if (job.mode !== "recorded" || (job.agentId || "tv") !== "tv" || !job.scheduledDay) return;
  const outcome = await store.read<RecordedDailyOutcome>("schedule-days", scheduledIdentity("recorded", job.scheduledDay));
  if (outcome?.jobId === job.id) await store.write("schedule-days", outcomeForJob(outcome, job));
}
