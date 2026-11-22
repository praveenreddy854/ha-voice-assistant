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

test("shutdown cancels startup at every Cosmos stage and prevents later requests", async t => {
  const { loadDeviceMonitorJobs } = await import("../src/cosmos");
  let requests = 0;
  const preAborted = new AbortController();
  preAborted.abort();
  const mock = t.mock.method(Databases.prototype, "createIfNotExists", async () => { requests++; throw new Error("Unexpected request"); });
  await assert.rejects(loadDeviceMonitorJobs(preAborted.signal), { name: "AbortError" });
  assert.equal(requests, 0);
  mock.mock.restore();
  for (const stage of ["database", "container", "query"]) {
    const shutdown = new AbortController();
    const calls: string[] = [];
    const captured: AbortSignal[] = [];
    const visit = async (name: string, options: { abortSignal: AbortSignal }) => {
      calls.push(name); captured.push(options.abortSignal);
      if (name === stage) {
        shutdown.abort();
        assert.equal(options.abortSignal.aborted, true, "shutdown reaches the SDK request signal");
        // A provider may still complete successfully after cancellation.
      }
    };
    const stageMock = t.mock.method(Databases.prototype, "createIfNotExists", async (_definition, options: any) => {
      await visit("database", options);
      return { database: { containers: { createIfNotExists: async (_definition: unknown, options: any) => {
        await visit("container", options);
        return { container: { items: { query: (_query: unknown, options: any) => ({ fetchAll: async () => {
          await visit("query", options);
          return { resources: [] };
        } }) } } };
      } } } };
    });
    await assert.rejects(loadDeviceMonitorJobs(shutdown.signal), { name: "AbortError" });
    assert.deepEqual(calls, ["database", "container", "query"].slice(0, ["database", "container", "query"].indexOf(stage) + 1));
    assert.ok(captured.every(signal => signal === captured[0]));
    stageMock.mock.restore();
  }
});
