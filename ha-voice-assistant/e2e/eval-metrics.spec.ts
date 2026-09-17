import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import type { EvalAgentId, EvalMetrics, EvalTrace, Usage } from "../../service/src/evals/types";
import { grade, makeRun, openPortal, unsafeReason, type PortalRun } from "./evalPortalFixture";

const usage: Usage = { inputTokens: 200, outputTokens: 40, totalTokens: 240, cacheReadTokens: 120, reasoningTokens: 20 };
const metrics = (overrides: Partial<EvalMetrics> = {}): EvalMetrics => ({
  version: 1, userTurns: 1, assistantTurns: 2, modelRequests: 2, modelErrors: 0,
  toolCalls: 2, toolExecutions: 1, toolErrors: 0, rejectedToolCalls: 0, unexecutedToolCalls: 0,
  completionCalls: 1, modelTimeMs: 1000, toolTimeMs: 250, timeToFirstResponseMs: 600,
  usageReportedResponses: 2, stopReason: "completed", virtualDeviceTimeMs: 1500, ...overrides,
});
const trace = (): EvalTrace => ({
  systemMessages: ["Fixture system instructions"],
  messages: [{ role: "user", content: "Open YouTube" }, { role: "assistant", content: "YouTube is ready" }],
  modelCalls: [
    { id: "model-1", userTurn: 1, offsetMs: 0, durationMs: 600, model: "fixture-model", status: "completed",
      responses: [{ turn: 1, responseId: "provider-response-1", text: "Inspect current state", finishReason: "tool-calls",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 60, reasoningTokens: 10 } }] },
    { id: "model-2", userTurn: 1, offsetMs: 850, durationMs: 400, model: "fixture-model", status: "completed",
      responses: [{ turn: 2, responseId: "provider-response-2", text: "YouTube is ready", finishReason: "tool-calls",
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, cacheReadTokens: 60, reasoningTokens: 10 } }] },
  ],
  toolCalls: [
    { id: "tool-1", modelCallId: "model-1", turn: 1, userTurn: 1, toolCallId: "state-call", name: "get_device_state",
      arguments: { target: "fixture" }, offsetMs: 600, durationMs: 250, executed: true, status: "completed", result: { observation: "YouTube open" } },
    { id: "tool-2", modelCallId: "model-2", turn: 2, userTurn: 1, toolCallId: "done-call", name: "complete_task",
      arguments: { success: true }, offsetMs: 1250, executed: false, status: "completed", result: { message: "YouTube is ready" } },
  ],
});
function trial(id: string, agentId: EvalAgentId = "tv", overrides: Partial<PortalRun> = {}): PortalRun {
  const base = makeRun(id, { mode: "simulated", agentId });
  return {
    ...base, assessedModel: "fixture-model", grade: grade(undefined, { scoringAssessment: undefined }),
    gradingDurationMs: 450, evaluationDurationMs: 2000,
    judgeUsage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
    assessment: {
      ...base.assessment!, coverage: "complete", usage, trace: trace(),
      metrics: metrics(agentId === "realtime" ? { userTurns: 2, assistantTurns: 4, modelRequests: 4, completionCalls: 0 } : {}),
    },
    ...overrides,
  };
}

test("all synthetic agents expose summary metrics without loading their full trace", async ({ page }) => {
  const detailsRequested: string[] = [];
  page.on("request", request => { if (request.url().includes("/api/evals/runs/")) detailsRequested.push(request.url()); });
  const runs = (["tv", "scheduled_task", "realtime"] as const).map(agentId => trial(`${agentId}-trial`, agentId));
  const { errors, unexpectedRequests } = await openPortal(page, { runs });
  for (const agentId of ["tv", "scheduled_task", "realtime"] as const) {
    await page.locator("#agent").selectOption(agentId);
    const row = page.locator("#runs tr").filter({ hasText: `${agentId}-trial` });
    await expect(row.locator(".trial-turns")).toHaveText(agentId === "realtime" ? "42 user turns" : "21 user turns");
    await expect(row.locator(".trial-tools")).toContainText("21 executed");
    await expect(row.locator(".trial-tokens")).toContainText("240");
    await expect(row.locator(".trial-tokens")).toContainText("In 200 / out 40");
    await expect(row).toContainText("1.5s");
  }
  expect(detailsRequested).toEqual([]);
  expect(errors).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
});

test("inspection separates agent usage and latency from grading and exposes a downloadable trace", async ({ page }, testInfo) => {
  const { errors, unexpectedRequests } = await openPortal(page, { runs: [trial("measured-trial")] });
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  const diagnostics = page.getByRole("region", { name: "Trial diagnostics", exact: true });
  await expect(diagnostics).toBeVisible();
  await expect(diagnostics.locator("dt").filter({ hasText: /^Assistant turns$/ }).locator("+ dd")).toHaveText("2");
  await expect(diagnostics.locator("dt").filter({ hasText: /^Tool calls$/ }).locator("+ dd")).toHaveText("2");
  await expect(diagnostics.locator("dt").filter({ hasText: /^Tool executions$/ }).locator("+ dd")).toHaveText("1");
  await expect(diagnostics.locator("dt").filter({ hasText: /^Agent wall time$/ }).locator("+ dd")).toHaveText("1.50 s");
  await expect(diagnostics.locator("dt").filter({ hasText: /^Offline grading time$/ }).locator("+ dd")).toHaveText("450 ms");
  await expect(diagnostics.locator("dt").filter({ hasText: /^Evaluation time$/ }).locator("+ dd")).toHaveText("2.00 s");
  await expect(diagnostics.locator("dt").filter({ hasText: /^Virtual device waits$/ }).locator("+ dd")).toHaveText("1.50 s");
  await expect(diagnostics.getByRole("row", { name: /^Assessed agent/ }).locator("td")).toHaveText(["200", "40", "240", "120", "20"]);
  await expect(diagnostics.getByRole("row", { name: /^Offline judge/ }).locator("td")).toHaveText(["30", "10", "40", "Unavailable", "Unavailable"]);
  await expect(diagnostics).toContainText("2 / 2 returned responses");
  await expect(diagnostics).toContainText("Cost is unavailable");

  const calls = page.getByRole("region", { name: "Model and tool trace", exact: true });
  await calls.locator(".model-call").first().locator("summary").first().click();
  await expect(calls).toContainText("provider-response-1");
  await calls.locator(".model-response").first().locator("summary").click();
  await expect(calls.locator(".model-response").first()).toContainText("Inspect current state");
  await calls.locator(".tool-call").first().locator("summary").click();
  await expect(calls.locator(".tool-call").first()).toContainText("YouTube open");
  await calls.locator(".trial-transcript > summary").click();
  await expect(calls.locator(".trial-transcript")).toContainText("Fixture system instructions");
  await expect(calls.locator(".trial-transcript")).toContainText("Open YouTube");
  await page.locator("#detail").evaluate(element => { element.scrollTop = 0; });
  await page.locator("#detail").screenshot({ path: testInfo.outputPath("trial-diagnostics.png") });

  const downloading = page.waitForEvent("download");
  await diagnostics.getByRole("link", { name: "Download trial JSON" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("measured-trial.json");
  const saved = JSON.parse(await readFile((await download.path())!, "utf8")) as PortalRun;
  expect(saved.assessment?.metrics?.assistantTurns).toBe(2);
  expect(saved.assessment?.trace?.toolCalls[0].toolCallId).toBe("state-call");
  expect(saved.assessment?.usage?.totalTokens).toBe(240);
  expect(saved.judgeUsage?.totalTokens).toBe(40);
  expect(errors).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
});

test("legacy, partial and explicitly zero metrics stay distinct in history and inspection", async ({ page }) => {
  const zero = trial("zero-usage");
  zero.assessment!.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  const partial = trial("partial-usage");
  partial.assessment!.usage = { inputTokens: 200 };
  partial.assessment!.metrics!.usageReportedResponses = 1;
  const legacy = makeRun("legacy-trial", { mode: "simulated" });
  const { errors } = await openPortal(page, { runs: [legacy, zero, partial] });
  await expect(page.locator("#runs tr").filter({ hasText: "legacy-trial" }).locator(".trial-turns")).toHaveText("Unavailable");
  await expect(page.locator("#runs tr").filter({ hasText: "legacy-trial" }).locator(".trial-tokens")).toHaveText("Unavailable");
  await expect(page.locator("#runs tr").filter({ hasText: "zero-usage" }).locator(".trial-tokens")).toHaveText("0In 0 / out 0");
  await expect(page.locator("#runs tr").filter({ hasText: "partial-usage" }).locator(".trial-tokens")).toContainText("Unavailable");
  await page.locator("#runs tr").filter({ hasText: "partial-usage" }).getByRole("button", { name: "Inspect" }).click();
  await expect(page.locator(".token-usage").getByRole("row", { name: /^Assessed agent/ }).locator("td"))
    .toHaveText(["200", "Unavailable", "Unavailable", "Unavailable", "Unavailable"]);
  await page.locator("#close").click();
  await page.locator("#runs tr").filter({ hasText: "legacy-trial" }).getByRole("button", { name: "Inspect" }).click();
  await expect(page.getByRole("region", { name: "Trial diagnostics" })).toContainText("Trial metrics unavailable for this evaluation");
  await expect(page.locator("#detail-body")).toContainText("Structured trace unavailable");
  expect(errors).toEqual([]);
});

test("failed trials keep partial traces and safely render errors on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const failed = trial("failed-trial", "tv", {
    status: "execution_error", grade: undefined, verdict: "error", error: `Connection lost: ${unsafeReason}`,
    gradingDurationMs: undefined, judgeUsage: undefined,
  });
  failed.assessment!.coverage = "partial";
  failed.assessment!.usage = undefined;
  failed.assessment!.metrics = metrics({
    assistantTurns: 1, modelErrors: 1, toolCalls: 1, toolErrors: 1, completionCalls: 0,
    usageReportedResponses: 1, stopReason: "error",
  });
  failed.assessment!.trace!.modelCalls[1] = {
    id: "model-2", userTurn: 1, model: "fixture-model", offsetMs: 850, durationMs: 650,
    status: "error", error: unsafeReason, partialText: unsafeReason, responses: [],
  };
  failed.assessment!.trace!.toolCalls = [{
    ...trace().toolCalls[0], status: "error", error: unsafeReason,
    result: { toolSuccess: false, observation: unsafeReason },
  }];
  const { errors, unexpectedRequests } = await openPortal(page, { runs: [failed] });
  await page.getByRole("button", { name: "Inspect", exact: true }).click();
  await expect(page.getByRole("region", { name: "Trial diagnostics" })).toContainText("Partial trace retained");
  await expect(page.locator(".model-call").last()).toHaveAttribute("open", "");
  await expect(page.locator(".model-call").last()).toContainText("No complete model response was retained");
  await expect(page.locator(".model-call").last()).toContainText(unsafeReason);
  await page.locator(".model-call").first().locator("summary").first().click();
  await expect(page.locator(".tool-call")).toContainText(unsafeReason);
  await expect(page.locator("#detail img")).toHaveCount(0);
  expect(await page.evaluate(() => "evidenceExecuted" in window)).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
});

test("batch latency and token totals keep scheduled and confirmation attempts separate", async ({ page }) => {
  const measured = trial("scheduled-trial", "tv", { attempt: "scheduled" });
  const confirmation = trial("confirmation-trial", "tv", { attempt: "confirmation" });
  const { errors } = await openPortal(page, {
    runs: [measured, confirmation],
    batches: [{
      id: "batch", agentId: "tv", mode: "simulated", attempt: "scheduled", status: "completed",
      startedAt: measured.assessedAt, runIds: [measured.id, confirmation.id, "missing-run"], missingRunSummaries: 1,
      metricsByAttempt: [
        { attempt: "scheduled", runCount: 1, measuredRuns: 1, assistantTurns: 2, toolCalls: 2, toolErrors: 0,
          usage, judgeUsage: { totalTokens: 40 }, latencySamples: 1, p50DurationMs: 1500, p95DurationMs: 1500,
          executionErrors: 0, gradingErrors: 0 },
        { attempt: "confirmation", runCount: 1, measuredRuns: 0, usage: {}, judgeUsage: {},
          latencySamples: 0, executionErrors: 1, gradingErrors: 0 },
      ],
    }],
  });
  await page.locator("#batches summary").click();
  await expect(page.locator("#batches")).toContainText("1 run summaries unavailable");
  const table = page.locator("#batches table");
  await expect(table.getByRole("row", { name: /^scheduled/ })).toContainText("1 / 1 trials");
  await expect(table.getByRole("row", { name: /^scheduled/ })).toContainText("240");
  await expect(table.getByRole("row", { name: /^scheduled/ })).toContainText("1.50 s / 1.50 s");
  await expect(table.getByRole("row", { name: /^confirmation/ })).toContainText("0 / 1 trials");
  await expect(table.getByRole("row", { name: /^confirmation/ })).toContainText("Unavailable");
  expect(errors).toEqual([]);
});
