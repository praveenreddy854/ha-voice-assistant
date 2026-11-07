import { randomUUID } from "crypto";
import { z } from "zod";
import { upsertScheduledTask, createScheduledTaskSequence } from "../../../cosmos";
import { dueDateSchema } from "./dueDate";
import { planScheduledTasks, containsInlineDelay } from "../taskPlan";
import { getRequestContext } from "../../../requestContext";
import type { ScheduledTask } from "../../../types/scheduledTask";

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
  dueDate: dueDateSchema.optional(),
  delaySeconds: z.number().int().min(0).max(31_536_000).optional().describe(
    "For relative requests use this instead of dueDate. The server adds seconds to the original request receipt, even after retries or pauses. Zero means execute as soon as saved."
  ),
  followUpActions: z.array(z.object({
    afterSeconds: z.number().int().positive().max(31_536_000),
    command: z.string().trim().min(1).describe("One immediate action on the same resolved entity; no embedded waits."),
  }).strict()).min(1).max(8).optional().describe(
    "One-shot timed phases on this same entity, at increasing offsets from the first scheduled action. For 'cool for five minutes then turn off', persist turn-off with afterSeconds=300. All phases are saved atomically."
  ),
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
}).superRefine((input, context) => {
  if ((input.effect.kind === "action" && containsInlineDelay(input.effect.command)) || input.followUpActions?.some(phase => containsInlineDelay(phase.command))) context.addIssue({ code: "custom", message: "Embedded waits are not executable scheduled phases; use followUpActions with explicit offsets" });
  if ((input.dueDate === undefined) === (input.delaySeconds === undefined)) context.addIssue({ code: "custom", message: "Provide exactly one of dueDate or delaySeconds" });
  if (input.followUpActions && (input.effect.kind !== "action" || input.isRecurring)) context.addIssue({ code: "custom", message: "Timed action sequences require a one-shot action; recurring sequences are not supported" });
  if (input.followUpActions?.some((phase, index, all) => index > 0 && phase.afterSeconds <= all[index - 1].afterSeconds)) context.addIssue({ code: "custom", message: "Follow-up offsets must strictly increase" });
});

export type SaveScheduledTaskInput = z.infer<typeof inputSchema>;

export async function execute(args: SaveScheduledTaskInput): Promise<{
  saved: ScheduledTask | null;
  savedTasks?: ScheduledTask[];
  observation: string;
  toolSuccess: boolean;
}> {
  const parsed = inputSchema.parse(args);
  if (parsed.isRecurring && !parsed.recurringPattern) {
    return {
      saved: null,
      toolSuccess: false,
      observation:
        "Cannot save: isRecurring is true but recurringPattern was not provided.",
    };
  }

  const now = new Date();
  const id = randomUUID();
  const recurrenceFamilyId = randomUUID();

  const plan = planScheduledTasks(parsed, { now, receivedAt: getRequestContext()?.receivedAt || now.toISOString(), id, recurrenceFamilyId });
  if (!plan.tasks) return { saved: null, observation: `Cannot save: ${plan.error}`, toolSuccess: false };
  const task = plan.tasks[0];

  const savedTasks = plan.tasks.length > 1 ? await createScheduledTaskSequence(plan.tasks) : undefined;
  const saved = savedTasks ? savedTasks[0] : plan.tasks.length > 1 ? null : await upsertScheduledTask(task);
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
    ...(savedTasks ? { savedTasks } : {}),
    toolSuccess: true,
    observation:
      `Saved ScheduledTask id=${saved.id} title="${saved.title}" ` +
      `effect=${saved.effect.kind}` +
      (saved.effect.kind === "action" ? ` entityId=${saved.effect.entityId}` : "") +
      ` dueDate=${saved.dueDate} recurring=${saved.isRecurring}.` +
      (savedTasks ? ` All ${savedTasks.length} timed phases persisted: ${savedTasks.map(phase => `${phase.dueDate}: ${phase.effect.kind === "action" ? phase.effect.command : phase.title}`).join("; ")}.` : ""),
  };
}

export const definition = {
  name: "save_scheduled_task",
  description:
    "Persist a ScheduledTask. For relative time supply delaySeconds; the server anchors it to request receipt. For absolute time supply dueDate. Timed one-shot phases use followUpActions and are persisted atomically on the same entity. Resolve the action entity first. Generates IDs server-side.",
  inputSchema,
};
