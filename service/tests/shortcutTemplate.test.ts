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

test("Shortcut has native-compatible URL, condition, and speech bindings", async () => {
  const template = await readFile(templatePath, "utf8");
  const shortcut = JSON.parse(
    renderAppleShortcutTemplate(template, "http://example.home.arpa:3005")
  ) as Shortcut;
  const actions = shortcut.WFWorkflowActions;
  const tokenReferences = (parameter: unknown): string[] => {
    const token = parameter as {
      WFSerializationType?: string;
      Value?: { string?: string; attachmentsByRange?: Record<string, { OutputUUID: string }> };
    };
    assert.equal(token?.WFSerializationType, "WFTextTokenString");
    assert.equal(token.Value?.string, "\uFFFC");
    return Object.values(token.Value?.attachmentsByRange ?? {}).map((value) => value.OutputUUID);
  };

  const downloads = actions.filter((action) => action.WFWorkflowActionIdentifier === "is.workflow.actions.downloadurl");
  assert.equal(downloads.length, 3);
  for (const action of downloads) {
    const [urlId] = tokenReferences(action.WFWorkflowActionParameters.WFURL);
    const producer = actions.find((candidate) => candidate.WFWorkflowActionParameters.UUID === urlId);
    assert.equal(producer?.WFWorkflowActionIdentifier, "is.workflow.actions.url");
  }

  const conditions = actions.filter((action) =>
    action.WFWorkflowActionIdentifier === "is.workflow.actions.conditional" &&
    action.WFWorkflowActionParameters.WFControlFlowMode === 0
  );
  assert.deepEqual(conditions.map((action) => action.WFWorkflowActionParameters.WFConditionalActionString), ["input_required", "running", "running", "input_required"]);
  for (const action of conditions) {
    const input = action.WFWorkflowActionParameters.WFInput as {
      Variable: { Value: { Aggrandizements: unknown[] } };
    };
    assert.deepEqual(input.Variable.Value.Aggrandizements, [{
      Type: "WFCoercionVariableAggrandizement", CoercionItemClass: "WFStringContentItem",
    }], "Dictionary status must be coerced to Text for native If to show its comparison value");
  }

  const speech = actions.filter((action) => action.WFWorkflowActionIdentifier === "is.workflow.actions.speaktext");
  assert.equal(speech.length, 3);
  const speechSources = speech.map((action) => tokenReferences(action.WFWorkflowActionParameters.WFText));
  assert.deepEqual(speechSources, [
    ["00000000-0000-4000-8000-000000000022"],
    ["00000000-0000-4000-8000-000000000040"],
    ["00000000-0000-4000-8000-000000000028"],
  ]);
});

interface SessionResponse {
  conversationId: string;
  status: string;
  message: string;
}

// Execute the template's control flow and variable bindings with fake HTTP and
// speech actions. This tests boundary behavior without native UI or device calls.
function runShortcut(
  shortcut: Shortcut,
  request: (method: string, url: string) => SessionResponse
): string[] {
  const actions = shortcut.WFWorkflowActions;
  const outputs = new Map<string, unknown>();
  const variables = new Map<string, unknown>();
  const spoken: string[] = [];
  let stopped = false;

  const resolve = (input: unknown): unknown => {
    if (typeof input !== "object" || input === null) return input;
    const token = input as Record<string, unknown>;
    if ("Variable" in token) return resolve(token.Variable);
    if ("Value" in token) return resolve(token.Value);
    if (token.Type === "Variable") return variables.get(String(token.VariableName));
    if (token.Type === "ActionOutput") return outputs.get(String(token.OutputUUID));
    if (typeof token.string === "string") {
      let rendered = token.string;
      const attachments = Object.entries(
        (token.attachmentsByRange ?? {}) as Record<string, unknown>
      ).sort(([a], [b]) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]));
      for (const [range, attachment] of attachments) {
        const [start, length] = range.match(/\d+/g)!.map(Number);
        rendered = rendered.slice(0, start) + String(resolve(attachment)) + rendered.slice(start + length);
      }
      return rendered;
    }
    return token;
  };

  const run = (start: number, end: number): void => {
    for (let index = start; index < end && !stopped; index++) {
      const action = actions[index];
      const params = action.WFWorkflowActionParameters;
      const kind = action.WFWorkflowActionIdentifier;
      if (params.WFControlFlowMode === 0) {
        const group = params.GroupingIdentifier;
        const endIndex = actions.findIndex((candidate, i) => i > index &&
          candidate.WFWorkflowActionParameters.GroupingIdentifier === group &&
          candidate.WFWorkflowActionParameters.WFControlFlowMode === 2);
        assert.ok(endIndex > index, "Control-flow group must close");
        if (kind === "is.workflow.actions.repeat.count") {
          for (let iteration = 0; iteration < Number(params.WFRepeatCount) && !stopped; iteration++) {
            run(index + 1, endIndex);
          }
        } else {
          assert.equal(kind, "is.workflow.actions.conditional");
          assert.equal(params.WFCondition, 4, "Simulator supports native equality conditions");
          const otherwiseIndex = actions.findIndex((candidate, i) => i > index && i < endIndex &&
            candidate.WFWorkflowActionParameters.GroupingIdentifier === group &&
            candidate.WFWorkflowActionParameters.WFControlFlowMode === 1);
          if (String(resolve(params.WFInput)) === params.WFConditionalActionString) {
            run(index + 1, otherwiseIndex < 0 ? endIndex : otherwiseIndex);
          } else if (otherwiseIndex >= 0) {
            run(otherwiseIndex + 1, endIndex);
          }
        }
        index = endIndex;
        continue;
      }

      let output: unknown;
      switch (kind) {
        case "is.workflow.actions.ask": output = "Test answer"; break;
        case "is.workflow.actions.url": output = resolve(params.WFURLActionURL); break;
        case "is.workflow.actions.downloadurl":
          output = request(String(params.WFHTTPMethod ?? "GET"), String(resolve(params.WFURL)));
          break;
        case "is.workflow.actions.setvariable":
          variables.set(String(params.WFVariableName), resolve(params.WFInput));
          break;
        case "is.workflow.actions.getvalueforkey":
          output = (resolve(params.WFInput) as Record<string, unknown>)[String(params.WFDictionaryKey)];
          break;
        case "is.workflow.actions.gettext": output = resolve(params.WFTextActionText); break;
        case "is.workflow.actions.speaktext": spoken.push(String(resolve(params.WFText))); break;
        case "is.workflow.actions.delay": break;
        case "is.workflow.actions.exit": stopped = true; break;
        default: assert.fail(`Unhandled Shortcut action: ${kind}`);
      }
      outputs.set(String(params.UUID), output);
    }
  };
  run(0, actions.length);
  return spoken;
}

test("Shortcut reports terminal responses received on the final poll or follow-up", async () => {
  const template = await readFile(templatePath, "utf8");
  const shortcut = JSON.parse(
    renderAppleShortcutTemplate(template, "http://example.home.arpa:3005")
  ) as Shortcut;

  for (const pendingStatus of ["running", "input_required"]) {
    for (const finalStatus of ["completed", "failed", "cancelled", "expired", pendingStatus]) {
      let continuations = 0;
      const message = `Final ${finalStatus} result`;
      const spoken = runShortcut(shortcut, (method, url) => {
        const initial = method === "POST" && url.endsWith("/sessions");
        if (!initial) {
          assert.equal(method, pendingStatus === "running" ? "GET" : "POST");
          assert.ok(url.endsWith(pendingStatus === "running" ? "/test-session" : "/test-session/input"));
          continuations++;
        }
        return {
          conversationId: "test-session",
          status: continuations === 60 ? finalStatus : pendingStatus,
          message: continuations === 60 ? message : "Still pending",
        };
      });
      assert.equal(continuations, 60);
      assert.deepEqual(spoken, [finalStatus === pendingStatus
        ? "The request timed out after two minutes."
        : message], `${pendingStatus} -> ${finalStatus} on final iteration`);
    }
  }
});

test("Shortcut keeps follow-up submission and polling in separate branches", async () => {
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
  const otherwiseIndex = actionIndex(
    "00000000-0000-4000-8000-000000000014"
  );
  const refreshedStatusIndex = actionIndex(
    "00000000-0000-4000-8000-000000000034"
  );
  const runningConditionIndex = actionIndex(
    "00000000-0000-4000-8000-000000000015"
  );

  // After a follow-up POST, status is read on the next Repeat iteration.
  // The second status read belongs to Otherwise, immediately before polling.
  assert.ok(responseUpdateIndex < otherwiseIndex);
  assert.ok(otherwiseIndex < refreshedStatusIndex);
  assert.equal(actions[otherwiseIndex].WFWorkflowActionParameters.WFControlFlowMode, 1);
  assert.equal(actions[otherwiseIndex].WFWorkflowActionParameters.GroupingIdentifier,
    actions[actionIndex("00000000-0000-4000-8000-000000000007")].WFWorkflowActionParameters.GroupingIdentifier);
  assert.ok(refreshedStatusIndex < runningConditionIndex);
  assert.match(
    JSON.stringify(actions[runningConditionIndex]),
    /00000000-0000-4000-8000-000000000034/
  );
});
