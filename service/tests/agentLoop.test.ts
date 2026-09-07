import assert from "node:assert/strict";
import test from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import type { ToolDefinition } from "../src/agents/core/agentLoop";

// The real SDK runs against an in-process model; no Azure credentials or network
// access are needed even though the service initializes its default provider.
process.env.AZURE_OPENAI_RESOURCE_NAME ??= "agent-loop-test";
process.env.AZURE_OPENAI_API_KEY ??= "agent-loop-test";

type ModelResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;

function toolCall(
  toolCallId: string,
  toolName: string,
  input: Record<string, unknown> = {}
): ModelResult {
  return {
    content: [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  };
}

function toolHistory(messages: ReadonlyArray<{ content: unknown }>): string[] {
  return messages.flatMap(({ content }) =>
    Array.isArray(content)
      ? content.flatMap((part) =>
          part.type === "tool-call" || part.type === "tool-result"
            ? [`${part.type}:${part.toolCallId}`]
            : []
        )
      : []
  );
}

test("keeps all automatic tool history exactly once through two screenshot continuations", async () => {
  const { createAgentLoop } = await import("../src/agents/core/agentLoop");
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall("skill-1", "load_skill"),
      toolCall("state-1", "get_device_state"),
      toolCall("screen-1", "get_latest_screenshot"),
      toolCall("navigate-1", "navigate"),
      toolCall("screen-2", "get_latest_screenshot"),
      toolCall("complete-1", "complete_task", {
        success: false,
        message: "The requested screen could not be verified.",
      }),
    ],
  });
  const executed: string[] = [];
  const tools: ToolDefinition[] = ["load_skill", "get_device_state", "navigate"].map(
    (name) => ({
      type: "function",
      function: { name, parameters: { type: "object", properties: {} } },
      execute: async () => {
        executed.push(name);
        return { observation: `${name} result retained`, toolSuccess: true };
      },
    })
  );
  tools.push({
    type: "function",
    function: {
      name: "get_latest_screenshot",
      parameters: { type: "object", properties: {} },
    },
  });
  const loop = createAgentLoop(
    { systemPrompt: "Test tool history.", model: "history-test", tools, maxIterations: 8 },
    () => model
  );
  const session = loop.createSession("Open the app home screen.");
  const firstHistory = [
    "tool-call:skill-1", "tool-result:skill-1",
    "tool-call:state-1", "tool-result:state-1",
    "tool-call:screen-1",
  ];
  // A small local PNG exercises the same tool-result + user-image continuation.
  const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

  try {
    const first = await loop.run(session.id);
    assert.equal(first.type, "tool_calls");
    assert.equal(first.toolCalls?.[0].id, "screen-1");
    assert.deepEqual(toolHistory(loop.getMessages(session.id)), firstHistory);

    const second = await loop.submitToolResults(session.id, [{
      toolCallId: "screen-1", toolName: "get_latest_screenshot",
      result: "First screenshot received.", imageBase64, imageContentType: "image/png",
    }]);
    assert.equal(second.type, "tool_calls");
    assert.equal(second.toolCalls?.[0].id, "screen-2");
    // Inspect the actual next provider request, not just the local session store.
    assert.deepEqual(toolHistory(model.doGenerateCalls[3].prompt), [
      ...firstHistory, "tool-result:screen-1",
    ]);
    const firstResumePrompt = JSON.stringify(model.doGenerateCalls[3].prompt);
    assert.match(firstResumePrompt, /load_skill result retained/);
    assert.match(firstResumePrompt, /get_device_state result retained/);
    assert.match(firstResumePrompt, /First screenshot received/);
    const secondHistory = [
      ...firstHistory, "tool-result:screen-1",
      "tool-call:navigate-1", "tool-result:navigate-1", "tool-call:screen-2",
    ];
    assert.deepEqual(toolHistory(loop.getMessages(session.id)), secondHistory);

    const completed = await loop.submitToolResults(session.id, [{
      toolCallId: "screen-2", toolName: "get_latest_screenshot",
      result: "Second screenshot received.", imageBase64, imageContentType: "image/png",
    }]);
    assert.equal(completed.type, "complete");
    assert.equal(completed.success, false);
    assert.equal(completed.completionToolCallId, "complete-1");
    assert.deepEqual(toolHistory(model.doGenerateCalls[5].prompt), [
      ...secondHistory, "tool-result:screen-2",
    ]);
    const secondResumePrompt = JSON.stringify(model.doGenerateCalls[5].prompt);
    assert.match(secondResumePrompt, /load_skill result retained/);
    assert.match(secondResumePrompt, /get_device_state result retained/);
    assert.match(secondResumePrompt, /navigate result retained/);
    assert.match(secondResumePrompt, /First screenshot received/);
    assert.match(secondResumePrompt, /Second screenshot received/);
    assert.deepEqual(toolHistory(loop.getMessages(session.id)), [
      ...secondHistory, "tool-result:screen-2", "tool-call:complete-1",
    ]);
    assert.deepEqual(executed, ["load_skill", "get_device_state", "navigate"]);
    assert.equal(model.doGenerateCalls.length, 6);
    assert.equal(
      loop.getMessages(session.id).filter((message) =>
        Array.isArray(message.content) && message.content.some((part) => part.type === "image")
      ).length,
      2
    );
  } finally {
    loop.deleteSession(session.id);
  }
});
