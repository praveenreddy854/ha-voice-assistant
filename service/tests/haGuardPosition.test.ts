import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import axios from "axios";
import type { HassServiceCommand } from "../src/types/ha";

test("preset-to-guard plans retain the settling delay and report transport evidence", async t => {
  process.env.HOME_ASSISTANT_DEVICES = "living_room";
  const requireModule = createRequire(__filename);
  const previous = new Map<string, NodeModule | undefined>();
  const preset: HassServiceCommand = {
    url_path: "select/select_option", entity_id: "select.living_room_ptz_preset", service_data: { option: "1" },
  };
  const guard: HassServiceCommand = {
    url_path: "button/press", entity_id: "button.living_room_guard_set_current_position",
  };
  const wait = (duration_ms: number): HassServiceCommand => ({
    url_path: "internal/wait", entity_id: "__internal_wait__", service_data: { duration_ms },
  });
  let plan: HassServiceCommand | HassServiceCommand[] = [];
  let memory = false;
  let abort: AbortController | undefined;
  let rejectPreset = false;
  let presetStatus = 200;
  const events: Array<string | number> = [];
  const stubs = {
    "../src/ai": { generateCompletion: async () => JSON.stringify(plan) },
    "../src/memory": {
      retrieveMemories: async () => memory ? [{ id: "fixture-memory", text: "Guard the living room camera after selecting a preset", scopes: {} }] : [],
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
  t.mock.method(axios, "get", async () => ({ status: 200, data: [] }));
  t.mock.method(axios, "post", async (url: string) => {
    events.push(url.endsWith("button/press") ? "guard" : "preset");
    if (rejectPreset && url.endsWith("select/select_option")) throw new Error("Synthetic preset failure");
    return { status: url.endsWith("select/select_option") ? presetStatus : 200, data: [] };
  });
  try {
    const { executeHACommand } = requireModule("../src/ha") as typeof import("../src/ha");
    const run = async (input: typeof plan, withMemory = false, signal?: AbortSignal) => {
      plan = input; memory = withMemory; events.length = 0;
      return executeHACommand("Set the living room camera to preset 1, then guard that position.", undefined, { abortSignal: signal });
    };
    await t.test("explicit guard waits without memory and keeps one guard action", async () => {
      const input = [preset, guard];
      const before = JSON.stringify(input);
      const result = await run(input);
      assert.equal(result.success, true);
      assert.deepEqual(events, ["preset", 300, 15000, 300, "guard"]);
      assert.match(result.message, /accepted 2 requests/i);
      assert.match(result.message, /device effects have not been verified/i);
      assert.equal(JSON.stringify(input), before);
    });
    await t.test("memory-derived and already-generated guards share the same delay", async () => {
      for (const input of [preset, [preset, guard]]) {
        await run(input, true);
        assert.deepEqual(events, ["preset", 300, 15000, 300, "guard"]);
      }
    });
    await t.test("existing waits count toward the delay without being duplicated", async () => {
      await run([preset, wait(15000), guard]);
      assert.deepEqual(events, ["preset", 300, 15000, 300, "guard"]);
      await run([preset, wait(5000), guard]);
      assert.deepEqual(events, ["preset", 300, 5000, 300, 10000, 300, "guard"]);
    });
    await t.test("each new preset resets the settling interval", async () => {
      await run([preset, guard, preset, guard]);
      assert.equal(events.filter(event => event === 15000).length, 2);
      assert.equal(events.filter(event => event === "guard").length, 2);
    });
    await t.test("path aliases receive the same protection", async () => {
      await run([{ ...preset, url_path: "/api/services/select/select_option/" }, { ...guard, url_path: "/api/services/button/press/" }]);
      assert.deepEqual(events, ["preset", 300, 15000, 300, "guard"]);
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
      assert.match(result.message, /remaining requests were not sent/);
      assert.deepEqual(events, ["preset"]);
      presetStatus = 200;
    });
    await t.test("cancellation during settling prevents the guard request", async () => {
      abort = new AbortController();
      await assert.rejects(run([preset, guard], false, abort.signal), /Synthetic cancellation/);
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
    for (const [filename, module] of previous) {
      if (module) requireModule.cache[filename] = module;
      else delete requireModule.cache[filename];
    }
  }
});
