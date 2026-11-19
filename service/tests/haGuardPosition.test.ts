import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import axios from "axios";
import type { HassServiceCommand } from "../src/types/ha";

test("preset-to-guard plans follow translated memory guidance and report transport evidence", async t => {
  const previousDevices = process.env.HOME_ASSISTANT_DEVICES;
  process.env.HOME_ASSISTANT_DEVICES = "living_room";
  const requireModule = createRequire(__filename);
  const previous = new Map<string, NodeModule | undefined>();
  const preset: HassServiceCommand = {
    url_path: "select/select_option", entity_id: "select.living_room_ptz_preset", service_data: { option: "1" },
  };
  const guard: HassServiceCommand = {
    url_path: "button/press", entity_id: "button.living_room_guard_set_current_position",
  };
  const states = [
    { entity_id: preset.entity_id, state: "1", attributes: { options: ["1"] } },
    { entity_id: guard.entity_id, state: "unknown", attributes: {} },
  ];
  const wait = (duration_ms: number): HassServiceCommand => ({
    url_path: "internal/wait", entity_id: "__internal_wait__", service_data: { duration_ms },
  });
  let plan: HassServiceCommand | HassServiceCommand[] = [];
  let memory: boolean | string = false;
  let abort: AbortController | undefined;
  let rejectPreset = false;
  let presetStatus = 200;
  const events: Array<string | number> = [];
  const stubs = {
    "../src/ai": { generateCompletion: async () => JSON.stringify(plan) },
    "../src/memory": {
      retrieveMemories: async () => memory ? [{ id: "fixture-memory", text: typeof memory === "string" ? memory : "Guard the living room camera after selecting a preset", scopes: {} }] : [],
      formatMemoryContext: () => "",
    },
    "../src/agents/common/utils": { delay: async (ms: number, signal?: AbortSignal) => {
      events.push(ms);
      if (ms >= 10000 && abort) abort.abort(new Error("Synthetic cancellation"));
      signal?.throwIfAborted();
    } },
  };
  for (const [name, exports] of Object.entries(stubs)) {
    const filename = requireModule.resolve(name);
    previous.set(filename, requireModule.cache[filename]);
    requireModule.cache[filename] = { id: filename, filename, loaded: true, exports } as NodeModule;
  }
  t.mock.method(axios, "get", async () => ({ status: 200, data: states }));
  t.mock.method(axios, "post", async (url: string) => {
    events.push(url.endsWith("button/press") ? "guard" : "preset");
    if (rejectPreset && url.endsWith("select/select_option")) throw new Error("Synthetic preset failure");
    return { status: url.endsWith("select/select_option") ? presetStatus : 200, data: [] };
  });
  try {
    const { executeHACommand } = requireModule("../src/ha") as typeof import("../src/ha");
    const run = async (input: typeof plan, withMemory: boolean | string = false, signal?: AbortSignal, command = "Set the living room camera to preset 1, then guard that position.") => {
      plan = input; memory = withMemory; events.length = 0;
      return executeHACommand(command, undefined, { abortSignal: signal });
    };
    await t.test("an explicit settling wait is preserved and excluded from accepted-request counts", async () => {
      const input = [preset, wait(15000), guard];
      const before = JSON.stringify(input);
      const result = await run(input);
      assert.equal(result.success, true);
      assert.deepEqual(events, ["preset", 300, 15000, 300, "guard"]);
      assert.match(result.message, /accepted 2 requests/i);
      assert.match(result.message, /device effects have not been verified/i);
      assert.equal(JSON.stringify(input), before);
    });
    await t.test("preset-only translations never acquire a guard from positive or negative memory", async () => {
      for (const guidance of [
        "Guard the living room camera after selecting a preset",
        "Do not guard the living room camera after selecting a preset",
      ]) {
        const result = await run(preset, guidance, undefined,
          "Set the living room camera to preset 1 only; do not change the guard position.");
        assert.equal(result.success, true);
        assert.deepEqual(events, ["preset"]);
      }
    });
    await t.test("device-specific waits are supplied by the plan and never defaulted or padded", async () => {
      for (const duration of [2400, 7600, 15000]) {
        await run([preset, wait(duration), guard], true);
        assert.deepEqual(events, ["preset", 300, duration, 300, "guard"]);
      }
      await run([preset, guard], true);
      assert.deepEqual(events, ["preset", 300, "guard"]);
    });
    await t.test("cumulative settling waits fail before the first service request", async () => {
      const result = await run([
        preset, wait(15000), guard, preset, wait(15000), guard, preset, wait(15000), guard,
      ], true);
      assert.equal(result.success, false);
      assert.match(result.message, /response_parse/);
      assert.deepEqual(events, []);
      assert.equal((await run([preset, wait(15000), guard, preset, wait(15000), guard])).success, true);
      assert.equal(events.filter(event => event === 15000).length, 2);
    });
    await t.test("path aliases retain explicit settling waits", async () => {
      await run([{ ...preset, url_path: "/api/services/select/select_option/" }, wait(15000), { ...guard, url_path: "/api/services/button/press/" }]);
      assert.deepEqual(events, ["preset", 300, 15000, 300, "guard"]);
    });
    await t.test("service-data target overrides are rejected before device actions", async () => {
      for (const asArray of [false, true]) {
        const target = (entityId: string) => asArray ? ["select.unrelated", entityId] : entityId;
        const overriddenPreset = {
          ...preset, entity_id: "select.other_camera_preset",
          service_data: { ...preset.service_data, entity_id: target(preset.entity_id) },
        };
        const overriddenGuard = {
          ...guard, entity_id: "button.other_camera_guard",
          service_data: { entity_id: target(guard.entity_id) },
        };
        for (const input of [[overriddenPreset, overriddenGuard], overriddenPreset]) {
          const result = await run(input, true);
          assert.equal(result.success, false);
          assert.match(result.message, /plan_validation/);
          assert.deepEqual(events, []);
        }
      }
    });
    await t.test("overridden preset and guard targets cannot bypass plan validation", async () => {
      presetStatus = 503;
      try {
        for (const asArray of [false, true]) {
          const target = (entityId: string) => asArray ? [entityId] : entityId;
          const result = await run([
            { ...preset, entity_id: "select.other_camera_preset", service_data: { option: "1", entity_id: target(preset.entity_id) } },
            { ...guard, entity_id: "button.other_camera_guard", service_data: { entity_id: target(guard.entity_id) } },
          ]);
          assert.equal(result.success, false);
          assert.match(result.message, /plan_validation/);
          assert.deepEqual(events, []);
        }
      } finally {
        presetStatus = 200;
      }
    });
    await t.test("overrides away from the camera are rejected before device actions", async () => {
      for (const asArray of [false, true]) {
        const target = (entityId: string) => asArray ? [entityId] : entityId;
        for (const input of [
          [{ ...preset, service_data: { option: "1", entity_id: target("select.other_camera_preset") } }, guard],
          [preset, { ...guard, service_data: { entity_id: target("button.other_camera_guard") } }],
        ]) {
          const result = await run(input, true);
          assert.equal(result.success, false);
          assert.match(result.message, /plan_validation/);
          assert.deepEqual(events, []);
        }
      }
    });
    await t.test("read-only, unrelated and reversed commands do not add a settling delay", async () => {
      for (const input of [
        [{ ...preset, url_path: "states/select.living_room_ptz_preset" }, guard],
        [{ ...preset, entity_id: "select.other_camera_preset" }, guard],
        [guard, preset],
      ]) {
        await run(input);
        assert.equal(events.filter(event => typeof event === "number" && event >= 10000).length, 0);
      }
    });
    await t.test("read-only preset queries never append a memory-derived guard", async () => {
      await run({ ...preset, url_path: "states/select.living_room_ptz_preset" }, true);
      assert.deepEqual(events, []);
    });
    await t.test("a returned preset error stops the dependent guard and reports failure", async () => {
      presetStatus = 503;
      const result = await run([preset, guard]);
      assert.equal(result.success, false);
      assert.match(result.message, /remaining commands skipped/);
      assert.deepEqual(events, ["preset"]);
      presetStatus = 200;
    });
    await t.test("cancellation during settling prevents the guard request", async () => {
      abort = new AbortController();
      await assert.rejects(run([preset, wait(15000), guard], false, abort.signal), /Synthetic cancellation/);
      assert.equal(events.includes("guard"), false);
      abort = undefined;
    });
    await t.test("a rejected preset request does not press guard", async () => {
      rejectPreset = true;
      const result = await run([preset, guard]);
      assert.equal(result.success, false);
      assert.deepEqual(events, ["preset"]);
      rejectPreset = false;
    });
  } finally {
    if (previousDevices === undefined) delete process.env.HOME_ASSISTANT_DEVICES;
    else process.env.HOME_ASSISTANT_DEVICES = previousDevices;
    for (const [filename, module] of previous) {
      if (module) requireModule.cache[filename] = module;
      else delete requireModule.cache[filename];
    }
  }
});
