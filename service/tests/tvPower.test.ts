import assert from "node:assert/strict";
import test, { before, type TestContext } from "node:test";
import { setImmediate } from "node:timers/promises";
import axios from "axios";
import type { ToolExecutionContext } from "../src/agents/tv/tools/types";

let power: typeof import("../src/agents/tv/tools/clickPowerButton").definition;
before(async () => {
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_RESOURCE_NAME = "test-resource";
  process.env.HOME_ASSISTANT_URL = "http://ha.invalid";
  process.env.HOME_ASSISTANT_TOKEN = "test-token";
  process.env.TV_DEFAULT_WAIT_MS = "250";
  power = (await import("../src/agents/tv/tools/clickPowerButton")).definition;
});

const context: ToolExecutionContext = {
  homeAssistantUrl: "http://ha.invalid",
  homeAssistantToken: "test-token",
};

function mockStates(t: TestContext, states: string[]): void {
  let index = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.ok(url.startsWith("http://ha.invalid/api/states/remote."));
    return new Response(JSON.stringify({
      entity_id: decodeURIComponent(url.split("/").at(-1)!),
      state: states[Math.min(index++, states.length - 1)],
      attributes: {},
    }));
  });
}

// Drive both the polling deadline and delays without real waiting or HA calls.
async function finishWithClock<T>(t: TestContext, run: () => Promise<T>): Promise<T> {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  let settled = false;
  const result = run();
  void result.then(() => { settled = true; }, () => { settled = true; });
  for (let i = 0; !settled && i < 30; i++) {
    await setImmediate();
    t.mock.timers.tick(1000);
  }
  assert.ok(settled, "Power operation must finish within the polling budget");
  return result;
}

for (const remote of ["remote.appletv", "remote.samsung_tv"]) {
  for (const desired of ["on", "off"] as const) {
    for (const beforeState of ["on", "off", "standby", "unknown", "unavailable"]) {
      test(`${remote}: requested ${desired} is honored when state is ${beforeState}`, async (t) => {
        mockStates(t, [beforeState, desired]);
        const post = t.mock.method(axios, "post", async () => ({ status: 200, data: [] }));
        const result = await finishWithClock(t, () => power.execute({
          remote_entity_id: remote, desired_state: desired, reason: `Turn ${desired} the TV`,
        }, context));
        assert.equal(post.mock.callCount(), 1);
        const [url, body] = post.mock.calls[0].arguments as unknown as [string, Record<string, unknown>];
        const apple = remote === "remote.appletv";
        assert.ok(url.endsWith(`/api/services/remote/${apple ? "send_command" : `turn_${desired}`}`));
        assert.deepEqual(body, apple
          ? { entity_id: remote, command: desired === "on" ? "wakeup" : "suspend" }
          : { entity_id: remote });
        assert.equal(result.toolSuccess, true);
      });
    }
  }
}

test("repeating a wake request with stale on state never sends suspend", async (t) => {
  mockStates(t, ["on"]);
  const post = t.mock.method(axios, "post", async () => ({ status: 200, data: [] }));
  await finishWithClock(t, async () => {
    for (let i = 0; i < 2; i++) {
      await power.execute({ remote_entity_id: "remote.appletv", desired_state: "on", reason: "Wake display" }, context);
    }
  });
  assert.equal(post.mock.callCount(), 2);
  for (const call of post.mock.calls) {
    assert.equal((call.arguments as unknown as [string, { command: string }])[1].command, "wakeup");
  }
});

for (const observed of ["on", "unknown", "unavailable"]) {
  test(`power off is unverified when HA continues reporting ${observed}`, async (t) => {
    mockStates(t, ["on", observed]);
    const post = t.mock.method(axios, "post", async () => ({ status: 200, data: [] }));
    const result = await finishWithClock(t, () => power.execute({
      remote_entity_id: "remote.appletv", desired_state: "off", reason: "Turn off the TV",
    }, context));
    assert.equal(post.mock.callCount(), 1);
    assert.equal(result.toolSuccess, false);
    assert.match(result.observation, /not verified/);
  });
}

test("missing or invalid power intent fails before any HA request", async (t) => {
  const post = t.mock.method(axios, "post", async () => { throw new Error("No request expected"); });
  const get = t.mock.method(globalThis, "fetch", async () => { throw new Error("No request expected"); });
  for (const desired_state of [undefined, "toggle", "invalid"]) {
    await assert.rejects(power.execute({ remote_entity_id: "remote.appletv", desired_state, reason: "Power" }, context));
  }
  assert.equal(get.mock.callCount(), 0);
  assert.equal(post.mock.callCount(), 0);
});

test("service failures are returned without polling or claiming success", async (t) => {
  mockStates(t, ["off"]);
  const post = t.mock.method(axios, "post", async () => ({ status: 500, data: [] }));
  const result = await power.execute({ remote_entity_id: "remote.appletv", desired_state: "on", reason: "Wake" }, context);
  assert.equal(post.mock.callCount(), 1);
  assert.equal(result.toolSuccess, false);
  assert.match(result.observation, /Failed to send/);
});

test("power requests pass cancellation through to the HA service", async (t) => {
  mockStates(t, ["off"]);
  const controller = new AbortController();
  const post = t.mock.method(axios, "post", async (_url: string, _data: unknown, options: { signal: AbortSignal }) => {
    assert.equal(options.signal, controller.signal);
    controller.abort(new Error("User cancelled"));
    throw controller.signal.reason;
  });
  await assert.rejects(power.execute({ remote_entity_id: "remote.appletv", desired_state: "on", reason: "Wake" }, {
    ...context, abortSignal: controller.signal,
  }), /User cancelled/);
  assert.equal(post.mock.callCount(), 1);
});
