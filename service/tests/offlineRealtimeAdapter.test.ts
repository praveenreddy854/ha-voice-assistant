import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import test from "node:test";
import { buildRealtimeInstructions, buildRealtimeTurnInstructions, needsActionConfirmation, REALTIME_TOOLS } from "../src/realtimeAgent";
import { createRealtimeAdapter, createRealtimeAdapterWithTransport } from "../src/evals/realtime/adapter";
import { RealtimeEnvironment } from "../src/evals/realtime/environment";
import { executeRealtimeSession, realtimeDeploymentUrl, realtimeUsage } from "../src/evals/realtime/executor";
import { EvalExecutionError, TrialTelemetry } from "../src/evals/telemetry";
import type { RealtimeExecutionOptions, RealtimeSocket, RealtimeTransport } from "../src/evals/realtime/executor";
import { realtimeScenarios } from "../src/evals/realtime/scenarios";
import { installNetworkBoundary } from "../src/evals/network";
import type { RealtimeGoal } from "../src/evals/realtime/scenarios";

type Frame = Record<string, any>;
const config = { resourceName: "fixture-resource", apiVersion: "2025-04-01-preview", apiKey: "fixture-key-not-for-evidence", model: "actual-realtime-deployment" };
const usage = { input_tokens: 10, output_tokens: 2, total_tokens: 12 };
const message = (text: string): Frame => ({ type: "message", role: "assistant", content: [{ type: "text", text }] });
const call = (name: string, args: Frame, id = "call-1"): Frame => ({ type: "function_call", name, call_id: id, arguments: JSON.stringify(args) });
const done = (id: string, output: Frame[], extra: Frame = {}): Frame => ({ type: "response.done", response: { id, status: "completed", output, usage, ...extra } });

class FakeSocket extends EventEmitter implements RealtimeSocket {
  readyState = 0;
  sent: Frame[] = [];
  closeCalls = 0;
  terminateCalls = 0;
  constructor(readonly onSend: (frame: Frame, socket: FakeSocket) => void) { super(); }
  open(): void { this.readyState = 1; this.emit("open"); }
  server(frame: Frame): void { this.emit("message", Buffer.from(JSON.stringify(frame))); }
  send(value: string): void { const frame = JSON.parse(value); this.sent.push(frame); this.onSend(frame, this); }
  close(code = 1000): void { this.closeCalls++; this.readyState = 3; this.emit("close", code); }
  terminate(): void { this.terminateCalls++; this.readyState = 3; this.emit("close", 1006); }
}
function transportFor(respond: (index: number, socket: FakeSocket, frame: Frame) => void) {
  const sockets: FakeSocket[] = [];
  const connections: Array<{ url: string; options: Parameters<RealtimeTransport>[1] }> = [];
  const transport: RealtimeTransport = (url, options) => {
    let index = 0;
    const socket = new FakeSocket((frame, ws) => {
      if (frame.type === "session.update") ws.server({ type: "session.updated" });
      if (frame.type === "response.create") respond(index++, ws, frame);
    });
    sockets.push(socket); connections.push({ url, options });
    queueMicrotask(() => socket.open());
    return socket;
  };
  return { transport, sockets, connections };
}
function options(transport: RealtimeTransport, extra: Partial<RealtimeExecutionOptions> = {}): RealtimeExecutionOptions {
  return {
    transport, url: realtimeDeploymentUrl(config.resourceName, config.apiVersion, config.model),
    apiKey: config.apiKey, instructions: buildRealtimeInstructions(), turns: [{ text: "Hello." }],
    signal: new AbortController().signal, beginTurn: () => "", executeTool: () => '{"ok":true}', finishTurn() {},
    timeoutMs: 500, ...extra,
  };
}
const scenario = (id: string) => realtimeScenarios.find(item => item.id === id)!;
const environment = (id: string) => { const env = new RealtimeEnvironment(scenario(id)); env.beginTurn(0); return env; };

test("extracted production prompt and tool declarations are byte-identical to their original contracts", () => {
  const source = fs.readFileSync(path.join(__dirname, "../src/realtimeAgent.ts"), "utf8");
  const tools = source.slice(source.indexOf("export const REALTIME_TOOLS ="), source.indexOf("\n\nexport function buildRealtimeInstructions")).replace(/^export /, "").trim();
  const prompt = source.slice(source.indexOf("const REALTIME_INSTRUCTIONS ="), source.indexOf("\n  return REALTIME_INSTRUCTIONS;")).trim();
  const hash = (text: string) => createHash("sha256").update(text).digest("hex");
  assert.equal(hash(tools), "012b2525f8bb65da4df830ef23a74da88b217d3108a9067d8a2a9bbe49c6f09d");
  assert.equal(hash(prompt), "3d5f9b1b512f32421d539aac4ad1ad894261aacd31bdfb7c72ccd57d0b364c58");
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
  assert.match(production, /modalities: \["text", "audio"\]/);
  assert.match(production, /model: AI_MODEL_TRANSCRIBE/);
});

test("default factory reports AI_MODEL_REALTIME, never an advanced chat model", async () => {
  process.env.AI_MODEL_REALTIME = "fixture-native-realtime";
  process.env.AI_MODEL_ADVANCED = "must-not-substitute-generic-chat";
  process.env.AZURE_OPENAI_RESOURCE_NAME = "fixture-resource";
  process.env.AZURE_OPENAI_API_KEY = config.apiKey;
  const adapter = await createRealtimeAdapter();
  assert.equal(adapter.id, "realtime");
  assert.equal(adapter.model, "fixture-native-realtime");
  assert.equal((await createRealtimeAdapter("explicit-realtime-deployment")).model, "explicit-realtime-deployment");
  assert.throws(() => createRealtimeAdapterWithTransport({ ...config, model: "" }, () => { throw new Error("must not connect"); }), /AI_MODEL_REALTIME/);
});

test("the real ws transport's HTTPS upgrade is subject to the existing worker network boundary", async () => {
  const original = { request: http.request, get: http.get, secureRequest: https.request, secureGet: https.get, fetch: globalThis.fetch };
  let upgrades = 0;
  try {
    https.request = (() => { upgrades++; throw new Error("Allowed upgrade reached fixture HTTPS transport"); }) as typeof https.request;
    installNetworkBoundary("fixture-resource.openai.azure.com");
    const { default: WebSocket } = await import("ws");
    assert.throws(() => new WebSocket(realtimeDeploymentUrl(config.resourceName, config.apiVersion, config.model)), /Allowed upgrade reached fixture HTTPS transport/);
    assert.equal(upgrades, 1);
    assert.throws(() => new WebSocket("wss://home-assistant.example.test/api/websocket"), /Offline eval blocked network/);
    assert.throws(() => new WebSocket("wss://fixture-resource.openai.azure.com/not-an-openai-path"), /Offline eval blocked network/);
    assert.equal(upgrades, 1, "blocked destinations must not reach the mocked transport or DNS");
  } finally {
    http.request = original.request; http.get = original.get;
    https.request = original.secureRequest; https.get = original.secureGet;
    globalThis.fetch = original.fetch;
  }
});

test("native Realtime request shape, isolated job acceptance, complete evidence and fresh session per attempt", async t => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No live tool fetch is permitted"); });
  const fake = transportFor((index, ws) => ws.server(done(`response-${index}`, index === 0
    ? [call("execute_home_assistant_command", { command: "Dim only the kitchen lights to 30 percent." })]
    : [message("On it")])));
  const adapter = createRealtimeAdapterWithTransport(config, fake.transport);
  for (let i = 0; i < 2; i++) {
    const result = await adapter.execute(scenario("ha-immediate-qualified"), new AbortController().signal);
    assert.equal(result.taskAssertion, true);
    assert.equal(result.model, config.model);
    assert.equal(result.finalResponse, "On it");
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 4, totalTokens: 24 });
    assert.equal(result.metrics?.userTurns, 1);
    assert.equal(result.metrics?.assistantTurns, 2);
    assert.equal(result.metrics?.modelRequests, 2);
    assert.equal(result.metrics?.toolCalls, 1);
    assert.equal(result.metrics?.toolExecutions, 1);
    assert.equal(result.metrics?.completionCalls, 0);
    assert.equal(result.metrics?.toolErrors, 0);
    assert.equal(result.trace?.toolCalls[0].toolCallId, "call-1");
    assert.doesNotMatch(JSON.stringify(result.trace), /fixture-key-not-for-evidence/);
    assert.equal(result.coverage, "complete");
    assert.match(result.expectations!, /Audio, microphone/);
    assert.deepEqual(new Set(result.evidence.map(item => item.kind)), new Set(["initial", "tool", "context", "final", "assertion"]));
    const tool = result.evidence.find(item => item.kind === "tool")!;
    assert.equal(JSON.parse(tool.text).jobId, "fixture-job-1");
    assert.equal(tool.args?.command, "Dim only the kitchen lights to 30 percent.");
    assert.match(tool.text, /job started.*On it/);
    assert.doesNotMatch(JSON.stringify(result.evidence), /fixture-key-not-for-evidence/);
    const state = JSON.parse(result.evidence[result.evidence.length - 1].text).finalFixtureState;
    assert.equal(state.devices.find((item: Frame) => item.entityId === "light.kitchen").state, "off");
  }
  assert.equal(fake.sockets.length, 2);
  for (const socket of fake.sockets) {
    assert.equal(socket.closeCalls, 1);
    assert.equal(socket.readyState, 3);
    assert.equal(socket.listenerCount("message"), 0);
    const session = socket.sent[0].session;
    assert.deepEqual(session.modalities, ["text"]);
    assert.equal(session.turn_detection, null);
    assert.equal(session.input_audio_transcription, null);
    assert.deepEqual(session.tools, REALTIME_TOOLS);
    assert.equal(session.voice, undefined);
    assert.ok(session.max_response_output_tokens > 0);
    assert.ok(socket.sent.filter(frame => frame.type === "response.create").every(frame => JSON.stringify(frame.response.modalities) === '["text"]'));
  }
  const connection = fake.connections[0];
  const url = new URL(connection.url);
  assert.equal(url.protocol, "wss:");
  assert.equal(url.pathname, "/openai/realtime");
  assert.equal(url.searchParams.get("deployment"), config.model);
  assert.equal(url.searchParams.get("api-version"), config.apiVersion);
  assert.deepEqual(connection.options.headers, { "api-key": config.apiKey });
  assert.equal(connection.options.followRedirects, false);
  for (const filename of Object.keys(require.cache)) {
    assert.doesNotMatch(filename, /\/src\/(?:realtimeChat|ha|memory|tvJobManager|activeRunManager)\.[jt]s$/);
    assert.doesNotMatch(filename, /\/src\/agents\/core\/agentLoop\.[jt]s$/);
  }
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

test("all twelve stateful fixtures support their expected paths and leave language correctness to the judge", async () => {
  assert.equal(realtimeScenarios.length, 12);
  for (const fixture of realtimeScenarios) {
    const script = fixture.initial.turns.flatMap(turn => happyTurn(turn.goal, turn.text));
    const fake = transportFor((index, ws) => {
      const output = script[index].map(item => item.type === "function_call" ? { ...item, call_id: `call-${index}` } : item);
      ws.server(done(`response-${index}`, output));
    });
    const result = await createRealtimeAdapterWithTransport(config, fake.transport).execute(fixture, new AbortController().signal);
    const assertion = JSON.parse(result.evidence[result.evidence.length - 1].text);
    assert.deepEqual(assertion.violations, [], fixture.id);
    assert.notEqual(result.taskAssertion, false, fixture.id);
    assert.equal(result.metrics?.userTurns, fixture.initial.turns.length, fixture.id);
    assert.equal(result.metrics?.assistantTurns, script.length, fixture.id);
    assert.equal(result.metrics?.modelRequests, script.length, fixture.id);
    assert.equal(result.metrics?.toolCalls, script.flat().filter(item => item.type === "function_call").length, fixture.id);
    if (fixture.initial.turns.some(turn => !["delegate", "control"].includes(turn.goal.kind))) {
      assert.equal(result.taskAssertion, undefined, fixture.id);
    }
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

test("response/tool caps validate a whole batch before simulated effects and prevent replay", async () => {
  for (const [extra, output, error] of [
    [{ maxResponses: 1 }, [call("await_user_followup", {})], /response limit/],
    [{ maxToolCalls: 1 }, [call("await_user_followup", {}, "a"), call("await_user_followup", {}, "b")], /tool-call limit/],
    [{}, [call("await_user_followup", {}, "a"), call("await_user_followup", {}, "a")], /Duplicate Realtime tool call/],
    [{}, [call("await_user_followup", {}, "a"), call("execute_home_assistant_command", { confirmed: true }, "b")], /command is required/],
  ] as const) {
    let effects = 0;
    const fake = transportFor((_index, ws) => ws.server(done("r", [...output])));
    await assert.rejects(executeRealtimeSession(options(fake.transport, { ...extra, executeTool: () => { effects++; return "{}"; } })), error);
    assert.equal(effects, 0);
    assert.equal(fake.sockets[0].closeCalls, 1);
  }
  let effects = 0;
  const replay = transportFor((index, ws) => ws.server(done(`r${index}`, [call("await_user_followup", {}, "replayed")])));
  await assert.rejects(executeRealtimeSession(options(replay.transport, { executeTool: () => { effects++; return "{}"; } })), /Duplicate Realtime tool call/);
  assert.equal(effects, 1);
});

test("failed, incomplete, cancelled, empty and malformed Realtime responses never pass", async () => {
  for (const [frame, expected] of [
    [done("r", [], { status: "failed" }), /ended with failed/],
    [done("r", [], { status: "incomplete", status_details: { reason: "max_output_tokens" } }), /incomplete/],
    [done("r", [], { status: "cancelled" }), /cancelled/],
    [done("r", []), /without a text answer/],
    [done("r", [call("made_up_tool", {})]), /Unsupported simulated/],
    [{ type: "error", error: { message: "deployment does not support Realtime" } }, /Realtime API error/],
    [{ type: "response.audio.delta", delta: "must-not-be-accepted" }, /unexpectedly received audio/],
  ] as const) {
    const fake = transportFor((_index, ws) => ws.server(frame));
    await assert.rejects(executeRealtimeSession(options(fake.transport)), expected);
    assert.equal(fake.sockets[0].readyState, 3);
  }
  const malformed = transportFor((_index, ws) => ws.emit("message", Buffer.from("{")));
  await assert.rejects(executeRealtimeSession(options(malformed.transport)), /JSON/);
});

test("abort, timeout, dial errors and early closes settle and shut down the socket", async () => {
  const cancelled = new AbortController();
  cancelled.abort(new Error("pre-aborted"));
  await assert.rejects(executeRealtimeSession(options(() => { throw new Error("must not connect"); }, { signal: cancelled.signal })), /pre-aborted/);
  const controller = new AbortController();
  const aborting = transportFor(() => controller.abort(new Error("stop eval")));
  await assert.rejects(executeRealtimeSession(options(aborting.transport, { signal: controller.signal })), /stop eval/);
  assert.equal(aborting.sockets[0].readyState, 3);
  const hanging = transportFor(() => {});
  const telemetry = new TrialTelemetry();
  await assert.rejects(executeRealtimeSession(options(hanging.transport, { timeoutMs: 10, telemetry })), /timed out/);
  const timeoutMetrics = telemetry.finish(new Error("Timed out")).metrics;
  assert.equal(timeoutMetrics.stopReason, "timeout");
  assert.equal(timeoutMetrics.modelErrors, 1);
  assert.equal(timeoutMetrics.modelRequests, 1);
  assert.equal(timeoutMetrics.assistantTurns, 0);
  assert.equal(hanging.sockets[0].readyState, 3);
  const closed = transportFor((_index, ws) => ws.close(1006));
  await assert.rejects(executeRealtimeSession(options(closed.transport)), /closed before completion/);
  let failedSocket: FakeSocket;
  await assert.rejects(executeRealtimeSession(options(() => {
    failedSocket = new FakeSocket(() => {});
    queueMicrotask(() => failedSocket.emit("error", new Error("fixture dial failure")));
    return failedSocket;
  })), /fixture dial failure/);
  assert.equal(failedSocket!.terminateCalls, 1);
  const upgrade = transportFor((_index, ws) => ws.emit("unexpected-response", {}, { statusCode: 401 }));
  await assert.rejects(executeRealtimeSession(options(upgrade.transport)), /upgrade rejected: HTTP 401/);
});

test("Realtime duplicate completions are counted once and native token subsets are retained", async () => {
  const fake = transportFor((index, ws) => {
    const frame = done(`response-${index}`, index === 0
      ? [call("execute_home_assistant_command", { command: "Dim only the kitchen lights to 30 percent." })]
      : [message("On it")], {
        usage: { ...usage, input_token_details: { cached_tokens: 3 }, output_token_details: { reasoning_tokens: 1 } },
      });
    ws.server(frame);
    ws.server(frame);
  });
  const result = await createRealtimeAdapterWithTransport(config, fake.transport)
    .execute(scenario("ha-immediate-qualified"), new AbortController().signal);
  assert.equal(result.metrics?.assistantTurns, 2);
  assert.equal(result.metrics?.toolCalls, 1);
  assert.equal(result.metrics?.modelRequests, 2);
  assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 4, totalTokens: 24, cacheReadTokens: 6, reasoningTokens: 2 });
  assert.equal(realtimeUsage({ input_tokens: -1 }).inputTokens, undefined);
});

test("Realtime transport failures keep partial response text, prior tool evidence and honest usage coverage", async () => {
  const fake = transportFor((index, ws) => {
    if (index === 0) ws.server(done("tool-response", [
      call("execute_home_assistant_command", { command: "Dim only the kitchen lights to 30 percent." }),
    ]));
    else {
      ws.server({ type: "response.text.delta", delta: "On" });
      setImmediate(() => ws.emit("error", new Error("Connection lost")));
    }
  });
  const adapter = createRealtimeAdapterWithTransport(config, fake.transport);
  await assert.rejects(adapter.execute(scenario("ha-immediate-qualified"), new AbortController().signal), (error: unknown) => {
    assert.ok(error instanceof EvalExecutionError);
    const result = error.assessment;
    assert.equal(result.coverage, "partial");
    assert.equal(result.metrics?.stopReason, "error");
    assert.equal(result.metrics?.assistantTurns, 1);
    assert.equal(result.metrics?.modelRequests, 2);
    assert.equal(result.metrics?.modelErrors, 1);
    assert.equal(result.metrics?.toolExecutions, 1);
    assert.equal(result.usage?.totalTokens, undefined);
    assert.equal(result.trace?.modelCalls[0].responses[0].usage?.totalTokens, 12);
    assert.equal(result.trace?.modelCalls[1].partialText, "On");
    assert.equal(result.evidence.filter(item => item.kind === "tool").length, 1);
    assert.doesNotMatch(JSON.stringify(result), /fixture-key-not-for-evidence/);
    return true;
  });
  assert.equal(fake.sockets[0].readyState, 3);
});

test("abort during an isolated tool prevents later outputs, calls and response creation", async () => {
  const controller = new AbortController();
  let calls = 0, release: (value: string) => void = () => {};
  const fake = transportFor((_index, ws) => ws.server(done("r", [
    call("await_user_followup", {}, "a"), call("await_user_followup", {}, "b"),
  ])));
  const execution = executeRealtimeSession(options(fake.transport, {
    signal: controller.signal,
    executeTool: () => {
      calls++;
      controller.abort(new Error("cancel during tool"));
      return new Promise<string>(resolve => { release = resolve; });
    },
  }));
  await assert.rejects(execution, /cancel during tool/);
  release("{}");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(fake.sockets[0].sent.filter(frame => frame.item?.type === "function_call_output").length, 0);
  assert.equal(fake.sockets[0].sent.filter(frame => frame.type === "response.create").length, 1);
  assert.equal(fake.sockets[0].readyState, 3);
});

test("usage stays unknown if any Realtime response omits token counts", async () => {
  for (const missing of [0, 1]) {
    const fake = transportFor((index, ws) => ws.server(done(`r${index}`,
      index === 0 ? [call("await_user_followup", {})] : [message("Which device?")],
      index === missing ? { usage: undefined } : {})));
    const result = await executeRealtimeSession(options(fake.transport));
    assert.deepEqual(result.usage, { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined });
  }
});
