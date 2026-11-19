import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import dotenv from "dotenv";
import { parseModelSettings, REASONING_EFFORTS } from "../src/modelSettings";

const requireModule = createRequire(__filename);
const modelKeys = ["AI_MODEL_NANO", "AI_MODEL_MINI", "AI_MODEL_ADVANCED", "AI_MODEL_HOME_ASSISTANT"] as const;

function withModels(values: Partial<Record<typeof modelKeys[number], string>>, check: (config: typeof import("../src/config")) => void) {
  const modulePath = requireModule.resolve("../src/config");
  const previousModule = requireModule.cache[modulePath];
  const previousEnv = modelKeys.map(key => [key, process.env[key]] as const);
  try {
    for (const key of modelKeys) process.env[key] = values[key] ?? "";
    delete requireModule.cache[modulePath];
    check(requireModule(modulePath));
  } finally {
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (previousModule) requireModule.cache[modulePath] = previousModule;
    else delete requireModule.cache[modulePath];
  }
}

test("JSON model settings accept API reasoning levels and preserve provider defaults", () => {
  for (const reasoningEffort of REASONING_EFFORTS) {
    assert.deepEqual(parseModelSettings(` { "model": " deployment ", "reasoningEffort": "${reasoningEffort}" } `), { model: "deployment", reasoningEffort });
  }
  assert.deepEqual(parseModelSettings('{"model":"deployment"}'), { model: "deployment" });
  assert.deepEqual(parseModelSettings(" deployment "), { model: "deployment" });
  assert.equal(parseModelSettings("  "), undefined);
  assert.equal(parseModelSettings(undefined), undefined);
});

test("malformed JSON, invalid fields, and CSV values are rejected with the setting name", () => {
  for (const invalid of [
    "deployment,low", ",low", "deployment,", "deployment,high,low",
    "{", "{model:'deployment'}", '{"model":"deployment",}', "{}", "[]",
    '"deployment"', '["deployment","low"]', '{"model":null}', '{"model":42}',
    '{"model":""}', '{"model":"  "}', '{"model":"deployment,low"}',
    '{"reasoningEffort":"low"}', '{"model":"deployment","reasoningEffort":"typo"}',
    '{"model":"deployment","reasoningEffort":null}', '{"model":"deployment","reasoningEffort":3}',
    '{"model":"deployment","reasoningLevel":"low"}', '{"model":"deployment","extra":true}',
  ]) {
    assert.throws(() => parseModelSettings(invalid, "AI_MODEL_MINI"), /AI_MODEL_MINI must be/);
  }
});

test("example environment preserves JSON settings through dotenv including inline comments", () => {
  const values = dotenv.parse(readFileSync(path.join(__dirname, "../example.env")));
  assert.deepEqual(parseModelSettings(values.AI_MODEL_NANO), { model: "gpt-5.4-nano", reasoningEffort: "low" });
  assert.deepEqual(parseModelSettings(values.AI_MODEL_MINI), { model: "gpt-5.4-mini", reasoningEffort: "low" });
  assert.deepEqual(parseModelSettings(values.AI_MODEL_ADVANCED), { model: "gpt-5.4", reasoningEffort: "medium" });
});

test("tiers sharing a deployment retain independent reasoning levels", t => {
  t.mock.method(dotenv, "config", () => ({}));
  withModels({
    AI_MODEL_NANO: '{"model":"shared","reasoningEffort":"low"}',
    AI_MODEL_MINI: '{"model":"shared","reasoningEffort":"medium"}',
    AI_MODEL_ADVANCED: '{"model":"shared","reasoningEffort":"high"}',
  }, config => {
    assert.equal(config.AI_MODEL_NANO, "shared");
    assert.equal(config.AI_MODEL_MINI, "shared");
    assert.equal(config.AI_MODEL_ADVANCED, "shared");
    assert.equal(config.AI_MODEL_NANO_REASONING_EFFORT, "low");
    assert.equal(config.AI_MODEL_MINI_REASONING_EFFORT, "medium");
    assert.equal(config.AI_MODEL_ADVANCED_REASONING_EFFORT, "high");
    assert.equal(config.AI_MODEL_HOME_ASSISTANT_REASONING_EFFORT, "high");
  });
});

test("tier fallback inherits all JSON settings, while overrides retain provider defaults", t => {
  t.mock.method(dotenv, "config", () => ({}));
  withModels({ AI_MODEL_NANO: '{"model":"nano","reasoningEffort":"none"}' }, config => {
    for (const key of modelKeys) {
      assert.equal(config[key], "nano");
      assert.equal(config[`${key}_REASONING_EFFORT`], "none");
    }
  });
  withModels({
    AI_MODEL_NANO: '{"model":"nano","reasoningEffort":"low"}',
    AI_MODEL_MINI: '{"model":"mini","reasoningEffort":"medium"}',
    AI_MODEL_HOME_ASSISTANT: '{"model":"translator","reasoningEffort":"high"}',
  }, config => {
    assert.equal(config.AI_MODEL_ADVANCED, "mini");
    assert.equal(config.AI_MODEL_ADVANCED_REASONING_EFFORT, "medium");
    assert.equal(config.AI_MODEL_HOME_ASSISTANT, "translator");
    assert.equal(config.AI_MODEL_HOME_ASSISTANT_REASONING_EFFORT, "high");
  });
  withModels({
    AI_MODEL_NANO: '{"model":"nano","reasoningEffort":"low"}',
    AI_MODEL_MINI: "mini",
    AI_MODEL_ADVANCED: '{"model":"advanced","reasoningEffort":"high"}',
    AI_MODEL_HOME_ASSISTANT: '{"model":"translator"}',
  }, config => {
    assert.equal(config.AI_MODEL_MINI_REASONING_EFFORT, undefined);
    assert.equal(config.AI_MODEL_HOME_ASSISTANT_REASONING_EFFORT, undefined);
  });
  withModels({}, config => {
    for (const key of modelKeys) assert.equal(config[key], undefined);
  });
  assert.throws(() => withModels({ AI_MODEL_ADVANCED: '{"model":"advanced","reasoningEffort":"typo"}' }, () => {}), /AI_MODEL_ADVANCED must be/);
  assert.throws(() => withModels({ AI_MODEL_ADVANCED: "advanced,high" }, () => {}), /CSV pairs are not supported/);
});
