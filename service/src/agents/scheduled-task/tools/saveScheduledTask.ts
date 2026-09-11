import { randomUUID } from "crypto";
import { z } from "zod";
import { upsertScheduledTask } from "../../../cosmos";
import { dueDateSchema, dueDateError } from "./dueDate";
import type {
  ScheduledTask,
  ScheduledTaskCategory,
  ScheduledTaskPriority,
} from "../../../types/scheduledTask";

const recurrenceSchema = z.object({
  type: z.enum(["daily", "weekly", "monthly", "yearly"]),
  interval: z.number().int().positive(),
});

const announcementEffect = z.object({
  kind: z.literal("announcement"),
});

const actionEffect = z.object({
  kind: z.literal("action"),
  command: z
    .string()
    .describe(
      "Natural-language command scoped to the resolved entity, e.g. 'start roborock vacuum'."
    ),
  entityId: z
    .string()
    .describe("The Home Assistant entity_id resolved via find_matching_entities."),
});

export const inputSchema = z.object({
  title: z
    .string()
    .describe("Short, user-facing label and the announcement text."),
  description: z.string().optional(),
  effect: z.union([announcementEffect, actionEffect]),
  dueDate: dueDateSchema,
  isRecurring: z.boolean(),
  recurringPattern: recurrenceSchema.optional(),
  category: z.enum([
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
  ]),
  priority: z.enum(["low", "medium", "high", "urgent"]),
});

export type SaveScheduledTaskInput = z.infer<typeof inputSchema>;

export async function execute(args: SaveScheduledTaskInput): Promise<{
  saved: ScheduledTask | null;
  observation: string;
  toolSuccess: boolean;
}> {
  const parsed = inputSchema.parse(args);
  const dateError = dueDateError(parsed.dueDate);
  if (dateError) {
    return { saved: null, observation: `Cannot save: ${dateError}`, toolSuccess: false };
  }

  if (parsed.isRecurring && !parsed.recurringPattern) {
    return {
      saved: null,
      toolSuccess: false,
      observation:
        "Cannot save: isRecurring is true but recurringPattern was not provided.",
    };
  }

  const now = new Date().toISOString();
  const id = randomUUID();
  const recurrenceFamilyId = randomUUID();

  const task: ScheduledTask = {
    id,
    recurrenceFamilyId,
    title: parsed.title,
    description: parsed.description,
    effect: parsed.effect,
    dueDate: parsed.dueDate,
    isRecurring: parsed.isRecurring,
    recurringPattern: parsed.recurringPattern,
    status: "active",
    category: parsed.category as ScheduledTaskCategory,
    priority: parsed.priority as ScheduledTaskPriority,
    createdAt: now,
    updatedAt: now,
  };

  const saved = await upsertScheduledTask(task);
  if (!saved) {
    return {
      saved: null,
      toolSuccess: false,
      observation:
        "Cosmos DB is not configured or the upsert failed. Task not saved.",
    };
  }

  return {
    saved,
    toolSuccess: true,
    observation:
      `Saved ScheduledTask id=${saved.id} title="${saved.title}" ` +
      `effect=${saved.effect.kind}` +
      (saved.effect.kind === "action" ? ` entityId=${saved.effect.entityId}` : "") +
      ` dueDate=${saved.dueDate} recurring=${saved.isRecurring}.`,
  };
}

export const definition = {
  name: "save_scheduled_task",
  description:
    "Persist a fully-specified ScheduledTask to Cosmos DB. Call this only after you have parsed the time, resolved any entity (for action effects), and chosen a category/priority. Generates id and recurrenceFamilyId server-side.",
  inputSchema,
};
