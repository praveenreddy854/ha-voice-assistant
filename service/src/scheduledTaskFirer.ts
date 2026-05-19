import { randomUUID } from "crypto";
import {
  deleteScheduledTask,
  insertScheduledTaskRun,
  listActiveScheduledTasks,
  upsertScheduledTask,
} from "./cosmos";
import { executeHACommand, fetchAllStates } from "./ha";
import type {
  RecurrencePattern,
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskRunOutcome,
} from "./types/scheduledTask";
import { emitAnnouncement } from "./announcementBus";

const FIRER_INTERVAL_MS = 30_000;
const activeFires = new Set<string>();
let firerStarted = false;

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
  let next = addRecurrence(new Date(task.dueDate), task.recurringPattern);
  while (next.getTime() <= now.getTime()) {
    next = addRecurrence(next, task.recurringPattern);
  }
  return next.toISOString();
}

function shortAnnouncement(message: string): string {
  const words = message.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "Task done";
  return words.slice(0, 4).join(" ").replace(/[.!?]+$/, "");
}

async function rescheduleOrDelete(task: ScheduledTask, now: Date): Promise<void> {
  const nextDue = nextDueDate(task, now);
  if (!nextDue) {
    await deleteScheduledTask(task.id, task.recurrenceFamilyId);
    return;
  }

  const nextTask: ScheduledTask = {
    ...task,
    id: randomUUID(),
    dueDate: nextDue,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  await upsertScheduledTask(nextTask);
  await deleteScheduledTask(task.id, task.recurrenceFamilyId);
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

  const states = await fetchAllStates();
  const entityState = states.find((s) => s.entity_id === effect.entityId);
  const deviceStateAtFire = entityState
    ? {
        entityId: entityState.entity_id,
        state: entityState.state,
        attributes: entityState.attributes,
      }
    : undefined;

  if (!entityState) {
    const summary = `${task.title} unavailable`;
    emitAnnouncement(shortAnnouncement(summary));
    return { outcome: "skipped", summary, deviceStateAtFire };
  }

  if (entityState.state === "unavailable" || entityState.state === "unknown") {
    const summary = `${task.title} skipped`;
    emitAnnouncement(shortAnnouncement(summary));
    return { outcome: "skipped", summary, deviceStateAtFire };
  }

  const result = await executeHACommand(effect.command);
  if (!result.success) {
    const summary = `${task.title} failed`;
    emitAnnouncement(shortAnnouncement(summary));
    return { outcome: "failed", summary, deviceStateAtFire };
  }

  const summary = `${task.title} done`;
  emitAnnouncement(shortAnnouncement(summary));
  return { outcome: "succeeded", summary, deviceStateAtFire };
}

async function fireTask(task: ScheduledTask): Promise<void> {
  const started = Date.now();
  const now = new Date();
  let outcome: ScheduledTaskRunOutcome = "failed";
  let summary = "ScheduledTask failed";
  let deviceStateAtFire: Record<string, unknown> | undefined;

  try {
    const result =
      task.effect.kind === "announcement"
        ? await fireAnnouncement(task)
        : await fireAction(task);
    outcome = result.outcome;
    summary = result.summary;
    deviceStateAtFire = result.deviceStateAtFire;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary = `${task.title} failed: ${message}`;
    emitAnnouncement(shortAnnouncement(`${task.title} failed`));
  }

  const run: ScheduledTaskRun = {
    id: randomUUID(),
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
}

async function scanDueTasks(): Promise<void> {
  const now = Date.now();
  const tasks = await listActiveScheduledTasks();
  const due = tasks.filter((task) => new Date(task.dueDate).getTime() <= now);

  for (const task of due) {
    if (activeFires.has(task.id)) continue;
    activeFires.add(task.id);
    fireTask(task)
      .catch((err) => {
        console.error(`[ScheduledTaskFirer] Failed to fire ${task.id}:`, err);
      })
      .finally(() => {
        activeFires.delete(task.id);
      });
  }
}

export function startScheduledTaskFirer(): void {
  if (firerStarted) return;
  firerStarted = true;
  void scanDueTasks();
  setInterval(() => {
    void scanDueTasks();
  }, FIRER_INTERVAL_MS);
  console.log("[ScheduledTaskFirer] Started");
}
