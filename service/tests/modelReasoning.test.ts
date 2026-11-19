import assert from "node:assert/strict";
import test from "node:test";
import { configureTestProviders, toolResponse } from "./helpers/agentFixtures";

configureTestProviders();
process.env.AI_MODEL_NANO = '{"model":"shared-deployment","reasoningEffort":"low"}';
process.env.AI_MODEL_MINI = '{"model":"shared-deployment","reasoningEffort":"medium"}';
process.env.AI_MODEL_ADVANCED = '{"model":"shared-deployment","reasoningEffort":"high"}';
process.env.AI_MODEL_HOME_ASSISTANT = "";

interface RequestBody {
  model: string;
  reasoning?: { effort: string };
  temperature?: number;
  max_output_tokens: number;
}

function completion(text = "OK") {
  return Response.json({
    id: "synthetic-response", created_at: 1, model: "shared-deployment",
    output: [{ type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

test("nano, mini, and advanced text/JSON/vision calls send separate effort to the same Azure alias", async t => {
  const config = await import("../src/config");
  const { generateCompletion, generateJsonCompletion, generateVisionText } = await import("../src/ai");
  const requests: RequestBody[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return completion('"OK"');
  });
  const tiers = [
    [config.AI_MODEL_NANO, config.AI_MODEL_NANO_REASONING_EFFORT],
    [config.AI_MODEL_MINI, config.AI_MODEL_MINI_REASONING_EFFORT],
    [config.AI_MODEL_ADVANCED, config.AI_MODEL_ADVANCED_REASONING_EFFORT],
  ] as const;
  for (const [model, reasoningEffort] of tiers) {
    const settings = { model: model!, reasoningEffort, temperature: 0 };
    const messages = [{ role: "user", content: "synthetic" }];
    await generateCompletion({ ...settings, messages });
    assert.equal(await generateJsonCompletion({ ...settings, messages }), "OK");
    await generateVisionText({ ...settings, prompt: "synthetic", imageBase64: "AA==", imageContentType: "image/png" });
    for (const request of requests.slice(-3)) {
      assert.equal(request.model, "shared-deployment");
      assert.equal(request.reasoning?.effort, reasoningEffort);
      assert.equal(request.temperature, undefined);
    }
  }
  const messages = [{ role: "user", content: "synthetic" }];
  await generateCompletion({ model: "shared-deployment", messages });
  assert.equal(requests.at(-1)!.reasoning, undefined);
  assert.equal(requests.at(-1)!.max_output_tokens, 1000);
  await generateCompletion({ model: '{"model":"shared-deployment","reasoningEffort":"none"}', messages });
  assert.equal(requests.at(-1)!.reasoning?.effort, "none");
  assert.equal(requests.at(-1)!.max_output_tokens, 1000);
  await generateCompletion({ model: '{"model":"shared-deployment","reasoningEffort":"low"}', reasoningEffort: "high", messages });
  assert.equal(requests.at(-1)!.reasoning?.effort, "high");
  await generateCompletion({ model: "gpt-5.4", messages });
  assert.equal(requests.at(-1)!.max_output_tokens, 26_000);
  await generateCompletion({ model: "gpt-5.1-chat", messages, maxTokens: 120 });
  assert.equal(requests.at(-1)!.max_output_tokens, 120);
  await generateVisionText({ model: "gpt-5.1-chat-latest", prompt: "screen", imageBase64: "AA==", imageContentType: "image/png" });
  assert.equal(requests.at(-1)!.max_output_tokens, 500);
});

test("short text and vision calls reserve reasoning tokens and reject incomplete output", async t => {
  const { generateCompletion, generateVisionText } = await import("../src/ai");
  const requests: RequestBody[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const body = await completion("partial").json();
    return Response.json({
      ...body, status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      output: requests.length === 1 ? [] : body.output,
    });
  });
  const settings = { model: '{"model":"shared-deployment","reasoningEffort":"high"}' };
  await assert.rejects(generateCompletion({
    ...settings, messages: [{ role: "user", content: "reminder" }], maxTokens: 120,
  }), /truncated at the output token limit/);
  await assert.rejects(generateVisionText({
    ...settings, prompt: "screen validation", imageBase64: "AA==", imageContentType: "image/png", maxTokens: 200,
  }), /truncated at the output token limit/);
  assert.deepEqual(requests.map(request => request.max_output_tokens), [25_120, 25_200]);
});

test("judge calls honor inherited effort and explicit JSON model settings", async t => {
  const { createLlmJudge } = await import("../src/evals/judge");
  const requests: RequestBody[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return completion("invalid grading JSON");
  });
  for (const [model, reasoningEffort, expected] of [
    ["shared-deployment", "high", "high"],
    ['{"model":"shared-deployment","reasoningEffort":"low"}', undefined, "low"],
    ['{"model":"shared-deployment","reasoningEffort":"low"}', "none", "none"],
    ["shared-deployment", undefined, undefined],
  ] as const) {
    const judge = await createLlmJudge(model, [], "", reasoningEffort);
    // An invalid grade avoids coupling this request test to the grading rubric.
    await assert.rejects(judge({ agentId: "tv", evidence: [] } as any, [], new AbortController().signal));
    assert.equal(requests.at(-1)!.model, "shared-deployment");
    assert.equal(requests.at(-1)!.reasoning?.effort, expected);
  }
});

test("offline adapters record effective effort for inherited and overridden model settings", async t => {
  const { createRealtimeAdapter } = await import("../src/evals/realtime/adapter");
  const { createScheduledTaskAdapter } = await import("../src/evals/scheduled-task/adapter");
  const { createTvAdapter } = await import("../src/evals/tv/adapter");
  const requests: RequestBody[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    return toolResponse("complete_task", { success: true, message: "The Moon's phases are the changing portion of its sunlit half that we see as it orbits Earth." });
  });
  for (const makeAdapter of [createTvAdapter, createScheduledTaskAdapter, createRealtimeAdapter]) {
    for (const [override, effort] of [
      [undefined, "high"],
      ['{"reasoningEffort":"low","model":"shared-deployment"}', "low"],
      ["shared-deployment", undefined],
    ] as const) {
      const adapter = await makeAdapter(override);
      const scenario = adapter.id === "realtime" ? adapter.scenarios.find(item => item.id === "general-chat")! : adapter.scenarios[0];
      const result = await adapter.execute(scenario, new AbortController().signal);
      const identity = effort ? JSON.stringify({ model: "shared-deployment", reasoningEffort: effort }) : "shared-deployment";
      assert.equal(result.coverage, "complete");
      assert.equal(result.metrics?.stopReason, "completed");
      assert.equal(adapter.model, identity);
      assert.equal(result.model, identity);
      assert.deepEqual(result.trace?.modelCalls.map(call => call.model), [identity]);
      assert.equal(requests.at(-1)!.model, "shared-deployment");
      assert.equal(requests.at(-1)!.reasoning?.effort, effort);
    }
  }
  assert.equal(requests.length, 9);
});

test("advanced agent defaults and explicit overrides survive tool steps and screenshot continuations", async t => {
  const { createAgentLoop } = await import("../src/agents/core/agentLoop");
  for (const [model, reasoningEffort, expected] of [
    [undefined, undefined, "high"],
    ['{"model":"shared-deployment","reasoningEffort":"low"}', undefined, "low"],
    ["shared-deployment", "none", "none"],
    ["shared-deployment", undefined, undefined],
  ] as const) await t.test(expected ?? "provider default", async subtest => {
    const requests: RequestBody[] = [];
    subtest.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      requests.push(JSON.parse(String(init.body)));
      if (requests.length === 1) return toolResponse("navigate", {});
      if (requests.length === 2) return toolResponse("get_latest_screenshot", {}, "screen");
      return toolResponse("complete_task", { success: true, message: "Done" }, "complete");
    });
    const events: unknown[] = [];
    const loop = createAgentLoop({
      systemPrompt: "synthetic", model, reasoningEffort, maxIterations: 4,
      onStepFinish: ({ requestModel, reasoningEffort }) => events.push({ requestModel, reasoningEffort }),
      tools: [
        { type: "function", function: { name: "navigate", parameters: { type: "object", properties: {} } }, execute: async () => "moved" },
        { type: "function", function: { name: "get_latest_screenshot", parameters: { type: "object", properties: {} } } },
      ],
    });
    const session = loop.createSession("synthetic");
    assert.equal((await loop.run(session.id)).type, "tool_calls");
    assert.equal((await loop.submitToolResults(session.id, [{ toolName: "get_latest_screenshot", toolCallId: "screen", result: "synthetic screen" }])).type, "complete");
    assert.equal(requests.length, 3);
    for (const request of requests) {
      assert.equal(request.model, "shared-deployment");
      assert.equal(request.reasoning?.effort, expected);
    }
    assert.deepEqual(events, Array.from({ length: 3 }, () => ({ requestModel: "shared-deployment", reasoningEffort: expected })));
    loop.deleteSession(session.id);
  });
});
