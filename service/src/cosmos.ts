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
  return (resource as ScheduledTask) ?? task;
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

export const updateScheduledTask = async (
  id: string,
  recurrenceFamilyId: string,
  patch: Partial<Omit<ScheduledTask, "id" | "recurrenceFamilyId" | "createdAt">>
): Promise<ScheduledTask | null> => {
  const existing = await getScheduledTaskById(id, recurrenceFamilyId);
  if (!existing) return null;
  const updated: ScheduledTask = {
    ...existing,
    ...patch,
    id: existing.id,
    recurrenceFamilyId: existing.recurrenceFamilyId,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  };
  return upsertScheduledTask(updated);
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
    return true;
  } catch (err) {
    console.error(`Failed to delete scheduled task ${id}`, err);
    return false;
  }
};

export const deleteRecurrenceFamily = async (
  recurrenceFamilyId: string
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
      deleted++;
    } catch (err) {
      console.error(`Failed to delete family member ${t.id}`, err);
    }
  }
  return deleted;
};

export const insertScheduledTaskRun = async (
  run: ScheduledTaskRun
): Promise<void> => {
  const container = await getScheduledTasksHistoryContainer();
  if (!container) return;
  await container.items.create(run);
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
