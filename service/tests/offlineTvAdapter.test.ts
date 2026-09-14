import test from "node:test";
import assert from "node:assert/strict";
import { configureTestProviders, readModelRequest, toolResponse } from "./helpers/agentFixtures";

configureTestProviders();
test("TV eval reuses model loop and contracts while replacing all tool execution", async () => {
  const original = globalThis.fetch;
  let call = 0;
  globalThis.fetch = async (input, init) => {
    const request = readModelRequest(input, init);
    call++;
    if (call === 1) return toolResponse("get_latest_screenshot", { reason: "Inspect YouTube" }, "screen");
    const encoded = JSON.stringify(request);
    assert.match(encoded, /data:image\/png;base64/);
    return toolResponse("complete_task", { success: true, message: "Done." }, "done");
  };
  try {
    const { createTvAdapter } = await import("../src/evals/tv/adapter");
    const adapter = await createTvAdapter();
    const result = await adapter.execute(adapter.scenarios[0], new AbortController().signal);
    assert.equal(result.taskAssertion, true); assert.equal(result.finalResponse, "Done."); assert.equal(call, 2);
    assert.ok(result.evidence.some(e => e.image)); assert.equal(result.mode, "simulated");
    assert.ok(result.promptVersion); assert.equal(result.usage?.inputTokens, 20);
  } finally { globalThis.fetch = original; }
});
