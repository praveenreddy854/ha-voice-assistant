import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { evalPage } from "../../service/src/evals/page";
import type { EvalRunSummary, RecordedSession, RecordedSessionEvaluation } from "../../service/src/evals/types";
import type { EvalJob } from "../../service/src/evals/worker";

type Run = EvalRunSummary & { verdict: string };
const run = (id: string, mode: Run["mode"], overrides: Partial<Run> = {}): Run => ({
  id, mode, request: id, batchId: "batch", agentId: "tv", attempt: "on_demand",
  adapterVersion: "adapter", graderVersion: "grader", judgeModel: "judge",
  assessedAt: "2026-09-14T12:00:00Z", gradedAt: "2026-09-14T13:00:00Z",
  status: "completed", verdict: "unknown", durationMs: 1500, ...overrides,
});
const mixedRuns = [
  run("real-error", "recorded", { status: "grading_error", verdict: "error", error: "Missing evidence" }),
  run("simulation-confirmation", "simulated", { attempt: "confirmation" }),
  run("simulation-scheduled", "simulated", { attempt: "scheduled", comparison: { baselineCount: 4, medianMs: 1000 } }),
  run("real-completed", "recorded"),
];
const agents = [
  { id: "tv", name: "TVAgent", description: "TV and playback state.", scenarioCount: 12, referenceCount: 6 },
  { id: "scheduled_task", name: "ScheduledTaskAgent", description: "Dates and isolated task storage.", scenarioCount: 12, referenceCount: 6 },
  { id: "realtime", name: "Realtime Voice Agent", description: "Text/tool decisions, not audio quality.", scenarioCount: 12, referenceCount: 6 },
];
const sessions: RecordedSession[] = agents.map(agent => ({
  sessionId: `${agent.id}-source`, agentId: agent.id, userPrompt: `${agent.name} recorded request`,
  startedAt: "2026-09-14T12:00:00Z", completedAt: "2026-09-14T12:01:00Z", status: "completed",
  sources: ["telemetry"], evaluation: { status: "not_evaluated", attemptCount: 0 },
}));

async function openDashboard(page: Page, initialRuns = mixedRuns) {
  let runs = initialRuns;
  let busy = false, loseSubmissionResponse = false;
  const postedJobs: Array<Omit<EvalJob, "id">> = [], acceptedJobs = new Map<string, EvalJob>();
  const statuses: Record<string, RecordedSessionEvaluation> = {};
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  // Exercise the backend's compiled browser script without starting workers or live services.
  const browserScript = await readFile(path.resolve("../service/dist/evals/browser.js"), "utf8");
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/dashboards/evals") {
      await route.fulfill({ contentType: "text/html", body: evalPage });
    } else if (url.pathname === "/dashboards/evals/browser.js") {
      await route.fulfill({ contentType: "application/javascript", body: browserScript });
    } else if (url.pathname === "/api/evals") {
      await route.fulfill({ json: {
        runs: runs.filter(run => run.agentId === url.searchParams.get("agentId")), agents, busy, alerts: [], batches: [], calibrations: [], fidelity: [],
        baseline: { from: "2026-09-07", to: "2026-09-13" },
        timezone: "America/New_York", scheduleEnabled: true, fidelityNote: "Fixture comparison data",
      } });
    } else if (url.pathname.startsWith("/api/evals/runs/")) {
      const result = runs.find(item => item.id === url.pathname.split("/").pop());
      await route.fulfill({ status: result ? 200 : 404, json: result || { error: "Eval run not found" } });
    } else if (url.pathname === "/api/evals/sessions") {
      await route.fulfill({ json: {
        sessions: sessions.filter(session => session.agentId === url.searchParams.get("agentId")),
        warnings: [], busy, timezone: "America/New_York",
      } });
    } else if (url.pathname === "/api/evals/session-statuses") {
      await route.fulfill({ json: { statuses, agents: agents.map(agent => agent.id), busy } });
    } else if (url.pathname === "/api/evals/jobs" && route.request().method() === "POST") {
      const body = route.request().postDataJSON() as Omit<EvalJob, "id">;
      postedJobs.push(body);
      const key = body.requestId || `job-${postedJobs.length}`;
      let job = acceptedJobs.get(key);
      if (!job) {
        job = { ...body, id: key, status: "queued" };
        acceptedJobs.set(key, job);
        for (const sessionId of body.sessionIds || []) statuses[sessionId] = { status: "queued", attemptCount: 1 };
      }
      busy = true;
      if (loseSubmissionResponse) { loseSubmissionResponse = false; await route.abort("failed"); }
      else await route.fulfill({ status: 202, json: job });
    } else {
      await route.fulfill({ status: 404, body: "Unexpected fixture request" });
    }
  });
  await page.goto("/dashboards/evals");
  await expect(page.locator("#cards .number").first()).toHaveText(String(runs.filter(run => run.agentId === "tv").length));
  return { errors, postedJobs, acceptedJobs, setRuns: (next: Run[]) => { runs = next; },
    loseNextSubmissionResponse: () => { loseSubmissionResponse = true; } };
}

test("All, Simulated, and Real filter history while preserving comparisons and inspection", async ({ page }) => {
  const { errors } = await openDashboard(page);
  const rows = page.locator("#runs tr");
  const all = page.getByRole("tab", { name: "All", exact: true });
  await expect(all).toHaveAttribute("aria-selected", "true");
  await expect(rows).toHaveCount(4);

  await page.getByRole("tab", { name: "Simulated", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("simulation-confirmation");
  await expect(rows.nth(1)).toContainText("simulation-scheduled");
  await expect(rows.nth(1)).toContainText("4 samples");
  await expect(rows.nth(1)).toContainText("Median 1.0s");
  await expect(page.locator("#mode")).toHaveValue("simulated");
  await expect(page.locator("#cards .number").first()).toHaveText("2");
  await expect(page.getByRole("tabpanel", { name: "Simulated", exact: true })).toBeVisible();

  await page.getByRole("tab", { name: "Real", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("real-error");
  await expect(rows.nth(1)).toContainText("real-completed");
  await expect(rows.nth(1)).toContainText("On demand");
  await expect(page.locator("#mode")).toHaveValue("recorded");
  await rows.nth(1).getByRole("button", { name: "Inspect" }).click();
  await expect(page.getByRole("dialog", { name: "Evaluation details" })).toBeVisible();
  await expect(page.locator("#detail-body h3").first()).toHaveText("real-completed");
  await page.locator("#close").click();
  await expect(page.getByRole("tab", { name: "Real", exact: true })).toHaveAttribute("aria-selected", "true");

  await all.click();
  await expect(rows).toHaveCount(4);
  expect(errors).toEqual([]);
});

test("mode changes synchronize tabs and refreshes preserve the selected mode", async ({ page }) => {
  await page.clock.install();
  const { errors, setRuns } = await openDashboard(page);
  const real = page.getByRole("tab", { name: "Real", exact: true });
  await page.locator("#mode").selectOption("recorded");
  await expect(real).toHaveAttribute("aria-selected", "true");
  await expect(real).toHaveAttribute("tabindex", "0");
  await expect(page.getByRole("tab", { name: "All", exact: true })).toHaveAttribute("tabindex", "-1");
  setRuns([run("new-real-result", "recorded"), ...mixedRuns]);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#runs tr")).toHaveCount(3);
  await expect(real).toHaveAttribute("aria-selected", "true");

  setRuns([run("another-real-result", "recorded"), run("new-simulation", "simulated"), ...mixedRuns]);
  await page.clock.fastForward(5_000);
  await expect(page.locator("#runs tr").first()).toContainText("another-real-result");
  await expect(page.locator("#runs tr")).toHaveCount(3);
  await expect(real).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#cards .number").first()).toHaveText("3");
  expect(errors).toEqual([]);
});

test("tabs support keyboard navigation and remain usable on narrow screens", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { errors } = await openDashboard(page);
  const all = page.getByRole("tab", { name: "All", exact: true });
  const simulated = page.getByRole("tab", { name: "Simulated", exact: true });
  const real = page.getByRole("tab", { name: "Real", exact: true });
  await all.focus();
  await page.keyboard.press("ArrowRight");
  await expect(simulated).toBeFocused();
  await expect(simulated).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(real).toBeFocused();
  await expect(real).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowRight");
  await expect(all).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(real).toBeFocused();
  await page.keyboard.press("Home");
  await expect(all).toBeFocused();
  await expect(all).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tabpanel", { name: "All", exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

test("empty states describe the selected mode without hiding other available evaluations", async ({ page }) => {
  const { errors, setRuns } = await openDashboard(page, [run("only-simulation", "simulated")]);
  await page.getByRole("tab", { name: "Real", exact: true }).click();
  await expect(page.locator("#runs")).toContainText("No real evals yet.");
  await expect(page.locator("#runs button")).toHaveCount(0);
  await page.getByRole("tab", { name: "All", exact: true }).click();
  await expect(page.locator("#runs")).toContainText("only-simulation");

  setRuns([]);
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#runs")).toContainText("No evals yet.");
  await page.getByRole("tab", { name: "Simulated", exact: true }).click();
  await expect(page.locator("#runs")).toContainText("No simulated evals yet.");
  expect(errors).toEqual([]);
});

test("agent selection scopes suites, history and alternative-model submissions", async ({ page }) => {
  const { errors, postedJobs } = await openDashboard(page, [
    run("tv-request", "simulated"), run("scheduled-request", "simulated", { agentId: "scheduled_task" }),
    run("voice-request", "recorded", { agentId: "realtime" }),
  ]);
  await expect(page.locator("#agent option")).toHaveCount(3);
  await page.locator("#agent").selectOption("scheduled_task");
  await expect(page.locator("#suite-description")).toContainText("12 ScheduledTaskAgent scenarios");
  await expect(page.locator("#runs tr")).toHaveCount(1);
  await expect(page.locator("#runs")).toContainText("scheduled-request");
  await expect(page.locator("#runs")).not.toContainText("tv-request");
  await page.locator("#model").fill("candidate-deployment");
  await page.locator("#simulate").click();
  await expect.poll(() => postedJobs.length).toBe(1);
  expect(postedJobs[0]).toEqual({ mode: "simulated", agentId: "scheduled_task", model: "candidate-deployment" });
  await expect(page.locator("#agent")).toHaveValue("scheduled_task");
  expect(errors).toEqual([]);
});

test("Realtime judge validation is agent-specific and mode selection survives refresh", async ({ page }) => {
  await page.clock.install();
  const { errors, postedJobs } = await openDashboard(page, [
    run("voice-simulation", "simulated", { agentId: "realtime" }),
    run("voice-recording", "recorded", { agentId: "realtime" }),
    run("tv-request", "recorded"),
  ]);
  await page.locator("#mode").selectOption("recorded");
  await page.locator("#agent").selectOption("realtime");
  await expect(page.locator("#runs tr")).toHaveCount(1);
  await expect(page.locator("#runs")).toContainText("voice-recording");
  await expect(page.locator("#suite-description")).toContainText("not audio quality");
  await page.clock.fastForward(5_000);
  await expect(page.locator("#mode")).toHaveValue("recorded");
  await expect(page.getByRole("tab", { name: "Real", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.locator("#calibrate").click();
  await expect.poll(() => postedJobs.length).toBe(1);
  expect(postedJobs[0]).toEqual({ mode: "calibrate", agentId: "realtime" });
  expect(errors).toEqual([]);
});

test("recorded selections persist separately by agent and cannot create a mixed batch", async ({ page }) => {
  const { errors, postedJobs } = await openDashboard(page);
  await page.locator("#recorded").click();
  await page.getByRole("checkbox", { name: "Select session tv-source", exact: true }).check();
  await page.locator("#session-close").click();
  await page.locator("#agent").selectOption("scheduled_task");
  await page.locator("#recorded").click();
  await expect(page.locator("#session-selector-title")).toContainText("ScheduledTaskAgent");
  await expect(page.locator("#session-rows")).not.toContainText("tv-source");
  await page.getByRole("checkbox", { name: "Select session scheduled_task-source", exact: true }).check();
  await page.locator("#session-run").click();
  await expect.poll(() => postedJobs.length).toBe(1);
  expect(postedJobs[0]).toMatchObject({ mode: "recorded", agentId: "scheduled_task", sessionIds: ["scheduled_task-source"] });
  await expect(page.locator("#session-message")).toContainText("Batch accepted");
  await page.locator("#session-close").click();
  await page.locator("#agent").selectOption("tv");
  await page.locator("#recorded").click();
  await expect(page.getByRole("checkbox", { name: "Select session tv-source", exact: true })).toBeChecked();
  await expect(page.locator("#session-run")).toBeDisabled();
  await expect(page.locator("#session-busy")).toContainText("worker is busy");
  expect(errors).toEqual([]);
});

test("uncertain recorded submissions retain their agent and reuse the same request identity", async ({ page }) => {
  const { errors, postedJobs, acceptedJobs, loseNextSubmissionResponse } = await openDashboard(page);
  await page.locator("#agent").selectOption("realtime");
  await page.locator("#recorded").click();
  await page.getByRole("checkbox", { name: "Select session realtime-source", exact: true }).check();
  loseNextSubmissionResponse();
  await page.locator("#session-run").click();
  await expect(page.locator("#session-message")).toContainText("Submission outcome is uncertain");
  await expect(page.locator("#agent")).toBeDisabled();
  await expect(page.locator("#session-run")).toHaveText("Retry submission (same batch)");
  await expect(page.locator("#session-run")).toBeEnabled();
  await page.locator("#session-run").click();
  await expect(page.locator("#session-message")).toContainText("Batch accepted");
  expect(postedJobs).toHaveLength(2);
  expect(postedJobs[0]).toEqual(postedJobs[1]);
  expect(postedJobs[1].agentId).toBe("realtime");
  expect(acceptedJobs.size).toBe(1);
  expect(errors).toEqual([]);
});

test("telemetry badges and history links support every registered agent", async ({ page }) => {
  const script = await readFile(path.resolve("../service/dist/evals/telemetryBrowser.js"), "utf8");
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/telemetry") {
      await route.fulfill({ contentType: "text/html", body: `<html><body>${[...agents.map(agent => agent.id), "unsupported"].map(id =>
        `<div data-eval-session-id="${id}-source" data-agent-type="${id}"></div>`).join("")}<script src="/telemetry-evals.js"></script></body></html>` });
    } else if (url.pathname === "/telemetry-evals.js") {
      await route.fulfill({ contentType: "application/javascript", body: script });
    } else if (url.pathname === "/api/evals/session-statuses") {
      await route.fulfill({ json: { statuses: {}, agents: agents.map(agent => agent.id), busy: false } });
    } else await route.fulfill({ status: 404, body: "Unexpected fixture request" });
  });
  await page.goto("/telemetry");
  for (const agent of agents) {
    const badge = page.locator(`[data-agent-type="${agent.id}"]`);
    await expect(badge).toBeVisible();
    await expect(badge.locator("a")).toHaveText("Eval: Not evaluated");
    await expect(badge.locator("a")).toHaveAttribute("href", `/dashboards/evals?agentId=${agent.id}&sessionId=${agent.id}-source`);
  }
  await expect(page.locator('[data-agent-type="unsupported"]')).toBeHidden();
});
