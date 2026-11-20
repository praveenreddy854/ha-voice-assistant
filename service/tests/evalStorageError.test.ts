import test from "node:test";
import assert from "node:assert/strict";
import { summarizeStorageError } from "../src/evals/storageError";

test("storage errors emit only fixed summaries and validated HTTP status", () => {
  for (const error of [undefined, null, "Authorization: secret", new Error("https://private.example?key=secret"),
    { message: "private", code: "Forbidden Authorization: secret" }, { code: 403.5 }, { statusCode: 999 }]) {
    assert.equal(summarizeStorageError(error), "Storage read failed; check service availability and credentials.");
  }
  for (const field of ["statusCode", "code"]) {
    for (const code of [403, "403"]) {
      assert.equal(summarizeStorageError({ [field]: code, message: "Header: secret" }),
        "Storage read failed (HTTP 403); check service availability and credentials.");
    }
  }
  assert.equal(summarizeStorageError(new Error("Source read timed out after 20 ms; incomplete history was not returned")),
    "Source read timed out; incomplete history was not returned");
});


test("recorded Cosmos fallback and missing-evidence errors never retain provider dumps", async t => {
  const { CosmosClient } = await import("@azure/cosmos");
  let disposed = 0;
  const error = Object.assign(new Error("Subscription owning the database account is disabled.\nRequestUri: https://private.example\nHeader: Authorization: secret"), { code: 403 });
  const config = { AZURE_COSMOS_ENDPOINT: "https://unused.invalid", AZURE_COSMOS_KEY: "dGVzdA==",
    AZURE_COSMOS_DATABASE: "fixture", AZURE_COSMOS_TV_FLOW_CONTAINER: "fixture" };
  for (const [name, value] of Object.entries(config)) {
    const previous = process.env[name]; process.env[name] = value;
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  t.mock.method(CosmosClient.prototype, "database", () => { throw error; });
  t.mock.method(CosmosClient.prototype, "dispose", () => { disposed++; });
  const { createTrace, completeTrace, telemetrySpanExporter } = await import("../src/tracing/agentTraceStore");
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
  const sdk = new NodeSDK({ autoDetectResources: false, spanProcessors: [new SimpleSpanProcessor(telemetrySpanExporter)] });
  sdk.start();
  t.after(() => sdk.shutdown());
  const { loadRecordedAssessment } = await import("../src/evals/recorded");
  createTrace("fixture", "tv", "Open fixture app");
  completeTrace("fixture", true, "Done");
  const result = await loadRecordedAssessment("fixture");
  assert.equal(result.coverage, "partial");
  assert.equal(result.finalResponse, "Done");
  assert.equal(result.evidence.at(-1)?.text, "Cosmos supplement unavailable: Storage subscription is disabled (HTTP 403). Restore subscription access before retrying.");
  assert.doesNotMatch(JSON.stringify(result), /private.example|Authorization|secret/);
  await assert.rejects(loadRecordedAssessment("missing-fixture"), {
    message: "Cosmos evidence unavailable: Storage subscription is disabled (HTTP 403). Restore subscription access before retrying."
  });
  assert.equal(disposed, 2);
});
