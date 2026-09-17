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
    assert.equal(result.metrics?.userTurns, 1);
    assert.equal(result.metrics?.assistantTurns, 2);
    assert.equal(result.metrics?.modelRequests, 2);
    assert.equal(result.metrics?.toolCalls, 2);
    assert.equal(result.metrics?.toolExecutions, 1);
    assert.equal(result.metrics?.completionCalls, 1);
    assert.equal(result.metrics?.toolErrors, 0);
    assert.equal(result.metrics?.stopReason, "completed");
    assert.equal(result.trace?.modelCalls[0].responses[0].responseId, "response-screen");
    assert.ok(JSON.stringify(result.trace?.messages).includes('"type":"image"'));
    assert.ok(JSON.stringify(result.trace?.messages).includes('"mediaType":"image/png"'));
    assert.doesNotMatch(JSON.stringify(result.trace), /test-key/);
  } finally { globalThis.fetch = original; }
});

test("shared offline loop preserves TV's one-tool-per-turn rejection", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = readModelRequest(input, init);
    if (++calls === 1) {
      const first = await toolResponse("get_device_state", { reason: "Inspect current device" }, "state").json();
      const second = await toolResponse("get_latest_screenshot", { reason: "Extra parallel screenshot" }, "screen").json();
      return Response.json({ ...first, output: [...first.output, ...second.output] });
    }
    assert.match(JSON.stringify(request), /Rejected parallel tool call: only one tool is allowed per turn/);
    assert.doesNotMatch(JSON.stringify(request), /data:image\/png;base64/);
    return toolResponse("complete_task", { success: true, message: "Already open." }, "done");
  });
  const { createTvAdapter } = await import("../src/evals/tv/adapter");
  const adapter = await createTvAdapter();
  const result = await adapter.execute(adapter.scenarios[0], new AbortController().signal);
  assert.equal(calls, 2);
  assert.equal(result.taskAssertion, true);
  assert.deepEqual(result.evidence.filter(event => event.kind === "tool").map(event => event.toolName), ["get_device_state"]);
  assert.ok(result.evidence.every(event => !event.image));
  assert.equal(result.metrics?.toolCalls, 3);
  assert.equal(result.metrics?.toolExecutions, 1);
  assert.equal(result.metrics?.rejectedToolCalls, 1);
  assert.equal(result.metrics?.unexecutedToolCalls, 0);
  assert.match(result.trace!.toolCalls[1].error!, /only one tool/);
});

test("shared offline loop still rejects premature TV completion until required research happens", async (t) => {
  let calls = 0;
  const launch = { app_name: "YouTube", media_player_entity_id: "media_player.appletv", reason: "Open the requested app" };
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const request = readModelRequest(input, init);
    calls++;
    if (calls === 1 || calls === 4) return toolResponse("launch_app", launch, `launch-${calls}`);
    if (calls === 3) {
      assert.match(JSON.stringify(request), /Completion rejected: command verification failed and required device-command research is pending/);
      return toolResponse("web_search", { query: "Apple TV app launch", reason: "Research after failed verification" }, "research");
    }
    assert.ok(calls === 2 || calls === 5);
    return toolResponse("complete_task", { success: true, message: "YouTube ready." }, `done-${calls}`);
  });
  const { createTvAdapter } = await import("../src/evals/tv/adapter");
  const adapter = await createTvAdapter();
  const result = await adapter.execute(adapter.scenarios.find(scenario => scenario.id === "youtube-launch-recovery")!, new AbortController().signal);
  assert.equal(calls, 5);
  assert.equal(result.taskAssertion, true);
  assert.deepEqual(result.evidence.filter(event => event.kind === "tool").map(event => event.toolName), ["launch_app", "web_search", "launch_app"]);
  assert.equal(result.usage?.inputTokens, 50);
  assert.equal(result.metrics?.assistantTurns, 5);
  assert.equal(result.metrics?.toolCalls, 5);
  assert.equal(result.metrics?.toolExecutions, 3);
  assert.equal(result.metrics?.toolErrors, 1);
  assert.equal(result.metrics?.rejectedToolCalls, 1);
  assert.equal(result.metrics?.completionCalls, 2);
});

test("shared offline loop retains TV iteration-cap ordering for pending tools and completion", async (t) => {
  const [{ createTvAdapter }, { TV_AGENT_MAX_ITERATIONS_CAP: cap }] = await Promise.all([
    import("../src/evals/tv/adapter"), import("../src/agents/tv/constants"),
  ]);
  const adapter = await createTvAdapter();
  await t.test("pending tool at cap is not executed", async (subtest) => {
    let calls = 0;
    subtest.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      readModelRequest(input, init);
      assert.ok(++calls <= cap);
      return toolResponse("get_device_state", { reason: "Inspect device" }, `state-${calls}`);
    });
    const result = await adapter.execute(adapter.scenarios[0], new AbortController().signal);
    assert.equal(calls, cap);
    assert.equal(result.evidence.filter(event => event.kind === "tool").length, cap - 1);
    assert.match(result.finalResponse, /iteration limit reached without completion/);
    assert.equal(JSON.parse(result.evidence.at(-1)!.text).stoppedAtIterationLimit, true);
    assert.equal(result.taskAssertion, true, "Existing TV semantics keep already-satisfied device state independent of loop termination");
    assert.equal(result.metrics?.toolCalls, cap);
    assert.equal(result.metrics?.toolExecutions, cap - 1);
    assert.equal(result.metrics?.unexecutedToolCalls, 1);
    assert.equal(result.metrics?.stopReason, "iteration_limit");
  });
  await t.test("completion at cap is returned even when further research would otherwise be required", async (subtest) => {
    let calls = 0;
    subtest.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      readModelRequest(input, init);
      assert.ok(++calls <= cap);
      if (calls === 1) return toolResponse("launch_app", {
        app_name: "YouTube", media_player_entity_id: "media_player.appletv", reason: "First launch fails in fixture",
      }, "launch");
      if (calls === cap) return toolResponse("complete_task", { success: true, message: "Claim at cap." }, "done");
      return toolResponse("get_device_state", { reason: "Inspect failed launch" }, `state-${calls}`);
    });
    const result = await adapter.execute(adapter.scenarios.find(scenario => scenario.id === "youtube-launch-recovery")!, new AbortController().signal);
    assert.equal(calls, cap);
    assert.equal(result.finalResponse, "Claim at cap.");
    assert.equal(result.taskAssertion, false);
    assert.equal(JSON.parse(result.evidence.at(-1)!.text).stoppedAtIterationLimit, false);
  });
});

test("shared offline loop preserves unknown TV usage and propagates cancellation", async (t) => {
  const { createTvAdapter } = await import("../src/evals/tv/adapter");
  const adapter = await createTvAdapter();
  await t.test("missing usage remains unknown", async (subtest) => {
    let calls = 0;
    subtest.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      readModelRequest(input, init);
      if (++calls === 1) {
        const response = await toolResponse("get_device_state", { reason: "Inspect current state" }, "state").json();
        delete response.usage;
        return Response.json(response);
      }
      return toolResponse("complete_task", { success: true, message: "Already ready." }, "done");
    });
    const result = await adapter.execute(adapter.scenarios[0], new AbortController().signal);
    assert.equal(result.taskAssertion, true);
    assert.deepEqual(result.usage, { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined });
    assert.equal(result.metrics?.usageReportedResponses, 1);
    assert.equal(result.metrics?.assistantTurns, 2);
  });

  await t.test("TV raw telemetry retains SDK-rejected calls and their usage while preserving model recovery", async t => {
    t.mock.method(console, "error", () => {});
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      readModelRequest(input, init);
      return ++calls === 1 ? toolResponse("not_a_real_tool", { target: "TV" }, "invalid")
        : toolResponse("complete_task", { success: false, message: "Cannot use that tool." }, "done");
    });
    const adapter = await (await import("../src/evals/tv/adapter")).createTvAdapter();
    const result = await adapter.execute(adapter.scenarios[0], new AbortController().signal);
    assert.equal(result.metrics?.assistantTurns, 2);
    assert.equal(result.metrics?.toolCalls, 2);
    assert.equal(result.metrics?.toolExecutions, 0);
    assert.equal(result.metrics?.rejectedToolCalls, 1);
    assert.equal(result.metrics?.stopReason, "completed");
    assert.equal(result.usage?.inputTokens, 20);
    assert.equal(result.trace?.toolCalls[0].name, "not_a_real_tool");
    assert.equal(result.trace?.toolCalls[0].status, "rejected");
    assert.equal(result.trace?.modelCalls[0].responses[0].responseId, "response-invalid");
    assert.equal(result.evidence.filter(item => item.kind === "tool").length, 0);
  });

  await t.test("TV metrics include each SDK retry without pretending missing usage was free", async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      readModelRequest(input, init);
      if (++calls === 1) return Response.json({ error: { message: "Rate limited", type: "rate_limit_error" } }, {
        status: 429, headers: { "retry-after-ms": "1" },
      });
      return toolResponse("complete_task", { success: true, message: "Already open." }, "done");
    });
    const adapter = await (await import("../src/evals/tv/adapter")).createTvAdapter();
    const result = await adapter.execute(adapter.scenarios[0], new AbortController().signal);
    assert.equal(calls, 2);
    assert.equal(result.metrics?.modelRequests, 2);
    assert.equal(result.metrics?.modelErrors, 1);
    assert.equal(result.metrics?.assistantTurns, 1);
    assert.equal(result.metrics?.toolCalls, 1);
    assert.equal(result.usage?.totalTokens, undefined);
    assert.equal(result.trace?.modelCalls[1].responses[0].usage?.totalTokens, 15);
    assert.equal(result.taskAssertion, true);
  });

  await t.test("TV virtual waits are tracked separately from real simulator and model latency", async t => {
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      readModelRequest(input, init);
      return ++calls === 1 ? toolResponse("wait", { duration_ms: 1500, reason: "Let the fixture settle" }, "wait")
        : toolResponse("complete_task", { success: true, message: "Ready." }, "done");
    });
    const adapter = await (await import("../src/evals/tv/adapter")).createTvAdapter();
    const result = await adapter.execute(adapter.scenarios[0], new AbortController().signal);
    assert.equal(result.metrics?.virtualDeviceTimeMs, 1500);
    assert.equal(result.metrics?.toolExecutions, 1);
    assert.ok(result.durationMs! >= result.metrics!.toolTimeMs + result.metrics!.modelTimeMs);
    assert.equal(result.metrics?.stopReason, "completed");
  });
  await t.test("aborted execution returns no success assessment", async (subtest) => {
    subtest.mock.method(console, "error", () => {});
    subtest.mock.method(globalThis, "fetch", async () => { assert.fail("A pre-aborted run must not request a model"); });
    const controller = new AbortController();
    controller.abort(new Error("Offline TV cancelled"));
    await assert.rejects(adapter.execute(adapter.scenarios[0], controller.signal), /Offline TV cancelled/);
  });
});
