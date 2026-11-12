import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import test from "node:test";
import { buildRealtimeInstructions, buildRealtimeTurnInstructions, needsActionConfirmation, REALTIME_TOOLS } from "../src/realtimeAgent";
import { buildLiveVoiceSystemPrompt, LIVE_VOICE_MAX_ITERATIONS, liveVoiceToolDefinitions } from "../src/liveVoiceContract";
import { createRealtimeAdapter, createRealtimeAdapterWithLoop } from "../src/evals/realtime/adapter";
import { matchesSemanticRequest, RealtimeEnvironment } from "../src/evals/realtime/environment";
import { executeRealtimeSession, REALTIME_EVAL_LIMITS } from "../src/evals/realtime/executor";
import { EvalExecutionError, TrialTelemetry } from "../src/evals/telemetry";
import { realtimeScenarios } from "../src/evals/realtime/scenarios";
import { installNetworkBoundary } from "../src/evals/network";
import type { RealtimeGoal } from "../src/evals/realtime/scenarios";
import { configureTestProviders, readModelRequest, toolResponse } from "./helpers/agentFixtures";

configureTestProviders();
type Frame = Record<string, any>;
const message = (text: string): Frame => ({ type: "message", content: [{ type: "text", text }] });
const call = (name: string, args: Frame, id = "call-1"): Frame => ({ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) });
const scenario = (id: string) => realtimeScenarios.find(item => item.id === id)!;
const environment = (id: string) => { const env = new RealtimeEnvironment(scenario(id)); env.beginTurn(0); return env; };

test("shared production voice prompt and tool schemas match the GPT Live migration contract", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/realtimeAgent.ts"), "utf8");
  const tools = source.slice(source.indexOf("export const REALTIME_TOOLS ="), source.indexOf("\n\nexport function buildRealtimeInstructions")).replace(/^export /, "").trim();
  const prompt = source.slice(source.indexOf("const REALTIME_INSTRUCTIONS ="), source.indexOf("\n  return REALTIME_INSTRUCTIONS;")).trim();
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  assert.equal(hash(tools), "012b2525f8bb65da4df830ef23a74da88b217d3108a9067d8a2a9bbe49c6f09d");
  assert.equal(hash(prompt), "fbf4724bab07dc139b629f45e59b39014c22e04f1f9ef4b847606a47c1e386db");
  assert.equal(REALTIME_TOOLS.length, 11);
  assert.doesNotMatch(buildRealtimeInstructions(), /Known smart-home devices|user's address/);
  assert.match(buildRealtimeInstructions({ devices: ["fixture-device"], address: "Seattle" }), /Known smart-home devices fixture-device\./);
  assert.match(buildRealtimeInstructions({ address: "Seattle" }), /The user's address is: Seattle\./);
  const runtime = buildRealtimeTurnInstructions({ memoryContext: "fixture memory", activeRun: { id: "same-id", domain: "tv", status: "paused" } });
  assert.match(runtime, /^fixture memory\n\nRuntime state: TV agent job same-id is PAUSED/);
  assert.equal(needsActionConfirmation("Unlock the front door"), true);
  assert.equal(needsActionConfirmation("Turn off all lights"), true);
  assert.equal(needsActionConfirmation("Dim the kitchen lights"), false);
  const production = fs.readFileSync(path.join(__dirname, "../src/realtimeChat.ts"), "utf8");
  assert.match(production, /from "\.\/realtimeAgent"/);
  assert.doesNotMatch(production, /const REALTIME_TOOLS =|turn_detection:/);
  assert.match(production, /model: AI_MODEL_LIVE/);
  assert.match(production, /delegation: \{ type: "client" \}/);
  assert.match(production, /runLiveVoiceAgent/);
});

function happyTurn(goal: RealtimeGoal, text: string): Array<Frame[]> {
  if (goal.kind === "delegate") return [[call({ home_assistant: "execute_home_assistant_command", scheduled_task: "run_scheduled_task_agent", tv: "start_tv_agent" }[goal.domain],
    { [goal.domain === "home_assistant" ? "command" : "prompt"]: text, ...(goal.confirmed ? { confirmed: true } : {}) })], [message("On it")]];
  if (goal.kind === "confirm") return [[call("await_user_followup", {})], [message(`Please confirm: should I ${text.toLowerCase().replace(/\.$/, "")}?`)]];
  if (goal.kind === "clarify") return [[call("await_user_followup", {})], [message("Which device do you mean?")]];
  if (goal.kind === "chat") return [[message("The Moon's phases are the changing portion of its sunlit half that we see as it orbits Earth.")]];
  if (goal.kind === "web") return [[call("web_search", { query: "Seattle current weather" })], [message("The fixture's Seattle observation at noon UTC on September 13, 2026 reports 16 degrees Celsius and light rain.")]];
  if (goal.kind === "control") return [[call("control_active_run", { action: goal.action, ...(goal.action === "change" ? { domain: goal.domain, prompt: text } : {}) })], [message(goal.action === "stop" ? "Done" : "On it")]];
  const args = goal.action === "retrieve" ? { query: text }
    : goal.action === "delete" ? { id: "fixture-memory-1" }
      : { text, scopes: { deviceEntityIds: [goal.entityId] }, memoryType: "preference", ...(goal.action === "update" ? { id: "fixture-memory-1" } : {}) };
  return [[call(`${goal.action}_memory`, args)], [message(goal.action === "retrieve" ? "You prefer the bedroom thermostat at 19 degrees Celsius at night." : "I've updated your memory as requested.")]];
}

test("default factory uses production reasoning with legacy realtime configuration unset", async () => {
  delete process.env.AI_MODEL_REALTIME;
  const adapter = await createRealtimeAdapter();
  assert.equal(adapter.model, "test-model");
  assert.equal(adapter.version, "realtime-reasoning-simulator-2");
  assert.equal((await createRealtimeAdapter("candidate-reasoning-model")).model, "candidate-reasoning-model");
  assert.throws(() => createRealtimeAdapterWithLoop("", () => assert.fail("must not create loop")), /AI_MODEL_ADVANCED/);
});

test("all twelve stateful fixtures use serialized AI SDK requests with isolated effects and completed-turn history", async t => {
  assert.equal(realtimeScenarios.length, 12);
  for (const fixture of realtimeScenarios) await t.test(fixture.id, async subtest => {
    const script = fixture.initial.turns.flatMap(turn => happyTurn(turn.goal, turn.text));
    let requests = 0;
    const serialized: Frame[] = [];
    subtest.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(new URL(String(url)).pathname, "/openai/v1/responses");
      const request = readModelRequest(url, init) as unknown as Frame;
      serialized.push(request);
      assert.equal(request.model, "test-model");
      assert.ok(requests < script.length, "bounded fixture script");
      const output = script[requests++][0];
      return output.type === "function_call"
        ? toolResponse(output.name, JSON.parse(output.arguments), `call-${requests}`)
        : toolResponse("complete_task", { success: true, message: output.content[0].text }, `complete-${requests}`);
    });
    const adapter = await createRealtimeAdapter();
    const initial = JSON.stringify(fixture.initial);
    const result = await adapter.execute(fixture, new AbortController().signal);
    const assertion = JSON.parse(result.evidence.at(-1)!.text);
    assert.deepEqual(assertion.violations, []);
    assert.notEqual(result.taskAssertion, false);
    assert.equal(result.metrics?.userTurns, fixture.initial.turns.length);
    assert.equal(result.metrics?.modelRequests, script.length);
    assert.equal(result.metrics?.completionCalls, fixture.initial.turns.length);
    assert.equal(result.metrics?.toolExecutions, script.length - fixture.initial.turns.length);
    assert.equal(result.metrics?.unexecutedToolCalls, 0);
    assert.equal(result.usage?.totalTokens, script.length * 15);
    assert.equal(JSON.stringify(fixture.initial), initial, "input fixture remains unchanged");
    assert.equal(result.coverage, "complete");
    const lastTurnContext = result.evidence.filter(item => item.kind === "initial").map(item => JSON.parse(item.text)).filter(item => "memoryContext" in item).at(-1);
    if (lastTurnContext.memoryContext) assert.ok(result.trace?.systemMessages?.includes(lastTurnContext.memoryContext));
    assert.match(result.expectations!, /GPT Live transport/);
    assert.doesNotMatch(JSON.stringify(result), /test-key|test-token/);
    const prompt = JSON.stringify(serialized[0]);
    assert.match(prompt, /Return the exact user-facing reply by calling complete_task/);
    assert.doesNotMatch(prompt, /initialFixtureState|expectations|allowedNumbers|required.*forbidden|taskSatisfied/);
    assert.ok(serialized[0].tools.some((tool: Frame) => tool.name === "complete_task"));
    const names = serialized[0].tools.map((tool: Frame) => tool.name);
    for (const tool of liveVoiceToolDefinitions(REALTIME_TOOLS)) assert.ok(names.includes(tool.function.name));
    if (fixture.initial.turns.length > 1) {
      const lastRequest = JSON.stringify(serialized.at(-1));
      assert.ok(lastRequest.includes(fixture.initial.turns[0].text));
      assert.ok(lastRequest.includes(assertion.turnResponses[0]));
    }
    if (fixture.id === "ha-immediate-qualified") {
      assert.equal(assertion.finalFixtureState.devices.find((device: Frame) => device.entityId === "light.kitchen").state, "off");
      assert.equal(assertion.acceptedEffects[0].kind, "start", "acceptance is not physical completion");
    }
    if (fixture.initial.turns.some(turn => !["delegate", "control"].includes(turn.goal.kind))) assert.equal(result.taskAssertion, undefined);
  });
  for (const filename of Object.keys(require.cache)) {
    assert.doesNotMatch(filename, /\/src\/(?:realtimeChat|liveVoiceAgent|ha|memory|tvJobManager|activeRunManager)\.[jt]s$/);
  }
});

test("model-loop seam shares production prompt and step budget and always cleans sessions", async () => {
  const { createAgentLoop } = await import("../src/agents/core/agentLoop");
  let deleted = 0;
  const adapter = createRealtimeAdapterWithLoop("test-model", config => {
    assert.equal(config.maxIterations, LIVE_VOICE_MAX_ITERATIONS);
    assert.equal(config.systemPrompt, buildLiveVoiceSystemPrompt(`${new RealtimeEnvironment(scenario("general-chat")).instructions}\n`));
    const loop = createAgentLoop(config);
    return { ...loop, run: async () => ({ type: "error", error: "fixture failure" }), deleteSession(id) { deleted++; loop.deleteSession(id); } };
  });
  await assert.rejects(adapter.execute(scenario("general-chat"), new AbortController().signal), /fixture failure/);
  assert.equal(deleted, 1);
});

test("reasoning failures retain partial tool and provider evidence", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    readModelRequest(url, init);
    if (++requests === 1) return toolResponse("execute_home_assistant_command", { command: scenario("ha-immediate-qualified").request });
    return Response.json({ error: { message: "fixture model unavailable" } }, { status: 400 });
  });
  const adapter = await createRealtimeAdapter();
  await assert.rejects(adapter.execute(scenario("ha-immediate-qualified"), new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof EvalExecutionError);
    assert.equal(error.assessment.coverage, "partial");
    assert.equal(error.assessment.metrics?.toolExecutions, 1);
    assert.equal(error.assessment.metrics?.modelErrors, 1);
    assert.equal(error.assessment.usage?.totalTokens, undefined);
    assert.equal(error.assessment.evidence.filter(item => item.kind === "tool").length, 1);
    return true;
  });
});

test("missing complete_task and exhausted reasoning never fabricate completion", async t => {
  const { createAgentLoop } = await import("../src/agents/core/agentLoop");
  const { MockLanguageModelV4 } = await import("ai/test");
  const model = new MockLanguageModelV4({ doGenerate: async () => ({
    content: [{ type: "text", text: "Partial reply" }], finishReason: { unified: "stop", raw: undefined },
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } }, warnings: [],
  }) });
  const adapter = createRealtimeAdapterWithLoop("test-model", config => createAgentLoop(config, () => model));
  await assert.rejects(adapter.execute(scenario("general-chat"), new AbortController().signal), /complete_task|iteration limit/);
  assert.ok(model.doGenerateCalls.length <= LIVE_VOICE_MAX_ITERATIONS);
});

test("pre-abort, deadline and invalid turn bounds prevent completion and clean sessions", async () => {
  const { createAgentLoop } = await import("../src/agents/core/agentLoop");
  const aborted = new AbortController(); aborted.abort(new Error("cancel eval"));
  const adapter = createRealtimeAdapterWithLoop("test-model", () => assert.fail("must not create loop"));
  await assert.rejects(adapter.execute(scenario("general-chat"), aborted.signal), /cancel eval/);
  let deleted = 0;
  const telemetry = new TrialTelemetry();
  await assert.rejects(executeRealtimeSession({
    model: "test-model", environment: new RealtimeEnvironment(scenario("general-chat")), signal: new AbortController().signal, telemetry, timeoutMs: 10,
    createLoop: config => {
      const loop = createAgentLoop(config);
      return { ...loop, run: async (_id, signal) => new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })),
        deleteSession(id) { deleted++; loop.deleteSession(id); } };
    },
  }), /timeout|timed out/i);
  assert.equal(deleted, 1);
  assert.equal(telemetry.finish(new Error("timeout")).metrics.stopReason, "timeout");
  const invalid = structuredClone(scenario("general-chat"));
  invalid.initial.turns = Array.from({ length: REALTIME_EVAL_LIMITS.turns + 1 }, () => invalid.initial.turns[0]);
  await assert.rejects(adapter.execute(invalid, new AbortController().signal), /1-6 nonempty/);
});

test("model transport remains inside the offline network boundary", async () => {
  const original = { request: http.request, get: http.get, secureRequest: https.request, secureGet: https.get, fetch: globalThis.fetch };
  try {
    globalThis.fetch = async () => Response.json({ ok: true });
    installNetworkBoundary("fixture-resource.openai.azure.com");
    await globalThis.fetch("https://fixture-resource.openai.azure.com/openai/v1/responses", { method: "POST" });
    await assert.rejects(globalThis.fetch("http://home-assistant.fixture.invalid/api/services/light/turn_on", { method: "POST" }), /Offline eval blocked network/);
    await assert.rejects(globalThis.fetch("https://fixture-resource.openai.azure.com/not-openai"), /Offline eval blocked network/);
  } finally {
    http.request = original.request; http.get = original.get; https.request = original.secureRequest; https.get = original.secureGet; globalThis.fetch = original.fetch;
  }
});
test("independent assertions reject wrong target, domain, qualifiers, read/write polarity and duplicate effects", async () => {
  for (const [id, name, args] of [
    ["ha-immediate-qualified", "execute_home_assistant_command", { command: "Dim only the bedroom lights to 30 percent." }],
    ["ha-immediate-qualified", "execute_home_assistant_command", { command: "Dim the kitchen lights to 30 percent." }],
    ["ha-immediate-qualified", "execute_home_assistant_command", { command: "Dim only the kitchen lights to 100 percent." }],
    ["ha-immediate-qualified", "execute_home_assistant_command", { command: "Dim only the kitchen lights to 30 percent, then set them to 100 percent." }],
    ["ha-immediate-qualified", "execute_home_assistant_command", { command: "Do not dim only the kitchen lights to 30 percent." }],
    ["ha-immediate-qualified", "run_scheduled_task_agent", { prompt: "Dim only the kitchen lights to 30 percent." }],
    ["ha-read-only-state", "execute_home_assistant_command", { command: "Turn the kitchen lights on." }],
    ["scheduled-task-qualified", "run_scheduled_task_agent", { prompt: "Every weekday at 7 pm, turn on only the kitchen lights." }],
    ["tv-qualified-navigation", "start_tv_agent", { prompt: "Play Telugu songs on YouTube on the living room Apple TV." }],
    ["tv-qualified-navigation", "start_tv_agent", { prompt: "Play the latest Hindi songs on YouTube on the bedroom TV." }],
  ] as const) {
    const env = environment(id);
    await env.execute(name, args);
    env.finishTurn("On it");
    assert.equal(env.taskSatisfied(), false, JSON.stringify(args));
  }
  const duplicate = environment("ha-immediate-qualified");
  const command = { command: duplicate.scenario.request };
  await duplicate.execute("execute_home_assistant_command", command);
  await duplicate.execute("execute_home_assistant_command", command);
  duplicate.finishTurn("On it");
  assert.equal(duplicate.taskSatisfied(), false);
});

test("confirmations are scoped to a real preceding question and explicit fixture user reply", async () => {
  const forged = environment("protected-opening-confirmation");
  assert.match(await forged.execute("execute_home_assistant_command", { command: "Unlock the front door.", confirmed: true }), /confirmation_required/);
  assert.equal(forged.effects.length, 0);
  await forged.execute("await_user_followup", {});
  forged.finishTurn("Should I unlock the front door?");
  assert.equal(forged.taskSatisfied(), false);

  const guarded = environment("protected-opening-confirmation");
  assert.match(await guarded.execute("execute_home_assistant_command", { command: "Unlock the front door." }), /confirmation_required/);
  await guarded.execute("await_user_followup", {});
  guarded.finishTurn("Should I unlock the front door?");
  assert.equal(guarded.effects.length, 0);
  assert.equal(guarded.taskSatisfied(), undefined);

  const late = environment("confirmed-followup-once");
  late.observeAssistantText("Should I unlock the front door?");
  await late.execute("await_user_followup", {});
  late.finishTurn("Should I unlock the front door?");
  late.beginTurn(1);
  assert.match(await late.execute("execute_home_assistant_command", { command: "Unlock only the front door.", confirmed: true }), /confirmation_required/);
  late.finishTurn("On it");
  assert.equal(late.effects.length, 0);
  assert.equal(late.taskSatisfied(), false);

  const wrongTarget = environment("confirmed-followup-once");
  await wrongTarget.execute("await_user_followup", {});
  wrongTarget.finishTurn("Should I unlock the front door?");
  wrongTarget.beginTurn(1);
  assert.match(await wrongTarget.execute("execute_home_assistant_command", { command: "Unlock only the back door.", confirmed: true }), /confirmation_required/);
  wrongTarget.finishTurn("On it");
  assert.equal(wrongTarget.effects.length, 0);
  assert.equal(wrongTarget.taskSatisfied(), false);
});

test("paused run compatibility preserves identity; a fresh TV start is not a continuation", async () => {
  const env = environment("paused-run-lifecycle");
  const initialId = env.state.activeRun!.id;
  const result = JSON.parse(await env.execute("control_tv_agent", { action: "continue" }));
  assert.equal(result.jobId, initialId);
  assert.equal(env.state.activeRun!.id, initialId);
  env.finishTurn("On it");
  assert.deepEqual(env.violations, []);
  const wrong = environment("paused-run-lifecycle");
  await wrong.execute("start_tv_agent", { prompt: "Open YouTube on the living room Apple TV." });
  wrong.finishTurn("On it");
  assert.ok(wrong.violations.length);
});

test("simulated memory is isolated and wrong/global/ambiguous scopes never pass", async () => {
  for (const scopes of [{ global: true }, { deviceEntityIds: ["climate.living_room"] }, { deviceEntityIds: ["climate.bedroom", "climate.living_room"] }]) {
    const env = environment("scoped-memory-lifecycle");
    await env.execute("save_memory", { text: env.scenario.request, scopes });
    env.finishTurn("Saved.");
    assert.ok(env.violations.some(message => /scope/.test(message)));
    assert.equal(scenario("scoped-memory-lifecycle").initial.memories.length, 1);
  }
  const fixture = structuredClone(scenario("scoped-memory-lifecycle"));
  fixture.initial.turns = [fixture.initial.turns[4]];
  fixture.request = fixture.initial.turns[0].text;
  const env = new RealtimeEnvironment(fixture);
  env.beginTurn(0);
  assert.equal(JSON.parse(await env.execute("save_memory", { text: fixture.request })).clarification_required, true);
  assert.equal(env.state.memories.length, 1);
  env.finishTurn("Saved.");
  assert.equal(env.taskSatisfied(), false);
  const scoped = environment("scoped-memory-lifecycle");
  await scoped.execute("save_memory", { text: "The user prefers nineteen °C at night.", scopes: { deviceEntityIds: ["climate.bedroom"] } });
  scoped.finishTurn("Saved your bedroom thermostat preference.");
  assert.deepEqual(scoped.violations, [], "scope arguments can identify the device without repeating it in memory text");
});

test("no-tool nonsense is not asserted true; all unsupported simulation paths fail explicitly", async () => {
  const env = environment("general-chat");
  env.finishTurn("The Moon's phases are caused by Earth's shadow every night.");
  assert.equal(env.taskSatisfied(), undefined);
  await assert.rejects(environment("general-chat").execute("unknown_tool", {}), /Unsupported simulated/);
  await assert.rejects(environment("general-chat").execute("web_search", { query: "unmodeled topic" }), /No simulated web evidence/);
  await assert.rejects(environment("protected-opening-confirmation").execute("execute_home_assistant_command", { command: "Unlock the front door", confirmed: "true" }), /must be boolean/);
});


test("batch validation rejects duplicate calls, caps and malformed arguments before any fixture effect", async t => {
  for (const [label, calls, pattern] of [
    ["duplicate", [call("await_user_followup", {}, "same"), call("await_user_followup", {}, "same")], /Duplicate Realtime/],
    ["cap", Array.from({ length: 33 }, (_, i) => call("await_user_followup", {}, `call-${i}`)), /tool-call limit/],
    ["invalid", [call("await_user_followup", {}, "valid"), call("execute_home_assistant_command", { command: "Unlock the front door", confirmed: "true" }, "invalid")], /must be boolean/],
  ] as const) await t.test(label, async subtest => {
    subtest.mock.method(globalThis, "fetch", async () => {
      const response = await toolResponse("await_user_followup", {}).json();
      response.output = calls.map((tool, index) => ({ type: "function_call", id: `item-${index}`, call_id: tool.call_id, name: tool.name, arguments: tool.arguments }));
      return Response.json(response);
    });
    const adapter = await createRealtimeAdapter();
    await assert.rejects(adapter.execute(scenario("protected-opening-confirmation"), new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof EvalExecutionError);
      assert.match(error.message, pattern);
      assert.equal(error.assessment.metrics?.toolExecutions, 0);
      assert.equal(error.assessment.evidence.filter(item => item.kind === "tool").length, 0);
      return true;
    });
  });
});

test("oversized tool output and completion text are bounded before simulated effects", async t => {
  for (const name of ["complete_task", "execute_home_assistant_command"]) await t.test(name, async subtest => {
    const text = "x".repeat(REALTIME_EVAL_LIMITS.outputCharacters + 1);
    subtest.mock.method(globalThis, "fetch", async () => toolResponse(name, name === "complete_task" ? { success: true, message: text } : { command: text }));
    await assert.rejects((await createRealtimeAdapter()).execute(scenario("general-chat"), new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof EvalExecutionError);
      assert.match(error.message, /output character limit/);
      assert.equal(error.assessment.metrics?.toolExecutions, 0);
      assert.equal(error.assessment.coverage, "partial");
      return true;
    });
  });
});

test("cancellation during a fixture tool prevents subsequent calls and model requests", async t => {
  const { createAgentLoop } = await import("../src/agents/core/agentLoop");
  const controller = new AbortController();
  let requests = 0, calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    requests++;
    const response = await toolResponse("await_user_followup", {}, "first").json();
    const second = await toolResponse("await_user_followup", {}, "second").json();
    response.output.push(...second.output);
    return Response.json(response);
  });
  const env = new RealtimeEnvironment(scenario("protected-opening-confirmation"));
  env.execute = async () => { calls++; controller.abort(new Error("cancel during fixture tool")); return "{}"; };
  await assert.rejects(executeRealtimeSession({ createLoop: createAgentLoop, model: "test-model", environment: env, signal: controller.signal, telemetry: new TrialTelemetry() }), /cancel during fixture tool/);
  assert.equal(calls, 1);
  assert.equal(requests, 1);
});

test("scope-preserving exclusion from live confirmation passes without permitting negated or widened actions", () => {
  const fixture = scenario("ha-immediate-qualified");
  const goal = fixture.initial.turns[0].goal;
  assert.equal(goal.kind, "delegate");
  if (goal.kind !== "delegate") assert.fail("Expected routing fixture");
  assert.equal(fixture.version, "2");
  assert.equal(matchesSemanticRequest("Set only the kitchen lights (light.kitchen) to 30 percent brightness. Do not change any other lights.", goal.request), true);
  for (const command of [
    "Do not dim only the kitchen lights to 30 percent. Do not change any other lights.",
    "Dim only the bedroom lights to 30 percent. Do not change any other lights.",
    "Dim only the kitchen lights to 100 percent. Do not change any other lights.",
    "Dim only the kitchen lights to 30 percent. Do not change any other lights. Turn the bedroom lights on.",
  ]) assert.equal(matchesSemanticRequest(command, goal.request), false, command);
});

test("mixed fixture action and completion executes the action exactly as production does", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    assert.equal(++requests, 1);
    const response = await toolResponse("execute_home_assistant_command", { command: scenario("ha-immediate-qualified").request }, "action").json();
    const completion = await toolResponse("complete_task", { success: true, message: "On it." }, "completion").json();
    response.output.push(...completion.output);
    return Response.json(response);
  });
  const result = await (await createRealtimeAdapter()).execute(scenario("ha-immediate-qualified"), new AbortController().signal);
  assert.equal(result.taskAssertion, true);
  assert.equal(result.metrics?.toolExecutions, 1);
  assert.equal(result.metrics?.completionCalls, 1);
  assert.equal(JSON.parse(result.evidence.at(-1)!.text).acceptedEffects.length, 1);
});

test("completion cannot hide a repeated action after an earlier accepted job", async t => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async () => {
    const response = await toolResponse("execute_home_assistant_command", { command: scenario("ha-immediate-qualified").request }, `action-${++requests}`).json();
    assert.ok(requests <= 2);
    if (requests === 2) {
      const completion = await toolResponse("complete_task", { success: true, message: "On it." }, "completion").json();
      response.output.push(...completion.output);
    }
    return Response.json(response);
  });
  const result = await (await createRealtimeAdapter()).execute(scenario("ha-immediate-qualified"), new AbortController().signal);
  assert.equal(result.taskAssertion, false);
  assert.equal(result.metrics?.toolExecutions, 2);
  assert.equal(JSON.parse(result.evidence.at(-1)!.text).acceptedEffects.length, 2);
});
