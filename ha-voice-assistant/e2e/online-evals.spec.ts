import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { onlinePage } from "../../service/src/evals/online/page";

const hostile = '<img src=x onerror="window.evidenceExecuted=true">';
test("online dashboard shows unknowns, worker failures and evidence safely; retry preserves its request ID", async ({ page }) => {
  const script = await readFile(path.resolve(__dirname, "../../service/dist/evals/online/browser.js"), "utf8");
  const record = { id: "run-1", sourceSessionId: "source-1", request: hostile, agentId: "realtime", model: "gpt-6.1-sol", status: "completed", reviewRequired: true,
    disagreements: ["task"], verdicts: { task: "unknown", handling: "pass", reporting: "pass", recovery: "not_applicable" } };
  let submissions = 0;
  const ids: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/dashboards/evals/online/browser.js") return route.fulfill({ contentType: "application/javascript", body: script });
    if (path === "/dashboards/evals/online") return route.fulfill({ contentType: "text/html", body: onlinePage });
    if (path.endsWith("/run-1/retry")) {
      ids.push(route.request().postDataJSON().requestId); submissions++;
      return submissions === 1 ? route.fulfill({ status: 503, json: { error: "Response uncertain; reuse requestId" } }) : route.fulfill({ status: 202, json: { id: ids[0], status: "queued" } });
    }
    if (path.endsWith("/run-1")) return route.fulfill({ json: { record, snapshot: { assessment: { request: hostile } }, result: { quality: { primary: { task: "pass" }, reviewer: { task: "fail" } } } } });
    if (path === "/api/evals/online") return route.fulfill({ json: {
      enabled: true, sampleRate: 1, worker: { running: false, error: "Worker unavailable" }, total: 1, records: [record],
      summary: { completed: 1, reviewRequired: 1, states: { completed: 1, queued: 0, running: 0, eval_error: 2, skipped: 1 }, cohorts: [{ agentId: "realtime", model: "gpt-6.1-sol", promptVersion: "prompt", graderVersion: "grader", count: 1, taskPass: 0, taskFail: 0, taskUnknown: 1, reportingFail: 0 }] },
    } });
    return route.abort();
  });
  // Plain HTTP on a LAN host is not a secure context; randomUUID is unavailable there.
  await page.goto("http://evals.test/dashboards/evals/online");
  await expect(page.getByRole("heading", { name: "Online evaluations", exact: true })).toBeVisible();
  await expect(page.locator("#health")).toContainText("Worker unavailable");
  await expect(page.locator("#records")).toContainText("unknown");
  await expect(page.locator("#records img")).toHaveCount(0);
  await page.getByRole("button", { name: "Details" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(JSON.parse(await page.locator("#evidence").textContent() || "{}").record.request).toBe(hostile);
  await page.getByRole("button", { name: "Re-evaluate snapshot" }).click();
  await expect(page.locator("#evidence")).toContainText("Response uncertain");
  await page.getByRole("button", { name: "Re-evaluate snapshot" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  expect(ids).toHaveLength(2); expect(ids[0]).toBe(ids[1]); expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as any).evidenceExecuted)).toBeUndefined();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "/tmp/ha-online-evals-mobile.png", fullPage: true });
});

test("API failure stays visible instead of showing an empty successful history", async ({ page }) => {
  const script = await readFile(path.resolve(__dirname, "../../service/dist/evals/online/browser.js"), "utf8");
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("browser.js")) return route.fulfill({ contentType: "application/javascript", body: script });
    if (path.startsWith("/api/")) return route.fulfill({ status: 503, json: { error: "Online evaluation history unavailable" } });
    return route.fulfill({ contentType: "text/html", body: onlinePage });
  });
  await page.goto("http://127.0.0.1:4174/dashboards/evals/online");
  await expect(page.getByRole("alert")).toHaveText("Online evaluation history unavailable");
});
