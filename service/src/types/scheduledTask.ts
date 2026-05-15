/**
 * ScheduledTask domain types.
 * See CONTEXT.md for terminology.
 */

export type ScheduledTaskCategory =
  | "general"
  | "medication"
  | "meeting"
  | "task"
  | "appointment"
  | "birthday"
  | "bill"
  | "exercise"
  | "meal"
  | "home_automation";

export type ScheduledTaskPriority = "low" | "medium" | "high" | "urgent";

export type RecurrencePattern = {
  type: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
};

export type ScheduledTaskEffect =
  | { kind: "announcement" }
  | {
      kind: "action";
      /** Natural-language command scoped to a resolved entity, e.g. "start roborock vacuum". */
      command: string;
      /** The HA entity the agent resolved at create time. */
      entityId: string;
    };

export interface ScheduledTask {
  id: string;
  /** Cosmos partition key value. */
  recurrenceFamilyId: string;
  title: string;
  description?: string;
  effect: ScheduledTaskEffect;
  /** ISO-8601 absolute timestamp for when this occurrence fires. */
  dueDate: string;
  isRecurring: boolean;
  recurringPattern?: RecurrencePattern;
  status: "active";
  category: ScheduledTaskCategory;
  priority: ScheduledTaskPriority;
  createdAt: string;
  updatedAt: string;
}

export type ScheduledTaskRunOutcome =
  | "succeeded"
  | "failed"
  | "skipped"
  | "aborted_by_agent";

export interface ScheduledTaskRun {
  id: string;
  /** Cosmos partition key value — same as the source task's family. */
  recurrenceFamilyId: string;
  scheduledTaskId: string;
  firedAt: string;
  effect: ScheduledTaskEffect;
  outcome: ScheduledTaskRunOutcome;
  /** Human-readable summary of what happened. */
  summary: string;
  /** Optional snapshot of relevant device state at fire time. */
  deviceStateAtFire?: Record<string, unknown>;
  durationMs?: number;
}
