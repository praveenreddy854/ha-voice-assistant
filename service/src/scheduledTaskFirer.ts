import { createHash } from "crypto";
import {
  deleteScheduledTask,
  insertScheduledTaskRun,
  listActiveScheduledTasks,
  upsertScheduledTask,
  claimScheduledTask,
} from "./cosmos";
import { executeHACommand, fetchAllStates } from "./ha";
import type {
  RecurrencePattern,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskRunOutcome,
} from "./types/scheduledTask";
import { emitAnnouncement } from "./announcementBus";
import { onScheduledTasksChanged } from "./scheduledTaskChanges";
import { ScheduledTaskTimers } from "./scheduledTaskTimers";


interface FireResult {
  outcome: ScheduledTaskRunOutcome;
  summary: string;
  deviceStateAtFire?: Record<string, unknown>;
}

function addRecurrence(date: Date, recurrence: RecurrencePattern): Date {
  const next = new Date(date.getTime());
  switch (recurrence.type) {
    case "daily":
      next.setDate(next.getDate() + recurrence.interval);
      break;
    case "weekly":
      next.setDate(next.getDate() + 7 * recurrence.interval);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + recurrence.interval);
      break;
    case "yearly":
      next.setFullYear(next.getFullYear() + recurrence.interval);
      break;
  }
  return next;
}

function nextDueDate(task: ScheduledTask, now: Date): string | undefined {
  if (!task.isRecurring || !task.recurringPattern) return undefined;
  if (!Number.isInteger(task.recurringPattern.interval) || task.recurringPattern.interval <= 0 || !["daily", "weekly", "monthly", "yearly"].includes(task.recurringPattern.type)) throw new Error("Invalid persisted recurrence pattern");
  let next = addRecurrence(new Date(task.dueDate), task.recurringPattern);
  while (next.getTime() <= now.getTime()) {
    next = addRecurrence(next, task.recurringPattern);
  }
  return next.toISOString();
}

async function rescheduleOrDelete(task: ScheduledTask, now: Date): Promise<void> {
  const nextDue = nextDueDate(task, now);
  if (!nextDue) {
    if (!await deleteScheduledTask(task.id, task.recurrenceFamilyId)) throw new Error("Fired task cleanup failed");
    return;
  }

  const { firing: _claim, _etag: _etag, ...recurring } = task;
  const nextTask: ScheduledTask = {
    ...recurring,
    id: createHash("sha256").update(`${task.id}:${nextDue}`).digest("hex").slice(0, 32),
    dueDate: nextDue,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  if (!await upsertScheduledTask(nextTask)) throw new Error("Next occurrence was not persisted");
  if (!await deleteScheduledTask(task.id, task.recurrenceFamilyId)) throw new Error("Fired occurrence cleanup failed");
}

async function fireAnnouncement(task: ScheduledTask): Promise<FireResult> {
  const message = task.title;
  emitAnnouncement(message);
  return { outcome: "succeeded", summary: message };
}

async function fireAction(task: ScheduledTask): Promise<FireResult> {
  const effect = task.effect;
  if (effect.kind !== "action") {
    return { outcome: "failed", summary: "Invalid action effect" };
  }

  const abortSignal = AbortSignal.timeout(60_000);
  const states = await fetchAllStates({ abortSignal });
  const entityState = states.find((s) => s.entity_id === effect.entityId);
  const deviceStateAtFire = entityState
    ? {
        entityId: entityState.entity_id,
        state: entityState.state,
        attributes: entityState.attributes,
      }
    : undefined;

  if (!entityState) {
    const summary = `${task.title} could not run because the device was not found`;
    emitAnnouncement(summary);
    return { outcome: "skipped", summary, deviceStateAtFire };
  }

  if (entityState.state === "unavailable" || entityState.state === "unknown") {
    const summary = `${task.title} could not run because the device is ${entityState.state}`;
    emitAnnouncement(summary);
    return { outcome: "skipped", summary, deviceStateAtFire };
  }

  const result = await executeHACommand(effect.command, undefined, { abortSignal });
  if (!result.success) {
    const summary = `${task.title} failed. ${result.message}`;
    emitAnnouncement(summary);
    return { outcome: "failed", summary, deviceStateAtFire };
  }

  const summary = `${task.title} done`;
  emitAnnouncement("Done");
  return { outcome: "succeeded", summary, deviceStateAtFire };
}

async function fireTask(candidate: ScheduledTask): Promise<boolean> {
  // A cancelled or edited task must not execute from an older timer snapshot.
  const claim = await claimScheduledTask(candidate.id, candidate.recurrenceFamilyId);
  if (!claim) return false;
  const task = claim.task;
  const started = Date.now();
  const now = new Date();
  let outcome: ScheduledTaskRunOutcome = "failed";
  let summary = "ScheduledTask failed";
  let deviceStateAtFire: Record<string, unknown> | undefined;

  try {
    const result: FireResult = claim.alreadyClaimed
      ? { outcome: "interrupted", summary: "The prior dispatch was interrupted or its cleanup failed; its device effect is unknown and was not replayed" }
      :
      task.effect.kind === "announcement"
        ? await fireAnnouncement(task)
        : await fireAction(task);
    outcome = result.outcome;
    summary = result.summary;
    deviceStateAtFire = result.deviceStateAtFire;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary = `${task.title} failed: ${message}`;
    emitAnnouncement(
      `${task.title} failed. Check Home Assistant and try again.`
    );
  }

  const run: ScheduledTaskRun = {
    id: task.firing!.id,
    recurrenceFamilyId: task.recurrenceFamilyId,
    scheduledTaskId: task.id,
    firedAt: now.toISOString(),
    effect: task.effect,
    outcome,
    summary,
    deviceStateAtFire,
    durationMs: Date.now() - started,
  };

  await insertScheduledTaskRun(run);
  await rescheduleOrDelete(task, now);
  return true;
}

const timers = new ScheduledTaskTimers({
  list: listActiveScheduledTasks, fire: fireTask, changed: onScheduledTasksChanged,
  error: error => console.error("[ScheduledTaskFirer]", error),
  async skip(task, summary) {
    const claim = await claimScheduledTask(task.id, task.recurrenceFamilyId);
    if (!claim) return false;
    await insertScheduledTaskRun({ id: claim.task.firing!.id, recurrenceFamilyId: task.recurrenceFamilyId,
      scheduledTaskId: task.id, firedAt: new Date().toISOString(), effect: task.effect,
      outcome: claim.alreadyClaimed ? "interrupted" : "skipped", summary });
    if (!await deleteScheduledTask(task.id, task.recurrenceFamilyId)) throw new Error("Obsolete timed phase cleanup failed");
    return true;
  },
});

export function startScheduledTaskFirer(): void {
  timers.start();
  console.log("[ScheduledTaskFirer] Started");
}
export function stopScheduledTaskFirer(): void { timers.stop(); }
