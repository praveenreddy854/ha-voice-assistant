import { CosmosClient, Container } from "@azure/cosmos";
import {
  AZURE_COSMOS_CONTAINER,
  AZURE_COSMOS_DATABASE,
  AZURE_COSMOS_ENDPOINT,
  AZURE_COSMOS_KEY,
} from "./config";

let containerPromise: Promise<Container | null> | null = null;

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

const initializeContainer = async (): Promise<Container> => {
  if (!isCosmosConfigured()) {
    throw new Error("Azure Cosmos DB configuration is incomplete");
  }

  const client = new CosmosClient({
    endpoint: AZURE_COSMOS_ENDPOINT!,
    key: AZURE_COSMOS_KEY!,
  });

  const { database } = await client.databases.createIfNotExists({
    id: AZURE_COSMOS_DATABASE!,
  });

  const { container } = await database.containers.createIfNotExists({
    id: AZURE_COSMOS_CONTAINER!,
    partitionKey: {
      kind: "Hash",
      paths: ["/entityId"],
    },
  });

  return container;
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
