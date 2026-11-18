import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import axios from "axios";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { getAllTraces, telemetrySpanExporter } from "../src/tracing/agentTraceStore";

test("translation refusals and clarification do not execute device requests", async t => {
  process.env.AI_MODEL_HOME_ASSISTANT = "synthetic-translator";
  process.env.HOME_ASSISTANT_DEVICES = "test_camera";
  const sdk = new NodeSDK({ autoDetectResources: false, spanProcessors: [new SimpleSpanProcessor(telemetrySpanExporter)] });
  sdk.start();
  const requireModule = createRequire(__filename);
  const previous = new Map<string, NodeModule | undefined>();
  const command = { url_path: "button/press", entity_id: "button.test_camera_guard" };
  let output: unknown = { error: "no_match" };
  const stubs = {
    "../src/ai": { generateCompletion: async () => JSON.stringify(output) },
    "../src/memory": { retrieveMemories: async () => [], formatMemoryContext: () => "" },
  };
  for (const [name, exports] of Object.entries(stubs)) {
    const filename = requireModule.resolve(name);
    previous.set(filename, requireModule.cache[filename]);
    requireModule.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeModule;
  }
  t.mock.method(console, "error", () => undefined);
  const get = t.mock.method(axios, "get", async (url: string) => ({ status: 200, data: url.endsWith("/api/states")
    ? [{ entity_id: command.entity_id, state: "unknown", attributes: {} }]
    : { entity_id: command.entity_id, state: "unknown", attributes: {} } }));
  const post = t.mock.method(axios, "post", async () => ({ status: 200, data: [] }));
  try {
    const { executeHACommand } = requireModule("../src/ha") as typeof import("../src/ha");
    await t.test("no_match explains the unavailable mapping and leaves a terminal trace", async () => {
      const ids = new Set(getAllTraces().map(trace => trace.sessionId));
      const result = await executeHACommand("Set test camera preset then enable guard mode");
      assert.equal(result.success, false);
      assert.match(result.message, /could not match.*available Home Assistant controls/i);
      assert.doesNotMatch(result.message, /invalid.*path/i);
      const trace = getAllTraces().find(trace => !ids.has(trace.sessionId))!;
      assert.equal(trace.status, "error");
      assert.equal(trace.toolResults.length, 0, "a refusal is not a device request");
      assert.equal(trace.llmSteps[0].text, JSON.stringify(output));
    });
    await t.test("clarification reaches the caller without inventing an end action", async () => {
      output = { clarification: "What should the camera do after thirty minutes?" };
      const result = await executeHACommand("Set test camera preset for thirty minutes");
      assert.equal(result.success, false);
      assert.match(result.message, /What should the camera do after thirty minutes\?/);
      assert.match(result.message, /No device requests were sent/);
    });
    await t.test("rejects the whole mixed or malformed plan before any side effect", async () => {
      for (output of [
        [command, { error: "no_match" }],
        [command, { clarification: "Which camera?" }],
        [command, { url_path: "invalid", entity_id: "button.test_camera_guard" }],
        [command, { url_path: "button/press" }],
        [command, null], [], null, 42,
        { ...command, error: "no_match" },
        { ...command, clarification: "Which camera?" },
        { clarification: " " }, { clarification: "x".repeat(1001) },
        { ...command, service_data: [] },
        { url_path: 42, entity_id: command.entity_id },
      ]) {
        const result = await executeHACommand("Control test camera");
        assert.equal(result.success, false, JSON.stringify(output));
        assert.match(result.message, /response_parse/);
        assert.equal(post.mock.callCount(), 0, JSON.stringify(output));
      }
    });
    await t.test("malformed percent-encoded state lookups reject the batch before its first action", async () => {
      for (const suffix of ["%", "%2", "%GG", "%E0%A4%A", "%ED%A0%80"]) {
        output = [command, { url_path: `api/states/${suffix}`, entity_id: command.entity_id }];
        const result = await executeHACommand("Press the camera button then read its state");
        assert.equal(result.success, false, suffix);
        assert.equal(post.mock.callCount(), 0, `No partial button press for ${suffix}`);
        assert.match(result.message, /response_parse/, suffix);
      }
    });
    assert.equal(post.mock.callCount(), 0);
    assert.equal(get.mock.calls.every(call => String(call.arguments[0]).endsWith("/api/states")), true,
      "only inventory reads are permitted for rejected translations");
    await t.test("valid single, batch and state-read translations still execute", async () => {
      for (output of [command, [command, command], { url_path: "states/button.test_camera_guard", entity_id: command.entity_id }, { url_path: "api/states/%62utton.test_camera_guard", entity_id: command.entity_id }]) {
        assert.equal((await executeHACommand("Control test camera")).success, true);
      }
      assert.equal(post.mock.callCount(), 3);
      assert.ok(get.mock.calls.some(call => String(call.arguments[0]).includes("/api/states/button.test_camera_guard")));
    });
  } finally {
    await sdk.shutdown();
    for (const [filename, value] of previous) {
      if (value) requireModule.cache[filename] = value; else delete requireModule.cache[filename];
    }
  }
});
