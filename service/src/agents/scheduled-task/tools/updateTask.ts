import { z } from "zod";
import { updateScheduledTask } from "../../../cosmos";

const recurrenceSchema = z.object({
  type: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().positive(),
});

const announcementEffect = z.object({
  kind: z.literal("announcement"),
});

const actionEffect = z.object({
  kind: z.literal("action"),
  command: z.string(),
  entityId: z.string(),
});

export const inputSchema = z.object({
  id: z.string().describe("The task's id (from list_scheduled_tasks)."),
  recurrenceFamilyId: z
    .string()
    .describe(
      "The task's recurrenceFamilyId (from list_scheduled_tasks). Required for partition key."
    ),
  patch: z
    .object({
      title: z.string().optional(),
      description: z.string().optional(),
      effect: z.union([announcementEffect, actionEffect]).optional(),
      dueDate: z
        .string()
        .optional()
        .describe(
          "Absolute ISO-8601 timestamp. Convert relative phrases against the current date/time in the system prompt."
        ),
      isRecurring: z.boolean().optional(),
      recurringPattern: recurrenceSchema.optional(),
      category: z
        .enum([
          "general",
          "medication",
          "meeting",
          "task",
          "appointment",
          "birthday",
          "bill",
          "exercise",
          "meal",
          "home_automation",
        ])
        .optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
    })
    .describe("Only the fields the user wants to change. Omit unchanged fields."),
});

export type UpdateScheduledTaskInput = z.infer<typeof inputSchema>;

export async function execute(args: UpdateScheduledTaskInput): Promise<{
  observation: string;
}> {
  const { id, recurrenceFamilyId, patch } = inputSchema.parse(args);
  if (Object.keys(patch).length === 0) {
    return { observation: "Patch is empty; nothing to update." };
  }
  const updated = await updateScheduledTask(id, recurrenceFamilyId, patch);
  if (!updated) {
    return {
      observation: `No task found with id=${id} familyId=${recurrenceFamilyId}, or Cosmos is not configured.`,
    };
  }
  return {
    observation: `Updated task id=${updated.id}: title="${updated.title}", due=${updated.dueDate}, effect=${updated.effect.kind}, recurring=${updated.isRecurring}.`,
  };
}

export const definition = {
  name: "update_scheduled_task",
  description:
    "Modify an existing ScheduledTask. Pass id + recurrenceFamilyId (from list_scheduled_tasks) and a patch object with only the fields to change. Common edits: dueDate (move time), recurringPattern (change schedule), title (rename).",
  inputSchema,
};
