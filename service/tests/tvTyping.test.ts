import assert from "node:assert/strict";
import test, { before } from "node:test";
import axios from "axios";
import { APPLETV_KEYBOARD } from "../src/agents/common/keyboards";
import type { ToolExecutionContext } from "../src/agents/tv/tools/types";

// Initialize providers with inert values before loading tool modules. Every HA
// request below is mocked; these tests must run without a developer's .env.
let typing: typeof import("../src/agents/tv/tools/deterministicTyping").definition;
let navigate: typeof import("../src/agents/tv/tools/navigate").definition;
let deletion: typeof import("../src/agents/tv/tools/deleteTypedText").definition;
before(async () => {
  process.env.AZURE_OPENAI_API_KEY = "test-key";
  process.env.AZURE_OPENAI_RESOURCE_NAME = "test-resource";
  process.env.HOME_ASSISTANT_URL = "http://ha.invalid";
  process.env.HOME_ASSISTANT_TOKEN = "test-token";
  process.env.TV_REMOTE_KEY_DELAY_MS = "0";
  typing = (await import("../src/agents/tv/tools/deterministicTyping")).definition;
  navigate = (await import("../src/agents/tv/tools/navigate")).definition;
  deletion = (await import("../src/agents/tv/tools/deleteTypedText")).definition;
});

const context: ToolExecutionContext = { homeAssistantUrl: "http://ha.invalid", homeAssistantToken: "test" };
const input = { remote_entity_id: "remote.appletv", current_cursor_position: "a", reason: "Search for requested songs" };

test("typing sends ordered zero-delay batches and produces the exact short query", async (t) => {
  let cursor = 2;
  let field = "";
  const post = t.mock.method(axios, "post", async (url: string, data: Record<string, unknown>) => {
    assert.ok(url.endsWith("/api/services/remote/send_command"));
    assert.equal(data.delay_secs, 0);
    assert.equal(data.num_repeats, 1);
    for (const command of data.command as string[]) {
      if (command === "right") cursor++;
      else if (command === "left") cursor--;
      else if (command === "select") {
        field += Object.entries(APPLETV_KEYBOARD.positions).find(([, p]) => p === cursor)![0];
      }
      assert.ok(cursor >= 1 && cursor <= 28);
    }
    return { status: 200, data: [] };
  });
  const target = "latest telugu songs";
  const result = await typing.execute({ ...input, text: target }, context);
  assert.equal(field, target);
  assert.equal(post.mock.callCount(), target.length);
  assert.equal(result.needsScreenshot, true);
  assert.notEqual(result.toolSuccess, false);
});

test("typing reconciles existing text and accepts the SPACE cursor label", async (t) => {
  let cursor = 1;
  let field = "latest telugu music video songs";
  t.mock.method(axios, "post", async (_url: string, data: Record<string, unknown>) => {
    for (const command of data.command as string[]) {
      if (command === "right") cursor++;
      if (command === "left") cursor--;
      if (command === "select") {
        const char = Object.entries(APPLETV_KEYBOARD.positions).find(([, p]) => p === cursor)![0];
        field = char === "delete" ? field.slice(0, -1) : field + char;
      }
    }
    return { status: 200, data: [] };
  });
  await typing.execute({ ...input, current_cursor_position: "SPACE", already_typed: field, text: "latest telugu songs" }, context);
  assert.equal(field, "latest telugu songs");
});

test("matching text and unsupported characters send no keys", async (t) => {
  const post = t.mock.method(axios, "post", async () => { throw new Error("No request expected"); });
  await typing.execute({ ...input, text: "telugu songs", already_typed: "telugu songs" }, context);
  const invalid = await typing.execute({ ...input, text: "telugu songs 2026", already_typed: "old text" }, context);
  assert.equal(invalid.toolSuccess, false);
  assert.equal(post.mock.callCount(), 0);
});

test("a partly executed batch stops typing and requires visual reconciliation", async (t) => {
  const post = t.mock.method(axios, "post", async () => ({ status: 500, data: [] }));
  const result = await typing.execute({ ...input, text: "telugu songs" }, context);
  assert.equal(post.mock.callCount(), 1);
  assert.equal(result.toolSuccess, false);
  assert.match(result.observation, /partly executed/);
});

test("typing honors cancellation and pauses at character boundaries", async (t) => {
  const controller = new AbortController();
  let pauses = 0;
  const post = t.mock.method(axios, "post", async (_url: string, _data: unknown, options: { signal: AbortSignal }) => {
    assert.equal(options.signal, controller.signal);
    controller.abort(new Error("User cancelled"));
    return { status: 200, data: [] };
  });
  await assert.rejects(typing.execute({ ...input, text: "telugu songs" }, {
    ...context, abortSignal: controller.signal, waitIfPaused: async () => { pauses++; },
  }), /User cancelled/);
  assert.equal(post.mock.callCount(), 1);
  assert.ok(pauses > 0);
});

test("known-device navigation sends one direct request with the correct key mapping", async (t) => {
  const sent: Array<Record<string, unknown>> = [];
  t.mock.method(axios, "post", async (_url: string, data: Record<string, unknown>) => {
    sent.push(data);
    return { status: 200, data: [] };
  });
  await navigate.execute({ ...input, direction: "right", count: 5 }, context);
  await navigate.execute({ ...input, remote_entity_id: "remote.samsungtv", direction: "up", count: 3 }, context);
  assert.deepEqual(sent.map(({ command, num_repeats, delay_secs }) => ({ command, num_repeats, delay_secs })), [
    { command: "right", num_repeats: 5, delay_secs: 0 },
    { command: "KEY_UP", num_repeats: 3, delay_secs: 0 },
  ]);
});

test("deletion refuses unknown cursor positions and batches a known delete", async (t) => {
  const post = t.mock.method(axios, "post", async () => ({ status: 200, data: [] }));
  const invalid = await deletion.execute({ ...input, current_cursor_position: "unknown" }, context);
  assert.equal(invalid.toolSuccess, false);
  assert.equal(post.mock.callCount(), 0);
  await deletion.execute({ ...input, current_cursor_position: "z" }, context);
  assert.deepEqual(post.mock.calls[0].arguments[1].command, ["right", "select"]);
});
