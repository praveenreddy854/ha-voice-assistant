import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  TextAssistantSessionManager,
  type TextAssistantSessionSnapshot,
} from "../src/textAssistantSessions";

async function waitFor(
  read: () => TextAssistantSessionSnapshot | undefined,
  status: TextAssistantSessionSnapshot["status"],
  timeoutMs = 500
): Promise<TextAssistantSessionSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = read();
    if (snapshot?.status === status) return snapshot;
    await delay(5);
  }
  throw new Error(`Session did not reach ${status}.`);
}

test("keeps clarification inside the same Shortcut voice turn", async () => {
  const manager = new TextAssistantSessionManager({
    executor: async (options) => {
      const answer = await options.requestInput("Which room?", "clarification");
      return { success: true, message: `Using ${answer}.` };
    },
    sessionTtlMs: 1_000,
  });

  const started = manager.start("apple-shortcuts", "Turn on the light");
  const pending = await waitFor(
    () => manager.get("apple-shortcuts", started.conversationId),
    "input_required"
  );
  assert.equal(pending.message, "Which room?");
  assert.equal(pending.inputReason, "clarification");

  const resumed = manager.submitInput(
    "apple-shortcuts",
    started.conversationId,
    "bathroom"
  );
  assert.equal(resumed?.status, "running");
  const completed = await waitFor(
    () => manager.get("apple-shortcuts", started.conversationId),
    "completed"
  );
  assert.equal(completed.message, "Using bathroom.");
});

test("short history retains follow-up prompts and answers", async () => {
  const histories: string[][] = [];
  let execution = 0;
  const manager = new TextAssistantSessionManager({
    executor: async (options) => {
      histories.push(options.history.map((item) => item.content));
      execution += 1;
      if (execution === 1) {
        const answer = await options.requestInput(
          "Which room?",
          "clarification"
        );
        return { success: true, message: `Using ${answer}.` };
      }
      return { success: true, message: "Done." };
    },
    sessionTtlMs: 1_000,
  });

  const first = manager.start("apple-shortcuts", "Turn on the light");
  await waitFor(
    () => manager.get("apple-shortcuts", first.conversationId),
    "input_required"
  );
  manager.submitInput("apple-shortcuts", first.conversationId, "bathroom");
  await waitFor(
    () => manager.get("apple-shortcuts", first.conversationId),
    "completed"
  );

  const second = manager.start("apple-shortcuts", "Do that again");
  await waitFor(
    () => manager.get("apple-shortcuts", second.conversationId),
    "completed"
  );

  assert.deepEqual(histories[1], [
    "Turn on the light",
    "Which room?",
    "bathroom",
    "Using bathroom.",
  ]);
});

test("short history is bounded to and isolated by caller scope", async () => {
  const seenHistory: Array<{ scope: string; content: string[] }> = [];
  let currentScope = "apple-shortcuts";
  const manager = new TextAssistantSessionManager({
    executor: async (options) => {
      seenHistory.push({
        scope: currentScope,
        content: options.history.map((item) => item.content),
      });
      return { success: false, message: `Reply to ${options.command}` };
    },
    sessionTtlMs: 1_000,
  });

  const first = manager.start("apple-shortcuts", "first");
  await waitFor(
    () => manager.get("apple-shortcuts", first.conversationId),
    "failed"
  );
  const second = manager.start("apple-shortcuts", "second");
  await waitFor(
    () => manager.get("apple-shortcuts", second.conversationId),
    "failed"
  );
  currentScope = "another-channel";
  const isolated = manager.start("another-channel", "third");
  await waitFor(
    () => manager.get("another-channel", isolated.conversationId),
    "failed"
  );

  assert.deepEqual(seenHistory[0].content, []);
  assert.deepEqual(seenHistory[1].content, ["first", "Reply to first"]);
  assert.deepEqual(seenHistory[2].content, []);
});

test("caller scopes cannot read or answer each other's sessions", () => {
  const manager = new TextAssistantSessionManager({
    executor: async ({ requestInput }) => {
      await requestInput("Confirm?", "action_confirmation");
      return { success: true, message: "Done." };
    },
    sessionTtlMs: 1_000,
  });
  const started = manager.start("apple-shortcuts", "unlock the front door");

  assert.equal(manager.get("another-channel", started.conversationId), undefined);
  assert.equal(
    manager.submitInput("another-channel", started.conversationId, "yes"),
    undefined
  );
  manager.cancel("apple-shortcuts", started.conversationId);
});

test("rejects a second simultaneous input request", async () => {
  const manager = new TextAssistantSessionManager({
    executor: async ({ requestInput }) => {
      const firstAnswer = requestInput("First question?", "clarification");
      await assert.rejects(
        requestInput("Second question?", "clarification"),
        /already waiting for input/i
      );
      return { success: true, message: await firstAnswer };
    },
    sessionTtlMs: 1_000,
  });
  const started = manager.start("apple-shortcuts", "ask me");
  await waitFor(
    () => manager.get("apple-shortcuts", started.conversationId),
    "input_required"
  );
  manager.submitInput("apple-shortcuts", started.conversationId, "answer");
  const completed = await waitFor(
    () => manager.get("apple-shortcuts", started.conversationId),
    "completed"
  );
  assert.equal(completed.message, "answer");
});

test("expires an unfinished session and aborts its work", async () => {
  let aborted = false;
  const manager = new TextAssistantSessionManager({
    executor: ({ abortSignal }) =>
      new Promise((_resolve, reject) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(abortSignal.reason);
          },
          { once: true }
        );
      }),
    sessionTtlMs: 25,
  });
  const started = manager.start("apple-shortcuts", "keep working");
  const expired = await waitFor(
    () => manager.get("apple-shortcuts", started.conversationId),
    "expired"
  );

  assert.match(expired.message, /two minutes/i);
  assert.equal(aborted, true);
});
