import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  agents, evidenceId, evaluation, grade, makeRun, makeSession, openPortal as openDashboard, rubricVersion, scored, unsafeReason,
} from "./evalPortalFixture";

const openPortal = (page: Page, initial: Parameters<typeof openDashboard>[1] = {}) =>
  openDashboard(page, initial, { agentId: "tv", evaluator: "code" });

function scoringRuns() {
  const zeroGrade = grade(scored(0));
  zeroGrade.task = { verdict: "fail", reason: "TV remained unreachable after reasonable recovery", evidenceIds: [evidenceId] };
  zeroGrade.scoringAssessment!.progress = { level: "none", reason: "No useful task progress", evidenceIds: [evidenceId] };
  const partialGrade = grade(scored(45));
  partialGrade.task = { verdict: "fail", reason: "Playback has not started", evidenceIds: [evidenceId] };
  partialGrade.scoringAssessment!.progress = { level: "nearly_complete", reason: "Requested content selected but paused", evidenceIds: [evidenceId] };
  const cappedGrade = grade(scored(20, { baseScore: 45, bandAdjustedScore: 45, reportingCeiling: 20 }));
  cappedGrade.task = partialGrade.task;
  cappedGrade.reporting = { verdict: "fail", reason: unsafeReason, evidenceIds: [evidenceId] };
  cappedGrade.scoringAssessment!.progress = partialGrade.scoringAssessment!.progress;
  const mistake = { id: "avoidably-abandoned", severity: "major" as const, reason: unsafeReason, evidenceIds: [evidenceId] };
  const deductionGrade = grade(scored(15, {
    baseScore: 45, totalDeductions: 30, deductions: [{ ...mistake, points: 30 }], bandAdjustedScore: 15, reportingCeiling: 20,
  }));
  deductionGrade.task = partialGrade.task;
  deductionGrade.reporting = cappedGrade.reporting;
  deductionGrade.scoringAssessment!.progress = partialGrade.scoringAssessment!.progress;
  deductionGrade.scoringAssessment!.mistakes = [mistake];
  const unscoredGrade = grade({
    status: "unscored", rubricVersion, value: null,
    reason: `Execution history missing: ${unsafeReason}`, blockingComponents: ["execution"],
  });
  unscoredGrade.scoringAssessment!.evidence.execution = { sufficient: false, reason: unsafeReason, evidenceIds: [] };
  unscoredGrade.gaps = ["An execution interval is not retained"];
  return [
    makeRun("verified-success"),
    makeRun("honest-zero", { grade: zeroGrade }),
    makeRun("partial-progress", { grade: partialGrade }),
    makeRun("report-capped", { grade: cappedGrade }),
    makeRun("major-deduction", { grade: deductionGrade }),
    makeRun("missing-evidence", { grade: unscoredGrade }),
    makeRun("legacy-evaluation", { grade: grade(undefined, { scoringAssessment: undefined }) }),
    makeRun("simulated-result", { mode: "simulated" }),
    makeRun("grading-error", { status: "grading_error", verdict: "error", error: "Invalid grading result" }),
    makeRun("execution-error", { status: "execution_error", verdict: "error", error: "Evidence import failed" }),
  ];
}

test("recorded scores preserve zero, partial credit, unscored, legacy, and independent verdicts", async ({ page }) => {
  const fixture = await openPortal(page, { runs: scoringRuns() });
  const rows = page.locator("#runs tr");
  const score = (id: string) => rows.filter({ hasText: id }).locator("td").nth(3);
  await expect(score("verified-success")).toHaveText("Task eval score: 100/100");
  await expect(score("honest-zero")).toHaveText("Task eval score: 0/100");
  await expect(rows.filter({ hasText: "honest-zero" }).locator("td").nth(4)).toHaveText("No useful progress");
  await expect(score("partial-progress")).toHaveText("Task eval score: 45/100");
  await expect(score("report-capped")).toHaveText("Task eval score: 20/100");
  await expect(rows.filter({ hasText: "report-capped" }).locator("td").nth(6)).toHaveText("20/100");
  await expect(score("missing-evidence")).toContainText("Unscored — insufficient evidence");
  await expect(score("missing-evidence")).toContainText(unsafeReason);
  await expect(score("legacy-evaluation")).toHaveText("Scoring unavailable for this evaluation");
  await expect(page.locator("#runs")).not.toContainText("simulated-result");
  await expect(score("grading-error")).toContainText("No completed task eval score");
  await expect(score("execution-error")).toContainText("No completed task eval score");
  await expect(page.locator("#runs img")).toHaveCount(0);
  await expect(page.locator("#runs")).not.toContainText("NaN");
  await expect(rows).toHaveCount(9);
  await expect(page.locator("#cards .number").first()).toHaveText("36");
  await page.getByRole("tab", { name: "LLM-based", exact: true }).click();
  const zero = rows.filter({ hasText: "honest-zero" }).locator("td");
  await expect(zero.nth(3)).toHaveText("fail");
  await expect(zero.nth(4)).toHaveText("pass");
  await expect(zero.nth(5)).toHaveText("pass");
  await expect(rows.filter({ hasText: "missing-evidence" }).locator("td").nth(3)).toHaveText("pass");
  await expect(rows.filter({ hasText: "report-capped" }).locator("td").nth(5)).toHaveText("fail");
  await expect(page.locator("#run-columns")).not.toContainText("Task eval score");
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("inspection shows deterministic arithmetic, reporting ceiling, evidence citations, and escaped reasons", async ({ page }) => {
  const fixture = await openPortal(page, { runs: scoringRuns() });
  await page.locator("#runs tr").filter({ hasText: "major-deduction" }).getByRole("button", { name: "Inspect" }).click();
  const breakdown = page.getByRole("region", { name: "Task eval score breakdown" });
  await expect(breakdown).toContainText("Rubric version: recorded-task-v1");
  await expect(breakdown).toContainText("45 − 30 = 15");
  await expect(breakdown).toContainText("Task fulfillment band");
  await expect(breakdown).toContainText("0–49");
  await expect(breakdown).toContainText("After band limits");
  await expect(breakdown).toContainText("20/100 — final score cannot exceed this ceiling");
  await expect(breakdown).toContainText("Final task eval score");
  await expect(breakdown).toContainText("15/100");
  await expect(breakdown).toContainText("avoidably-abandoned · major · −30 points");
  await expect(breakdown).toContainText(unsafeReason);
  await expect(breakdown).toContainText("Nearly complete");
  await expect(breakdown).toContainText("execution: Sufficient");
  await expect(breakdown).toContainText("not a probability or confidence");
  await expect(page.locator("#detail-body img")).toHaveCount(0);
  await page.getByText("Full judgments and scoring data", { exact: true }).click();
  await expect(page.locator("#detail-body pre").filter({ hasText: '"rubricVersion": "recorded-task-v1"' })).toBeVisible();
  const citation = breakdown.getByRole("link", { name: evidenceId }).first();
  await citation.focus();
  await page.keyboard.press("Enter");
  const evidence = page.locator(`#evidence-${evidenceId}`);
  await expect(evidence).toHaveAttribute("open", "");
  await expect(evidence.locator("summary")).toBeFocused();
  await expect(evidence.locator("pre")).toContainText(JSON.stringify(unsafeReason));
  expect(await page.evaluate("window.evidenceExecuted")).toBeUndefined();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Evaluation details" })).not.toBeVisible();

  await page.locator("#runs tr").filter({ hasText: "report-capped" }).getByRole("button", { name: "Inspect" }).click();
  await expect(breakdown).toContainText("45 − 0 = 45");
  await expect(breakdown).toContainText("Final task eval score20/100");
  await expect(breakdown).toContainText("No assessed mistake deductions.");
  expect(fixture.errors).toEqual([]);
});

test("unscored gaps and historical absence remain distinct in inspection on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await openPortal(page, { runs: scoringRuns() });
  const breakdown = page.getByRole("region", { name: "Task eval score breakdown" });
  await page.locator("#runs tr").filter({ hasText: "missing-evidence" }).getByRole("button", { name: "Inspect" }).click();
  await expect(breakdown).toContainText("Unscored — insufficient evidence");
  await expect(breakdown).toContainText("Blocking components: execution");
  await expect(breakdown).toContainText("execution: Blocking gap");
  await expect(breakdown).toContainText("No numeric score was assigned.");
  await expect(breakdown).toContainText("An execution interval is not retained");
  await expect(breakdown.locator(".score-calculation")).toHaveCount(0);
  await expect(breakdown.locator("img")).toHaveCount(0);
  await page.locator("#close").click();

  for (const [id, expected] of [
    ["legacy-evaluation", "Scoring unavailable for this evaluation"],
    ["simulated-result", "N/A — synthetic evaluation"],
    ["grading-error", "No completed task eval score"],
  ]) {
    await page.getByRole("tab", { name: id === "simulated-result" ? "Synthetic" : "Recorded", exact: true }).click();
    await page.locator("#runs tr").filter({ hasText: id }).getByRole("button", { name: "Inspect" }).click();
    await expect(breakdown).toContainText(expected);
    await expect(breakdown).not.toContainText("Unscored");
    await expect(breakdown.locator(".score-calculation")).toHaveCount(0);
    await page.locator("#close").click();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(fixture.errors).toEqual([]);
});

for (const agentId of ["scheduled_task", "realtime"] as const) {
  test(`${agentId} keeps categorical history and reports numeric scoring as not applicable`, async ({ page }) => {
    const completed = makeRun(`${agentId}-completed`, { agentId });
    const state = evaluation(completed, "queued");
    const sessionId = `${agentId}-session`;
    const fixture = await openPortal(page, {
      runs: [
        makeRun("tv-scored"), completed,
        makeRun(`${agentId}-simulation`, { agentId, mode: "simulated" }),
        makeRun(`${agentId}-error`, { agentId, status: "grading_error" }),
      ],
      sessions: [makeSession("tv-session", evaluation(makeRun("tv-scored"))), makeSession(sessionId, state, agentId)],
      statuses: { [sessionId]: state },
      histories: { [sessionId]: { attempts: [
        { ...state.latestAttempt!, sourceSessionId: sessionId },
        {
          id: `${agentId}-previous`, jobId: "previous-job", agentId, sourceSessionId: sessionId,
          status: "evaluated", requestedAt: "2026-09-15T04:00:00Z", finishedAt: completed.gradedAt,
          runId: completed.id, run: completed,
        },
      ] } },
    });
    await page.locator(`#agent-tab-${agentId}`).click();
    const rows = page.locator("#runs tr");
    await expect(rows).toHaveCount(2);
    await expect(page.locator("#runs")).not.toContainText("tv-scored");
    for (const row of await rows.all()) {
      await expect(row.locator("td").nth(3)).toHaveText("Task eval score: N/A for this agent");
    }
    await expect(page.locator("#runs")).not.toContainText("Scoring unavailable");
    await expect(page.locator("#runs")).not.toContainText("Unscored");
    await page.getByRole("tab", { name: "LLM-based", exact: true }).click();
    await expect(rows.first().locator("td").nth(3)).toHaveText("pass");
    await rows.first().getByRole("button", { name: "Inspect" }).click();
    const breakdown = page.getByRole("region", { name: "Task eval score breakdown" });
    await expect(breakdown).toContainText("N/A for this agent");
    await expect(breakdown.locator(".score-calculation")).toHaveCount(0);
    await expect(page.locator("#detail-body")).toContainText(`"agentId": "${agentId}"`);
    await page.locator("#close").click();

    await page.locator("#recorded").click();
    await expect(page.locator("#session-rows tr")).toHaveCount(1);
    await expect(page.locator("#session-rows")).toContainText("Previous evaluation");
    await expect(page.locator("#session-rows")).toContainText("Task eval score: N/A for this agent");
    await page.getByRole("button", { name: `Evaluation history for ${sessionId}`, exact: true }).click();
    const attempts = page.locator("#detail-body section");
    await expect(attempts.first()).toContainText("N/A for this agent. Verdicts are not available yet.");
    await expect(attempts.nth(1)).toContainText("Previous evaluation · Evaluated");
    await expect(attempts.nth(1)).toContainText("N/A for this agent");
    await expect(attempts.nth(1)).toContainText("Task pass");
    await expect(page.locator("#detail-body")).not.toContainText("Scoring unavailable");

    await page.goto(`/dashboards/evals?agentId=${agentId}&sessionId=${sessionId}`);
    await expect(page.locator(`#agent-tab-${agentId}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: "Recorded", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("dialog", { name: "Session evaluation history" })).toBeVisible();
    await expect(attempts.nth(1)).toContainText("Previous evaluation · Evaluated");
    expect(fixture.errors).toEqual([]);
    expect(fixture.unexpectedRequests).toEqual([]);
  });
}

test("selection and history attach previous scores to completed attempts, never to a re-evaluation", async ({ page }) => {
  const runs = scoringRuns();
  const statusList = [
    evaluation(runs[0]), evaluation(runs[1], "queued"), evaluation(runs[5], "eval_error"),
    evaluation(runs[6], "running"),
  ];
  const sessions = statusList.map((status, index) => makeSession(`session-${index}`, status));
  const fixture = await openPortal(page, {
    runs, sessions, statuses: Object.fromEntries(statusList.map((status, index) => [`session-${index}`, status])),
    histories: {
      "session-1": { attempts: [
        { ...statusList[1].latestAttempt!, sourceSessionId: "session-1" },
        {
          id: "previous-zero", jobId: "previous-job", sourceSessionId: "session-1", status: "evaluated",
          requestedAt: "2026-09-15T04:00:00Z", finishedAt: runs[1].gradedAt, runId: runs[1].id, run: runs[1],
        },
      ] },
    },
  });
  await page.getByRole("button", { name: "Select sessions", exact: true }).click();
  const rows = page.locator("#session-rows tr");
  const sessionRow = (id: string) => rows.filter({ has: page.locator(`input[data-select="${id}"]`) });
  await expect(sessionRow("session-0")).toContainText("Task eval score: 100/100");
  await expect(sessionRow("session-0")).not.toContainText("Previous evaluation");
  await expect(sessionRow("session-1")).toContainText("Queued");
  await expect(sessionRow("session-1")).toContainText("Previous evaluation");
  await expect(sessionRow("session-1")).toContainText("Task eval score: 0/100");
  await expect(sessionRow("session-1").getByRole("checkbox")).toBeDisabled();
  await expect(sessionRow("session-2")).toContainText("Eval error");
  await expect(sessionRow("session-2")).toContainText("Re-evaluation interrupted before grading");
  await expect(sessionRow("session-2")).toContainText("Previous evaluation");
  await expect(sessionRow("session-2")).toContainText("Unscored — insufficient evidence");
  await expect(sessionRow("session-3")).toContainText("Running");
  await expect(sessionRow("session-3")).toContainText("Previous evaluation");
  await expect(sessionRow("session-3")).toContainText("Scoring unavailable for this evaluation");
  await sessionRow("session-0").getByRole("checkbox").check();
  await page.getByRole("button", { name: "Review selected", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Task eval score: 100/100");
  await page.getByRole("button", { name: "Back to all sessions", exact: true }).click();
  await page.getByRole("button", { name: "Evaluation history for session-1", exact: true }).click();
  const attempts = page.locator("#detail-body section");
  await expect(attempts).toHaveCount(2);
  await expect(attempts.first()).toContainText("Queued");
  await expect(attempts.first()).toContainText("Verdicts and task eval score are not available yet");
  await expect(attempts.first()).not.toContainText("0/100");
  await expect(attempts.nth(1)).toContainText("Previous evaluation · Evaluated");
  await expect(attempts.nth(1)).toContainText("Task eval score: 0/100");
  await attempts.nth(1).getByRole("button", { name: "Inspect" }).click();
  await expect(page.getByRole("region", { name: "Task eval score breakdown" })).toContainText("No useful progress");
  await page.getByRole("button", { name: "Back to session attempt history" }).click();
  await expect(attempts.nth(1)).toContainText("Task eval score: 0/100");
  await page.locator("#close").click();
  await expect(page.getByRole("dialog", { name: "Select recorded TVAgent sessions" })).toBeVisible();

  fixture.state.statusesError = "Attempt history store unavailable";
  await page.getByRole("button", { name: "Refresh sessions", exact: true }).click();
  await expect(page.locator("#session-state-error")).toContainText("Attempt history store unavailable");
  await expect(sessionRow("session-0")).toContainText("Previous evaluation (last loaded)");
  await expect(sessionRow("session-0")).toContainText("Task eval score: 100/100");
  await expect(page.locator("#session-run")).toBeDisabled();
  expect(fixture.errors).toEqual([]);
});

test("telemetry keeps score summaries and previous labels while unavailable status remains an error", async ({ page }) => {
  await page.clock.install();
  const runs = scoringRuns();
  const statuses = {
    success: evaluation(runs[0]), zero: evaluation(runs[1]), missing: evaluation(runs[5]),
    legacy: evaluation(runs[6]), queued: evaluation(runs[1], "queued"),
    running: evaluation(runs[0], "running"), failed: evaluation(runs[0], "eval_error"),
    scheduled: evaluation(makeRun("scheduled-result", { agentId: "scheduled_task" })),
    voice: evaluation(makeRun("voice-result", { agentId: "realtime" }), "queued"),
  };
  let unavailable = false;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const browserScript = await readFile(path.resolve("../service/dist/evals/telemetryBrowser.js"), "utf8");
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/telemetry") {
      await route.fulfill({ contentType: "text/html", body: `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>${Object.entries(statuses).map(([id, status]) => `<div data-eval-session-id="${id}" data-agent-type="${status.latestCompleted!.agentId}"></div>`).join("")}<div data-eval-session-id="other" data-agent-type="other"></div><script src="/eval-status.js"></script></body></html>` });
    } else if (url.pathname === "/eval-status.js") {
      await route.fulfill({ contentType: "application/javascript", body: browserScript });
    } else if (url.pathname === "/api/evals/session-statuses") {
      await route.fulfill(unavailable ? { status: 503, body: "Status store unavailable" } : { json: { statuses, agents: agents.map(agent => agent.id), busy: false } });
    } else await route.fulfill({ status: 404, body: "Unexpected fixture request" });
  });
  await page.goto("/telemetry");
  const row = (id: string) => page.locator(`[data-eval-session-id="${id}"]`);
  await expect(row("success")).toContainText("Evaluation: task eval score: 100/100");
  await expect(row("zero")).toContainText("task eval score: 0/100; task fail; handling pass; reporting pass");
  await expect(row("missing")).toContainText("Unscored — insufficient evidence");
  await expect(row("missing")).toContainText(unsafeReason);
  await expect(row("missing").locator("img")).toHaveCount(0);
  await expect(row("legacy")).toContainText("Scoring unavailable for this evaluation");
  await expect(row("scheduled")).toContainText("Evaluation: task eval score: N/A for this agent; task pass");
  await expect(row("voice")).toContainText("Previous evaluation: task eval score: N/A for this agent; task pass");
  await expect(row("voice")).not.toContainText("Scoring unavailable");
  await expect(row("voice").getByRole("link")).toHaveAttribute("href", "/dashboards/evals?agentId=realtime&sessionId=voice");
  for (const id of ["queued", "running", "failed"]) await expect(row(id)).toContainText("Previous evaluation:");
  await expect(row("failed").getByRole("link")).toHaveAttribute("title", /Re-evaluation interrupted before grading/);
  await expect(row("other")).toBeHidden();
  unavailable = true;
  await page.clock.fastForward(5_000);
  await expect(row("success").getByRole("link")).toHaveText("Eval: status unavailable");
  await expect(row("success")).toContainText("Previous evaluation: task eval score: 100/100");
  await expect(row("success")).toContainText("(last loaded)");
  await expect(row("success").getByRole("link")).toHaveAttribute("title", /HTTP 503.*This does not mean/s);
  await expect(row("success").getByRole("button", { name: "Retry eval status" })).toBeVisible();
  unavailable = false;
  await row("success").getByRole("button", { name: "Retry eval status" }).click();
  await expect(row("success").getByRole("link")).toHaveText("Eval: Evaluated");
  await expect(row("success")).not.toContainText("Previous evaluation");
  expect(errors).toEqual([]);
});

test("calibration distinguishes score and progress mismatches from matching categorical verdicts", async ({ page }) => {
  const expected = ["fail", "pass", "pass"];
  const fixture = await openPortal(page, { calibrations: [{
    id: "numeric-calibration", judgeModel: "fixture-judge", createdAt: "2026-09-15T07:00:00Z", passed: false,
    results: [
      {
        id: "zero-reference", passed: true, expected: ["fail", "not_checked", "pass"], actual: expected,
        expectedScore: 0, actualScore: 0, expectedProgress: "none", actualProgress: "none",
        expectedSeverities: [], actualSeverities: [], expectedBlockingComponents: [], actualBlockingComponents: [],
      },
      {
        id: "progress-mismatch", passed: false, expected, actual: expected,
        expectedScore: 45, actualScore: 30, expectedProgress: "nearly_complete", actualProgress: "partial",
        expectedSeverities: [], actualSeverities: ["moderate"],
      },
      {
        id: "unscored-reference", passed: true, expected, actual: expected,
        expectedScore: null, actualScore: null, expectedBlockingComponents: ["execution"], actualBlockingComponents: ["execution"],
      },
      { id: "grading-failure", passed: false, expected, expectedScore: 100, expectedProgress: "complete", error: unsafeReason },
      { id: "legacy-categorical", passed: true, expected, actual: expected },
    ],
  }] });
  await page.getByRole("tab", { name: "LLM-based", exact: true }).click();
  await page.locator("#calibrations summary").click();
  const result = (id: string) => page.locator("#calibrations p").filter({ hasText: id });
  await expect(result("zero-reference")).toContainText("Task eval score: expected 0/100; actual 0/100");
  await expect(result("zero-reference")).toContainText("expected fail / Not checked / pass");
  await expect(result("zero-reference")).toContainText("Not checked means this reference does not assert that categorical judgment.");
  await expect(result("zero-reference").locator(".badge")).toHaveText("pass");
  await expect(result("zero-reference")).toContainText("Mistake severities: expected None; actual None");
  await expect(result("progress-mismatch")).toContainText("Task eval score: expected 45/100; actual 30/100");
  await expect(result("progress-mismatch")).toContainText("Progress: expected nearly complete; actual partial");
  await expect(result("progress-mismatch")).toContainText("Mistake severities: expected None; actual moderate");
  await expect(result("progress-mismatch").locator(".badge")).toHaveText("fail");
  await expect(result("unscored-reference")).toContainText("expected Unscored — insufficient evidence; actual Unscored — insufficient evidence");
  await expect(result("unscored-reference")).toContainText("Blocking components: expected execution; actual execution");
  await expect(result("grading-failure")).toContainText("Task eval score: expected 100/100; actual Unavailable");
  await expect(result("grading-failure")).toContainText(unsafeReason);
  await expect(result("grading-failure").locator("img")).toHaveCount(0);
  await expect(result("legacy-categorical")).not.toContainText("Task eval score");
  expect(fixture.errors).toEqual([]);
});

test("agent-specific calibration retains categorical limitations without inheriting TV scoring", async ({ page }) => {
  const catalog = agents.map((agent, index) => ({ ...agent, scenarioCount: 12 + index, referenceCount: 6 + index }));
  const fixture = await openPortal(page, {
    agents: catalog,
    calibrations: [
      {
        id: "legacy-tv-calibration", judgeModel: "tv-judge", createdAt: "2026-09-15T07:00:00Z", passed: true,
        results: [{ id: "tv-score-reference", passed: true, expected: ["pass", "pass", "pass"], actual: ["pass", "pass", "pass"], expectedScore: 100, actualScore: 100 }],
      },
      ...catalog.filter(agent => agent.id !== "tv").map(agent => ({
        id: `${agent.id}-calibration`, agentId: agent.id, judgeModel: `${agent.id}-judge`,
        createdAt: "2026-09-15T07:00:00Z", passed: true, limitation: `Starter reference limitation: ${unsafeReason}`,
        results: [{ id: `${agent.id}-reference`, passed: true, expected: ["fail", "pass", "pass"], actual: ["fail", "pass", "pass"] }],
      })),
    ],
  });
  await page.getByRole("tab", { name: "LLM-based", exact: true }).click();
  await expect(page.locator("#calibrations")).toContainText("tv-judge");
  await page.locator("#calibrations summary").click();
  await expect(page.locator("#calibrations")).toContainText("Task eval score: expected 100/100; actual 100/100");
  for (const agent of catalog.filter(agent => agent.id !== "tv")) {
    await page.locator(`#agent-tab-${agent.id}`).click();
    await expect(page.locator("#calibrations summary")).toContainText(`${agent.id}-judge`);
    await expect(page.locator("#calibrations summary")).toHaveCount(1);
    await page.locator("#calibrations summary").click();
    await expect(page.locator("#calibrations")).toContainText("expected fail / pass / pass; actual fail / pass / pass");
    await expect(page.locator("#calibrations")).toContainText("Task eval score: N/A for this agent");
    await expect(page.locator("#calibrations")).toContainText(`Starter reference limitation: ${unsafeReason}`);
    await expect(page.locator("#calibrations")).not.toContainText("100/100");
    await expect(page.locator("#calibrations img")).toHaveCount(0);
    await expect(page.locator("#suite-description")).toContainText(`${agent.scenarioCount} ${agent.name} scenarios`);
    await expect(page.locator("#judge-description")).toContainText(`${agent.referenceCount} starter reference cases`);
    await expect(page.locator("#judge-description")).toContainText("numeric task eval scoring is not applicable");
  }
  expect(await page.evaluate("window.evidenceExecuted")).toBeUndefined();
  expect(fixture.errors).toEqual([]);
});
