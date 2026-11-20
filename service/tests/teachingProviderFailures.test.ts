import assert from "node:assert/strict";
import test from "node:test";
import { configureTestProviders } from "./helpers/agentFixtures";

configureTestProviders();
process.env.AZURE_STORAGE_ACCOUNT_KEY = "";

test("missing embedding credentials prevent a teaching session and lookup", async t => {
  const originalKey = process.env.AZURE_OPENAI_API_KEY_EUS2!;
  process.env.AZURE_OPENAI_API_KEY_EUS2 = "";
  t.after(() => { process.env.AZURE_OPENAI_API_KEY_EUS2 = originalKey; });
  const fetch = t.mock.method(globalThis, "fetch", async () => {
    assert.fail("Invalid configuration should be rejected before making requests");
  });
  const { startTeachingSession, getActiveSessions, findGuidanceForTask } = await import("../src/agents/tv/teaching/teachingRecorder");

  await assert.rejects(startTeachingSession("Open settings"), /Configure AZURE_OPENAI_API_KEY_EUS2/);
  assert.equal(getActiveSessions().length, 0);
  await assert.rejects(findGuidanceForTask("Open settings"), /Configure AZURE_OPENAI_API_KEY_EUS2/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("failed vision analysis does not append a teaching step and can be retried", async t => {
  const { addScreenshotCapture, cancelTeachingSession, startTeachingSession } = await import("../src/agents/tv/teaching/teachingRecorder");
  let output: string | undefined;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    if (new URL(url).pathname.endsWith("/embeddings")) {
      return Response.json({ data: [{ embedding: [0.1] }] });
    }
    return Response.json({
      id: "fixture", created_at: 1, model: "fixture",
      status: output === undefined ? "incomplete" : "completed",
      incomplete_details: output === undefined ? { reason: "max_output_tokens" } : null,
      output: [{ id: "m1", type: "message", role: "assistant", content: [
        { type: "output_text", text: output ?? "partial", annotations: [] },
      ] }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  const { sessionId, recording } = await startTeachingSession("Open settings");
  t.after(() => { cancelTeachingSession(sessionId); });
  const capture = () => addScreenshotCapture(sessionId, "AA==", "image/png", 0);
  const originalKey = process.env.AZURE_OPENAI_API_KEY_EUS!;
  try {
    process.env.AZURE_OPENAI_API_KEY_EUS = "";
    await assert.rejects(capture(), /Configure AZURE_OPENAI_API_KEY_EUS/);
  } finally {
    process.env.AZURE_OPENAI_API_KEY_EUS = originalKey;
  }
  await assert.rejects(capture(), /truncated at the output token limit/);
  output = "not a valid analysis";
  await assert.rejects(capture(), /did not return a valid analysis/);
  assert.equal(recording.steps.length, 0);

  output = JSON.stringify({ description: "Settings screen", focusedElement: null, inferredAction: "Started recording" });
  const step = await capture();
  assert.equal(step?.stepNumber, 1);
  assert.equal(step?.description, "Settings screen");
  assert.equal(recording.steps.length, 1);
});
