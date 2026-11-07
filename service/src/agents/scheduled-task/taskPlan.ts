import type { SaveScheduledTaskInput } from "./tools/saveScheduledTask";
import { dueDateError } from "./tools/dueDate";
import type { ScheduledTask } from "../../types/scheduledTask";

export const containsInlineDelay = (command: string): boolean => /\b(?:wait|sleep|delay)\s+(?:for\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|thirty|sixty)\s*(?:seconds?|minutes?|hours?)\b/i.test(command);

/** Shared by production storage and the simulator; no clock or model supplied by a tool caller. */
export function planScheduledTasks(input: SaveScheduledTaskInput, context: {
  now: Date; receivedAt: string; id: string; recurrenceFamilyId: string;
}): { tasks: ScheduledTask[]; error?: undefined } | { tasks?: undefined; error: string } {
  const { delaySeconds, followUpActions, dueDate: absolute, ...fields } = input;
  const anchor = Date.parse(context.receivedAt);
  if (!Number.isFinite(anchor)) return { error: "Original request timestamp is unavailable" };
  if ((absolute === undefined) === (delaySeconds === undefined)) return { error: "Provide exactly one of dueDate or delaySeconds" };
  const dueDate = absolute ?? new Date(delaySeconds === 0 ? context.now : anchor + delaySeconds! * 1000).toISOString();
  const error = dueDateError(dueDate, context.now);
  if (error && delaySeconds !== 0) return { error };
  if (followUpActions && (fields.effect.kind !== "action" || fields.isRecurring)) return { error: "Timed phases require a one-shot action" };
  const now = context.now.toISOString();
  const first: ScheduledTask = {
    ...fields, dueDate, id: context.id, recurrenceFamilyId: context.recurrenceFamilyId,
    status: "active", createdAt: now, updatedAt: now,
    ...(delaySeconds !== undefined ? { timing: { requestReceivedAt: context.receivedAt, delaySeconds } } : {}),
  };
  if (!followUpActions?.length) return { tasks: [first] };
  const phases = [first, ...followUpActions.map((phase, index): ScheduledTask => ({
    ...first, id: `${context.id}-phase-${index + 1}`, title: `${first.title} — phase ${index + 2}`,
    dueDate: new Date(Date.parse(dueDate) + phase.afterSeconds * 1000).toISOString(),
    effect: { kind: "action", command: phase.command, entityId: fields.effect.kind === "action" ? fields.effect.entityId : "" },
  }))];
  return { tasks: phases.map((phase, index) => ({ ...phase, sequenceId: first.id, sequenceStep: index, sequenceLength: phases.length })) };
}
