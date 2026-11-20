import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Databases } from "@azure/cosmos";
import { configureTestProviders, messageText, readModelRequest } from "./helpers/agentFixtures";

configureTestProviders();
process.env.AZURE_COSMOS_ENDPOINT = "https://cosmos.invalid";
process.env.AZURE_COSMOS_KEY = Buffer.from("fixture-key").toString("base64");
process.env.AZURE_COSMOS_DATABASE = "fixture";
process.env.AZURE_COSMOS_TV_FLOW_CONTAINER = "flows";

function disableEmbeddingCredentials(t: TestContext) {
  const key = process.env.AZURE_OPENAI_API_KEY_EUS2!;
  const restore = () => { process.env.AZURE_OPENAI_API_KEY_EUS2 = key; };
  process.env.AZURE_OPENAI_API_KEY_EUS2 = "";
  t.after(restore);
  return restore;
}

test("completed TV runs are persisted without embeddings during a configuration outage", async t => {
  disableEmbeddingCredentials(t);
  const { saveTvFlowMemory, retrieveSimilarTvFlows } = await import("../src/agents/tv/flowMemory");
  const saved: Array<{ sessionId: string; success: boolean; embedding: number[] }> = [];
  t.mock.method(Databases.prototype, "createIfNotExists", async () => ({
    database: { containers: { createIfNotExists: async () => ({
      container: { items: { upsert: async (doc: typeof saved[number]) => { saved.push(doc); } } },
    }) } },
  }) as never);
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    assert.fail("Invalid configuration should be rejected before making requests");
  });

  await saveTvFlowMemory({
    sessionId: "completed-flow", userPrompt: "Open settings", status: "completed",
    success: true, steps: [], iterations: 1, maxSteps: 3,
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].sessionId, "completed-flow");
  assert.equal(saved[0].success, true);
  assert.deepEqual(saved[0].embedding, []);
  await assert.rejects(retrieveSimilarTvFlows({ currentGoal: "Open settings" }), /Configure AZURE_OPENAI_API_KEY_EUS2/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("consolidation retains pending interactions without calling extraction until credentials return", async t => {
  const restore = disableEmbeddingCredentials(t);
  const { recordMemoryInteraction, runMemoryConsolidationOnce } = await import("../src/memory");
  const prompts: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    prompts.push(messageText(readModelRequest(url, init), "user"));
    return Response.json({
      id: "fixture", created_at: 1, model: "fixture",
      output: [{ id: "m1", type: "message", role: "assistant", content: [
        { type: "output_text", text: "[]", annotations: [] },
      ] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });

  const userText = "I prefer the lights dimmed after dinner.";
  recordMemoryInteraction({ agentType: "realtime", userText });
  await runMemoryConsolidationOnce();
  await runMemoryConsolidationOnce();
  assert.deepEqual(prompts, []);

  restore();
  await runMemoryConsolidationOnce();
  await runMemoryConsolidationOnce();
  assert.equal(prompts.length, 1);
  assert.ok(prompts[0].includes(userText));
});
