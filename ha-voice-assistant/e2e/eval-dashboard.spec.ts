import { expect, test, type Page } from "@playwright/test";
import { SCORING_RUBRIC, SCORING_VERSION } from "../../service/src/evals/scoring";
import type { Verdict } from "../../service/src/evals/types";
import { evidenceId, grade, makeRun, openPortal, rubricVersion, scored } from "./evalPortalFixture";

const judgment = (verdict: Verdict) => ({ verdict, reason: "Retained evidence supports this judgment", evidenceIds: [evidenceId] });
const card = (page: Page, agentId: string) => page.locator(`[data-agent-card="${agentId}"]`);
const metric = (page: Page, label: string) => page.locator("#cards .card").filter({ has: page.getByText(label, { exact: true }) });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`borderless tab groups retain their content and clear selection at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixture = await openPortal(page, { runs: [
      makeRun("recorded"), makeRun("synthetic", { mode: "simulated", taskAssertion: true }),
    ] });
    await expect(page.locator("#source-container > #source-panel > #method-container > #evaluator-panel > #agent-container > #agent-panel")).toBeVisible();
    for (const agent of await page.locator(".agent-card").all()) {
      await expect(agent).toHaveCSS("border-top-width", "0px");
      await expect(agent).toHaveCSS("border-left-width", "0px");
    }
    for (const source of ["Recorded", "Synthetic"]) {
      await page.getByRole("tab", { name: source, exact: true }).click();
      for (const method of ["Code-based", "LLM-based"]) {
        await page.getByRole("tab", { name: method, exact: true }).click();
        for (const agent of ["Overview", "TVAgent"]) {
          await page.getByRole("tab", { name: agent, exact: true }).click();
          const containers = await page.evaluate(() => [
            ["source-container", "source-tabs", "source-panel"],
            ["method-container", "evaluator-tabs", "evaluator-panel"],
            ["agent-container", "agent-tabs", "agent-panel"],
          ].map(([containerId, ...children]) => {
            const container = document.getElementById(containerId)!;
            const bounds = container.getBoundingClientRect();
            const style = getComputedStyle(container);
            return {
              id: containerId,
              borderless: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].every(width => parseFloat(width) === 0),
              contained: children.every(id => {
                const child = document.getElementById(id)!;
                const rect = child.getBoundingClientRect();
                return container.contains(child) && rect.left >= bounds.left && rect.right <= bounds.right
                  && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
              }),
            };
          }));
          expect(containers).toEqual([
            { id: "source-container", borderless: true, contained: true },
            { id: "method-container", borderless: true, contained: true },
            { id: "agent-container", borderless: true, contained: true },
          ]);
          await expect(page.getByRole("tab", { name: source, exact: true })).toHaveAttribute("aria-selected", "true");
          await expect(page.getByRole("tab", { name: method, exact: true })).toHaveAttribute("aria-selected", "true");
          await expect(page.getByRole("tab", { name: agent, exact: true })).toHaveAttribute("aria-selected", "true");
          await expect(page.locator("#source-container #scoring-guide")).toHaveCount(1);
          await expect(page.locator("#source-container #schedules")).toBeVisible();
          await expect(page.locator("#source-container #window")).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        }
      }
    }
    expect(fixture.errors).toEqual([]);
    expect(fixture.submissions).toEqual([]);
  });
}

test("overview compares agents using explicit denominators, not blended outcomes or missing-data passes", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await openPortal(page, { runs: [
    makeRun("tv-success"),
    makeRun("tv-honest-failure", { grade: grade(scored(0), { task: judgment("fail") }) }),
    makeRun("tv-unknown", { grade: grade(undefined, { task: judgment("unknown"), handling: judgment("unknown"), reporting: judgment("unknown") }) }),
    makeRun("tv-not-applicable", { grade: grade(undefined, { task: judgment("not_applicable"), handling: judgment("not_applicable"), reporting: judgment("not_applicable") }) }),
    makeRun("tv-grading-error", { status: "grading_error" }),
    makeRun("scheduled-success", { agentId: "scheduled_task" }),
    makeRun("voice-failure", { agentId: "realtime", grade: grade(undefined, { task: judgment("fail") }) }),
    makeRun("synthetic-success", { mode: "simulated", taskAssertion: true }),
  ] });
  await expect(card(page, "tv").locator(".number")).toHaveText("50%");
  await expect(card(page, "tv")).toContainText("1 passed / 2 known · 3 excluded");
  await expect(card(page, "tv")).toContainText("1 eval error");
  await expect(card(page, "scheduled_task").locator(".number")).toHaveText("100%");
  await expect(card(page, "realtime").locator(".number")).toHaveText("0%");
  for (const value of await page.locator("#agent-cards .number").all()) {
    expect(await value.evaluate(element => element.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  }
  await expect(page.locator("#sample-note")).toContainText("7 retained recorded attempts");
  await card(page, "tv").getByRole("button", { name: "View agent results" }).click();
  await expect(page.getByRole("tab", { name: "TVAgent", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(metric(page, "Task fulfillment").locator(".number")).toHaveText("50%");
  await expect(metric(page, "Handling pass rate")).toContainText("2 passed / 2 known · 3 excluded");
  await expect(metric(page, "Reporting pass rate").locator(".number")).toHaveText("100%");
  await expect(metric(page, "Eval errors").locator(".number")).toHaveText("1");
  await expect(page.locator("#runs tr")).toHaveCount(5);
  await expect(page.locator("#runs")).not.toContainText("synthetic-success");
  await page.getByRole("link", { name: "How scoring works", exact: true }).click();
  await expect(page.locator("#scoring-guide")).toHaveAttribute("open", "");
  await expect(page.locator("#llm-rules")).toContainText("passes / (passes + failures)");
  expect(fixture.submissions).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("recorded code dashboards include zero, exclude unscored and legacy results, and label unsupported agents", async ({ page }) => {
  const fixture = await openPortal(page, { runs: [
    makeRun("full-credit"), makeRun("zero-credit", { grade: grade(scored(0), { task: judgment("fail") }) }),
    makeRun("unscored", { grade: grade({ status: "unscored", rubricVersion, value: null, reason: "Execution evidence missing", blockingComponents: ["execution"] }) }),
    makeRun("legacy", { grade: grade() }), makeRun("error", { status: "grading_error" }),
    makeRun("non-tv", { agentId: "scheduled_task" }), makeRun("synthetic", { mode: "simulated" }),
    makeRun("non-tv-error", { agentId: "realtime", status: "grading_error" }),
  ] }, { evaluator: "code" });
  await expect(card(page, "tv").locator(".number")).toHaveText("50");
  await expect(card(page, "tv")).toContainText("2 scored · 1 unscored · 2 unavailable / unfinished");
  await expect(card(page, "scheduled_task")).toContainText("Not applicable");
  await expect(card(page, "realtime").locator(".health")).toHaveText("Not applicable");
  await expect(card(page, "realtime").locator(".health")).not.toHaveClass(/fail/);
  await expect(page.locator("#method-explanation")).toContainText("An LLM assesses progress, mistakes and evidence");
  await page.getByRole("link", { name: "How scoring works", exact: true }).click();
  const rules = page.locator("#recorded-code-rules");
  await expect(rules).toBeVisible();
  await expect(rules).toContainText(SCORING_VERSION);
  await expect(rules.locator("tbody tr td:last-child")).toHaveText(Object.values(SCORING_RUBRIC.progress).map(String));
  await expect(rules).toContainText("Subtract 5 / 15 / 30 points");
  await expect(rules).toContainText("cap at 20 if reporting fails");
  await card(page, "scheduled_task").getByRole("button", { name: "View LLM-based results" }).click();
  await expect(page.getByRole("tab", { name: "LLM-based", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "ScheduledTaskAgent", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "Recorded", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#runs")).toContainText("non-tv");
  await expect(page.locator("#run-columns")).not.toContainText("Task eval score");
  expect(fixture.submissions).toEqual([]);
  expect(fixture.errors).toEqual([]);
});

test("known task success does not hide unknown handling or reporting evidence", async ({ page }) => {
  const fixture = await openPortal(page, { runs: [
    makeRun("success-missing-report", { grade: grade(undefined, { reporting: judgment("unknown") }) }),
    makeRun("not-applicable", { agentId: "realtime", grade: grade(undefined, { task: judgment("not_applicable") }) }),
  ] });
  await expect(card(page, "tv").locator(".number")).toHaveText("100%");
  await expect(card(page, "tv")).toContainText("Incomplete evidence");
  await expect(card(page, "tv")).not.toContainText("Known checks pass");
  await expect(card(page, "realtime")).toContainText("No applicable judgments");
  expect(fixture.errors).toEqual([]);
});

test("synthetic code results use saved assertions even when the LLM disagrees or grading fails", async ({ page }) => {
  const fixture = await openPortal(page, { runs: [
    makeRun("code-pass", { mode: "simulated", taskAssertion: true }),
    makeRun("code-fail", { mode: "simulated", taskAssertion: false }),
    makeRun("legacy-llm-pass", { mode: "simulated" }),
    makeRun("judge-error-code-pass", { mode: "simulated", taskAssertion: true, status: "grading_error" }),
    makeRun("recorded", { grade: grade(scored(0)) }),
    makeRun("scheduled-code-fail", { agentId: "scheduled_task", mode: "simulated", taskAssertion: false }),
  ] }, { mode: "simulated", evaluator: "code" });
  await expect(card(page, "tv").locator(".number")).toHaveText("67%");
  await expect(card(page, "tv")).toContainText("2 passed / 3 known · 1 excluded");
  await expect(card(page, "scheduled_task").locator(".number")).toHaveText("0%");
  await expect(card(page, "realtime").locator(".number")).toHaveText("—");
  await card(page, "tv").getByRole("button", { name: "View agent results" }).click();
  await expect(metric(page, "Assertions passed").locator(".number")).toHaveText("2");
  await expect(metric(page, "Assertions failed").locator(".number")).toHaveText("1");
  await expect(metric(page, "Assertion unavailable").locator(".number")).toHaveText("1");
  await expect(page.locator('[data-run-id="code-fail"] td').nth(3)).toHaveText("fail");
  await expect(page.locator('[data-run-id="legacy-llm-pass"] td').nth(3)).toContainText("Assertion unavailable");
  const failedJudge = page.locator('[data-run-id="judge-error-code-pass"]');
  await expect(failedJudge.locator("td").nth(3)).toHaveText("pass");
  await expect(failedJudge).toContainText("Grading failed; any saved code result is retained");
  await failedJudge.getByRole("button", { name: "Inspect" }).click();
  await expect(page.getByRole("region", { name: "Independent code assertion" })).toContainText("pass");
  await expect(page.getByRole("region", { name: "LLM-based judgments" })).toContainText("No completed LLM judgments");
  await page.locator("#close").click();
  await page.getByRole("tab", { name: "LLM-based", exact: true }).click();
  await expect(page.locator("#run-columns")).not.toContainText("Independent assertion");
  await expect(metric(page, "Handling pass rate").locator(".number")).toHaveText("100%");
  await expect(page.locator("#runs")).not.toContainText("recorded");
  expect(fixture.errors).toEqual([]);
});

test("empty and unavailable dashboards never invent a passing rate or a zero score", async ({ page }) => {
  const fixture = await openPortal(page, { dashboardError: "Summary store unavailable" });
  await expect(page.locator("#status")).toContainText("No evaluation data loaded");
  await expect(page.locator("#cards .number")).toHaveCount(0);
  fixture.state.dashboardError = undefined;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#status")).toBeEmpty();
  for (const agentId of ["tv", "scheduled_task", "realtime"]) {
    await expect(card(page, agentId)).toContainText("No evaluations");
    await expect(card(page, agentId).locator(".number")).toHaveText("—");
  }
  fixture.state.runs = [makeRun("available-result")];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(card(page, "tv").locator(".number")).toHaveText("100%");
  fixture.state.dashboardError = "Summary store temporarily unavailable";
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Showing the last loaded results");
  await expect(card(page, "tv").locator(".number")).toHaveText("100%");
  fixture.state.dashboardError = undefined;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#status")).toBeEmpty();
  expect(fixture.errors).toEqual([]);
});

test("batches, schedules, alerts and advanced comparisons stay in the applicable source and method", async ({ page }) => {
  const fixture = await openPortal(page, {
    runs: [makeRun("recorded"), makeRun("simulated", { mode: "simulated" })],
    batches: [
      { id: "recorded-batch", agentId: "tv", mode: "recorded", attempt: "on_demand", startedAt: "2026-09-15T12:00:00Z", status: "completed", runIds: ["recorded"] },
      { id: "synthetic-batch", agentId: "tv", mode: "simulated", attempt: "scheduled", startedAt: "2026-09-15T12:00:00Z", status: "completed", runIds: ["simulated"] },
      { id: "voice-batch", agentId: "realtime", mode: "recorded", attempt: "on_demand", startedAt: "2026-09-15T12:00:00Z", status: "completed", runIds: [] },
    ],
    alerts: [
      { id: "r", agentId: "tv", key: "tv:r", batchId: "recorded-batch", createdAt: "2026-09-15T12:00:00Z", kind: "incomplete", message: "Recorded batch warning", runIds: ["recorded"] },
      { id: "s", agentId: "tv", key: "tv:s", batchId: "synthetic-batch", createdAt: "2026-09-15T12:00:00Z", kind: "failure", message: "Synthetic regression", runIds: ["simulated"] },
      { id: "j", agentId: "tv", key: "tv:j", batchId: "judge-job", createdAt: "2026-09-15T12:00:00Z", kind: "incomplete", message: "Judge validation worker stopped", runIds: [] },
    ],
    jobs: [{ id: "judge-job", agentId: "tv", mode: "calibrate", status: "failed" }],
    fidelity: [{ simulatedId: "simulated", recordedIds: ["recorded"], status: "comparable" }],
  }, { agentId: "tv" });
  await page.locator("#batch-section > summary").click();
  await expect(page.locator("#batches")).toContainText("recorded · On demand");
  await expect(page.locator("#batches p")).toHaveCount(1);
  await expect(page.locator("#alerts")).toContainText("Recorded batch warning");
  await expect(page.locator("#alerts")).not.toContainText("Synthetic regression");
  await expect(page.locator("#alerts")).toContainText("Judge validation alerts · Shared across sources");
  await expect(page.locator("#alerts")).toContainText("Judge validation worker stopped");
  await expect(page.locator("#fidelity-section")).toBeHidden();
  await page.getByRole("tab", { name: "Synthetic", exact: true }).click();
  await expect(page.locator("#batches")).toContainText("synthetic · Scheduled");
  await expect(page.locator("#batches")).not.toContainText("recorded");
  await expect(page.locator("#alerts")).toContainText("Synthetic regression");
  await expect(page.locator("#alerts")).not.toContainText("Recorded batch warning");
  await expect(page.locator("#alerts")).toContainText("Judge validation worker stopped");
  await expect(page.locator("#fidelity-section")).toBeVisible();
  await page.locator("#fidelity-section > summary").click();
  await page.getByRole("button", { name: "Compare steps" }).click();
  await expect(page.getByRole("dialog", { name: "Synthetic and recorded comparison" })).toBeVisible();
  await page.locator("#close").click();
  await page.getByRole("tab", { name: "Code-based", exact: true }).click();
  await expect(page.locator("#fidelity-section")).toBeHidden();
  await expect(page.locator("#alerts-section")).toBeHidden();
  await expect(page.locator("#judge-section")).toBeHidden();
  expect(fixture.errors).toEqual([]);
});

test("polling preserves focused drilldowns and expanded scoring and judge explanations", async ({ page }) => {
  await page.clock.install();
  const fixture = await openPortal(page, {
    runs: [makeRun("first")],
    calibrations: [{ id: "calibration", judgeModel: "judge", createdAt: "2026-09-15T12:00:00Z", passed: true, results: [] }],
  });
  const openAgent = card(page, "tv").getByRole("button", { name: "View agent results" });
  await openAgent.focus();
  fixture.state.runs.push(makeRun("second"));
  await page.clock.fastForward(5_000);
  await expect(card(page, "tv")).toContainText("2 passed / 2 known");
  await expect(openAgent).toBeFocused();
  await openAgent.click();
  await expect(page.locator("#agent-panel")).toHaveAttribute("aria-busy", "false");
  const inspect = page.locator('[data-run-id="first"] button');
  await inspect.focus();
  fixture.state.runs.push(makeRun("third"));
  await page.clock.fastForward(5_000);
  await expect(page.locator("#runs tr")).toHaveCount(3);
  await expect(inspect).toBeFocused();
  await page.getByRole("link", { name: "How scoring works", exact: true }).click();
  await page.locator("#calibrations summary").click();
  await page.clock.fastForward(5_000);
  await expect(page.locator("#calibrations details")).toHaveAttribute("open", "");
  await expect(page.locator("#calibrations summary")).toBeFocused();
  await expect(page.locator("#scoring-guide")).toHaveAttribute("open", "");
  expect(fixture.errors).toEqual([]);
});

test("legacy session links retain the TV default without changing the overview landing page", async ({ page }) => {
  const fixture = await openPortal(page, { histories: { legacy: { attempts: [{
    id: "legacy-attempt", jobId: "legacy-job", sourceSessionId: "legacy",
    status: "queued", requestedAt: "2026-09-15T12:00:00Z",
  }] } } });
  await page.goto("/dashboards/evals?sessionId=legacy&mode=simulated");
  await expect(page.getByRole("tab", { name: "Recorded", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tab", { name: "TVAgent", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("dialog", { name: "Session evaluation history" })).toBeVisible();
  await expect(page.locator("#detail-body")).toContainText("Verdicts and task eval score are not available yet");
  await expect(page.locator("#detail-body")).not.toContainText("N/A for this agent");
  await page.goto("/dashboards/evals");
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(fixture.errors).toEqual([]);
});
