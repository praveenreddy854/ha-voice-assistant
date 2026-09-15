import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { evalPage } from "../../service/src/evals/page";
import type { EvalRunSummary } from "../../service/src/evals/types";

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

async function openDashboard(page: Page, initialRuns = mixedRuns) {
  let runs = initialRuns;
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
        runs, busy: false, alerts: [], batches: [], calibrations: [], fidelity: [],
        baseline: { from: "2026-09-07", to: "2026-09-13" },
        timezone: "America/New_York", scheduleEnabled: true, fidelityNote: "Fixture comparison data",
      } });
    } else if (url.pathname.startsWith("/api/evals/runs/")) {
      const result = runs.find(item => item.id === url.pathname.split("/").pop());
      await route.fulfill({ status: result ? 200 : 404, json: result || { error: "Eval run not found" } });
    } else {
      await route.fulfill({ status: 404, body: "Unexpected fixture request" });
    }
  });
  await page.goto("/dashboards/evals");
  await expect(page.locator("#cards .number").first()).toHaveText(String(runs.length));
  return { errors, setRuns: (next: Run[]) => { runs = next; } };
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
