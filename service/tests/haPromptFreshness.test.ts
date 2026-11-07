import test from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

process.env.AZURE_OPENAI_RESOURCE_NAME ??= "prompt-test";
process.env.AZURE_OPENAI_API_KEY ??= "prompt-test";

test("HA translation refreshes entities and options on every command instead of retaining startup state", async t => {
  const previous = process.env.HOME_ASSISTANT_DEVICES;
  process.env.HOME_ASSISTANT_DEVICES = "samsungtv";
  let requests = 0;
  t.mock.method(axios, "get", async () => ({ status: 200, data: ++requests === 1
    ? [{ entity_id: "media_player.samsungtv", state: "on", attributes: { source_list: ["YouTube"] } }]
    : [{ entity_id: "media_player.samsungtv", state: "unavailable", attributes: {} }, { entity_id: "media_player.samsungtv_2", state: "off", attributes: { source_list: ["Netflix"] } }],
  }));
  try {
    const { getHAPrompt } = await import("../src/ha");
    const first = await getHAPrompt("Open YouTube");
    const second = await getHAPrompt("Open Netflix");
    assert.equal(requests, 2);
    assert.ok(!first.includes('"entity_id": "media_player.samsungtv_2"'));
    assert.ok(second.includes('"entity_id": "media_player.samsungtv_2"'));
    assert.ok(second.includes('"state": "unavailable"'));
    assert.ok(second.includes('"Netflix"'));
    assert.ok(!second.includes("{{{Devices}}}"));
  } finally { if (previous === undefined) delete process.env.HOME_ASSISTANT_DEVICES; else process.env.HOME_ASSISTANT_DEVICES = previous; }
});
