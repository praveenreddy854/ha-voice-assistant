import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { before, after } from "node:test";
import { configureTestProviders, deferred, readModelRequest, toolResponse } from "./helpers/agentFixtures";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { telemetrySpanExporter } from "../src/tracing/agentTraceStore";
import type { AgentRunResult } from "../src/agents/core/types";

let core: typeof import("../src/agents/core");
let jobs: typeof import("../src/tvJobManager");
let traces: typeof import("../src/tracing/agentTraceStore");
const completions: AgentRunResult[] = [];
const loopSessionIds = new Map<string, string>();
const requireModule = createRequire(__filename);
let rtspMode = false;
let screenshotAvailable = false;
const started = new Set<string>();
const stopped = new Set<string>();
const previous = new Map<string, NodeModule | undefined>();

const sdk = new NodeSDK({ autoDetectResources: false, spanProcessors: [new SimpleSpanProcessor(telemetrySpanExporter)] });
after(async () => {
  await sdk.shutdown();
  for (const [path, cached] of previous) {
    if (cached) requireModule.cache[path] = cached;
    else delete requireModule.cache[path];
  }
});

before(async () => {
  sdk.start();
  configureTestProviders();
  process.env.CAMERA_ON_DEVICE = "true";
  const utils = requireModule("../src/agents/common/utils") as typeof import("../src/agents/common/utils");
  const stubs: Record<string, unknown> = {
    "../src/agents/common/rtspCapture": {
      isRtspMode: () => rtspMode,
      startRtspCapture: async (id: string) => { started.add(id); },
      stopRtspCapture: (id: string) => { stopped.add(id); },
    },
    "../src/agents/common/screenshotStore": { getLatestScreenshot: async () => screenshotAvailable
      ? { base64: "c3ludGhldGlj", contentType: "image/jpeg", filePath: "/synthetic/frame.jpg" }
      : undefined },
    "../src/agents/common/utils": { ...utils, delay: async () => {} },
  };
  for (const [name, exports] of Object.entries(stubs)) {
    const path = requireModule.resolve(name);
    previous.set(path, requireModule.cache[path]);
    requireModule.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeModule;
  }
  core = await import("../src/agents/core");
  jobs = await import("../src/tvJobManager");
  traces = await import("../src/tracing/agentTraceStore");
  core.registerAgent({
    agentType: "tv", name: "Synthetic TV", description: "Input cleanup fixture",
    systemPrompt: "Synthetic input fixture", maxIterations: 4,
    tools: ["request_input", "get_latest_screenshot"].map((name) => ({
      type: "function", function: { name, parameters: { type: "object", properties: {} } },
    })),
    buildInitialMessage: async (prompt) => prompt,
    executeTool: async () => { throw new Error("No device execution expected"); },
    getToolActionSummary: (name) => name,
    buildToolContext: () => ({}),
    onComplete: async (session, result) => {
      loopSessionIds.set(session.id, session.agentLoopSessionId);
      completions.push(result);
    },
  });
});

test("failed background input closes the child trace and deletes both sessions before notification", { timeout: 10_000 }, async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    readModelRequest(url, init);
    return toolResponse("request_input", {}, "background-input");
  });
  const done = deferred();
  let failure = "";
  let completed = false;
  const count = completions.length;
  jobs.startTvAgentJob("Synthetic background input", {
    onComplete: () => { completed = true; done.resolve(); },
    onError: (message) => { failure = message; done.resolve(); },
  });
  await done.promise;
  assert.equal(completed, false);
  assert.match(failure, /stalled waiting for a screenshot/);
  assert.equal(completions.length, count + 1);
  const result = completions[count];
  assert.equal(result.status, "error");
  assert.equal(result.success, false);
  assert.equal(core.getSession(result.sessionId), undefined);
  const trace = traces.getTrace(result.sessionId)!;
  assert.equal(trace.status, "error");
  assert.equal(trace.success, false);
  assert.ok(trace.completedAt);
  assert.equal(trace.finalMessage, failure);
  const loop = core.getAgentLoop("tv")!;
  assert.deepEqual(loop.getMessages(loopSessionIds.get(result.sessionId)!), []);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(jobs.getActiveTvJob(), null);
});

test("interactive input remains resumable and completes with the supplied input", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    readModelRequest(url, init);
    return ++calls === 1 ? toolResponse("request_input", {}, "interactive-input")
      : toolResponse("complete_task", { success: true, message: "Synthetic completion" }, "interactive-done");
  });
  const count = completions.length;
  const pending = await core.runAgent({ agentType: "tv", userPrompt: "Synthetic interactive input" });
  assert.equal(pending.status, "awaiting_external_input");
  const session = core.getSession(pending.sessionId)!;
  assert.ok(session);
  const loop = core.getAgentLoop("tv")!;
  assert.ok(loop.getMessages(session.agentLoopSessionId).length > 0);
  assert.equal(completions.length, count);
  const resumed = await core.runAgent({ agentType: "tv", sessionId: pending.sessionId,
    externalInput: { type: "confirmation", data: { answer: "yes" } } });
  assert.equal(resumed.status, "completed");
  assert.equal(resumed.success, true);
  assert.equal(core.getSession(pending.sessionId), undefined);
  assert.deepEqual(loop.getMessages(session.agentLoopSessionId), []);
});

test("missing RTSP frames stop both session and job captures without another model call", { timeout: 10_000 }, async (t) => {
  rtspMode = true;
  started.clear();
  stopped.clear();
  t.after(() => { rtspMode = false; });
  let modelCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    readModelRequest(url, init);
    modelCalls++;
    return toolResponse("get_latest_screenshot", {}, "missing-frame");
  });
  const done = deferred();
  let failure = "";
  const count = completions.length;
  const job = jobs.startTvAgentJob("Synthetic missing frame", {
    onError: (message) => { failure = message; done.resolve(); },
    onComplete: () => done.resolve(),
  });
  await done.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(failure, /stalled waiting for a screenshot/);
  const result = completions[count];
  assert.equal(result.status, "error");
  assert.equal(core.getSession(result.sessionId), undefined);
  assert.equal(traces.getTrace(result.sessionId)!.status, "error");
  assert.deepEqual(started, new Set([job.jobId, result.sessionId]));
  assert.deepEqual(stopped, started);
  assert.equal(modelCalls, 1);
});

test("an already waiting session can fail without resuming the model", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    readModelRequest(url, init);
    calls++;
    return toolResponse("request_input", {}, "existing-input");
  });
  const pending = await core.runAgent({ agentType: "tv", userPrompt: "Synthetic waiting session" });
  const session = core.getSession(pending.sessionId)!;
  assert.equal(pending.status, "awaiting_external_input");
  const failed = await core.runAgent({ agentType: "tv", sessionId: pending.sessionId,
    externalInputFailureMessage: "Synthetic caller cannot provide input" });
  assert.equal(failed.status, "error");
  assert.equal(failed.success, false);
  assert.equal(core.getSession(pending.sessionId), undefined);
  assert.deepEqual(core.getAgentLoop("tv")!.getMessages(session.agentLoopSessionId), []);
  assert.equal(traces.getTrace(pending.sessionId)!.status, "error");
  assert.equal(calls, 1);
});


test("automatic screenshot fulfillment completes background jobs and stops both captures", { timeout: 10_000 }, async (t) => {
  rtspMode = true;
  screenshotAvailable = true;
  started.clear();
  stopped.clear();
  t.after(() => { rtspMode = false; screenshotAvailable = false; });
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    readModelRequest(url, init);
    return ++calls === 1 ? toolResponse("get_latest_screenshot", {}, "available-frame")
      : toolResponse("complete_task", { success: true, message: "Synthetic completion" }, "automatic-done");
  });
  const done = deferred();
  let message = "";
  let failure = "";
  const count = completions.length;
  const job = jobs.startTvAgentJob("Synthetic available frame", {
    onComplete: (value) => { message = value; done.resolve(); },
    onError: (value) => { failure = value; done.resolve(); },
  });
  await done.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(failure, "");
  assert.equal(message, "Synthetic completion");
  const result = completions[count];
  assert.equal(result.status, "completed");
  assert.equal(result.success, true);
  assert.equal(core.getSession(result.sessionId), undefined);
  assert.deepEqual(started, new Set([job.jobId, result.sessionId]));
  assert.deepEqual(stopped, started);
  assert.equal(calls, 2);
});
