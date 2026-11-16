import { cronJobs } from "./cronJobs";
import { DEVICE_STATE_LOG_CRON } from "./config";
import { getKnownDeviceStates } from "./ha";
import {
  DeviceStateRecord,
  isCosmosConfigured,
  saveDeviceStatesBatch,
} from "./cosmos";

const buildRecordId = (entityId: string, capturedAtIso: string): string => {
  const sanitizedEntity = entityId.replace(/[^a-zA-Z0-9-_]/g, "_");
  return `${sanitizedEntity}_${capturedAtIso.replace(/[^0-9A-Za-z]/g, "")}`;
};

const mapStatesToRecords = (
  capturedAt: Date,
  captureReason: string,
  states: Awaited<ReturnType<typeof getKnownDeviceStates>>
): DeviceStateRecord[] => {
  const capturedAtIso = capturedAt.toISOString();

  return states.map((state) => {
    const [domain] = state.entity_id.split(".");

    return {
      id: buildRecordId(state.entity_id, capturedAtIso),
      entityId: state.entity_id,
      domain,
      friendlyName: state.attributes?.friendly_name ?? state.entity_id,
      state: state.state,
      attributes: { ...(state.attributes ?? {}) },
      lastChanged: state.last_changed,
      lastUpdated: state.last_updated,
      context: state.context || null,
      capturedAt: capturedAtIso,
      additional: {
        captureReason,
        source: "home-assistant",
      },
    } satisfies DeviceStateRecord;
  });
};

const captureAndPersistStates = async (reason: string): Promise<void> => {
  if (!isCosmosConfigured()) {
    console.warn(
      `Azure Cosmos DB credentials are missing; skipping device state capture (${reason})`
    );
    return;
  }

  try {
    const states = await getKnownDeviceStates();

    const capturedAt = new Date();
    const records = mapStatesToRecords(capturedAt, reason, states);

    if (records.length === 0) {
      console.info(
        `No Home Assistant device states matched the configured filters at ${capturedAt.toISOString()}`
      );
      return;
    }

    await saveDeviceStatesBatch(records);
    console.info(
      `Persisted ${records.length} Home Assistant device states to Azure Cosmos DB (${reason})`
    );
  } catch (error) {
    console.error("Failed to capture Home Assistant device states", error);
  }
};

export const startDeviceStateLogging = (): void => {
  if (!isCosmosConfigured()) {
    console.warn(
      "Azure Cosmos DB credentials are not configured; device state logging scheduler will remain idle"
    );
    return;
  }

  cronJobs.register({
    id: "device-state-log",
    expression: DEVICE_STATE_LOG_CRON,
    runOnStart: true,
    run: (_signal, reason) => captureAndPersistStates(reason === "startup" ? "startup snapshot" : "scheduled run"),
  });

  console.info(
    `Home Assistant device state logging scheduler initialised with cron '${DEVICE_STATE_LOG_CRON}'`
  );
};
