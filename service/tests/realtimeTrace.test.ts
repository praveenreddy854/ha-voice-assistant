import assert from "node:assert/strict";
import test from "node:test";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { getTrace, telemetrySpanExporter } from "../src/tracing/agentTraceStore";
import { RealtimeTraceRecorder } from "../src/tracing/realtimeTrace";
import type { RealtimeTraceSink } from "../src/tracing/realtimeTrace";
import type { TraceLLMStep, TraceToolResult } from "../src/tracing/agentTraceStore";

const response = (id: string, text: string, extra: Record<string, unknown> = {}) => ({
  type: "response.done",
  response: { id, status: "completed", output: [{ type: "message", content: [{ type: "audio", transcript: text, audio: "omitted-audio" }] }],
    usage: { input_tokens: 30, output_tokens: 7, total_tokens: 37, input_token_details: { cached_tokens: 3 } }, ...extra },
});
const toolEvent = (responseId: string, raw = '{ "command": "Dim only the kitchen lights to 30 percent." }') => ({
  type: "response.function_call_arguments.done", response_id: responseId, call_id: "call-ha",
  name: "execute_home_assistant_command", arguments: raw,
});
const toolDone = (id: string) => ({
  type: "response.done", response: { id, status: "completed", output: [{
    type: "function_call", name: "execute_home_assistant_command", call_id: "call-ha",
    arguments: '{ "command": "Dim only the kitchen lights to 30 percent." }',
  }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } },
});
function fixture(extra: { terminalGraceMs?: number; turnTimeoutMs?: number } = {}) {
  let time = 1000, id = 0;
  const created: Array<{ id: string; type: string; request: string }> = [];
  const requests: Array<{ id: string; request: string }> = [];
  const steps: Array<{ id: string; value: TraceLLMStep }> = [];
  const tools: Array<{ id: string; value: TraceToolResult }> = [];
  const events: Array<{ id: string; type: string; message: string; data?: Record<string, unknown> }> = [];
  const completed: Array<{ id: string; success: boolean; text: string; status: string; at: number }> = [];
  const sink: RealtimeTraceSink = {
    create(id, type, request) { created.push({ id, type, request }); },
    request(id, request) { requests.push({ id, request }); },
    step(id, value) { steps.push({ id, value }); },
    tool(id, value) { tools.push({ id, value }); },
    event(id, type, message, data) { events.push({ id, type, message, data }); },
    complete(id, success, text, status) { completed.push({ id, success, text, status, at: time }); },
  };
  const recorder = new RealtimeTraceRecorder({
    model: "actual-realtime-deployment", instructions: "Exact production instructions", sink,
    now: () => time, makeId: () => `fixture-turn-${++id}`, ...extra,
  });
  return { recorder, created, requests, steps, tools, events, completed, advance: (ms: number) => { time += ms; } };
}
const created = (id: string) => ({ type: "response.created", response: { id } });
const committed = (id: string) => ({ type: "input_audio_buffer.committed", item_id: id });
const transcript = (id: string, text: string) => ({ type: "conversation.item.input_audio_transcription.completed", item_id: id, transcript: text });

test("a retained turn spans tool-only responses, exact tool results and final spoken text without audio", () => {
  const f = fixture();
  const id = f.recorder.beginText("Dim only the kitchen lights to 30 percent.");
  f.recorder.responseRequested(id, "Injected per-turn memory");
  f.recorder.observe(created("r-tool"));
  const token = f.recorder.startTool(toolEvent("r-tool"));
  f.advance(50);
  const output = '{"success":true,"jobId":"accepted-only","message":"Home Assistant job started. Say exactly: On it."}';
  f.recorder.finishTool(token, output);
  f.advance(100);
  f.recorder.observe(toolDone("r-tool"));
  assert.equal(f.completed.length, 0, "function-call-only response is not a terminal user answer");
  assert.equal(f.tools.length, 1);
  assert.equal(f.tools[0].value.observation, output);
  assert.equal(f.tools[0].value.durationMs, 50);
  assert.deepEqual(f.tools[0].value.args, { command: "Dim only the kitchen lights to 30 percent." });
  assert.equal(f.steps[0].value.responseTimeMs, 150);
  assert.equal(f.steps[0].value.timestamp, new Date(1000).toISOString());
  assert.equal(f.steps[0].value.requestModel, "actual-realtime-deployment");
  assert.deepEqual(f.steps[0].value.systemMessages, ["Exact production instructions", "Injected per-turn memory"]);
  f.recorder.responseRequested(id);
  f.recorder.observe(created("r-spoken"));
  f.recorder.observe({ type: "response.audio.delta", response_id: "r-spoken", delta: "secret-raw-audio", apiKey: "secret-credential" });
  f.recorder.observe({ type: "response.audio_transcript.delta", response_id: "r-spoken", delta: "On " });
  f.recorder.observe({ type: "response.audio_transcript.delta", response_id: "r-spoken", delta: "it" });
  f.advance(250);
  f.recorder.observe(response("r-spoken", "On it", { model: "reported-realtime-model" }));
  assert.deepEqual(f.completed, [{ id, status: "completed", success: true, text: "On it", at: 1400 }]);
  assert.equal(f.steps.length, 2);
  assert.equal(f.steps[1].value.responseTimeMs, 250);
  assert.equal(f.steps[1].value.inputTokens, 30);
  assert.equal(f.steps[1].value.cacheReadTokens, 3);
  assert.equal(f.steps[1].value.responseModel, "reported-realtime-model");
  assert.equal(f.created[0].type, "realtime");
  const retained = JSON.stringify([f.created, f.requests, f.events, f.steps, f.tools, f.completed]);
  assert.doesNotMatch(retained, /secret-raw-audio|omitted-audio|secret-credential/);
  assert.ok(f.events.some(event => event.data?.rawArguments === toolEvent("r-tool").arguments));
  f.recorder.observe(response("r-spoken", "duplicate"));
  assert.equal(f.completed.length, 1);
});

test("late audio transcription updates the original lifecycle and is not assigned to a newer turn", () => {
  const f = fixture();
  f.recorder.observe(committed("audio-a"));
  const a = f.recorder.currentTurnId!;
  f.recorder.responseRequested(a);
  f.recorder.observe(created("ra"));
  f.advance(100);
  f.recorder.observe(response("ra", "Answer A"));
  assert.equal(f.completed.length, 0, "response.done must wait for the already-committed audio item's transcript");
  assert.equal(f.steps.length, 1, "usage and response timings are retained at their actual arrival, not delayed until transcription");
  f.recorder.observe(committed("audio-b"));
  const b = f.recorder.currentTurnId!;
  assert.notEqual(a, b);
  f.recorder.responseRequested(b);
  f.recorder.observe(created("rb"));
  f.recorder.observe(transcript("audio-b", "Request B"));
  f.advance(100);
  f.recorder.observe(transcript("audio-a", "Request A"));
  assert.deepEqual(f.completed.map(item => item.id), [a]);
  assert.equal(f.recorder.currentTurnId, b);
  f.recorder.observe(response("rb", "Answer B"));
  assert.deepEqual(f.requests, [{ id: b, request: "Request B" }, { id: a, request: "Request A" }]);
  assert.deepEqual(f.completed.map(item => [item.id, item.text]), [[a, "Answer A"], [b, "Answer B"]]);
  assert.equal(f.created.length, 2);
  assert.equal(f.steps[0].value.responseTimeMs, 100);
});

test("tool results retain the original owner across interleaved turns and finish only after results arrive", () => {
  const f = fixture();
  const a = f.recorder.beginText("Request A");
  f.recorder.responseRequested(a); f.recorder.observe(created("ra1"));
  const token = f.recorder.startTool(toolEvent("ra1"));
  f.recorder.observe(toolDone("ra1"));
  f.recorder.responseRequested(a); f.recorder.observe(created("ra2"));
  f.recorder.observe(response("ra2", "On it"));
  assert.equal(f.completed.length, 0);
  const b = f.recorder.beginText("Request B");
  f.recorder.responseRequested(b); f.recorder.observe(created("rb"));
  f.recorder.observe(response("rb", "Answer B"));
  f.advance(400);
  f.recorder.finishTool(token, '{"success":true,"jobId":"accepted-only"}');
  assert.deepEqual(f.completed.map(item => item.id), [b, a]);
  assert.equal(f.tools[0].id, a);
  assert.equal(f.tools[0].value.durationMs, 400);
  f.recorder.finishTool(token, '{"success":true,"jobId":"duplicate"}');
  assert.equal(f.tools.length, 1);
});

test("async specialist announcements and replayed responses are not fabricated user turns", () => {
  const f = fixture();
  const a = f.recorder.beginText("Request A");
  f.recorder.responseRequested(a); f.recorder.observe(created("ra")); f.recorder.observe(response("ra", "On it"));
  f.recorder.responseRequested(null, 'Say exactly "Done."');
  f.recorder.observe(created("announcement"));
  const b = f.recorder.beginText("Request B");
  f.recorder.responseRequested(b);
  f.recorder.interrupt("Interrupting the untraced async announcement");
  assert.equal(f.recorder.currentTurnId, b, "interrupting an announcement must not cancel a queued user turn");
  f.recorder.observe(response("announcement", "Done"));
  f.recorder.observe(response("ra", "Replayed old response"));
  assert.equal(f.completed.length, 1);
  f.recorder.observe(created("rb")); f.recorder.observe(response("rb", "Answer B"));
  assert.equal(f.created.length, 2);
  assert.deepEqual(f.steps.map(item => item.value.responseId), ["ra", "rb"]);
  assert.deepEqual(f.completed.map(item => item.text), ["On it", "Answer B"]);
});

test("cancellation preserves partial spoken text, unknown usage and the correct interrupted identity", () => {
  const f = fixture();
  const a = f.recorder.beginText("Explain the Moon's phases.");
  f.recorder.responseRequested(a); f.recorder.observe(created("ra"));
  f.recorder.observe({ type: "response.audio_transcript.delta", response_id: "ra", delta: "The Moon orbits" });
  f.recorder.observe(committed("audio-b"));
  const b = f.recorder.currentTurnId;
  f.recorder.interrupt("User interrupted");
  assert.equal(f.completed.length, 0);
  f.recorder.observe({ type: "response.done", response: { id: "ra", status: "cancelled", output: [] } });
  assert.deepEqual(f.completed.map(item => [item.id, item.status, item.text]), [[a, "error", "The Moon orbits"]]);
  assert.equal(f.steps[0].value.inputTokens, undefined);
  assert.equal(f.steps[0].value.totalTokens, undefined);
  assert.equal(f.recorder.currentTurnId, b);
  f.recorder.observe(transcript("audio-b", "Stop."));
  f.recorder.close("Client closed");
  assert.equal(f.completed.length, 2);
  assert.equal(f.completed[1].id, b);
});

test("connection close retains a terminal error, partial model output and asynchronous tool failure", () => {
  const f = fixture();
  const id = f.recorder.beginText("Dim the lights.");
  f.recorder.responseRequested(id); f.recorder.observe(created("r"));
  const token = f.recorder.startTool(toolEvent("r"));
  f.recorder.observe({ type: "response.text.delta", response_id: "r", delta: "I can" });
  f.advance(200);
  f.recorder.close("Azure connection closed");
  assert.equal(f.completed.length, 0, "do not discard an already-started tool result on connection close");
  f.advance(100);
  f.recorder.finishTool(token, '{"error":"fixture tool failed"}', new Error("fixture tool failed"));
  assert.deepEqual(f.completed, [{ id, success: false, status: "error", text: "I can", at: 1300 }]);
  assert.equal(f.steps[0].value.finishReason, "connection_closed");
  assert.equal(f.steps[0].value.totalTokens, undefined);
  assert.equal(f.tools[0].value.toolSuccess, false);
  assert.equal(f.tools[0].value.durationMs, 300);
  assert.ok(f.events.some(event => event.message === "fixture tool failed"));
  f.recorder.close("duplicate close");
  assert.equal(f.completed.length, 1);
});

test("API failures, missing/failed transcription and bare wake phrases terminate without invented requests", async () => {
  const f = fixture({ terminalGraceMs: 5 });
  f.recorder.observe(committed("late"));
  const id = f.recorder.currentTurnId!;
  f.recorder.responseRequested(id); f.recorder.observe(created("r"));
  f.recorder.observe(response("r", "Answer"));
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(f.completed.length, 1);
  assert.equal(f.requests[0].request, "[Audio transcription unavailable]");
  assert.ok(f.events.some(event => event.type === "realtime.evidence.gap"));
  f.recorder.observe(transcript("old-unretained-audio", "A historical request"));
  assert.equal(f.created.length, 1, "never manufacture traces for old transcript-only events");
  f.recorder.observe(committed("failed"));
  const failed = f.recorder.currentTurnId;
  f.recorder.observe({ type: "conversation.item.input_audio_transcription.failed", item_id: "failed" });
  f.recorder.observe({ type: "error", error: { message: "deployment unavailable" }, audio: "raw", apiKey: "credential" });
  assert.equal(f.completed[1].id, failed);
  assert.equal(f.completed[1].status, "error");
  assert.doesNotMatch(JSON.stringify(f.events), /"raw"|"credential"/);
  f.recorder.observe(committed("wake"));
  f.recorder.observe(transcript("wake", "Hey assistant"));
  f.recorder.finishWakePhrase("wake");
  assert.equal(f.completed[2].status, "completed");
  assert.equal(f.completed[2].text, "");
});

test("a missing response.created has unknown latency and a missing terminal answer is an error", () => {
  const f = fixture();
  const id = f.recorder.beginText("Hello");
  f.recorder.responseRequested(id);
  f.recorder.observe(response("no-created", "Hello"));
  assert.equal(f.steps[0].value.responseTimeMs, undefined);
  assert.ok(f.events.some(event => /start time is unknown/.test(event.message)));
  const next = f.recorder.beginText("Do something");
  f.recorder.responseRequested(next); f.recorder.observe(created("preamble"));
  f.recorder.observe({ type: "response.text.delta", response_id: "preamble", delta: "Let me check." });
  f.recorder.observe(toolDone("preamble"));
  f.recorder.responseRequested(next); f.recorder.observe(created("empty"));
  f.recorder.observe({ type: "response.done", response: { id: "empty", status: "completed", output: [] } });
  assert.equal(f.completed[1].status, "error");
  assert.equal(f.completed[1].text, "Let me check.");
});

test("benign cleanup errors and failing trace sinks do not alter voice execution but capture failures are visible", t => {
  const errors = t.mock.method(console, "error", () => {});
  const f = fixture();
  const id = f.recorder.beginText("Hello");
  f.recorder.observe({ type: "error", error: { message: "no active response" } });
  f.recorder.observe({ type: "error", error: { message: "the audio buffer is empty" } });
  assert.equal(f.completed.length, 0);
  f.recorder.responseRequested(id); f.recorder.observe(created("r")); f.recorder.observe(response("r", "Hello"));
  assert.equal(f.completed.length, 1);
  assert.equal(errors.mock.callCount(), 0);
  const fail = () => { throw new Error("Telemetry unavailable: sensitive payload"); };
  const recorder = new RealtimeTraceRecorder({
    model: "realtime", instructions: "instructions",
    sink: { create: fail, request: fail, event: fail, step: fail, tool: fail, complete: fail },
  });
  assert.doesNotThrow(() => {
    const failedId = recorder.beginText("Hello");
    recorder.responseRequested(failedId); recorder.observe(created("failed-sink"));
    const token = recorder.startTool(toolEvent("failed-sink"));
    recorder.finishTool(token, '{"success":true}');
    recorder.observe(response("failed-sink", "Hello"));
    recorder.close("Test complete");
  });
  assert.ok(errors.mock.callCount() > 0);
  for (const call of errors.mock.calls) {
    assert.match(String(call.arguments[0]), /Evidence capture failed/);
    assert.doesNotMatch(JSON.stringify(call.arguments), /sensitive payload/);
  }
});

test("default recorder persists the updated audio request, timestamps, steps and terminal lifecycle through the existing store", async () => {
  const processor = new SimpleSpanProcessor(telemetrySpanExporter);
  const sdk = new NodeSDK({ spanProcessors: [processor] });
  sdk.start();
  try {
    const recorder = new RealtimeTraceRecorder({ model: "fixture-native-realtime", instructions: "fixture instructions" });
    recorder.observe(committed("persisted-audio"));
    const id = recorder.currentTurnId!;
    assert.equal(getTrace(id)?.status, "running");
    recorder.responseRequested(id); recorder.observe(created("persisted-response"));
    recorder.observe(response("persisted-response", "Retained spoken answer"));
    assert.equal(getTrace(id)?.status, "running");
    recorder.observe(transcript("persisted-audio", "The actual late user transcription"));
    await processor.forceFlush();
    const trace = getTrace(id)!;
    assert.equal(trace.agentType, "realtime");
    assert.equal(trace.status, "completed");
    assert.equal(trace.userPrompt, "The actual late user transcription");
    assert.equal(trace.finalMessage, "Retained spoken answer");
    assert.equal(trace.llmSteps.length, 1);
    assert.equal(trace.llmSteps[0].requestModel, "fixture-native-realtime");
    assert.equal(trace.llmSteps[0].totalTokens, 37);
    assert.ok(trace.completedAt);
    assert.ok(trace.durationMs !== undefined && trace.durationMs >= 0);
    assert.ok(Date.parse(trace.completedAt!) >= Date.parse(trace.startedAt));
  } finally { await sdk.shutdown(); }
});
