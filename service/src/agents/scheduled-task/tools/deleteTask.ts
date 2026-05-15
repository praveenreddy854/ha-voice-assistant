import { z } from "zod";
import {
  deleteScheduledTask,
  deleteRecurrenceFamily,
} from "../../../cosmos";

export const inputSchema = z.object({
  scope: z
    .enum(["occurrence", "family"])
    .describe(
      "'occurrence' deletes a single ScheduledTask row (one fire). 'family' deletes every row sharing the recurrenceFamilyId — i.e. stops a recurring instruction entirely."
    ),
  id: z
    .string()
    .optional()
    .describe(
      "Task id. Required when scope='occurrence'. Ignored when scope='family'."
    ),
  recurrenceFamilyId: z
    .string()
    .describe(
      "The recurrenceFamilyId. Required for both scopes (used as partition key for occurrence and as the family target for family)."
    ),
});

export type DeleteScheduledTaskInput = z.infer<typeof inputSchema>;

export async function execute(args: DeleteScheduledTaskInput): Promise<{
  observation: string;
}> {
  const { scope, id, recurrenceFamilyId } = inputSchema.parse(args);

  if (scope === "occurrence") {
    if (!id) {
      return {
        observation:
          "Cannot delete: scope='occurrence' requires id. Use list_scheduled_tasks to find it.",
      };
    }
    const ok = await deleteScheduledTask(id, recurrenceFamilyId);
    return {
      observation: ok
        ? `Deleted occurrence id=${id} from family ${recurrenceFamilyId}.`
        : `Failed to delete occurrence id=${id}. The task may already be gone.`,
    };
  }

  const deleted = await deleteRecurrenceFamily(recurrenceFamilyId);
  return {
    observation: `Deleted ${deleted} occurrence(s) from family ${recurrenceFamilyId}. Recurrence stopped.`,
  };
}

export const definition = {
  name: "delete_scheduled_task",
  description:
    "Cancel a ScheduledTask. Scope='occurrence' removes a single dated instance; scope='family' stops an entire recurring instruction. Always call list_scheduled_tasks first to identify the right id and recurrenceFamilyId.",
  inputSchema,
};
