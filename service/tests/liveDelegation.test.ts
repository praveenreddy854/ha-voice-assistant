import assert from "node:assert/strict";
import test from "node:test";
import { LiveDelegationController, type LiveDelegationRequest, type VoiceHistoryItem } from "../src/liveDelegation";

const drain = () => new Promise((resolve) => setImmediate(resolve));
function fixture(run: (request: LiveDelegationRequest) => Promise<string> = async () => "Done.") {
  const replies: Array<{ content: string; id: string | null; quiet?: boolean }> = [];
  const history: VoiceHistoryItem[] = [];
  const controller = new LiveDelegationController({ history, run, reply: (content, id, quiet) => replies.push({ content, id, quiet }), onIdle() {} });
  return { controller, replies, history };
}

test("transcripts alone never execute a request; multiple IDs for one utterance run once", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const commands: string[] = [];
  const { controller, replies } = fixture(async ({ command }) => { commands.push(command); return "On it."; });
  controller.appendTranscript("Play Netflix");
  t.mock.timers.tick(800);
  await drain();
  assert.deepEqual(commands, []);
  controller.delegate("d1");
  controller.delegate("d1");
  controller.delegate("d2");
  t.mock.timers.tick(800);
  await drain();
  assert.deepEqual(commands, ["Play Netflix"]);
  assert.deepEqual(replies, [{ content: "On it.", id: "d1", quiet: false }, { content: "On it.", id: "d2", quiet: true }]);
  controller.dispose();
});

test("delegation before any transcript waits for the complete request", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const commands: string[] = [];
  const { controller } = fixture(async ({ command }) => { commands.push(command); return "Done."; });
  controller.delegate("d1");
  t.mock.timers.tick(1000);
  await drain();
  assert.deepEqual(commands, []);
  controller.appendTranscript("Turn on ");
  t.mock.timers.tick(500);
  controller.appendTranscript("the bedroom light");
  t.mock.timers.tick(800);
  await drain();
  assert.deepEqual(commands, ["Turn on the bedroom light"]);
  controller.dispose();
});

test("missing transcripts produce a correlated clarification, never an empty command", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let executed = false;
  const { controller, replies } = fixture(async () => { executed = true; return "bad"; });
  controller.delegate("d1");
  t.mock.timers.tick(5000);
  await drain();
  assert.equal(executed, false);
  assert.equal(replies[0].id, "d1");
  assert.match(replies[0].content, /repeat/i);
  assert.equal(controller.busy, false);
  controller.dispose();
});

test("requests are serialized and follow-up answers receive their own voice history", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (value: string) => void;
  const seen: LiveDelegationRequest[] = [];
  const { controller } = fixture(async (request) => {
    seen.push(request);
    return seen.length === 1 ? new Promise((resolve) => { finish = resolve; }) : "Done.";
  });
  controller.appendTranscript("Unlock the garage");
  controller.delegate("d1");
  t.mock.timers.tick(800);
  await drain();
  controller.appendTranscript("yes");
  controller.delegate("d2");
  t.mock.timers.tick(800);
  await drain();
  assert.equal(seen.length, 1);
  finish("Please confirm: unlock the garage?");
  await drain();
  assert.equal(seen.length, 2);
  assert.equal(seen[1].command, "yes");
  assert.deepEqual(seen[1].history.map((item) => item.content), ["Unlock the garage", "Please confirm: unlock the garage?"]);
  controller.dispose();
});

test("disconnect aborts reasoning and drops late replies and queued commands", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (value: string) => void;
  const seen: LiveDelegationRequest[] = [];
  const { controller, replies } = fixture(async (request) => { seen.push(request); return new Promise((resolve) => { finish = resolve; }); });
  controller.submitText("first");
  t.mock.timers.tick(800);
  await drain();
  controller.submitText("second");
  t.mock.timers.tick(800);
  controller.dispose();
  assert.equal(seen[0].signal.aborted, true);
  finish("Late reply");
  await drain();
  assert.equal(seen.length, 1);
  assert.deepEqual(replies, []);
});

test("a failed request reports failure and does not block later requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { controller, replies } = fixture(async ({ command }) => { if (command === "first") throw new Error("Tool failed"); return "Done."; });
  controller.submitText("first");
  t.mock.timers.tick(800);
  await drain();
  controller.submitText("second");
  t.mock.timers.tick(800);
  await drain();
  assert.match(replies[0].content, /Tool failed/);
  assert.equal(replies[1].content, "Done.");
  controller.dispose();
});
