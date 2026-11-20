import assert from "node:assert/strict";
import test from "node:test";
import { Databases } from "@azure/cosmos";

test("device-state initialization, queries and writes cancel and retry after outages", async t => {
  process.env.AZURE_COSMOS_ENDPOINT = "https://cosmos.invalid";
  process.env.AZURE_COSMOS_KEY = "dGVzdA==";
  process.env.AZURE_COSMOS_DATABASE = "test";
  process.env.AZURE_COSMOS_CONTAINER = "states";
  let initializationCalls = 0;
  let querySignal: AbortSignal | undefined;
  let writeSignal: AbortSignal | undefined;
  let stallQuery = true;
  let stallWrite = true;
  const pending = (signal: AbortSignal): Promise<never> => new Promise((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  const items = {
    query: (_query: unknown, options: { abortSignal: AbortSignal }) => {
      querySignal = options.abortSignal;
      return { fetchAll: async () => stallQuery ? pending(options.abortSignal) : { resources: [] } };
    },
    upsert: async (_record: unknown, options: { abortSignal: AbortSignal }) => {
      writeSignal = options.abortSignal;
      if (stallWrite) await pending(options.abortSignal);
    },
  };
  t.mock.method(Databases.prototype, "createIfNotExists", async (_definition: unknown, options: { abortSignal: AbortSignal }) => {
    initializationCalls++;
    if (initializationCalls === 1) await pending(options.abortSignal);
    return { database: { containers: { createIfNotExists: async (_definition: unknown, containerOptions: { abortSignal: AbortSignal }) => {
      assert.equal(containerOptions.abortSignal, options.abortSignal);
      return { container: { items } };
    } } } };
  });
  const { queryRecentDeviceStates, saveDeviceStatesBatch } = await import("../src/cosmos");
  const first = new AbortController();
  const initialization = queryRecentDeviceStates("2026-11-20", first.signal);
  const other = new AbortController();
  const waiting = queryRecentDeviceStates("2026-11-20", other.signal);
  other.abort();
  await assert.rejects(waiting, { name: "AbortError" });
  assert.equal(first.signal.aborted, false, "one waiter can stop without waiting for the initialization owner");
  first.abort(new DOMException("Deadline", "TimeoutError"));
  await assert.rejects(initialization, { name: "TimeoutError" });
  const second = new AbortController();
  const query = queryRecentDeviceStates("2026-11-20", second.signal);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(initializationCalls, 2, "an aborted initialization is retried");
  assert.equal(querySignal, second.signal, "the deadline reaches the SDK query");
  second.abort(new DOMException("Deadline", "TimeoutError"));
  await assert.rejects(query, { name: "TimeoutError" });
  stallQuery = false;
  assert.deepEqual(await queryRecentDeviceStates("2026-11-20"), []);
  const record = { id: "test", entityId: "switch.test", domain: "switch", state: "on", attributes: {}, capturedAt: "2026-11-20" };
  const shutdown = new AbortController();
  const write = saveDeviceStatesBatch([record, record], shutdown.signal);
  for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.equal(writeSignal, shutdown.signal, "shutdown reaches the SDK upsert");
  shutdown.abort();
  await assert.rejects(write, { name: "AbortError" });
  stallWrite = false;
  await saveDeviceStatesBatch([record]);
});
