import { isDeepStrictEqual } from "node:util";
import type { ToolDefinition } from "../../agents/core/agentLoop";
import type { DeleteScheduledTaskInput } from "../../agents/scheduled-task/tools/deleteTask";
import type { FindMatchingEntitiesInput } from "../../agents/scheduled-task/tools/findMatchingEntities";
import type { SaveScheduledTaskInput } from "../../agents/scheduled-task/tools/saveScheduledTask";
import type { UpdateScheduledTaskInput } from "../../agents/scheduled-task/tools/updateTask";
import type { MemoryScopes, MemoryType, MemoryWriteValidation } from "../../memory";
import type { ScheduledTask } from "../../types/scheduledTask";
import type { Evidence, Scenario } from "../types";
import type { ScheduledTaskMemory, ScheduledTaskMutation, ScheduledTaskState } from "./scenarios";

export const SCHEDULED_TASK_SIMULATED_TOOLS = [
  "find_matching_entities", "save_scheduled_task", "list_scheduled_tasks",
  "update_scheduled_task", "delete_scheduled_task",
  "retrieve_memory", "save_memory", "update_memory", "delete_memory",
] as const;

export interface ScheduledTaskEnvironmentDependencies {
  tools: ToolDefinition[];
  dueDateError(dueDate: string, now: Date): string | undefined;
  validateMemoryWrite(text: string, scopes?: MemoryScopes): MemoryWriteValidation;
  normalizeMemoryScopes(scopes?: MemoryScopes): MemoryScopes;
}

export interface ScheduledTaskToolResult {
  observation: string;
  toolSuccess: boolean;
  [key: string]: unknown;
}

export function assertScheduledTaskToolCoverage(tools: ToolDefinition[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    const name = tool.function.name;
    if (names.has(name)) throw new Error(`Duplicate offline tool ${name}`);
    names.add(name);
    if (!(SCHEDULED_TASK_SIMULATED_TOOLS as readonly string[]).includes(name)) {
      throw new Error(`No simulator implementation for ${name}; live fallback is forbidden`);
    }
    if (!tool.function.inputSchema?.parse || !tool.function.inputSchema.toJSONSchema) {
      throw new Error(`Missing production input schema for ${name}`);
    }
  }
  for (const name of SCHEDULED_TASK_SIMULATED_TOOLS) {
    if (!names.has(name)) throw new Error(`Missing offline tool capability ${name}`);
  }
}

function canonical(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item) =>
    key === "dueDate" && typeof item === "string" && Number.isFinite(Date.parse(item))
      ? new Date(item).toISOString() : item));
}

function taskRows(tasks: ScheduledTask[]): unknown {
  return canonical([...tasks].sort((a, b) =>
    `${a.recurrenceFamilyId}/${a.id}`.localeCompare(`${b.recurrenceFamilyId}/${b.id}`)));
}

function mutation(value: ScheduledTaskMutation): unknown {
  const args = { ...value.args };
  if (value.toolName === "delete_scheduled_task" && args.scope === "family") delete args.id;
  return canonical({ toolName: value.toolName, args });
}

const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();
const taskKey = (id: string, family: string) => `${family}/${id}`;

export class ScheduledTaskEnvironment {
  readonly state: ScheduledTaskState;
  readonly evidence: Evidence[] = [];
  readonly mutations: ScheduledTaskMutation[] = [];
  readonly policyViolations: string[] = [];
  private readonly initial: ScheduledTaskState;
  private readonly contracts: Map<string, ToolDefinition>;
  private readonly observedEntities = new Set<string>();
  private readonly observedTasks = new Set<string>();
  private listed = false;
  private taskSequence = 0;
  private memorySequence = 0;

  constructor(scenario: Scenario<ScheduledTaskState>, private readonly dependencies: ScheduledTaskEnvironmentDependencies) {
    assertScheduledTaskToolCoverage(dependencies.tools);
    for (const name of ["dueDateError", "validateMemoryWrite", "normalizeMemoryScopes"] as const) {
      if (typeof dependencies[name] !== "function") throw new Error(`Missing offline validation capability ${name}`);
    }
    if (!Number.isFinite(Date.parse(scenario.initial.now))) throw new Error("Invalid fixture clock");
    new Intl.DateTimeFormat("en", { timeZone: scenario.initial.timeZone }).format(new Date(scenario.initial.now));
    this.initial = structuredClone(scenario.initial);
    this.state = structuredClone(scenario.initial);
    this.contracts = new Map(dependencies.tools.map(tool => [tool.function.name, tool]));
    this.record({ kind: "initial", text: JSON.stringify(this.snapshot()) });
  }

  record(item: Omit<Evidence, "id">): Evidence {
    const event = { ...item, id: `e${this.evidence.length + 1}`, timestamp: this.initial.now };
    this.evidence.push(event);
    return event;
  }

  snapshot(): Omit<ScheduledTaskState, "expected"> {
    const { expected: _expected, ...state } = this.state;
    return structuredClone(state);
  }

  assertion(finalResponse = "") {
    const expected = this.initial.expected;
    const storageMatchesExpected = isDeepStrictEqual(taskRows(this.state.tasks), taskRows(expected.tasks));
    const mutationsMatchExpected = isDeepStrictEqual(this.mutations.map(mutation), expected.mutations.map(mutation));
    const memoryUnchanged = isDeepStrictEqual(this.state.memories, this.initial.memories);
    const entityStateUnchanged = isDeepStrictEqual(this.state.entities, this.initial.entities);
    const requiredReadObserved = !expected.requiresList || this.listed;
    const answerMatches = expected.answer === undefined ||
      normalizeText(finalResponse).replace(/\.$/, "").toLowerCase() === expected.answer.toLowerCase();
    return {
      taskSatisfied: expected.fulfillable && storageMatchesExpected && mutationsMatchExpected &&
        memoryUnchanged && entityStateUnchanged && requiredReadObserved && answerMatches && this.policyViolations.length === 0,
      storageMatchesExpected, mutationsMatchExpected, memoryUnchanged, entityStateUnchanged, requiredReadObserved, answerMatches,
      fulfillable: expected.fulfillable, policyViolations: [...this.policyViolations],
      expectedTasks: structuredClone(expected.tasks), actualFinalState: this.snapshot(),
      expectedMutations: structuredClone(expected.mutations), actualMutations: structuredClone(this.mutations),
    };
  }

  taskSatisfied(finalResponse = ""): boolean {
    return this.assertion(finalResponse).taskSatisfied;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ScheduledTaskToolResult> {
    const contract = this.contracts.get(name);
    if (!contract) throw new Error(`No simulator implementation for ${name}; live fallback is forbidden`);
    const started = Date.now();
    let parsed: Record<string, unknown>;
    try {
      parsed = contract.function.inputSchema!.parse(args) as Record<string, unknown>;
    } catch (error) {
      this.record({ kind: "tool", toolName: name, text: "Rejected malformed tool arguments; no simulated effect.", args });
      throw error;
    }
    let result: ScheduledTaskToolResult;
    switch (name) {
      case "find_matching_entities": result = this.findEntities(parsed as FindMatchingEntitiesInput); break;
      case "list_scheduled_tasks": result = this.listTasks(); break;
      case "save_scheduled_task": result = this.saveTask(parsed as SaveScheduledTaskInput); break;
      case "update_scheduled_task": result = this.updateTask(parsed as UpdateScheduledTaskInput); break;
      case "delete_scheduled_task": result = this.deleteTask(parsed as DeleteScheduledTaskInput); break;
      case "retrieve_memory": result = this.retrieveMemory(parsed); break;
      case "save_memory": result = this.saveMemory(parsed); break;
      case "update_memory": result = this.updateMemory(parsed); break;
      case "delete_memory": result = this.deleteMemory(parsed); break;
      default: throw new Error(`No simulator implementation for ${name}; live fallback is forbidden`);
    }
    if (result.toolSuccess && /^(save|update|delete)_/.test(name)) {
      this.mutations.push({ toolName: name, args: structuredClone(parsed) });
    }
    this.record({
      kind: "tool", toolName: name, args: structuredClone(parsed), text: JSON.stringify(result),
      durationMs: Math.max(0, Date.now() - started),
    });
    return structuredClone(result);
  }

  private findEntities({ query, domain }: FindMatchingEntitiesInput): ScheduledTaskToolResult {
    const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const matches = this.state.entities.filter(entity => (!domain || entity.domain === domain) &&
      tokens.every(token => `${entity.entityId} ${entity.friendlyName}`.toLowerCase().includes(token)));
    for (const match of matches) this.observedEntities.add(match.entityId);
    return {
      matches, toolSuccess: true,
      observation: matches.length
        ? `Found ${matches.length} matching entit${matches.length === 1 ? "y" : "ies"}:\n${matches.map(match =>
          `  - ${match.entityId} (friendly: "${match.friendlyName}", state: ${match.state})`).join("\n")}`
        : `No entities matched "${query}"${domain ? ` in domain "${domain}"` : ""}.`,
    };
  }

  private listTasks(): ScheduledTaskToolResult {
    if (this.state.storage === "unavailable") {
      return { tasks: [], observation: "Cannot list tasks: scheduled task storage is unavailable.", toolSuccess: false };
    }
    const tasks = [...this.state.tasks].sort((a, b) => Date.parse(a.dueDate) - Date.parse(b.dueDate));
    this.listed = true;
    for (const task of tasks) this.observedTasks.add(taskKey(task.id, task.recurrenceFamilyId));
    const lines = tasks.map(task => {
      const effect = task.effect.kind === "action" ? `action(${task.effect.entityId})` : "announcement";
      const recurrence = task.isRecurring && task.recurringPattern
        ? `every ${task.recurringPattern.interval} ${task.recurringPattern.type}` : "one-shot";
      return `  - id=${task.id} familyId=${task.recurrenceFamilyId} title="${task.title}" due=${task.dueDate} ${effect} ${recurrence} category=${task.category} priority=${task.priority}`;
    });
    return {
      tasks, toolSuccess: true,
      observation: tasks.length ? `Active scheduled tasks (${tasks.length}):\n${lines.join("\n")}` : "No active scheduled tasks.",
    };
  }

  private saveTask(input: SaveScheduledTaskInput): ScheduledTaskToolResult {
    const dateError = this.dependencies.dueDateError(input.dueDate, new Date(this.initial.now));
    if (dateError) return { saved: null, observation: `Cannot save: ${dateError}`, toolSuccess: false };
    if (input.isRecurring && !input.recurringPattern) {
      return { saved: null, observation: "Cannot save: isRecurring is true but recurringPattern was not provided.", toolSuccess: false };
    }
    if (this.state.storage !== "available") {
      return { saved: null, observation: "Cosmos DB is not configured or the upsert failed. Task not saved.", toolSuccess: false };
    }
    do { this.taskSequence++; } while (this.state.tasks.some(task =>
      task.id === `eval-task-${this.taskSequence}` || task.recurrenceFamilyId === `eval-family-${this.taskSequence}`));
    const saved: ScheduledTask = {
      ...input, id: `eval-task-${this.taskSequence}`, recurrenceFamilyId: `eval-family-${this.taskSequence}`,
      status: "active", createdAt: this.initial.now, updatedAt: this.initial.now,
    };
    if (saved.effect.kind === "action" && !this.observedEntities.has(saved.effect.entityId)) {
      this.policyViolations.push(`Action entity ${saved.effect.entityId} was not resolved before save.`);
    }
    this.state.tasks.push(saved);
    return {
      saved, toolSuccess: true,
      observation: `Saved ScheduledTask id=${saved.id} title="${saved.title}" effect=${saved.effect.kind}` +
        (saved.effect.kind === "action" ? ` entityId=${saved.effect.entityId}` : "") +
        ` dueDate=${saved.dueDate} recurring=${saved.isRecurring}.`,
    };
  }

  private updateTask({ id, recurrenceFamilyId, patch }: UpdateScheduledTaskInput): ScheduledTaskToolResult {
    if (patch.dueDate !== undefined) {
      const dateError = this.dependencies.dueDateError(patch.dueDate, new Date(this.initial.now));
      if (dateError) return { observation: `Cannot update: ${dateError}`, toolSuccess: false };
    }
    if (Object.keys(patch).length === 0) return { observation: "Patch is empty; nothing to update.", toolSuccess: false };
    const index = this.state.tasks.findIndex(task => task.id === id && task.recurrenceFamilyId === recurrenceFamilyId);
    if (index < 0 || this.state.storage !== "available") {
      return { observation: `No task found with id=${id} familyId=${recurrenceFamilyId}, or Cosmos is not configured.`, toolSuccess: false };
    }
    this.requireObservedTask(id, recurrenceFamilyId);
    const existing = this.state.tasks[index];
    if (patch.effect?.kind === "action" &&
      (existing.effect.kind !== "action" || existing.effect.entityId !== patch.effect.entityId) &&
      !this.observedEntities.has(patch.effect.entityId)) {
      this.policyViolations.push(`Changed action entity ${patch.effect.entityId} was not resolved before update.`);
    }
    const updated = { ...existing, ...patch, id, recurrenceFamilyId, createdAt: existing.createdAt, updatedAt: this.initial.now };
    this.state.tasks[index] = updated;
    return {
      toolSuccess: true,
      observation: `Updated task id=${updated.id}: title="${updated.title}", due=${updated.dueDate}, effect=${updated.effect.kind}, recurring=${updated.isRecurring}.`,
    };
  }

  private deleteTask({ scope, id, recurrenceFamilyId }: DeleteScheduledTaskInput): ScheduledTaskToolResult {
    if (this.state.storage === "unavailable") {
      return { observation: "Cannot delete tasks: scheduled task storage is unavailable.", toolSuccess: false };
    }
    if (scope === "occurrence" && !id) {
      return { observation: "Cannot delete: scope='occurrence' requires id. Use list_scheduled_tasks to find it.", toolSuccess: false };
    }
    if (this.state.storage === "write_failure") {
      return { observation: "Tool delete_scheduled_task failed during execution. Check its arguments and service availability.", toolSuccess: false };
    }
    const targets = this.state.tasks.filter(task => task.recurrenceFamilyId === recurrenceFamilyId &&
      (scope === "family" || task.id === id));
    if (scope === "occurrence" && targets.length === 0) {
      return { observation: `Failed to delete occurrence id=${id}. The task may already be gone.`, toolSuccess: false };
    }
    for (const target of targets) this.requireObservedTask(target.id, target.recurrenceFamilyId);
    this.state.tasks = this.state.tasks.filter(task => !targets.includes(task));
    return {
      toolSuccess: true,
      observation: scope === "family"
        ? `Deleted ${targets.length} occurrence(s) from family ${recurrenceFamilyId}. Recurrence stopped.`
        : `Deleted occurrence id=${id} from family ${recurrenceFamilyId}.`,
    };
  }

  private requireObservedTask(id: string, family: string): void {
    if (!this.observedTasks.has(taskKey(id, family))) {
      this.policyViolations.push(`Task ${id} in family ${family} was not read before mutation.`);
    }
  }

  private matchingMemories(query: string, limit: number): ScheduledTaskMemory[] {
    const tokens = normalizeText(query).toLowerCase().split(/\W+/).filter(Boolean);
    if (!tokens.length) return [];
    return this.state.memories.map(memory => ({
      memory, score: tokens.filter(token => memory.text.toLowerCase().includes(token)).length,
    })).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(item => item.memory);
  }

  private retrieveMemory(args: Record<string, unknown>): ScheduledTaskToolResult {
    const memories = this.matchingMemories(String(args.query), Number(args.limit || 5));
    return {
      memories, toolSuccess: true,
      observation: memories.length ? `Retrieved ${memories.length} relevant memories.` : "No relevant Persistent agent memory found.",
    };
  }

  private memoryScopes(text: string, input?: MemoryScopes): MemoryScopes {
    const scopes = this.dependencies.normalizeMemoryScopes(input);
    const scoped = scopes.global || ["roomNames", "deviceNames", "deviceEntityIds", "domains", "appNames", "people"]
      .some(key => (scopes[key as keyof MemoryScopes] as string[] | undefined)?.length);
    if (!scoped) {
      // Scope inference is lexical and bounded to the same room/device vocabulary as production.
      const rooms = ["living room", "bedroom", "kitchen", "garage", "office", "loft", "front", "back", "patio", "nursery", "laundry"];
      const devices = ["camera", "preset", "light", "switch", "vacuum", "tv", "television", "thermostat", "fan", "door", "lock", "garage", "sensor", "speaker", "remote", "media player"];
      const inferred = rooms.flatMap(room => devices.map(device => `${room} ${device}`)).find(value => text.toLowerCase().includes(value));
      if (inferred) scopes.deviceNames = [inferred];
      else if (!devices.some(device => text.toLowerCase().includes(device))) scopes.global = true;
    }
    return scopes;
  }

  private saveMemory(args: Record<string, unknown>): ScheduledTaskToolResult {
    const text = normalizeText(String(args.text));
    const validation = this.dependencies.validateMemoryWrite(text, args.scopes as MemoryScopes | undefined);
    if (!validation.ok) {
      return {
        saved: null, clarification_required: validation.clarificationRequired === true, toolSuccess: false,
        observation: validation.message || "Memory needs a clearer scope before it can be saved.",
      };
    }
    do { this.memorySequence++; } while (this.state.memories.some(memory => memory.id === `eval-memory-${this.memorySequence}`));
    const scopes = this.memoryScopes(text, args.scopes as MemoryScopes | undefined);
    scopes.agentTypes = Array.from(new Set([...(scopes.agentTypes || []), "scheduled_task"]));
    const saved: ScheduledTaskMemory = {
      id: `eval-memory-${this.memorySequence}`, text, memoryType: (args.memoryType as MemoryType | undefined) || "preference",
      source: "explicit", confidence: 1, scopes, updatedAt: this.initial.now,
    };
    this.state.memories.push(saved);
    return { saved, observation: `Saved memory ${saved.id}.`, toolSuccess: true };
  }

  private updateMemory(args: Record<string, unknown>): ScheduledTaskToolResult {
    const existing = args.id
      ? this.state.memories.find(memory => memory.id === args.id)
      : this.matchingMemories(String(args.query || args.text), 1)[0];
    if (!existing) return { updated: null, observation: "No matching memory was updated.", toolSuccess: false };
    const text = normalizeText(String(args.text));
    const scopes: MemoryScopes = { ...existing.scopes };
    for (const [key, value] of Object.entries(this.dependencies.normalizeMemoryScopes(args.scopes as MemoryScopes | undefined))) {
      if (key === "global") scopes.global = scopes.global || value as boolean;
      else if (Array.isArray(value)) {
        const field = key as Exclude<keyof MemoryScopes, "global">;
        scopes[field] = Array.from(new Set([...(scopes[field] || []), ...value])).slice(0, 20);
      }
    }
    const enriched = this.memoryScopes(text, scopes);
    const validation = this.dependencies.validateMemoryWrite(text, enriched);
    if (!validation.ok) return { updated: null, observation: validation.message || "No matching memory was updated.", toolSuccess: false };
    const updated: ScheduledTaskMemory = {
      ...existing, text, scopes: enriched, memoryType: (args.memoryType as MemoryType | undefined) || existing.memoryType,
      source: "explicit", confidence: 1, updatedAt: this.initial.now,
    };
    this.state.memories[this.state.memories.indexOf(existing)] = updated;
    return { updated, observation: `Updated memory ${updated.id}.`, toolSuccess: true };
  }

  private deleteMemory(args: Record<string, unknown>): ScheduledTaskToolResult {
    const deleted = args.id
      ? this.state.memories.filter(memory => memory.id === args.id)
      : this.matchingMemories(String(args.query || ""), Number(args.limit || 3));
    this.state.memories = this.state.memories.filter(memory => !deleted.includes(memory));
    return {
      deleted, toolSuccess: deleted.length > 0,
      observation: deleted.length ? `Deleted ${deleted.length} memories.` : "No matching memory was deleted.",
    };
  }
}
