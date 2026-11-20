import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import dotenv from "dotenv";
import { MODEL_CATALOG, regionForDeployment } from "../src/modelCatalog";
import { modelSettingsIdentity, parseModelSettings, REASONING_EFFORTS } from "../src/modelSettings";

const requireModule = createRequire(__filename);
const modelKeys = ["AI_MODEL_NANO", "AI_MODEL_MINI", "AI_MODEL_ADVANCED", "AI_MODEL_HOME_ASSISTANT"] as const;
const modelEnvKeys = [...modelKeys, "EMBEDDING_MODEL"] as const;

function withModels(values: Partial<Record<typeof modelEnvKeys[number], string>>, check: (config: typeof import("../src/config")) => void) {
  const modulePath = requireModule.resolve("../src/config");
  const previousModule = requireModule.cache[modulePath];
  const previousEnv = modelEnvKeys.map(key => [key, process.env[key]] as const);
  try {
    for (const key of modelEnvKeys) {
      const value = values[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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

test("model settings identity includes the effective reasoning effort canonically", () => {
  assert.equal(modelSettingsIdentity("deployment"), "deployment");
  assert.equal(modelSettingsIdentity("deployment", "high"), '{"model":"deployment","reasoningEffort":"high"}');
  assert.equal(modelSettingsIdentity('{"reasoningEffort":"low","model":"deployment"}'), '{"model":"deployment","reasoningEffort":"low"}');
  assert.equal(modelSettingsIdentity('{"model":"deployment","reasoningEffort":"low"}', "high"), '{"model":"deployment","reasoningEffort":"high"}');
  assert.equal(modelSettingsIdentity("deployment", undefined), "deployment");
  assert.equal(modelSettingsIdentity(undefined, "high"), undefined);
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

test("example environment has empty Foundry credential placeholders and preserves the embedding deployment", () => {
  const values = dotenv.parse(readFileSync(path.join(__dirname, "../example.env")));
  for (const suffix of ["EUS", "EUS2"]) {
    assert.equal(values[`AZURE_OPENAI_RESOURCE_NAME_${suffix}`], "");
    assert.equal(values[`AZURE_OPENAI_API_KEY_${suffix}`], "");
  }
  assert.equal(values.EMBEDDING_MODEL, "text-embedding-3-large");
  assert.deepEqual(Object.keys(values).filter(key => /^AI_MODEL_|_EVAL_(JUDGE|REVIEW)_MODEL$/.test(key)), []);
});

test("production tiers ignore legacy environment settings", t => {
  t.mock.method(dotenv, "config", () => ({}));
  withModels({
    AI_MODEL_NANO: "untracked",
    AI_MODEL_MINI: "untracked",
    AI_MODEL_ADVANCED: "untracked",
    AI_MODEL_HOME_ASSISTANT: "untracked",
  }, config => {
    for (const [i, role] of (["nano", "mini", "advanced", "homeAssistant"] as const).entries()) {
      assert.equal(config[modelKeys[i]], MODEL_CATALOG[role].model);
      assert.equal(config[`${modelKeys[i]}_REASONING_EFFORT`], MODEL_CATALOG[role].reasoningEffort);
    }
  });
});

test("embedding configuration preserves both the previous default and deployed overrides", t => {
  t.mock.method(dotenv, "config", () => ({}));
  withModels({}, config => assert.equal(config.EMBEDDING_MODEL, "text-embedding-ada-002"));
  for (const model of ["text-embedding-3-large", "custom-embedding-deployment"]) {
    withModels({ EMBEDDING_MODEL: model }, config => assert.equal(config.EMBEDDING_MODEL, model));
  }
});

test("Live and embedding use East US 2; reasoning and ad-hoc evals use East US", () => {
  for (const [role, { model }] of Object.entries(MODEL_CATALOG)) {
    assert.equal(regionForDeployment(model), role === "live" || role === "embedding" ? "eus2" : "eus");
  }
  assert.equal(regionForDeployment("text-embedding-3-large"), "eus2");
  assert.equal(regionForDeployment("new-eval-candidate"), "eus");
});
