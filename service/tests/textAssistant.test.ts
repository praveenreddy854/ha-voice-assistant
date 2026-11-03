import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import type { AgentLoopConfig } from "../src/agents/core/agentLoop";
import type { TextAssistantRunOptions } from "../src/textAssistant";

const requireModule = createRequire(__filename);

function assistantFixture(command: string) {
  const executed: string[] = [];
  let deleted = false;
  let config!: AgentLoopConfig;
  const stubs: Record<string, unknown> = {
    "../src/config": { AI_MODEL_ADVANCED: "test-model" },
    "../src/memory": { getPromptMemoryContext: async () => "", AGENT_MEMORY_SYSTEM_INSTRUCTIONS: "" },
    "../src/agents/core/memoryTools": { buildMemoryToolDefinitions: () => [] },
    "../src/assistantCapabilities": {
      executeHomeAssistantCapability: async (value: string) => {
        executed.push(value);
        return { success: true, message: "Done." };
      },
    },
    "../src/agents/core/agentLoop": {
      createAgentLoop: (value: AgentLoopConfig) => {
        config = value;
        return {
          createSession: () => ({ id: "test-session" }),
          run: async () => {
            const tool = config.tools.find((item) => item.function.name === "execute_home_assistant_command")!;
            // A model-supplied confirmation flag cannot bypass asking the user.
            const result = await tool.execute!({ command, confirmed: true }) as { success: boolean; message: string };
            return { type: "complete", ...result };
          },
          deleteSession: () => { deleted = true; },
        };
      },
    },
  };
  const modulePath = requireModule.resolve("../src/textAssistant");
  const previous = new Map<string, NodeModule | undefined>([[modulePath, requireModule.cache[modulePath]]]);
  delete requireModule.cache[modulePath];
  try {
    for (const [name, exports] of Object.entries(stubs)) {
      const path = requireModule.resolve(name);
      previous.set(path, requireModule.cache[path]);
      requireModule.cache[path] = { id: path, filename: path, loaded: true, exports } as NodeModule;
    }
    const { runTextAssistant } = requireModule("../src/textAssistant") as typeof import("../src/textAssistant");
    return { runTextAssistant, executed, deleted: () => deleted };
  } finally {
    for (const [path, value] of previous) {
      if (value) requireModule.cache[path] = value;
      else delete requireModule.cache[path];
    }
  }
}

function options(command: string, requestInput: TextAssistantRunOptions["requestInput"]): TextAssistantRunOptions {
  return { command, requestInput, history: [], abortSignal: new AbortController().signal };
}

test("protected actions wait for a user's unambiguous confirmation", async () => {
  const fixture = assistantFixture("open the garage");
  const answers = ["maybe", "yes"];
  const prompts: string[] = [];
  const result = await fixture.runTextAssistant(options("open the garage", async (prompt, reason) => {
    assert.deepEqual(fixture.executed, []);
    assert.equal(reason, "action_confirmation");
    prompts.push(prompt);
    return answers.shift()!;
  }));
  assert.equal(prompts.length, 2);
  assert.equal(result.success, true);
  assert.deepEqual(fixture.executed, ["open the garage"]);
  assert.equal(fixture.deleted(), true);
});

test("declined or repeatedly unclear answers never execute the action", async () => {
  for (const answer of ["no", "maybe"]) {
    const fixture = assistantFixture("turn off all lights");
    let questions = 0;
    const result = await fixture.runTextAssistant(options("turn off all lights", async () => {
      questions += 1;
      return answer;
    }));
    assert.equal(questions, answer === "no" ? 1 : 3);
    assert.equal(result.success, false);
    assert.deepEqual(fixture.executed, []);
    assert.equal(fixture.deleted(), true);
  }
});

test("routine actions run without a confirmation question", async () => {
  const fixture = assistantFixture("turn on the bathroom light");
  await fixture.runTextAssistant(options("turn on the bathroom light", async () => {
    assert.fail("Routine commands must not ask for confirmation.");
  }));
  assert.deepEqual(fixture.executed, ["turn on the bathroom light"]);
});

test("an expired confirmation cleans up without executing the action", async () => {
  const fixture = assistantFixture("open the garage");
  await assert.rejects(fixture.runTextAssistant(options("open the garage", async () => {
    throw new Error("The Shortcut voice turn has ended.");
  })), /voice turn has ended/);
  assert.deepEqual(fixture.executed, []);
  assert.equal(fixture.deleted(), true);
});
