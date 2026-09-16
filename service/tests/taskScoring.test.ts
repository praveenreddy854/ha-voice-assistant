import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import express from "express";
import { computeTaskScore, SCORING_VERSION } from "../src/evals/scoring";
import { GRADER_VERSION, JUDGE_PROMPT, makeJudge, RECORDED_JUDGE_PROMPT, validateGrade } from "../src/evals/judge";
import { fidelityPairs } from "../src/evals/analytics";
import { EvalStore } from "../src/evals/store";
import { EvalRunner } from "../src/evals/runner";
import { recordedHistories, sessionEvaluations } from "../src/evals/history";
import { assessmentFromRecord, RECORDED_IMPORT_VERSION } from "../src/evals/recorded";
import { calibrateJudge, calibrationReferenceAssessments } from "../src/evals/references";
import { createEvalRouter } from "../src/evals/api";
import { EvalSupervisor } from "../src/evals/supervisor";
import type { Assessment, EvalRun, Grade, MistakeSeverity, RecordedSessionEvaluation, RecordedSessionHistory, RecordedSessionsResponse, TaskProgressLevel, TaskScoringAssessment, Verdict } from "../src/evals/types";

const fact = (verdict: Verdict) => ({ verdict, reason: "Retained observation", evidenceIds: ["e1"] });
function assessment(): Assessment {
  return { agentId: "tv", mode: "recorded", request: "Play latest Telugu songs on Apple TV", finalResponse: "Done",
    startedAt: "2026-09-15T12:00:00Z", coverage: "partial", sourceSessionId: "recorded-task",
    evidence: Array.from({ length: 24 }, (_, i) => ({ id: `e${i + 1}`, kind: "context", text: `Retained fact ${i + 1}` })) };
}
function scoring(level: TaskProgressLevel | "unknown" = "complete", severities: MistakeSeverity[] = []): TaskScoringAssessment {
  const sufficient = { sufficient: true, reason: "Relevant observations and actions retained", evidenceIds: ["e1"] };
  return { progress: { level, reason: "Progress supported by observations", evidenceIds: ["e1"] },
    mistakes: severities.map((severity, i) => ({ id: `episode-${i}`, severity, reason: "Distinct avoidable action", evidenceIds: [`e${i + 2}`] })),
    evidence: { progress: { ...sufficient }, execution: { ...sufficient }, reporting: { ...sufficient } } };
}
function grade(level: TaskProgressLevel | "unknown" = "complete", severities: MistakeSeverity[] = [], reporting: Verdict = "pass"): Grade {
  return { task: fact(level === "complete" ? "pass" : level === "unknown" ? "unknown" : "fail"),
    handling: fact("pass"), reporting: fact(reporting), recovery: fact("not_applicable"),
    steps: [], gaps: [], context: { task: "latest Telugu songs", target: "Apple TV", app: "YouTube", startingState: "home" },
    scoringAssessment: scoring(level, severities) };
}

test("fixed progress values are outcome-first, including an already-satisfied request", () => {
  for (const [level, expected] of [["none", 0], ["prerequisites", 15], ["partial", 30], ["nearly_complete", 45], ["complete", 100]] as const) {
    const result = validateGrade(grade(level), assessment());
    assert.equal(result.score?.status, "scored");
    assert.equal(result.score?.value, expected);
    assert.equal(result.score?.rubricVersion, SCORING_VERSION);
  }
  const already = grade();
  already.steps = [{ ...fact("pass"), objective: "app_ready", startingState: "YouTube ready", alreadySatisfied: true }];
  assert.equal(validateGrade(already, { ...assessment(), request: "Open YouTube" }).score?.value, 100);
});

test("deductions, fulfillment floor and reporting cap follow the exact agreed arithmetic", () => {
  const cases: Array<[TaskProgressLevel, MistakeSeverity[], Verdict, number]> = [
    ["complete", ["minor"], "pass", 95], ["complete", ["moderate"], "pass", 85],
    ["complete", ["major"], "pass", 70], ["complete", ["major", "major"], "pass", 50],
    ["complete", ["major", "major", "major"], "fail", 20], ["nearly_complete", [], "fail", 20],
    ["nearly_complete", ["major"], "fail", 15], ["prerequisites", ["major"], "pass", 0],
    ["none", [], "pass", 0], ["partial", ["minor", "moderate"], "pass", 10],
  ];
  for (const [level, severities, reporting, expected] of cases) {
    const output = validateGrade(grade(level, severities, reporting), assessment());
    assert.equal(output.score?.value, expected, JSON.stringify([level, severities, reporting]));
    assert.equal(output.handling.verdict, reporting === "fail" ? "fail" : "pass");
    assert.equal(output.task.verdict, level === "complete" ? "pass" : "fail");
    assert.equal(output.score?.status, "scored");
    if (output.score?.status === "scored") {
      assert.equal(output.score.deductions.length, severities.length);
      assert.equal(output.score.reportingCeiling, reporting === "fail" ? 20 : undefined);
      assert.deepEqual(output.score.band, level === "complete" ? { min: 50, max: 100 } : { min: 0, max: 49 });
    }
  }
});

test("justified recovery, duration, cost, and partial coverage do not inherently deduct", () => {
  const recovered = grade();
  recovered.recovery = fact("pass");
  const input = { ...assessment(), durationMs: 9_000_000, usage: { totalTokens: 999_999 } };
  assert.equal(validateGrade(recovered, input).score?.value, 100);
  assert.equal(validateGrade(grade("none"), input).score?.value, 0);
  assert.equal(validateGrade(grade("none"), input).handling.verdict, "pass");
});

test("missing required evidence leaves a known successful task unscored, not 100 or zero", () => {
  const input = grade();
  input.scoringAssessment!.evidence.execution = { sufficient: false, reason: "Intermediate execution trace missing", evidenceIds: ["e1"] };
  const output = validateGrade(input, assessment());
  assert.equal(output.task.verdict, "pass");
  assert.deepEqual(output.score, { status: "unscored", rubricVersion: SCORING_VERSION, value: null,
    blockingComponents: ["execution"], reason: "execution: Intermediate execution trace missing" });
});

test("unknown outcome and reporting preserve explicit gaps and categorical judgments", () => {
  const input = grade("unknown", [], "unknown");
  input.scoringAssessment!.evidence.progress = { sufficient: false, reason: "Final state missing", evidenceIds: [] };
  input.scoringAssessment!.evidence.reporting = { sufficient: false, reason: "Claim support unknown", evidenceIds: [] };
  const output = validateGrade(input, assessment());
  assert.equal(output.score?.status, "unscored");
  assert.equal(output.score?.value, null);
  assert.equal(output.task.verdict, "unknown");
  assert.equal(output.reporting.verdict, "unknown");
});

test("invalid scoring inputs are errors rather than success-shaped fallback scores", () => {
  const input = assessment();
  const missing = grade(); delete missing.scoringAssessment;
  assert.throws(() => validateGrade(missing, input));
  assert.throws(() => validateGrade({ ...grade(), score: 100 }, input));
  assert.throws(() => validateGrade({ ...grade(), scoringAssessment: { ...scoring(), mistakes: [{ id: "bad", severity: "catastrophic", reason: "x", evidenceIds: ["e1"] }] } }, input));
  const invented = grade(); invented.scoringAssessment!.progress.evidenceIds = ["invented"];
  assert.throws(() => validateGrade(invented, input), /nonexistent/);
  const uncited = grade(); uncited.scoringAssessment!.evidence.execution.evidenceIds = [];
  assert.throws(() => validateGrade(uncited, input), /requires references/);
  const inconsistent = grade(); inconsistent.scoringAssessment!.progress.level = "partial";
  assert.throws(() => validateGrade(inconsistent, input), /contradicts/);
  const unknown = grade("unknown");
  assert.throws(() => validateGrade(unknown, input), /unknown progress/);
  const reportingUnknown = grade("complete", [], "unknown");
  assert.throws(() => validateGrade(reportingUnknown, input), /unknown reporting/);
});

test("duplicated episodes and copies of the same source cannot be charged twice", () => {
  const sameId = grade("complete", ["minor", "moderate"]);
  sameId.scoringAssessment!.mistakes[1].id = sameId.scoringAssessment!.mistakes[0].id;
  assert.throws(() => validateGrade(sameId, assessment()), /Duplicate mistake episode/);
  const sameReferences = grade("complete", ["moderate", "moderate"]);
  sameReferences.scoringAssessment!.mistakes[1].evidenceIds = ["e2"];
  const singleAction = assessment(); singleAction.evidence[1].kind = "tool";
  assert.throws(() => validateGrade(sameReferences, singleAction), /Duplicate mistake episode/);
  const input = assessment();
  input.evidence[1].kind = "tool"; input.evidence[2].kind = "tool";
  input.evidence[1].source = "telemetry:task:tool:call1";
  input.evidence[2].source = "telemetry:task:tool:call1";
  assert.throws(() => validateGrade(grade("complete", ["minor", "minor"]), input), /Duplicate mistake episode/);
  const sharedContext = grade("complete", ["minor", "minor"]);
  sharedContext.scoringAssessment!.mistakes[1].evidenceIds = ["e2"];
  assert.equal(validateGrade(sharedContext, assessment()).score?.value, 90);
});

test("simulated grading retains its categorical prompt and never gets numeric scoring", async () => {
  const systems: string[] = [];
  const judge = makeJudge(async system => { systems.push(system); return { output: grade() }; });
  const simulated = await judge({ ...assessment(), mode: "simulated" }, [], new AbortController().signal);
  const recorded = await judge(assessment(), [], new AbortController().signal);
  assert.deepEqual(systems, [JUDGE_PROMPT, RECORDED_JUDGE_PROMPT]);
  assert.equal(simulated.grade.score, undefined);
  assert.equal(simulated.grade.scoringAssessment, undefined);
  assert.equal(recorded.grade.score?.value, 100);
  assert.throws(() => computeTaskScore(scoring(), grade(), { ...assessment(), mode: "simulated" }), /only to recorded/);
});

test("non-TV recorded grading remains categorical without requiring scoring inputs", async () => {
  const categorical = grade(); delete categorical.scoringAssessment;
  const prompts: string[] = [];
  const judge = makeJudge(async system => { prompts.push(system); return { output: categorical }; });
  for (const agentId of ["scheduled_task", "realtime"]) {
    const input = { ...assessment(), agentId };
    const result = await judge(input, [], new AbortController().signal);
    assert.equal(result.grade.task.verdict, "pass");
    assert.equal(result.grade.score, undefined);
    assert.equal(result.grade.scoringAssessment, undefined);
    assert.throws(() => computeTaskScore(scoring(), grade(), input), /only to recorded TVAgent/);
  }
  assert.deepEqual(prompts, [JUDGE_PROMPT, JUDGE_PROMPT]);
});

test("the shared grader configuration allows compatible cross-mode comparisons without pooling old grades", () => {
  const common = { batchId: "batch", agentId: "tv", attempt: "on_demand" as const, adapterVersion: "adapter",
    graderVersion: GRADER_VERSION, judgeModel: "judge", assessedModel: "model", promptVersion: "known-prompt",
    assessedAt: assessment().startedAt, gradedAt: assessment().startedAt, status: "completed" as const };
  const simulated: EvalRun = { ...common, id: "simulated", mode: "simulated",
    grade: validateGrade(grade(), { ...assessment(), mode: "simulated" }) };
  const recorded: EvalRun = { ...common, id: "recorded", mode: "recorded", grade: validateGrade(grade(), assessment()) };
  assert.deepEqual(fidelityPairs([simulated, recorded])[0].recordedIds, ["recorded"]);
  assert.deepEqual(fidelityPairs([simulated, { ...recorded, graderVersion: "older-configuration" }])[0].recordedIds, []);
});

test("saved scores, unscored results and failed re-evaluations remain distinct in history", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "task-score-test-"));
  try {
    const store = new EvalStore(directory);
    let raw: Grade = grade("complete", ["moderate"]);
    const runner = new EvalRunner(store, makeJudge(async () => ({ output: raw })), "judge", GRADER_VERSION);
    const runOnce = () => runner.recorded("tv", [{ sessionId: "recorded-task", load: async () => assessment() }], new AbortController().signal);
    const first = await runOnce();
    raw = grade(); raw.scoringAssessment!.evidence.execution.sufficient = false;
    const second = await runOnce();
    raw = grade(); delete raw.scoringAssessment;
    const failed = await runOnce();
    const histories = await recordedHistories(store);
    const state = sessionEvaluations(histories)["recorded-task"];
    assert.equal(state.status, "eval_error");
    assert.equal(state.latestCompleted?.grade?.score?.status, "unscored");
    const scores = (await store.list<import("../src/evals/types").EvalRun>("summaries")).map(run => run.grade?.score?.value);
    assert.ok(scores.includes(85)); assert.ok(scores.includes(null));
    assert.equal(first.status, "completed"); assert.equal(second.status, "completed"); assert.equal(failed.status, "incomplete");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("recorded evidence retains action identity and chronology without inventing tool timestamps", () => {
  const input = assessmentFromRecord({ sessionId: "real", agentType: "tv", userPrompt: "Open YouTube", status: "completed",
    completedAt: "2026-09-15T12:01:00Z", startedAt: "2026-09-15T12:00:00Z", finalMessage: "Done",
    llmSteps: [{ stepNumber: 1, timestamp: "2026-09-15T12:00:10Z", finishReason: "tool_calls", text: "",
      toolCalls: [{ toolCallId: "call1", toolName: "launch_app", args: {}, actionSummary: "Open app" }] }],
    toolResults: [{ toolCallId: "call1", toolName: "launch_app", observation: "App ready", durationMs: 100 }],
    screenshots: [], events: [{ type: "agent.tool.completed", timestamp: "2026-09-15T12:00:11Z", message: "App launch completed" }] });
  assert.equal(JSON.parse(input.evidence.find(e => e.kind === "tool")!.text).toolCallId, "call1");
  assert.equal(input.evidence.find(e => e.kind === "tool")!.timestamp, undefined);
  assert.ok(input.evidence.some(e => e.source === "telemetry:real:event:0" && e.timestamp === "2026-09-15T12:00:11Z"));
  assert.equal(input.evidence.filter(e => e.source === "telemetry:real:event:0").length, 1);
  assert.match(input.evidence.at(-1)!.text, /not a merged chronological timeline/);
  assert.equal(RECORDED_IMPORT_VERSION, "recorded-import-3");
});

test("judge validation checks numeric and semantic reference outputs, including zero and unscored", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "score-reference-test-"));
  try {
    const references = calibrationReferenceAssessments("tv");
    assert.equal(references.length, 15);
    let corruptScore = false, invalidOutput = false;
    const judge = makeJudge(async (_system, input) => {
      const reference = references.find(item => item.assessment.evidence[0].id === input.evidence[0].id)!;
      if (invalidOutput && reference.id === "TVS1") return { output: { invalid: true } };
      const level = reference.expectedProgress || (reference.expected[0] === "pass" ? "complete" : reference.expected[0] === "fail" ? "none" : "unknown");
      const result = grade(level, reference.expectedSeverities || [], reference.expected[2]);
      result.handling.verdict = reference.expected[1] === "not_checked" ? "pass" : reference.expected[1];
      for (const item of [result.task, result.handling, result.reporting, result.recovery, result.scoringAssessment!.progress,
        ...result.scoringAssessment!.mistakes, ...Object.values(result.scoringAssessment!.evidence)]) item.evidenceIds = [input.evidence[0].id];
      if (level === "unknown") result.scoringAssessment!.evidence.progress.sufficient = false;
      if (result.reporting.verdict === "unknown") result.scoringAssessment!.evidence.reporting.sufficient = false;
      for (const component of reference.expectedBlockingComponents || []) result.scoringAssessment!.evidence[component].sufficient = false;
      if (corruptScore && reference.id === "TVS2") {
        result.scoringAssessment!.progress.level = "prerequisites";
      }
      return { output: result };
    });
    const store = new EvalStore(directory), signal = new AbortController().signal;
    const passed = await calibrateJudge(store, judge, "fixture-judge", GRADER_VERSION, signal);
    assert.equal(passed.passed, true);
    assert.equal(passed.results.length, 15);
    assert.equal(passed.scoringVersion, SCORING_VERSION);
    corruptScore = true;
    const failed = await calibrateJudge(store, judge, "fixture-judge", GRADER_VERSION, signal);
    assert.equal(failed.passed, false);
    assert.equal(failed.results.find(item => item.id === "TVS2")?.passed, false);
    invalidOutput = true;
    const invalid = await calibrateJudge(store, judge, "fixture-judge", GRADER_VERSION, signal);
    assert.equal(invalid.results.find(item => item.id === "TVS1")?.expectedScore, 100);
    assert.equal(invalid.results.find(item => item.id === "TVS1")?.passed, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("scores survive every recorded API surface and schedule status is read-only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "score-api-test-"));
  const store = new EvalStore(directory), app = express();
  const sources = ["scored", "unscored", "legacy", "zero"].map(sessionId => ({
    sessionId, agentId: "tv", userPrompt: "Open YouTube", startedAt: "2026-09-15T12:00:00Z",
    completedAt: "2026-09-15T12:01:00Z", status: "completed" as const, sources: ["telemetry" as const],
  }));
  const input = grade(); input.scoringAssessment!.evidence.execution.sufficient = false;
  const legacy = grade(); delete legacy.scoringAssessment;
  const grades = [validateGrade(grade("complete", ["moderate"]), assessment()), validateGrade(input, assessment()),
    legacy, validateGrade(grade("none"), assessment())];
  for (const [index, source] of sources.entries()) await store.saveRun({
    id: source.sessionId, sourceSessionId: source.sessionId, batchId: "batch", agentId: "tv", mode: "recorded", attempt: "on_demand",
    adapterVersion: RECORDED_IMPORT_VERSION, graderVersion: "grader", judgeModel: "judge", status: "completed",
    assessedAt: source.startedAt, gradedAt: source.completedAt, grade: grades[index], assessment: { ...assessment(), sourceSessionId: source.sessionId },
  });
  app.use(createEvalRouter(new EvalSupervisor(store), async () => ({ sessions: sources, warnings: [] })));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    async function read<T>(pathname: string): Promise<T> {
      const response = await fetch(`${baseUrl}${pathname}`);
      assert.equal(response.status, 200);
      return response.json();
    }
    const dashboard = await read<{ runs: EvalRun[]; schedules: { simulated: { hour: number }; recorded: { hour: number; enabledAt?: string } } }>("/api/evals");
    assert.equal(dashboard.runs.find(run => run.id === "scored")?.grade?.score?.value, 85);
    assert.equal(dashboard.runs.find(run => run.id === "zero")?.grade?.score?.value, 0);
    assert.equal(dashboard.runs.find(run => run.id === "legacy")?.grade?.score, undefined);
    assert.equal(dashboard.schedules.simulated.hour, 3);
    assert.equal(dashboard.schedules.recorded.hour, 1);
    assert.equal(dashboard.schedules.recorded.enabledAt, undefined);
    const sessions = await read<RecordedSessionsResponse>("/api/evals/sessions");
    assert.equal(sessions.sessions.find(session => session.sessionId === "unscored")?.evaluation.latestCompleted?.grade?.score?.status, "unscored");
    const statuses = await read<{ statuses: Record<string, RecordedSessionEvaluation> }>("/api/evals/session-statuses");
    assert.equal(statuses.statuses.scored.latestCompleted?.grade?.score?.value, 85);
    const history = await read<RecordedSessionHistory>("/api/evals/sessions/scored/history");
    assert.equal(history.attempts[0].run?.grade?.score?.value, 85);
    const detail = await read<EvalRun>("/api/evals/runs/scored");
    assert.equal(detail.grade?.score?.status, "scored");
    assert.equal(detail.assessment?.sourceSessionId, "scored");
    assert.deepEqual(detail.grade?.score, dashboard.runs.find(run => run.id === "scored")?.grade?.score);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
