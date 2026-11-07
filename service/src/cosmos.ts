import { CosmosClient, Container, PartitionKeyKind } from "@azure/cosmos";
import {
  AZURE_COSMOS_CONTAINER,
  AZURE_COSMOS_DATABASE,
  AZURE_COSMOS_ENDPOINT,
  AZURE_COSMOS_KEY,
  AZURE_COSMOS_SCHEDULED_TASKS_CONTAINER,
  AZURE_COSMOS_SCHEDULED_TASKS_HISTORY_CONTAINER,
} from "./config";
import type { ScheduledTask, ScheduledTaskRun } from "./types/scheduledTask";
import { scheduledTasksChanged, ScheduledTaskMutationError } from "./scheduledTaskChanges";
import { randomUUID } from "node:crypto";

let containerPromise: Promise<Container | null> | null = null;
let scheduledTasksContainerPromise: Promise<Container | null> | null = null;
let scheduledTasksHistoryContainerPromise: Promise<Container | null> | null =
  null;
let cosmosClient: CosmosClient | null = null;

export const isCosmosConfigured = (): boolean => {
  return Boolean(
    AZURE_COSMOS_ENDPOINT &&
      AZURE_COSMOS_KEY &&
      AZURE_COSMOS_DATABASE &&
      AZURE_COSMOS_CONTAINER
  );
};

export const getCosmosContainer = async (): Promise<Container | null> => {
  if (!isCosmosConfigured()) {
    return null;
  }

  if (!containerPromise) {
    containerPromise = initializeContainer().catch((error) => {
      console.error("Failed to initialize Azure Cosmos DB container", error);
      return null;
    });
  }

  return containerPromise;
};

const getCosmosClient = (): CosmosClient => {
  if (!cosmosClient) {
    cosmosClient = new CosmosClient({
      endpoint: AZURE_COSMOS_ENDPOINT!,
      key: AZURE_COSMOS_KEY!,
    });
  }
  return cosmosClient;
};

const initializeContainer = async (): Promise<Container> => {
  if (!isCosmosConfigured()) {
    throw new Error("Azure Cosmos DB configuration is incomplete");
  }

  const { database } = await getCosmosClient().databases.createIfNotExists({
    id: AZURE_COSMOS_DATABASE!,
  });

  const { container } = await database.containers.createIfNotExists({
    id: AZURE_COSMOS_CONTAINER!,
    partitionKey: {
      kind: PartitionKeyKind.Hash,
      paths: ["/entityId"],
    },
  });

  return container;
};

const initializeScheduledTasksContainer = async (
  containerId: string
): Promise<Container> => {
  if (!isCosmosConfigured()) {
    throw new Error("Azure Cosmos DB configuration is incomplete");
  }

  const { database } = await getCosmosClient().databases.createIfNotExists({
    id: AZURE_COSMOS_DATABASE!,
  });

  const { container } = await database.containers.createIfNotExists({
    id: containerId,
    partitionKey: {
      kind: PartitionKeyKind.Hash,
      paths: ["/recurrenceFamilyId"],
    },
  });

  return container;
};

export const getScheduledTasksContainer = async (): Promise<Container | null> => {
  if (!isCosmosConfigured()) return null;
  if (!scheduledTasksContainerPromise) {
    scheduledTasksContainerPromise = initializeScheduledTasksContainer(
      AZURE_COSMOS_SCHEDULED_TASKS_CONTAINER!
    ).catch((error) => {
      console.error(
        "Failed to initialize scheduled-tasks container",
        error
      );
      return null;
    });
  }
  return scheduledTasksContainerPromise;
};

export const getScheduledTasksHistoryContainer = async (): Promise<Container | null> => {
  if (!isCosmosConfigured()) return null;
  if (!scheduledTasksHistoryContainerPromise) {
    scheduledTasksHistoryContainerPromise = initializeScheduledTasksContainer(
      AZURE_COSMOS_SCHEDULED_TASKS_HISTORY_CONTAINER!
    ).catch((error) => {
      console.error(
        "Failed to initialize scheduled-tasks-history container",
        error
      );
      return null;
    });
  }
  return scheduledTasksHistoryContainerPromise;
};

export const upsertScheduledTask = async (
  task: ScheduledTask
): Promise<ScheduledTask | null> => {
  const container = await getScheduledTasksContainer();
  if (!container) return null;
  const { resource } = await container.items.upsert<ScheduledTask>(task);
  scheduledTasksChanged();
  return (resource as ScheduledTask) ?? task;
};

/** All phases share one partition, so a failed transaction cannot leave a lone start without its shutoff. */
export const createScheduledTaskSequence = async (tasks: ScheduledTask[]): Promise<ScheduledTask[] | null> => {
  const container = await getScheduledTasksContainer();
  if (!container) return null;
  if (tasks.length < 2 || tasks.length > 9 || tasks.some(task => task.recurrenceFamilyId !== tasks[0].recurrenceFamilyId)) throw new Error("Invalid scheduled action sequence partition");
  const response = await container.items.batch(tasks.map(task => ({ operationType: "Create" as const, resourceBody: JSON.parse(JSON.stringify(task)) })), tasks[0].recurrenceFamilyId);
  if (!response.code || response.code < 200 || response.code >= 300 || response.result?.length !== tasks.length || response.result.some(result => result.statusCode < 200 || result.statusCode >= 300)) throw new Error("Timed action transaction failed; no complete sequence was confirmed");
  scheduledTasksChanged();
  return tasks;
};

export const getScheduledTaskById = async (
  id: string,
  recurrenceFamilyId: string
): Promise<ScheduledTask | null> => {
  const container = await getScheduledTasksContainer();
  if (!container) return null;
  try {
    const { resource } = await container
      .item(id, recurrenceFamilyId)
      .read<ScheduledTask>();
    return (resource as ScheduledTask) ?? null;
  } catch (err) {
    console.error(`Failed to read scheduled task ${id}`, err);
    return null;
  }
};

export const claimScheduledTask = async (id: string, family: string, now = new Date()): Promise<{
  task: ScheduledTask; alreadyClaimed: boolean;
} | undefined> => {
  const container = await getScheduledTasksContainer();
  if (!container) throw new Error("Task storage is unavailable");
  try {
    const item = container.item(id, family);
    const { resource } = await item.read<ScheduledTask & { _etag?: string }>();
    if (!resource || Date.parse(resource.dueDate) > now.getTime()) return;
    if (resource.firing) {
      const owner = resource.firing.ownerPid;
      if (owner && owner !== process.pid && Date.parse(resource.firing.expiresAt || "") > now.getTime()) {
        try { process.kill(owner, 0); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; }
      }
      return { task: resource, alreadyClaimed: true };
    }
    if (!resource._etag) throw new Error("Task has no concurrency token; refusing unclaimed device execution");
    const task: ScheduledTask = { ...resource, firing: { id: randomUUID(), claimedAt: now.toISOString(), ownerPid: process.pid, expiresAt: new Date(now.getTime() + 90_000).toISOString() } };
    await item.replace(task, { accessCondition: { type: "IfMatch", condition: resource._etag } });
    return { task, alreadyClaimed: false };
  } catch (error) {
    if ([404, 412].includes(Number((error as { code?: number }).code))) return;
    throw error;
  }
};

export const updateScheduledTask = async (
  id: string,
  recurrenceFamilyId: string,
  patch: Partial<Omit<ScheduledTask, "id" | "recurrenceFamilyId" | "createdAt">>
): Promise<ScheduledTask | null> => {
  const existing = await getScheduledTaskById(id, recurrenceFamilyId);
  if (!existing) return null;
  if (existing.firing) throw new ScheduledTaskMutationError("This occurrence has already started dispatching; its effect cannot be rescheduled");
  if (existing.sequenceId && Object.keys(patch).some(key => ["dueDate", "effect", "isRecurring", "recurringPattern"].includes(key))) throw new ScheduledTaskMutationError("Cancel and recreate the timed sequence to change its timing or actions; moving one phase alone is not allowed");
  const updated: ScheduledTask = {
    ...existing,
    ...patch,
    id: existing.id,
    recurrenceFamilyId: existing.recurrenceFamilyId,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  const container = await getScheduledTasksContainer();
  if (!container) return null;
  if (!existing._etag) throw new ScheduledTaskMutationError("Task concurrency metadata is unavailable; refresh before editing");
  try {
    const { resource } = await container.item(id, recurrenceFamilyId).replace(updated, { accessCondition: { type: "IfMatch", condition: existing._etag } });
    scheduledTasksChanged();
    return resource || updated;
  } catch (error) {
    if ([404, 412].includes(Number((error as { code?: number }).code))) throw new ScheduledTaskMutationError("The task changed or began firing during this edit; refresh the task list before trying again");
    throw error;
  }
};

export const listActiveScheduledTasks = async (): Promise<ScheduledTask[]> => {
  const container = await getScheduledTasksContainer();
  if (!container) return [];
  const { resources } = await container.items
    .query<ScheduledTask>("SELECT * FROM c")
    .fetchAll();
  return resources;
};

export const deleteScheduledTask = async (
  id: string,
  recurrenceFamilyId: string
): Promise<boolean> => {
  const container = await getScheduledTasksContainer();
  if (!container) return false;
  try {
    await container.item(id, recurrenceFamilyId).delete();
    scheduledTasksChanged();
    return true;
  } catch (err) {
    console.error(`Failed to delete scheduled task ${id}`, err);
    return false;
  }
};

/** UI/tool occurrence cancellation removes all remaining phases of that occurrence, never another family. */
export const deleteScheduledTaskOccurrence = async (id: string, recurrenceFamilyId: string): Promise<boolean> => {
  const task = await getScheduledTaskById(id, recurrenceFamilyId);
  if (!task) return false;
  if (!task.sequenceId) return deleteScheduledTask(id, recurrenceFamilyId);
  const container = await getScheduledTasksContainer();
  if (!container) return false;
  const { resources } = await container.items.query<ScheduledTask>({
    query: "SELECT * FROM c WHERE c.recurrenceFamilyId = @family AND c.sequenceId = @sequence",
    parameters: [{ name: "@family", value: recurrenceFamilyId }, { name: "@sequence", value: task.sequenceId }],
  }).fetchAll();
  if (!resources.length || resources.length > 9) return false;
  const response = await container.items.batch(resources.map(phase => ({ operationType: "Delete" as const, id: phase.id })), recurrenceFamilyId);
  const deleted = Boolean(response.code && response.code >= 200 && response.code < 300 && response.result?.length === resources.length && response.result.every(result => result.statusCode >= 200 && result.statusCode < 300));
  if (deleted) scheduledTasksChanged();
  return deleted;
};

export const deleteRecurrenceFamily = async (
  recurrenceFamilyId: string,
  options: { throwOnFailure?: boolean } = {}
): Promise<number> => {
  const container = await getScheduledTasksContainer();
  if (!container) return 0;
  const { resources } = await container.items
    .query<ScheduledTask>({
      query: "SELECT c.id FROM c WHERE c.recurrenceFamilyId = @fid",
      parameters: [{ name: "@fid", value: recurrenceFamilyId }],
    })
    .fetchAll();
  let deleted = 0;
  for (const t of resources) {
    try {
      await container.item(t.id, recurrenceFamilyId).delete();
      scheduledTasksChanged();
      deleted++;
    } catch (err) {
      // Agent tools must not claim the recurrence stopped after a partial delete.
      if (options.throwOnFailure) throw err;
      console.error(`Failed to delete family member ${t.id}`, err);
    }
  }
  return deleted;
};

export const insertScheduledTaskRun = async (
  run: ScheduledTaskRun
): Promise<void> => {
  const container = await getScheduledTasksHistoryContainer();
  if (!container) throw new Error("Scheduled task history storage is unavailable");
  try { await container.items.create(run); }
  catch (error) {
    // A dispatch has one immutable outcome. Recovery must not replace a saved
    // success with an interruption or replay a device action after cleanup fails.
    if (Number((error as { code?: number }).code) !== 409) throw error;
  }
};

export interface DeviceStateRecord {
  id: string;
  entityId: string;
  domain: string;
  friendlyName?: string;
  state: string;
  attributes: Record<string, unknown>;
  lastChanged?: string;
  lastUpdated?: string;
  context?: Record<string, unknown> | null;
  capturedAt: string;
  additional?: Record<string, unknown>;
}

export const queryRecentDeviceStates = async (
  sinceIso: string
): Promise<DeviceStateRecord[]> => {
  const container = await getCosmosContainer();
  if (!container) return [];

  const { resources } = await container.items
    .query<DeviceStateRecord>({
      query: "SELECT * FROM c WHERE c.capturedAt >= @since",
      parameters: [{ name: "@since", value: sinceIso }],
    })
    .fetchAll();

  return resources;
};

export const saveDeviceStatesBatch = async (
  deviceStates: DeviceStateRecord[]
): Promise<void> => {
  if (deviceStates.length === 0) {
    return;
  }

  const container = await getCosmosContainer();
  if (!container) {
    console.warn(
      "Azure Cosmos DB container is not available; skipping device state persistence"
    );
    return;
  }

  for (const record of deviceStates) {
    try {
      await container.items.upsert(record);
    } catch (error) {
      console.error(
        `Failed to upsert device state for ${record.entityId} (${record.id})`,
        error
      );
    }
  }
};
