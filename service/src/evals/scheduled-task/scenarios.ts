import type { EntityMatch } from "../../agents/scheduled-task/tools/findMatchingEntities";
import type { SaveScheduledTaskInput } from "../../agents/scheduled-task/tools/saveScheduledTask";
import type { MemoryScopes, MemoryType } from "../../memory";
import type { ScheduledTask } from "../../types/scheduledTask";
import type { Scenario } from "../types";

export interface ScheduledTaskMemory {
  id: string;
  text: string;
  memoryType: MemoryType;
  source: "explicit" | "inferred";
  confidence: number;
  scopes: MemoryScopes;
  updatedAt: string;
}

export interface ScheduledTaskMutation {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ScheduledTaskExpectation {
  tasks: ScheduledTask[];
  mutations: ScheduledTaskMutation[];
  fulfillable: boolean;
  requiresList?: boolean;
  answer?: string;
}

export interface ScheduledTaskState {
  now: string;
  timeZone: string;
  tasks: ScheduledTask[];
  entities: EntityMatch[];
  memories: ScheduledTaskMemory[];
  storage: "available" | "unavailable" | "write_failure";
  expected: ScheduledTaskExpectation;
}

export const SCHEDULED_TASK_REFERENCE_NOW = "2026-03-07T12:00:00.000Z";
export const SCHEDULED_TASK_TIME_ZONE = "America/New_York";

const entities: EntityMatch[] = [
  { entityId: "vacuum.roborock_downstairs", friendlyName: "Downstairs Roborock vacuum", domain: "vacuum", state: "docked" },
  { entityId: "vacuum.roborock_upstairs", friendlyName: "Upstairs Roborock vacuum", domain: "vacuum", state: "docked" },
  { entityId: "light.kitchen", friendlyName: "Kitchen light", domain: "light", state: "off" },
];
const createdAt = "2026-03-01T12:00:00.000Z";
const appointment: ScheduledTask = {
  id: "dentist", recurrenceFamilyId: "family-dentist", title: "Dentist appointment",
  description: "Unrelated appointment; leave unchanged.", effect: { kind: "announcement" },
  dueDate: "2026-04-01T09:00:00-04:00", isRecurring: false, status: "active",
  category: "appointment", priority: "medium", createdAt, updatedAt: createdAt,
};
const vacuum: ScheduledTask = {
  id: "vacuum-tomorrow", recurrenceFamilyId: "family-downstairs-vacuum", title: "Run downstairs Roborock",
  description: "Keep the pet area clean.",
  effect: { kind: "action", command: "start the downstairs Roborock vacuum", entityId: "vacuum.roborock_downstairs" },
  dueDate: "2026-03-08T09:00:00-04:00", isRecurring: true, recurringPattern: { type: "daily", interval: 1 },
  status: "active", category: "home_automation", priority: "high", createdAt, updatedAt: createdAt,
};
const nextVacuum: ScheduledTask = { ...vacuum, id: "vacuum-next-day", dueDate: "2026-03-09T09:00:00-04:00" };
const upstairsVacuum: ScheduledTask = {
  ...vacuum, id: "upstairs-vacuum", recurrenceFamilyId: "family-upstairs-vacuum", title: "Run upstairs Roborock",
  description: "Do not cancel with downstairs tasks.",
  effect: { kind: "action", command: "start the upstairs Roborock vacuum", entityId: "vacuum.roborock_upstairs" },
  dueDate: "2026-03-08T10:00:00-04:00",
};
const medicine: ScheduledTask = {
  ...appointment, id: "medicine-today", recurrenceFamilyId: "family-medicine", title: "Take medicine",
  description: "After breakfast.", dueDate: "2026-03-07T09:00:00-05:00", category: "medication", priority: "high",
};
const bill: ScheduledTask = {
  ...appointment, id: "bill-today", recurrenceFamilyId: "family-bill", title: "Pay electricity bill",
  description: "Monthly bill.", dueDate: "2026-03-07T18:00:00-05:00", category: "bill",
};
const recurringTasks = [nextVacuum, upstairsVacuum, vacuum, appointment];

function newTask(input: SaveScheduledTaskInput, now: string): ScheduledTask {
  return {
    ...input, id: "eval-task-1", recurrenceFamilyId: "eval-family-1",
    status: "active", createdAt: now, updatedAt: now,
  };
}

function scenario(options: {
  id: string;
  task: string;
  request: string;
  expectations: string;
  tasks?: ScheduledTask[];
  now?: string;
  storage?: ScheduledTaskState["storage"];
  expected: ScheduledTaskExpectation;
}): Scenario<ScheduledTaskState> {
  const now = options.now || SCHEDULED_TASK_REFERENCE_NOW;
  return {
    id: options.id, version: "1", request: options.request,
    context: {
      task: options.task, target: "scheduled_tasks", app: "ScheduledTask",
      startingState: options.storage === "write_failure" ? "storage_write_failure" : options.id,
    },
    expectations: `${options.expectations} The fixture clock is fixed at ${now} (${SCHEDULED_TASK_TIME_ZONE}), including retries and confirmations. Verify every stored field and leave all unrelated rows and memory unchanged. A correct refusal or clarification does not fulfill an impossible or unresolved scheduling request.`,
    initial: structuredClone({
      now, timeZone: SCHEDULED_TASK_TIME_ZONE, tasks: options.tasks || [appointment],
      entities, memories: [], storage: options.storage || "available", expected: options.expected,
    }),
  };
}

const absoluteInput: SaveScheduledTaskInput = {
  title: "Take medicine", effect: { kind: "announcement" }, dueDate: "2026-03-07T09:00:00-05:00",
  isRecurring: false, category: "medication", priority: "high",
};
const relativeNow = "2026-03-08T06:55:00.000Z";
const relativeInput: SaveScheduledTaskInput = {
  title: "Check the oven", effect: { kind: "announcement" }, dueDate: "2026-03-08T03:05:00-04:00",
  isRecurring: false, category: "task", priority: "medium",
};
const recurringInput: SaveScheduledTaskInput = {
  title: "Run downstairs Roborock", description: "Resolved to the downstairs Roborock vacuum.",
  effect: { kind: "action", command: "start the downstairs Roborock vacuum", entityId: "vacuum.roborock_downstairs" },
  dueDate: "2026-03-08T09:00:00-04:00", isRecurring: true, recurringPattern: { type: "daily", interval: 1 },
  category: "home_automation", priority: "medium",
};
const updatedDueDate = "2026-03-08T10:00:00-04:00";

export const scheduledTaskScenarios: Scenario<ScheduledTaskState>[] = [
  scenario({
    id: "announcement-at-time", task: "create_announcement",
    request: "Remind me today at 9 AM with the exact announcement title 'Take medicine'. Use medication category, high priority, no recurrence, and no description.",
    expectations: "Create exactly one announcement at 09:00 EST on March 7 (14:00Z); title Take medicine, medication/high, one-shot. Confirm only after a successful save.",
    expected: {
      tasks: [appointment, newTask(absoluteInput, SCHEDULED_TASK_REFERENCE_NOW)], fulfillable: true,
      mutations: [{ toolName: "save_scheduled_task", args: absoluteInput }],
    },
  }),
  scenario({
    id: "announcement-relative-dst", task: "create_relative_announcement", now: relativeNow,
    request: "Remind me in ten minutes with the exact announcement title 'Check the oven'. Use task category, medium priority, no recurrence, and no description.",
    expectations: "Ten minutes from 01:55 EST crosses the spring DST jump: save 03:05 EDT, March 8 (07:05Z), not 03:05 EST or tomorrow. Keep the clock fixed across model turns.",
    expected: {
      tasks: [appointment, newTask(relativeInput, relativeNow)], fulfillable: true,
      mutations: [{ toolName: "save_scheduled_task", args: relativeInput }],
    },
  }),
  scenario({
    id: "recurring-action-dst", task: "create_recurring_action",
    request: "Every day at 9 AM local time starting tomorrow, March 8, schedule the command 'start the downstairs Roborock vacuum'. Use the exact title 'Run downstairs Roborock' and description 'Resolved to the downstairs Roborock vacuum.', home_automation category and medium priority.",
    expectations: "Resolve the downstairs Roborock via find_matching_entities before saving its action. Multiple search matches do not force clarification on CREATE: choose downstairs, not upstairs. Save the first daily occurrence at 09:00 EDT March 8 (13:00Z), recurrence daily/1; do not fire HA now.",
    expected: {
      tasks: [appointment, newTask(recurringInput, SCHEDULED_TASK_REFERENCE_NOW)], fulfillable: true,
      mutations: [{ toolName: "save_scheduled_task", args: recurringInput }],
    },
  }),
  scenario({
    id: "query-today", task: "query_tasks", tasks: [vacuum, bill, medicine, appointment],
    request: "What reminders do I have today in my local timezone? Read my tasks, but change nothing. Reply only with each exact title followed by ' at HH:mm' in 24-hour local time, earliest first, separated by semicolons.",
    expectations: "List active tasks, filter March 7 in America/New_York, and answer 'Take medicine at 09:00; Pay electricity bill at 18:00'. Exclude tomorrow's vacuum and April's appointment. No mutation, including memory, is requested.",
    expected: {
      tasks: [vacuum, bill, medicine, appointment], mutations: [], fulfillable: true, requiresList: true,
      answer: "Take medicine at 09:00; Pay electricity bill at 18:00",
    },
  }),
  scenario({
    id: "update-preserve-fields", task: "update_task", tasks: recurringTasks,
    request: "Move the next downstairs Roborock run to 10 AM tomorrow, March 8. Change only its due time; leave the following occurrence and every other field unchanged.",
    expectations: "List first and select the soonest downstairs occurrence, vacuum-tomorrow. Patch only dueDate to 10:00 EDT March 8 (14:00Z). Preserve title, description, entity/command, recurrence, priority, category, IDs and createdAt; updatedAt uses the fixed clock.",
    expected: {
      tasks: recurringTasks.map(task => task.id === vacuum.id ? { ...task, dueDate: updatedDueDate, updatedAt: SCHEDULED_TASK_REFERENCE_NOW } : task),
      fulfillable: true, requiresList: true,
      mutations: [{ toolName: "update_scheduled_task", args: {
        id: vacuum.id, recurrenceFamilyId: vacuum.recurrenceFamilyId, patch: { dueDate: updatedDueDate },
      } }],
    },
  }),
  scenario({
    id: "cancel-occurrence", task: "cancel_occurrence", tasks: recurringTasks,
    request: "Cancel only tomorrow's 9 AM downstairs Roborock run on March 8, not its daily schedule or any other task.",
    expectations: "After listing, delete occurrence vacuum-tomorrow from family-downstairs-vacuum. The March 9 row in that family, upstairs schedule and unrelated appointment must remain byte-for-byte unchanged.",
    expected: {
      tasks: recurringTasks.filter(task => task.id !== vacuum.id), fulfillable: true, requiresList: true,
      mutations: [{ toolName: "delete_scheduled_task", args: {
        scope: "occurrence", id: vacuum.id, recurrenceFamilyId: vacuum.recurrenceFamilyId,
      } }],
    },
  }),
  scenario({
    id: "cancel-family", task: "cancel_family", tasks: recurringTasks,
    request: "Stop the entire daily downstairs Roborock schedule, including all its future occurrences. Do not cancel the upstairs vacuum or any other reminder.",
    expectations: "After listing, delete family-downstairs-vacuum using scope family, removing both March 8 and March 9. Deleting only one occurrence does not fulfill the request. Preserve the upstairs family and appointment.",
    expected: {
      tasks: recurringTasks.filter(task => task.recurrenceFamilyId !== vacuum.recurrenceFamilyId), fulfillable: true, requiresList: true,
      mutations: [{ toolName: "delete_scheduled_task", args: { scope: "family", recurrenceFamilyId: vacuum.recurrenceFamilyId } }],
    },
  }),
  scenario({
    id: "ambiguous-delete", task: "cancel_ambiguous_task", tasks: recurringTasks,
    request: "Cancel the vacuum.",
    expectations: "Several downstairs/upstairs occurrences match. List and ask which vacuum/date the user means with complete_task(success:false). Do not guess or delete. Clarification is correct handling, but the cancellation is not fulfilled.",
    expected: { tasks: recurringTasks, mutations: [], fulfillable: false, requiresList: true },
  }),
  scenario({
    id: "missing-entity", task: "create_missing_entity",
    request: "Schedule an action to start the pool pump today at 5 PM.",
    expectations: "Search the fixture entities; no pool pump exists. Ask for a valid device or report inability to schedule. Do not invent an entity or substitute a vacuum, light, or announcement. The requested action remains unscheduled.",
    expected: { tasks: [appointment], mutations: [], fulfillable: false },
  }),
  scenario({
    id: "past-date", task: "reject_past_date",
    request: "Create an announcement titled 'Past meeting' for exactly March 6, 2026 at 9 AM New York time. Do not substitute another date.",
    expectations: "The requested instant is past the fixed March 7 clock. Refuse or clarify; a save/update attempt must be rejected by production due-date validation. Never claim that the reminder was saved.",
    expected: { tasks: [appointment], mutations: [], fulfillable: false },
  }),
  scenario({
    id: "invalid-date", task: "reject_invalid_date",
    request: "Create an announcement titled 'Impossible date' on February 30, 2026 at 9 AM New York time. Do not roll it forward or choose another date.",
    expectations: "February 30 is not a calendar date. Ask for a valid date without saving. Do not accept Date.parse rollover to March or report creation. A malformed tool timestamp must fail closed.",
    expected: { tasks: [appointment], mutations: [], fulfillable: false },
  }),
  scenario({
    id: "storage-failure", task: "create_storage_failure", storage: "write_failure",
    request: "Remind me today at 9 AM with the exact announcement title 'Take medicine'. Use medication category, high priority, no recurrence, and no description.",
    expectations: "All storage writes fail in this fixture; reads are available. Attempt a valid save and honestly explain the persistence failure. No task was saved, even if a tool was called or the agent says success. Avoid duplicate attempts and leave existing records unchanged.",
    expected: { tasks: [appointment], mutations: [], fulfillable: false },
  }),
];
