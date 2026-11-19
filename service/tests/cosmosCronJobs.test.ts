import assert from "node:assert/strict";
import test from "node:test";
import { Databases, PartitionKeyKind } from "@azure/cosmos";

test("loads and validates all monitor documents from the dedicated cron container", async t => {
  process.env.AZURE_COSMOS_ENDPOINT = "https://cosmos.invalid";
  process.env.AZURE_COSMOS_KEY = "dGVzdA==";
  process.env.AZURE_COSMOS_DATABASE = "test";
  process.env.AZURE_COSMOS_CONTAINER = ""; // Device-state logging is independent.
  process.env.AZURE_COSMOS_CRON_JOBS_CONTAINER = "test-cron";

  const resources: Record<string, unknown>[] = [];
  const items = { query: () => ({ fetchAll: async () => ({ resources }) }) };
  t.mock.method(Databases.prototype, "createIfNotExists", async ({ id }: { id: string }) => {
    assert.equal(id, "test");
    return { database: { containers: { createIfNotExists: async (definition: unknown) => {
      assert.deepEqual(definition, { id: "test-cron", partitionKey: { kind: PartitionKeyKind.Hash, paths: ["/id"] } });
      return { container: { items } };
    } } } };
  });
  const { loadDeviceMonitorJobs } = await import("../src/cosmos");
  assert.deepEqual(await loadDeviceMonitorJobs(), []);

  const job = {
    id: "monitor", entityId: "sensor.test", cron: "* * * * * *",
    conditions: [{ field: "state", operator: "equals", value: "on" }], announcement: "Test",
  };
  resources.push({ ...job, _rid: "rid", _self: "self", _etag: "tag", _attachments: "attachments/", _ts: 1 });
  assert.deepEqual(await loadDeviceMonitorJobs(), [
    { ...job, enabled: true, minStateDurationSeconds: 0, announcementPolicy: "oncePerState" },
  ]);
  resources.push({ ...job, id: "invalid", typo: true });
  await assert.rejects(loadDeviceMonitorJobs(), { name: "ZodError" });

  t.mock.method(items, "query", () => ({ fetchAll: async () => { throw new Error("Unavailable"); } }));
  await assert.rejects(loadDeviceMonitorJobs(), /Unavailable/);
});
