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
  });
  await t.test("aborted execution returns no success assessment", async (subtest) => {
    subtest.mock.method(console, "error", () => {});
    subtest.mock.method(globalThis, "fetch", async () => { assert.fail("A pre-aborted run must not request a model"); });
    const controller = new AbortController();
    controller.abort(new Error("Offline TV cancelled"));
    await assert.rejects(adapter.execute(adapter.scenarios[0], controller.signal), /Offline TV cancelled/);
  });
});
