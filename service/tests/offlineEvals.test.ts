import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { EvalStore } from "../src/evals/store";
import { EvalRunner } from "../src/evals/runner";
import { baselineFor, fidelityPairs, isDue, localDay, runVerdict } from "../src/evals/analytics";
import { networkAllowed } from "../src/evals/network";
import { validateGrade } from "../src/evals/judge";
import { assessmentFromRecord } from "../src/evals/recorded";
import { tvScenarios } from "../src/evals/tv/scenarios";
import { TvEnvironment } from "../src/evals/tv/environment";
import { referenceAssessments } from "../src/evals/references";
import type { AgentAdapter, Assessment, EvalAlert, EvalRun, EvalRunSummary, Grade, Judge, Verdict } from "../src/evals/types";

const fact = (verdict: Verdict) => ({ verdict, reason: "Referenced observation", evidenceIds: ["e1"] });
function grade(handling: Verdict = "pass"): Grade {
  return { task: fact(handling), handling: fact(handling), reporting: fact("pass"), recovery: fact("not_applicable"),
    context: tvScenarios[0].context, steps: [{ ...fact(handling), objective: "app_ready", startingState: "app_ready", alreadySatisfied: true }], gaps: [] };
}
function assessment(): Assessment {
  return { agentId: "tv", mode: "simulated", request: "Open YouTube", finalResponse: "Done", startedAt: new Date().toISOString(),
    durationMs: 1000, model: "model", promptVersion: "prompt", evidence: [{ id: "e1", kind: "initial", text: "YouTube open" }], coverage: "complete", context: tvScenarios[0].context };
}
function run(day: string, options: Partial<EvalRun> = {}): EvalRun {
  return { id: `r-${day}`, batchId: "batch", agentId: "tv", mode: "simulated", attempt: "scheduled", scenarioId: tvScenarios[0].id,
    scenarioVersion: "1", adapterVersion: "adapter", graderVersion: "grader", judgeModel: "judge", scheduledDay: day,
    assessedAt: `${day}T12:00:00Z`, gradedAt: `${day}T13:00:00Z`, status: "completed", durationMs: 1000,
    assessedModel: "model", promptVersion: "prompt", grade: grade(), ...options };
}
async function withStore(fn: (store: EvalStore) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "offline-evals-test-"));
  try { await fn(new EvalStore(dir)); } finally { await rm(dir, { recursive: true, force: true }); }
}
test("TV suite contains exactly the twelve agreed scenarios and independent state expectations", () => {
  assert.equal(tvScenarios.length, 12); assert.equal(new Set(tvScenarios.map(s => s.id)).size, 12);
  assert.equal(new TvEnvironment(tvScenarios[0]).taskSatisfied(), true);
  assert.equal(new TvEnvironment(tvScenarios.find(s => s.id === "netflix-unreachable")!).taskSatisfied(), false);
});
test("failed launch requires research, then alternate navigation can complete the task", async () => {
  const env = new TvEnvironment(tvScenarios.find(s => s.id === "youtube-launch-recovery")!);
  assert.equal((await env.execute("launch_app", { app_name: "YouTube" })).toolSuccess, false);
  assert.equal((await env.execute("click_select_button", {})).toolSuccess, false);
  await env.execute("web_search", { query: "Apple TV integration" });
  await env.execute("click_select_button", {});
  assert.equal(env.taskSatisfied(), true);
});
test("unsupported simulator tools fail closed and unknown devices never change state", async () => {
  const env = new TvEnvironment(tvScenarios[1]);
  await assert.rejects(env.execute("call_live_home", {}), /live fallback is forbidden/);
  assert.equal((await env.execute("click_power_button", { remote_entity_id: "remote.someone_else", desired_state: "on" })).toolSuccess, false);
  assert.equal(env.state.power, false);
});
test("typing needs a visible keyboard and correct focus; wrong content cannot fulfill latest Telugu", async () => {
  const env = new TvEnvironment(tvScenarios.find(s => s.id === "telugu-fresh-search")!);
  assert.equal((await env.execute("deterministic_typing", { text: "latest telugu songs", current_cursor_position: "a" })).toolSuccess, false);
  await env.execute("click_select_button", {});
  assert.equal((await env.execute("deterministic_typing", { text: "latest telugu songs", current_cursor_position: "x" })).toolSuccess, false);
  const typed = await env.execute("deterministic_typing", { text: "latest telugu songs", current_cursor_position: "a" });
  assert.ok(typed.image?.startsWith("data:image/png;base64,"));
  await env.execute("navigate", { direction: "down", count: 1 });
  await env.execute("navigate", { direction: "down", count: 1 });
  await env.execute("click_select_button", {});
  assert.equal(env.state.content, "old-telugu"); assert.equal(env.taskSatisfied(), false);
});
test("paused selected content needs actual play state, and PNG screens render from state", async () => {
  const env = new TvEnvironment(tvScenarios.find(s => s.id === "telugu-paused-selection")!);
  await env.execute("click_select_button", {});
  assert.equal(env.taskSatisfied(), false);
  await env.execute("media_control", { action: "play" }); assert.equal(env.taskSatisfied(), true);
  const image = await env.screenshot();
  const meta = await sharp(Buffer.from(image.split(",")[1], "base64")).metadata();
  assert.equal(meta.width, 1280); assert.equal(meta.height, 720); assert.equal(meta.format, "png");
});
test("judge evidence IDs are validated and independent simulator facts override guessed task success", () => {
  const invalid = grade(); invalid.task.evidenceIds = ["invented"];
  assert.throws(() => validateGrade(invalid, assessment()), /nonexistent/);
  const input = assessment(); input.taskAssertion = false; input.evidence.push({ id: "e2", kind: "assertion", text: "App is not open" });
  const output = validateGrade(grade(), input);
  assert.equal(output.task.verdict, "fail"); assert.deepEqual(output.task.evidenceIds, ["e2"]);
  const falseClaim = grade(); falseClaim.reporting.verdict = "fail";
  assert.equal(validateGrade(falseClaim, input).handling.verdict, "fail");
});
test("unreachable task failure can pass handling; a partial historical record stays unknown", () => {
  const references = referenceAssessments();
  assert.deepEqual(references.find(r => r.id === "J5")?.expected, ["fail", "pass", "pass"]);
  assert.deepEqual(references.find(r => r.id === "J6")?.expected, ["unknown", "unknown", "unknown"]);
  const honest = run("2026-09-13"); honest.grade!.task.verdict = "fail";
  assert.equal(runVerdict(honest), "pass");
});
test("network boundary allows model calls and explicitly read-only Cosmos, never HA or redirects to other hosts", () => {
  const model = "model.openai.azure.com", cosmos = "db.documents.azure.com";
  assert.equal(networkAllowed(new URL(`https://${model}/openai/responses`), "POST", {}, model), true);
  assert.equal(networkAllowed(new URL("http://homeassistant.local:8123/api/services/remote/turn_on"), "POST", {}, model), false);
  assert.equal(networkAllowed(new URL(`https://${cosmos}/dbs/a/colls/b/docs`), "POST", {}, model, cosmos), false);
  assert.equal(networkAllowed(new URL(`https://${cosmos}/dbs/a/colls/b/docs`), "POST", { "x-ms-documentdb-isquery": "true", "content-type": "application/query+json" }, model, cosmos), true);
  assert.equal(networkAllowed(new URL(`https://${cosmos}/dbs/a/colls/b/docs`), "DELETE", {}, model, cosmos), false);
  assert.equal(networkAllowed(new URL(`https://${model}.evil.test/openai/responses`), "POST", {}, model), false);
});
test("Cosmos query-plan POSTs are read-only; missing markers, document writes, and other paths stay blocked", () => {
  const model = "model.openai.azure.com", cosmos = "db.documents.azure.com";
  const url = new URL(`https://${cosmos}/dbs/a/colls/b/docs`);
  const headers = { "X-Ms-Cosmos-Is-Query-Plan-Request": "True", "Content-Type": "application/query+json" };
  assert.equal(networkAllowed(url, "POST", headers, model, cosmos), true);
  assert.equal(networkAllowed(url, "POST", headers, model), false);
  assert.equal(networkAllowed(url, "POST", { ...headers, "X-Ms-Cosmos-Is-Query-Plan-Request": "False" }, model, cosmos), false);
  assert.equal(networkAllowed(url, "POST", { ...headers, "Content-Type": "application/json" }, model, cosmos), false);
  assert.equal(networkAllowed(url, "PUT", headers, model, cosmos), false);
  assert.equal(networkAllowed(url, "DELETE", headers, model, cosmos), false);
  assert.equal(networkAllowed(new URL(`${url}/document-id`), "POST", headers, model, cosmos), false);
  assert.equal(networkAllowed(new URL(`https://${cosmos}/dbs/a/colls/b/sprocs/run`), "POST", headers, model, cosmos), false);
});
test("baseline excludes today, confirmation attempts, old fixtures, and ungraded failures", () => {
  const current = run("2026-09-13", { grade: grade("fail") });
  const prior = [run("2026-09-10"), run("2026-09-11"), run("2026-09-12"), run("2026-09-13"),
    run("2026-09-09", { attempt: "confirmation" }), run("2026-09-08", { scenarioVersion: "old" }), run("2026-09-07", { status: "grading_error" })];
  assert.deepEqual(baselineFor(current, prior), { baselineCount: 3, medianMs: 1000, signal: "failure" });
  assert.equal(baselineFor(run("2026-09-13", { durationMs: 2001 }), prior).signal, "slowdown");
  assert.equal(baselineFor(run("2026-09-13", { durationMs: 2000 }), prior).signal, undefined);
});
test("schedule uses New York day boundaries and follows daylight-saving changes", () => {
  assert.equal(localDay(new Date("2026-09-14T01:00:00Z")), "2026-09-13");
  assert.equal(isDue(new Date("2026-03-08T06:59:00Z")), false);
  assert.equal(isDue(new Date("2026-03-08T07:00:00Z")), true);
  assert.equal(isDue(new Date("2026-11-01T07:59:00Z")), false);
  assert.equal(isDue(new Date("2026-11-01T08:00:00Z")), true);
});
test("recorded importer rejects live sessions and never trusts reported success", () => {
  assert.throws(() => assessmentFromRecord({ agentType: "tv", status: "running" } as never), /completed/);
  const input = assessmentFromRecord({ sessionId: "real", agentType: "tv", userPrompt: "Open Netflix", status: "completed", completedAt: "2026-09-13T12:00:00Z", startedAt: "2026-09-13T11:59:00Z",
    finalMessage: "Done", success: true, llmSteps: [], toolResults: [], screenshots: [], events: [] });
  assert.equal(input.taskAssertion, undefined); assert.equal(input.coverage, "partial"); assert.equal(input.mode, "recorded");
});
test("group identity survives missing validation and separates agent contexts", async () => withStore(async store => {
  const first = run("2026-09-12"); await store.saveRun(first);
  const missing = run("2026-09-13", { mode: "recorded", grade: grade("unknown") }); await store.saveRun(missing);
  assert.equal(first.grade!.steps[0].groupId, missing.grade!.steps[0].groupId);
  assert.equal((await store.list("groups")).length, 1);
  await assert.rejects(store.read("runs", "../secrets"), /Invalid/);
}));
test("summaries retain independent assertions without exposing evidence or guessing from judge verdicts", async () => withStore(async store => {
  for (const assertion of [true, false, undefined]) {
    const result = run(String(assertion), { status: "grading_error", assessment: { ...assessment(), taskAssertion: assertion } });
    await store.saveRun(result);
    const summary = await store.read<EvalRunSummary>("summaries", result.id);
    assert.equal(summary?.taskAssertion, assertion);
    assert.equal(summary?.status, "grading_error");
    assert.equal(summary?.request, result.assessment?.request);
    assert.ok(summary && !("assessment" in summary));
  }
  const recorded = run("recorded", { mode: "recorded", assessment: { ...assessment(), mode: "recorded", taskAssertion: true } });
  await store.saveRun(recorded);
  assert.equal((await store.read<EvalRunSummary>("summaries", recorded.id))?.taskAssertion, undefined);
}));
test("one confirmation preserves the first failure; daily batch is not duplicated", async () => withStore(async store => {
  for (const day of ["2026-09-10", "2026-09-11", "2026-09-12"]) await store.saveRun(run(day));
  let calls = 0;
  const judge: Judge = async () => ({ grade: grade(++calls === 1 ? "fail" : "pass") });
  const runner = new EvalRunner(store, judge, "judge", "grader");
  const adapter: AgentAdapter = { id: "tv", version: "adapter", model: "model", promptVersion: "prompt", scenarios: [tvScenarios[0]], execute: async () => assessment() };
  const batch = await runner.simulated(adapter, new AbortController().signal, { scheduledDay: "2026-09-13" });
  assert.equal(batch.runIds.length, 2);
  const original = await store.read<EvalRun>("runs", batch.runIds[0]);
  assert.equal(runVerdict(original!), "fail"); assert.equal(original?.comparison?.confirmation, "intermittent");
  assert.equal((await store.list<EvalAlert>("alerts")).length, 0);
  const again = await runner.simulated(adapter, new AbortController().signal, { scheduledDay: "2026-09-13" });
  assert.equal(again.id, batch.id); assert.equal(calls, 2);
}));
test("execution failures never call the judge and produce incomplete batches", async () => withStore(async store => {
  let calls = 0;
  const runner = new EvalRunner(store, async () => { calls++; return { grade: grade() }; }, "judge", "grader");
  const batch = await runner.recorded("tv", [async () => { throw new Error("Source unavailable"); }], new AbortController().signal);
  assert.equal(batch.status, "incomplete"); assert.equal(calls, 0);
  assert.equal((await store.read<EvalRun>("runs", batch.runIds[0]))?.status, "execution_error");
  assert.equal((await store.list<EvalAlert>("alerts"))[0].kind, "incomplete");
}));
test("fidelity requires comparable configuration and does not equate missing metadata", () => {
  const sim = run("2026-09-13"), real = run("2026-09-12", { id: "real", mode: "recorded" });
  assert.deepEqual(fidelityPairs([sim, real])[0].recordedIds, ["real"]);
  assert.deepEqual(fidelityPairs([sim, { ...real, promptVersion: undefined }])[0].recordedIds, []);
});
