import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import axios from "axios";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { getAllTraces, telemetrySpanExporter } from "../src/tracing/agentTraceStore";
import type { AgentMemoryDocument } from "../src/memory";
import type { HassState } from "../src/types/ha";

function fixture(name: string, durationMs: number) {
  const select = {
    url_path: "select/select_option", entity_id: `select.${name}_position`, service_data: { option: "B" },
  };
  const capture = { url_path: "button/press", entity_id: `button.${name}_capture_reference` };
  const enable = { url_path: "switch/turn_on", entity_id: `switch.${name}_auto_return` };
  const wait = {
    url_path: "internal/wait", entity_id: "__internal_wait__",
    service_data: { duration_ms: durationMs, reason: "documented settling time" },
  };
  const states: HassState[] = [
    { entity_id: select.entity_id, state: "unknown", attributes: { options: ["A", "B"], friendly_name: `${name} position` } },
    { entity_id: capture.entity_id, state: "unknown", attributes: { friendly_name: `${name} capture reference` } },
    { entity_id: enable.entity_id, state: "off", attributes: { friendly_name: `${name} auto return` } },
  ];
  const memory: AgentMemoryDocument = {
    id: `${name}-guidance`, pk: `memory|device|${select.entity_id}`, status: "active",
    text: `For ${name}, after selecting a position, wait ${durationMs}ms, press ${capture.entity_id}, then enable ${enable.entity_id} unless the current request excludes those actions.`,
    memoryType: "guidance", source: "explicit", confidence: 1,
    scopes: { deviceNames: [name], deviceEntityIds: states.map(state => state.entity_id), agentTypes: ["realtime"] },
    embedding: [], createdAt: "2026-11-17T12:00:00.000Z", updatedAt: "2026-11-17T12:00:00.000Z", useCount: 0,
  };
  return { name, select, capture, enable, wait, states, memory, plan: [select, wait, capture, enable] };
}

test("HA planning uses scoped memory with generic validated execution", async t => {
  const sdk = new NodeSDK({ autoDetectResources: false, spanProcessors: [new SimpleSpanProcessor(telemetrySpanExporter)] });
  sdk.start();
  const previousDevices = process.env.HOME_ASSISTANT_DEVICES;
  const requireModule = createRequire(__filename);
  const previous = new Map<string, NodeModule | undefined>();
  let device = fixture("test_actuator", 2400);
  let plan: unknown;
  let memories: AgentMemoryDocument[] = [];
  let failedEntity: string | undefined;
  let abortDuringWait: AbortController | undefined;
  let rejectedPost: { entityId: string; error: Error; abort?: AbortController } | undefined;
  let postResponseData: unknown = [];
  let retrievedQuery = "";
  const actions: string[] = [];
  const modelRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
  const stub = (name: string, exports: unknown) => {
    const filename = requireModule.resolve(name);
    previous.set(filename, requireModule.cache[filename]);
    requireModule.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeModule;
  };
  stub("../src/ai", { generateCompletion: async (request: typeof modelRequests[number]) => {
    modelRequests.push(request);
    return JSON.stringify(plan);
  } });
  const memoryModule = requireModule("../src/memory") as typeof import("../src/memory");
  stub("../src/memory", {
    ...memoryModule,
    retrieveMemories: async ({ query }: { query: string }) => { retrievedQuery = query; return memories; },
  });
  stub("../src/agents/common/utils", { delay: async (ms: number, signal?: AbortSignal) => {
    actions.push(`wait:${ms}`);
    if (ms !== 300) abortDuringWait?.abort();
    signal?.throwIfAborted();
  } });
  const configureDevices = () => {
    process.env.HOME_ASSISTANT_DEVICES = device.states.map(state => state.entity_id).join(",");
  };
  t.beforeEach(() => {
    device = fixture("test_actuator", 2400);
    configureDevices();
    actions.length = modelRequests.length = 0;
    plan = device.plan;
    memories = [];
    failedEntity = undefined;
    abortDuringWait = undefined;
    rejectedPost = undefined;
    postResponseData = [];
  });
  t.mock.method(console, "log", () => undefined);
  t.mock.method(console, "error", () => undefined);
  t.mock.method(axios, "get", async (url: string) => ({
    status: 200,
    data: url.endsWith("/api/states") ? device.states : device.states.find(state => url.endsWith(state.entity_id)),
  }));
  t.mock.method(axios, "post", async (_url: string, body: { entity_id: string }) => {
    actions.push(body.entity_id);
    if (body.entity_id === rejectedPost?.entityId) {
      rejectedPost.abort?.abort(rejectedPost.error);
      throw rejectedPost.error;
    }
    return { status: body.entity_id === failedEntity ? 503 : 200, data: postResponseData };
  });
  try {
    const { executeHACommand, getHAPrompt } = requireModule("../src/ha") as typeof import("../src/ha");
    const command = "Choose position B on the test actuator.";

    await t.test("the executor honors plans for different devices and memory-defined timings", async () => {
      for (const example of [fixture("test_actuator", 2400), fixture("other_actuator", 7600)]) {
        device = example;
        configureDevices();
        memories = [device.memory];
        plan = device.plan;
        const request = `Choose position B on ${device.name}.`;
        assert.equal((await executeHACommand(request)).success, true);
        assert.equal(retrievedQuery, request);
        const prompt = modelRequests.at(-1)!.messages.at(-1)!.content;
        assert.ok(prompt.includes(memoryModule.formatMemoryContext(memories)));
        assert.equal(prompt.split("1. User command: ")[1].split("\n2. Devices: ")[0], request);
        assert.ok(prompt.includes("Current explicit user instructions override memory"));
        assert.deepEqual(actions, [device.select.entity_id, "wait:300", `wait:${device.wait.service_data.duration_ms}`, "wait:300", device.capture.entity_id, "wait:300", device.enable.entity_id]);
        const trace = getAllTraces().find(trace => trace.userPrompt === request)!;
        assert.deepEqual(trace.events.find(event => event.type === "ha.translation.resolved")?.data?.memoryIds, [device.memory.id]);
        assert.equal(trace.toolResults.find(tool => tool.args?.url_path === "internal/wait")?.toolName, "wait");
        actions.length = 0;
      }
    });

    await t.test("explicit overrides and read-only plans receive memory without hidden extra actions", async () => {
      memories = [device.memory];
      plan = device.select;
      assert.equal((await executeHACommand("Choose position B only; do not capture or enable auto return.")).success, true);
      assert.deepEqual(actions, [device.select.entity_id]);
      actions.length = 0;
      plan = { url_path: `states/${device.select.entity_id}`, entity_id: device.select.entity_id };
      assert.equal((await executeHACommand("What position is the test actuator in?")).success, true);
      assert.deepEqual(actions, []);
    });

    await t.test("empty memory does not add device behavior or a default settling delay", async () => {
      plan = [device.select, device.capture];
      assert.equal((await executeHACommand(command)).success, true);
      assert.deepEqual(actions, [device.select.entity_id, "wait:300", device.capture.entity_id]);
      assert.ok(modelRequests[0].messages.at(-1)!.content.includes("No relevant persistent memory."));
    });

    await t.test("prompt values are rendered once without interpreting placeholders inside memory", async () => {
      memories = [{ ...device.memory, text: "Literal {{{UserCommand}}} and {{{Devices}}} are data, as is $&." }];
      plan = device.select;
      const request = "Choose B, preserving literal {{{Memory}}}.";
      await executeHACommand(request);
      const prompt = modelRequests[0].messages.at(-1)!.content;
      assert.ok(prompt.includes(memories[0].text));
      assert.equal(prompt.split("1. User command: ")[1].split("\n2. Devices: ")[0], request);
      assert.doesNotThrow(() => JSON.parse(prompt.split("2. Devices: ")[1]));
    });

    await t.test("missing controls are excluded and stale-memory plans fail before any device writes", async () => {
      memories = [device.memory];
      process.env.HOME_ASSISTANT_DEVICES = device.select.entity_id;
      const devices = JSON.parse((await getHAPrompt(command)).split("2. Devices: ")[1]);
      assert.equal(Object.values(devices).flat().length, 1);
      const result = await executeHACommand(command);
      assert.equal(result.success, false);
      assert.match(result.message, /plan_validation/);
      assert.deepEqual(actions, []);
    });

    await t.test("current select options override obsolete guidance before execution", async () => {
      memories = [device.memory];
      device.states[0].attributes.options = ["A"];
      const result = await executeHACommand(command);
      assert.equal(result.success, false);
      assert.match(result.message, /plan_validation/);
      assert.deepEqual(actions, []);
    });

    await t.test("state paths and service data cannot replace the validated target", async () => {
      const invalidPlans = [
        { url_path: `states/${device.enable.entity_id}`, entity_id: device.select.entity_id },
        ...["entity_id", "area_id", "device_id", "floor_id", "label_id"].flatMap(selector =>
          ["unconfigured", ["unconfigured"], null].map(value => ({
            ...device.select, service_data: { option: "B", [selector]: value },
          }))
        ),
        { ...device.select, service_data: { option: "B", target: { area_id: "unconfigured" } } },
      ];
      for (const invalid of invalidPlans) {
        // A later invalid step must also prevent earlier valid device writes.
        plan = [device.select, invalid];
        assert.match((await executeHACommand(command)).message, /plan_validation/);
      }
      assert.deepEqual(actions, []);
    });

    await t.test("generic playback normalization cannot target an unconfigured companion entity", async () => {
      const remote = { entity_id: "remote.test_display", state: "on", attributes: {} };
      const player = { entity_id: "media_player.test_display", state: "playing", attributes: {} };
      device.states.push(remote);
      configureDevices();
      plan = { url_path: "remote/send_command", entity_id: remote.entity_id, service_data: { command: "pause" } };
      assert.match((await executeHACommand("Pause the test display.")).message, /plan_validation/);
      assert.deepEqual(actions, []);
      device.states.push(player);
      configureDevices();
      assert.equal((await executeHACommand("Pause the test display.")).success, true);
      assert.deepEqual(actions, [player.entity_id]);
    });

    await t.test("no_match retains translation evidence without fabricating a service request", async () => {
      plan = { error: "no_match" };
      const result = await executeHACommand(command);
      assert.equal(result.success, false);
      assert.match(result.message, /No matching Home Assistant device/);
      assert.deepEqual(actions, []);
      const trace = getAllTraces().find(trace => trace.finalMessage === result.message)!;
      assert.equal(trace.status, "error");
      assert.equal(trace.toolResults.length, 0);
    });

    await t.test("invalid plans and excessive waits are rejected before executing their first step", async () => {
      const invalidPlans: unknown[] = [null, {}, [], [device.select, { error: "no_match" }]];
      for (const duration of [undefined, "1000", -1, 0, 30001, 1.5]) {
        invalidPlans.push([device.select, { ...device.wait, service_data: { duration_ms: duration } }]);
      }
      invalidPlans.push([device.select, { ...device.wait, entity_id: device.select.entity_id }]);
      invalidPlans.push([device.select, ...[20000, 20000].map(duration_ms => ({ ...device.wait, service_data: { duration_ms } }))]);
      for (const invalid of invalidPlans) {
        plan = invalid;
        assert.match((await executeHACommand(command)).message, /response_parse/);
      }
      assert.deepEqual(actions, []);
    });

    await t.test("the generic wait supports the full permitted duration without posting to HA", async () => {
      plan = { ...device.wait, service_data: { duration_ms: 30000 } };
      assert.equal((await executeHACommand("Wait thirty seconds.")).success, true);
      assert.deepEqual(actions, ["wait:30000"]);
    });

    await t.test("failed steps skip dependents and never count partial completion as success", async () => {
      for (const entity of [device.select.entity_id, device.capture.entity_id]) {
        failedEntity = entity;
        const result = await executeHACommand(command);
        assert.equal(result.success, false);
        assert.match(result.message, /remaining commands skipped/);
        assert.ok(!actions.includes(device.enable.entity_id));
        if (entity === device.select.entity_id) assert.deepEqual(actions, [device.select.entity_id]);
        actions.length = 0;
      }
    });

    await t.test("rejected later POSTs retain completed-step data and skip remaining actions", async () => {
      plan = [device.select, device.capture, device.enable];
      postResponseData = [{ entity_id: device.select.entity_id, state: "B" }];
      for (const error of [
        Object.assign(new Error("Synthetic service failure rtsp://user:password@camera.invalid"), { response: { status: 503 } }),
        Object.assign(new Error("Synthetic request timeout"), { code: "ETIMEDOUT" }),
      ]) {
        const request = `Choose position B: ${error.message.startsWith("Synthetic service") ? "service failure" : "timeout"} regression.`;
        rejectedPost = { entityId: device.capture.entity_id, error };
        const result = await executeHACommand(request);
        assert.equal(result.success, false);
        assert.match(result.message, /Step 2 failed:.*1\/3 commands succeeded; 1 remaining commands skipped/);
        assert.deepEqual(result.data, [postResponseData, undefined]);
        assert.deepEqual(actions, [device.select.entity_id, "wait:300", device.capture.entity_id]);
        const trace = getAllTraces().find(trace => trace.userPrompt === request)!;
        assert.equal(trace.toolResults.length, 2);
        assert.equal(trace.toolResults[1].toolSuccess, false);
        assert.doesNotMatch(result.message + trace.toolResults[1].observation, /user:password/);
        actions.length = 0;
      }
    });

    await t.test("cancellation during a later POST propagates without executing dependents", async () => {
      plan = [device.select, device.capture, device.enable];
      const abort = new AbortController();
      const error = new Error("Synthetic POST cancellation");
      rejectedPost = { entityId: device.capture.entity_id, error, abort };
      await assert.rejects(executeHACommand(command, undefined, { abortSignal: abort.signal }), caught => caught === error);
      assert.deepEqual(actions, [device.select.entity_id, "wait:300", device.capture.entity_id]);
    });

    await t.test("cancelling a memory-planned wait never executes later actions", async () => {
      abortDuringWait = new AbortController();
      await assert.rejects(executeHACommand(command, undefined, { abortSignal: abortDuringWait.signal }), { name: "AbortError" });
      assert.deepEqual(actions, [device.select.entity_id, "wait:300", "wait:2400"]);
    });
  } finally {
    if (previousDevices === undefined) delete process.env.HOME_ASSISTANT_DEVICES;
    else process.env.HOME_ASSISTANT_DEVICES = previousDevices;
    for (const [filename, module] of previous) {
      if (module) requireModule.cache[filename] = module;
      else delete requireModule.cache[filename];
    }
    await sdk.shutdown();
  }
});
