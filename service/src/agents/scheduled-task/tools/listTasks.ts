import { z } from "zod";
import { listActiveScheduledTasks } from "../../../cosmos";
import type { ScheduledTask } from "../../../types/scheduledTask";

export const inputSchema = z.object({
  reason: z
    .string()
    .optional()
    .describe(
      "Why you need the list — e.g. 'user asked what tasks they have today', 'looking up the vacuum task to cancel it'."
    ),
});

export type ListScheduledTasksInput = z.infer<typeof inputSchema>;

export async function execute(_args: ListScheduledTasksInput): Promise<{
  tasks: ScheduledTask[];
  observation: string;
}> {
  const tasks = await listActiveScheduledTasks();
  const sorted = [...tasks].sort(
    (a, b) =>
      new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
  );

  if (sorted.length === 0) {
    return {
      tasks: sorted,
      observation: "No active scheduled tasks.",
    };
  }

  const lines = sorted.map((t) => {
    const eff =
      t.effect.kind === "action"
        ? `action(${t.effect.entityId})`
        : "announcement";
    const recur = t.isRecurring && t.recurringPattern
      ? `every ${t.recurringPattern.interval} ${t.recurringPattern.type}`
      : "one-shot";
    return `  - id=${t.id} familyId=${t.recurrenceFamilyId} title="${t.title}" due=${t.dueDate} ${eff} ${recur} category=${t.category} priority=${t.priority}`;
  });

  return {
    tasks: sorted,
    observation: `Active scheduled tasks (${sorted.length}):\n${lines.join("\n")}`,
  };
}

export const definition = {
  name: "list_scheduled_tasks",
  description:
    "Read every active ScheduledTask from Cosmos. Use before any UPDATE or DELETE so you can identify the right id and recurrenceFamilyId. Also use to answer LIST/QUERY voice requests ('what do I have today?').",
  inputSchema,
};
