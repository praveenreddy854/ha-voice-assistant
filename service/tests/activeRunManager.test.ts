import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  getActiveRun,
  startActiveRun,
  type ActiveRunDomain,
} from "../src/activeRunManager";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Condition was not reached.");
}

test("different capability domains can run concurrently", async () => {
  const tv = deferred<string>();
  const scheduled = deferred<string>();
  let completed = 0;

  startActiveRun({
    domain: "tv",
    prompt: "play a show",
    execute: () => tv.promise,
    onComplete: () => {
      completed += 1;
    },
  });
  startActiveRun({
    domain: "scheduled_task",
    prompt: "remind me tomorrow",
    execute: () => scheduled.promise,
    onComplete: () => {
      completed += 1;
    },
  });

  assert.equal(getActiveRun("tv")?.domain, "tv");
  assert.equal(getActiveRun("scheduled_task")?.domain, "scheduled_task");
  tv.resolve("done");
  scheduled.resolve("done");
  await waitUntil(() => completed === 2);
});

test("a replacement cancels only the conflicting domain", async () => {
  let cancelled = 0;
  const other = deferred<string>();
  const replacement = deferred<string>();
  const neverComplete = (domain: ActiveRunDomain) =>
    startActiveRun({
      domain,
      prompt: "first",
      execute: ({ abortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          abortSignal.addEventListener("abort", () => reject(abortSignal.reason), {
            once: true,
          });
        }),
      onCancelled: () => {
        cancelled += 1;
      },
    });

  neverComplete("tv");
  startActiveRun({
    domain: "home_assistant",
    prompt: "turn on a light",
    execute: () => other.promise,
  });
  startActiveRun({
    domain: "tv",
    prompt: "replacement",
    execute: () => replacement.promise,
  });

  await waitUntil(() => cancelled === 1);
  assert.equal(getActiveRun("home_assistant")?.domain, "home_assistant");
  assert.equal(getActiveRun("tv")?.prompt, "replacement");
  other.resolve("done");
  replacement.resolve("done");
});
