import { expect, test } from "@playwright/test";
import type { RecordedDailyOutcome } from "../../service/src/evals/scheduling";
import { agents, enabledSchedules, makeRun, makeSession, openPortal, unsafeReason } from "./evalPortalFixture";

const outcome = (overrides: Partial<RecordedDailyOutcome> = {}): RecordedDailyOutcome => ({
  id: "recorded-2026-09-15", mode: "recorded", day: "2026-09-15", status: "queued",
  selectedCount: 1, sessionIds: ["new-session"], warnings: [], createdAt: "2026-09-15T05:00:00Z", ...overrides,
});

test("both New York schedules, persisted cutoff, and scheduled recorded provenance are visible", async ({ page }) => {
  const schedules = enabledSchedules();
  schedules.recorded.latest = outcome({ status: "completed" });
  const fixture = await openPortal(page, {
    schedules,
    runs: [
      makeRun("scheduled-recorded", { attempt: "scheduled", scheduledDay: "2026-09-15" }),
      makeRun("manual-recorded"),
      makeRun("scheduled-simulated", {
        mode: "simulated", attempt: "scheduled", scheduledDay: "2026-09-15",
        comparison: { baselineCount: 4, medianMs: 1000 },
      }),
    ],
    batches: [{
      id: "nightly-recorded", agentId: "tv", mode: "recorded", attempt: "scheduled",
      scheduledDay: "2026-09-15", startedAt: "2026-09-15T05:00:00Z", status: "completed", runIds: ["scheduled-recorded"],
    }],
  });
  const recorded = page.locator("#recorded-schedule"), simulated = page.locator("#simulated-schedule");
  await expect(recorded).toContainText("Daily at 1 a.m. · America/New_York");
  await expect(simulated).toContainText("Daily at 3 a.m. · America/New_York");
  await expect(recorded).toContainText("Enabled");
  await expect(simulated).toContainText("Enabled");
  await expect(recorded).toContainText("Initial eligibility cutoff");
  await expect(recorded).toContainText("9/14/2026");
  await expect(recorded).toContainText("6:00:00 AM EDT");
  await expect(recorded).toContainText("Older runs remain available manually.");
  await expect(recorded).toContainText("Batch completed");
  await expect(recorded).toContainText("2026-09-15 · 1 sessions selected");
  const rows = page.locator("#runs tr");
  const comparison = rows.filter({ hasText: "scheduled-recorded" }).locator("td").nth(8);
  await expect(comparison).toContainText("Scheduled");
  await expect(comparison).toContainText("2026-09-15");
  await expect(comparison).toContainText("Not part of the simulated baseline");
  await expect(comparison).not.toContainText("On demand");
  await expect(rows.filter({ hasText: "manual-recorded" })).toContainText("On demand");
  await expect(rows.filter({ hasText: "scheduled-simulated" })).toContainText("4 samples");
  await expect(page.locator("#batches")).toContainText("recorded · Scheduled");
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("the recorded schedule is TV-only while simulated schedules cover every registered agent", async ({ page }) => {
  const fresh = { status: "not_evaluated" as const, attemptCount: 0 };
  const fixture = await openPortal(page, {
    schedules: enabledSchedules(),
    sessions: [makeSession("voice-manual", fresh, "realtime")],
    statuses: { "voice-manual": fresh },
  });
  const recorded = page.locator("#recorded-schedule"), simulated = page.locator("#simulated-schedule");
  for (const agent of agents) {
    await page.locator("#agent").selectOption(agent.id);
    await expect(page.locator("#suite-description")).toContainText(agent.name);
    await expect(recorded.getByRole("heading")).toHaveText("Recorded runs · TV only");
    await expect(recorded).toContainText("Automatic recorded grading covers TVAgent only");
    await expect(recorded).toContainText("Other agents remain available for manual recorded evaluation");
    await expect(recorded).toContainText("Daily at 1 a.m.");
    await expect(simulated.getByRole("heading")).toHaveText("Simulated suites · All registered agents");
    await expect(simulated).toContainText("Daily at 3 a.m.");
    for (const registered of agents) await expect(simulated).toContainText(registered.name);
    await expect(page.locator("#simulate")).toBeEnabled();
    await expect(page.locator("#calibrate")).toBeEnabled();
  }
  await page.locator("#recorded").click();
  await page.getByRole("checkbox", { name: "Select session voice-manual", exact: true }).check();
  await page.locator("#session-run").click();
  await expect(page.locator("#session-message")).toContainText("Batch accepted");
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.submissions[0]).toMatchObject({ mode: "recorded", agentId: "realtime", sessionIds: ["voice-manual"] });
  expect(fixture.errors).toEqual([]);
  expect(fixture.unexpectedRequests).toEqual([]);
});

test("disabled schedules do not disable explicit manual evaluation and worker availability still does", async ({ page }) => {
  const schedules = enabledSchedules();
  schedules.recorded.enabled = false;
  schedules.simulated.enabled = false;
  const fresh = { status: "not_evaluated" as const, attemptCount: 0 };
  const fixture = await openPortal(page, {
    schedules, busy: true, sessions: [makeSession("manual-session", fresh)], statuses: { "manual-session": fresh },
  });
  await expect(page.locator("#recorded-schedule")).toContainText("Disabled");
  await expect(page.locator("#simulated-schedule")).toContainText("Disabled");
  await expect(page.locator("#simulate")).toBeDisabled();
  await expect(page.locator("#calibrate")).toBeDisabled();
  await page.getByRole("button", { name: "Select sessions", exact: true }).click();
  await page.getByRole("checkbox", { name: "Select session manual-session", exact: true }).check();
  await expect(page.locator("#session-run")).toBeDisabled();
  await expect(page.locator("#session-busy")).toContainText("worker is busy");
  fixture.state.busy = false;
  await page.getByRole("button", { name: "Refresh sessions", exact: true }).click();
  await expect(page.locator("#session-run")).toBeEnabled();
  await expect(page.locator("#simulate")).toBeEnabled();
  await expect(page.locator("#calibrate")).toBeEnabled();
  await page.locator("#session-run").click();
  await expect(page.locator("#session-message")).toContainText("Batch accepted: fixture-job");
  expect(fixture.submissions).toHaveLength(1);
  expect(fixture.submissions[0]).toMatchObject({ mode: "recorded", sessionIds: ["manual-session"] });
  expect(fixture.submissions[0].requestId).toEqual(expect.any(String));
  await expect(page.locator("#session-run")).toBeDisabled();
  expect(fixture.errors).toEqual([]);
});

test("legacy snapshots never invent recorded scheduling enablement", async ({ page }) => {
  const fixture = await openPortal(page, { scheduleEnabled: false });
  await expect(page.locator("#recorded-schedule")).toContainText("Daily at 1 a.m.");
  await expect(page.locator("#recorded-schedule")).toContainText("Schedule status unavailable");
  await expect(page.locator("#recorded-schedule")).not.toContainText("Enabled");
  await expect(page.locator("#recorded-schedule")).not.toContainText("Initial eligibility cutoff");
  await expect(page.locator("#simulated-schedule")).toContainText("Disabled (legacy schedule status)");
  await expect(page.locator("#simulate")).toBeEnabled();
  fixture.state.scheduleEnabled = true;
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.locator("#simulated-schedule")).toContainText("Enabled (legacy schedule status)");
  await expect(page.locator("#recorded-schedule")).toContainText("Schedule status unavailable");
  expect(fixture.errors).toEqual([]);
});

test("partial discovery, failed selection, and verified empty daily outcomes stay distinguishable", async ({ page }) => {
  const schedules = enabledSchedules();
  schedules.recorded.latest = outcome({ warnings: [`Cosmos discovery unavailable: ${unsafeReason}`] });
  const fixture = await openPortal(page, { schedules });
  const recorded = page.locator("#recorded-schedule");
  await expect(recorded).toContainText("Batch queued");
  await expect(recorded).toContainText("1 sessions selected");
  await expect(recorded.getByRole("status")).toContainText("Incomplete recorded-run discovery");
  await expect(recorded.getByRole("status")).toContainText(`Cosmos discovery unavailable: ${unsafeReason}`);
  await expect(recorded.locator("img")).toHaveCount(0);
  schedules.recorded.latest = outcome({
    status: "incomplete_discovery", selectedCount: 0, sessionIds: [],
    warnings: ["Telemetry unavailable; no eligible sessions in available Cosmos records"],
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(recorded).toContainText("No eligible sessions in available sources — discovery incomplete");
  await expect(recorded).toContainText("Telemetry unavailable");
  schedules.recorded.latest = outcome({
    status: "failed", selectedCount: 0, sessionIds: [], error: `Evaluation history unreadable: ${unsafeReason}`,
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(recorded).toContainText("Scheduling failed");
  await expect(recorded.getByRole("alert")).toHaveText(`Evaluation history unreadable: ${unsafeReason}`);
  await expect(recorded).not.toContainText("No eligible sessions");
  await expect(recorded.locator("img")).toHaveCount(0);
  schedules.recorded.latest = outcome({
    status: "empty", selectedCount: 0, sessionIds: [], finishedAt: "2026-09-15T05:00:01Z",
  });
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(recorded).toContainText("No eligible sessions");
  await expect(recorded).toContainText("0 sessions selected");
  await expect(recorded.getByRole("alert")).toHaveCount(0);
  await expect(recorded.getByRole("status")).toHaveCount(0);
  await expect(recorded).not.toContainText("discovery incomplete");
  expect(fixture.submissions).toEqual([]);
  expect(await page.evaluate("window.evidenceExecuted")).toBeUndefined();
  expect(fixture.errors).toEqual([]);
});
