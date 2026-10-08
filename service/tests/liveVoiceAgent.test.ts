import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { AgentLoopConfig } from "../src/agents/core/agentLoop";
import type { LiveDelegationRequest } from "../src/liveDelegation";

const requireModule = createRequire(__filename);
function runnerFixture(memory = async () => "Use bedroom lights by default.", beforeComplete?: (config: AgentLoopConfig) => Promise<void>) {
  let config!: AgentLoopConfig;
  let sessionArgs: unknown[] = [];
  let deleted = false;
  let fail = false;
  const evidence: Array<{ type: string; args: any[] }> = [];
  const capture = (type: string) => (...args: any[]) => evidence.push({ type, args });
  const stubs: Record<string, unknown> = {
    "../src/config": { AI_MODEL_ADVANCED: "existing-advanced-deployment" },
    "../src/memory": { getPromptMemoryContext: memory, recordMemoryInteraction: capture("memory") },
    "../src/tracing/agentTraceStore": {
      createTrace: capture("started"), addEvent: capture("event"), addLLMStep: capture("step"),
      completeTrace: capture("finished"), trackToolResult: capture("tool"),
      withTraceSession: (_id: string, callback: () => unknown) => callback(),
    },
    "../src/agents/core/agentLoop": { createAgentLoop: (options: AgentLoopConfig) => {
      config = options;
      return {
        createSession: (...args: unknown[]) => { sessionArgs = args; return { id: "voice-session" }; },
        run: async () => {
          await beforeComplete?.(config);
          return fail ? { type: "error", error: "Model unavailable" } : { type: "complete", message: "Done." };
        },
        deleteSession: () => { deleted = true; },
      };
    } },
  };
  const path = requireModule.resolve("../src/liveVoiceAgent");
  const previous = new Map<string, NodeModule | undefined>([[path, requireModule.cache[path]]]);
  delete requireModule.cache[path];
  try {
    for (const [name, exports] of Object.entries(stubs)) {
      const path = requireModule.resolve(name);
      previous.set(path, requireModule.cache[path]);
      requireModule.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeModule;
    }
    const { runLiveVoiceAgent } = requireModule("../src/liveVoiceAgent");
    return { runLiveVoiceAgent, config: () => config, sessionArgs: () => sessionArgs, deleted: () => deleted, evidence, fail: () => { fail = true; } };
  } finally {
    for (const [path, value] of previous) {
      if (value) requireModule.cache[path] = value;
      else delete requireModule.cache[path];
    }
  }
}
function request(signal = new AbortController().signal): LiveDelegationRequest {
  return { command: "Turn on the lights", delegationId: "d1", signal, history: [{ role: "user", content: "Use my bedroom", createdAt: Date.now() }] };
}
const tools = [{ type: "function" as const, name: "execute_home_assistant_command", description: "Execute HA", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }];

test("voice reasoning uses existing model, history, memory, and capability tools", async () => {
  const fixture = runnerFixture();
  const input = request();
  const result = await fixture.runLiveVoiceAgent(input, "Voice routing instructions", tools, async () => "Done.");
  assert.equal(result, "Done.");
  assert.equal(fixture.config().model, "existing-advanced-deployment");
  assert.equal(fixture.config().tools[0].function.name, "execute_home_assistant_command");
  assert.deepEqual(fixture.sessionArgs().slice(1), [input.history, ["Use bedroom lights by default."]]);
  assert.equal(fixture.deleted(), true);
  assert.deepEqual(fixture.evidence.find((item) => item.type === "finished")?.args, ["realtime-voice-session", true, "Done.", "completed"]);
});

test("disconnect during memory retrieval prevents model creation and execution", async () => {
  let release!: (value: string) => void;
  const fixture = runnerFixture(() => new Promise<string>((resolve) => { release = resolve; }));
  const abort = new AbortController();
  const run = fixture.runLiveVoiceAgent(request(abort.signal), "instructions", tools, async () => "bad");
  abort.abort(new Error("Disconnected"));
  release("Memory");
  await assert.rejects(run, /Disconnected/);
  assert.equal(fixture.config(), undefined);
});

test("model failures clean up the temporary agent session", async () => {
  const fixture = runnerFixture();
  fixture.fail();
  await assert.rejects(fixture.runLiveVoiceAgent(request(), "instructions", tools, async () => "Done."), /Model unavailable/);
  assert.equal(fixture.deleted(), true);
  assert.deepEqual(fixture.evidence.find((item) => item.type === "finished")?.args, ["realtime-voice-session", false, "Model unavailable", "error"]);
});

test("delegated reasoning retains tool outcomes, provider usage, and conversation evidence", async () => {
  const fixture = runnerFixture(undefined, async (config) => {
    await config.tools[0].execute!({ command: "Turn on the lights" }, { toolCallId: "call-1" } as any);
    config.onStepFinish!({
      stepNumber: 1, text: "", toolCalls: [{ toolName: "execute_home_assistant_command", toolCallId: "call-1", args: { command: "Turn on the lights" } }],
      finishReason: "tool_calls", requestModel: "existing-advanced-deployment", responseId: "response-1", provider: "azure.ai.openai",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, performance: { responseTimeMs: 25 },
      messages: [{ role: "user", content: "Turn on the lights" }], systemMessages: ["Voice routing instructions"],
    });
  });
  await fixture.runLiveVoiceAgent(request(), "Voice routing instructions", tools, async () => JSON.stringify({ success: true, jobId: "job-1" }));
  const result = fixture.evidence.find((item) => item.type === "tool")?.args[1];
  assert.equal(result.toolCallId, "call-1");
  assert.equal(result.toolSuccess, true);
  const step = fixture.evidence.find((item) => item.type === "step")?.args[1];
  assert.equal(step.requestModel, "existing-advanced-deployment");
  assert.equal(step.inputTokens, 10);
  assert.equal(step.toolCalls[0].toolCallId, "call-1");
  assert.deepEqual(step.messages, [{ role: "user", content: "Turn on the lights" }]);
});

test("AI SDK tool execution stays ordered and abort prevents queued work", async () => {
  const fixture = runnerFixture();
  const abort = new AbortController();
  const seen: string[] = [];
  let finish!: (value: string) => void;
  await fixture.runLiveVoiceAgent(request(abort.signal), "instructions", tools, async (_name: string, args: Record<string, unknown>) => {
    seen.push(String(args.command));
    return new Promise<string>((resolve) => { finish = resolve; });
  });
  const execute = fixture.config().tools[0].execute!;
  const first = execute({ command: "first" });
  const second = execute({ command: "second" });
  const rejected = assert.rejects(second, /Disconnected/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, ["first"]);
  abort.abort(new Error("Disconnected"));
  finish("Done.");
  await first;
  await rejected;
  assert.deepEqual(seen, ["first"]);
});
