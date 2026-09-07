import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { renderAppleShortcutTemplate } from "../src/shortcutTemplate";

interface ShortcutAction {
  WFWorkflowActionIdentifier: string;
  WFWorkflowActionParameters: Record<string, unknown>;
}

interface Shortcut {
  WFWorkflowActions: ShortcutAction[];
}

const templatePath = path.resolve(
  __dirname,
  "../shortcuts/Ask Assistant.shortcut.json"
);

test("rendered Shortcut keeps dynamic URL attachments aligned", async () => {
  const template = await readFile(templatePath, "utf8");
  const baseUrl = "http://ha-service.home.arpa:3005";
  const rendered = renderAppleShortcutTemplate(template, baseUrl);
  const shortcut = JSON.parse(rendered) as Shortcut;

  assert.doesNotMatch(rendered, /__APPLE_SHORTCUT_/);
  const tokenizedUrlValues = shortcut.WFWorkflowActions.flatMap((action) => {
    const url = action.WFWorkflowActionParameters.WFURLActionURL;
    if (typeof url !== "object" || url === null || !("Value" in url)) return [];
    const value = url.Value;
    if (
      typeof value !== "object" ||
      value === null ||
      !("string" in value) ||
      !("attachmentsByRange" in value)
    ) {
      return [];
    }
    return [value];
  });

  assert.equal(tokenizedUrlValues.length, 2);
  const postActions = shortcut.WFWorkflowActions.filter(
    (action) => action.WFWorkflowActionParameters.WFHTTPMethod === "POST"
  );
  assert.equal(postActions.length, 2);
  assert.ok(
    postActions.every(
      (action) => action.WFWorkflowActionParameters.WFHTTPBodyType === "JSON"
    )
  );
  const expectedOffset =
    baseUrl.length + "/api/integrations/apple-shortcuts/sessions/".length;
  for (const value of tokenizedUrlValues) {
    assert.equal(typeof value.string, "string");
    assert.equal(value.string[expectedOffset], "￼");
    assert.deepEqual(Object.keys(value.attachmentsByRange as object), [
      `{${expectedOffset}, 1}`,
    ]);
  }
});

test("Shortcut refreshes status after submitting follow-up input", async () => {
  const template = await readFile(templatePath, "utf8");
  const shortcut = JSON.parse(
    renderAppleShortcutTemplate(template, "http://example.home.arpa:3005")
  ) as Shortcut;
  const actions = shortcut.WFWorkflowActions;
  const actionIndex = (uuid: string) =>
    actions.findIndex(
      (action) => action.WFWorkflowActionParameters.UUID === uuid
    );

  const responseUpdateIndex = actionIndex(
    "00000000-0000-4000-8000-000000000013"
  );
  const refreshedStatusIndex = actionIndex(
    "00000000-0000-4000-8000-000000000034"
  );
  const runningConditionIndex = actionIndex(
    "00000000-0000-4000-8000-000000000015"
  );

  assert.ok(responseUpdateIndex < refreshedStatusIndex);
  assert.ok(refreshedStatusIndex < runningConditionIndex);
  assert.match(
    JSON.stringify(actions[runningConditionIndex]),
    /00000000-0000-4000-8000-000000000034/
  );
});
