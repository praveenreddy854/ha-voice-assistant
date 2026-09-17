import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { evalPage } from "../../service/src/evals/page";
import type { EvalScheduleStatus } from "../../service/src/evals/scheduling";
import type {
  EvalAgentId, EvalAlert, EvalBatch, EvalMode, EvalRun, EvalRunSummary, Grade, RecordedSession, RecordedSessionEvaluation, RecordedSessionHistory, TaskEvalScore,
} from "../../service/src/evals/types";

export type PortalRun = EvalRun & Pick<EvalRunSummary, "taskAssertion"> & { request: string; verdict: string };
export const agents = [
  { id: "tv", name: "TVAgent", description: "TV and playback state.", scenarioCount: 12, referenceCount: 6 },
  { id: "scheduled_task", name: "ScheduledTaskAgent", description: "Dates and isolated task storage.", scenarioCount: 12, referenceCount: 6 },
  { id: "realtime", name: "Realtime Voice Agent", description: "Text/tool decisions, not audio quality.", scenarioCount: 12, referenceCount: 6 },
];
export const evidenceId = "observed-state";
export const unsafeReason = '<img src=x onerror="window.evidenceExecuted=true"> & "retained observation"';
export const rubricVersion = "recorded-task-v1";
export const scored = (value: number, overrides: Partial<Extract<TaskEvalScore, { status: "scored" }>> = {}): TaskEvalScore => ({
  status: "scored", rubricVersion, value, baseScore: value, deductions: [],
  totalDeductions: 0, band: { min: value >= 50 ? 50 : 0, max: value >= 50 ? 100 : 49 },
  bandAdjustedScore: value, ...overrides,
});
export const grade = (score?: TaskEvalScore, overrides: Partial<Grade> = {}): Grade => {
  const judgment = { verdict: "pass" as const, reason: "Supported by retained observation", evidenceIds: [evidenceId] };
  return {
    task: judgment, handling: judgment, reporting: judgment, recovery: judgment, steps: [], gaps: [],
    context: { task: "playback", target: "requested music", app: "YouTube", startingState: "ready" },
    scoringAssessment: {
      progress: { level: "complete", reason: "Requested content is playing", evidenceIds: [evidenceId] },
      mistakes: [],
      evidence: {
        progress: { sufficient: true, reason: "Final state retained", evidenceIds: [evidenceId] },
        execution: { sufficient: true, reason: "Action history retained", evidenceIds: [evidenceId] },
        reporting: { sufficient: true, reason: "Final response retained", evidenceIds: [evidenceId] },
      },
    },
    score, ...overrides,
  };
};
export const makeRun = (id: string, overrides: Partial<PortalRun> = {}): PortalRun => ({
  id, mode: "recorded", request: id, batchId: "batch", agentId: "tv", attempt: "on_demand",
  adapterVersion: "adapter", graderVersion: "grader", judgeModel: "judge",
  assessedAt: "2026-09-15T02:00:00Z", gradedAt: "2026-09-15T05:00:00Z",
  status: "completed", verdict: "pass", durationMs: 1500,
  grade: overrides.mode === "simulated" || (overrides.agentId && overrides.agentId !== "tv")
    ? grade(undefined, { scoringAssessment: undefined }) : grade(scored(100)),
  assessment: {
    agentId: overrides.agentId || "tv", mode: overrides.mode || "recorded", request: id, finalResponse: "Requested music is playing.",
    startedAt: "2026-09-15T02:00:00Z", coverage: "partial",
    evidence: [{ id: evidenceId, kind: "tool", toolName: "get_device_state", text: unsafeReason }],
    taskAssertion: overrides.taskAssertion,
  },
  ...overrides,
});
export const evaluation = (
  run: PortalRun, status: RecordedSessionEvaluation["status"] = "evaluated",
): RecordedSessionEvaluation => ({
  status, attemptCount: status === "evaluated" ? 1 : 2, latestCompleted: run,
  latestAttempt: status === "not_evaluated" ? undefined : {
    id: `${run.id}-latest`, jobId: "latest-job", agentId: run.agentId, sourceSessionId: `${run.id}-session`, status,
    requestedAt: "2026-09-15T06:00:00Z",
    ...(status === "evaluated" ? { runId: run.id, finishedAt: run.gradedAt }
      : status === "eval_error" ? { error: "Re-evaluation interrupted before grading", finishedAt: "2026-09-15T06:01:00Z" } : {}),
  },
});
export const makeSession = (sessionId: string, state: RecordedSessionEvaluation, agentId: EvalAgentId = "tv"): RecordedSession => ({
  sessionId, agentId, userPrompt: `Recorded request for ${sessionId}`, startedAt: "2026-09-15T02:00:00Z",
  completedAt: "2026-09-15T02:01:00Z", status: "completed",
  sources: agentId === "tv" ? ["telemetry", "cosmos"] : ["telemetry"], evaluation: state,
});
export const enabledSchedules = (): EvalScheduleStatus => ({
  timezone: "America/New_York", simulated: { enabled: true, hour: 3 },
  recorded: { enabled: true, hour: 1, enabledAt: "2026-09-14T10:00:00Z" },
});

interface FixtureState {
  agents: typeof agents;
  runs: PortalRun[];
  schedules?: EvalScheduleStatus;
  scheduleEnabled: boolean;
  busy: boolean;
  sessions: RecordedSession[];
  statuses: Record<string, RecordedSessionEvaluation>;
  histories: Record<string, RecordedSessionHistory>;
  batches: EvalBatch[];
  jobs: import("../../service/src/evals/worker").EvalJob[];
  alerts: EvalAlert[];
  fidelity: { simulatedId: string; recordedIds: string[]; status: string }[];
  calibrations: { id: string; agentId?: string; judgeModel: string; createdAt: string; passed: boolean; limitation?: string; results: {
    id: string; passed: boolean; expected: string[]; actual?: string[]; error?: string;
    expectedScore?: number | null; actualScore?: number | null; expectedProgress?: string; actualProgress?: string;
    expectedSeverities?: string[]; actualSeverities?: string[];
    expectedBlockingComponents?: string[]; actualBlockingComponents?: string[];
  }[] }[];
  statusesError?: string;
  dashboardError?: string;
}

export async function openPortal(page: Page, initial: Partial<FixtureState> = {}, view: {
  agentId?: EvalAgentId; mode?: EvalMode; evaluator?: "code" | "llm";
} = {}) {
  const state: FixtureState = {
    agents, runs: [], busy: false, scheduleEnabled: true, sessions: [], statuses: {}, histories: {},
    batches: [], jobs: [], alerts: [], fidelity: [], calibrations: [], ...initial,
  };
  const errors: string[] = [], unexpectedRequests: string[] = [];
  const submissions: Record<string, unknown>[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const browserScript = await readFile(path.resolve("../service/dist/evals/browser.js"), "utf8");
  // Every request is intercepted; these tests never start devices, workers, or model services.
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    const agentId = url.searchParams.get("agentId");
    if (url.pathname === "/dashboards/evals") {
      await route.fulfill({ contentType: "text/html", body: evalPage });
    } else if (url.pathname === "/dashboards/evals/browser.js") {
      await route.fulfill({ contentType: "application/javascript", body: browserScript });
    } else if (url.pathname === "/api/evals") {
      if (state.dashboardError) {
        await route.fulfill({ status: 503, json: { error: state.dashboardError } });
        return;
      }
      await route.fulfill({ json: {
        agents: state.agents, runs: state.runs.filter(run => !agentId || run.agentId === agentId).map(({ assessment, ...summary }) => summary),
        busy: state.busy, schedules: state.schedules, scheduleEnabled: state.scheduleEnabled,
        alerts: state.alerts.filter(alert => !agentId || (alert.agentId || alert.key.split(":")[0]) === agentId),
        batches: state.batches.filter(batch => !agentId || batch.agentId === agentId),
        jobs: state.jobs.filter(job => !agentId || (job.agentId || "tv") === agentId),
        calibrations: state.calibrations.filter(calibration => !agentId || (calibration.agentId || "tv") === agentId),
        fidelity: state.fidelity.filter(pair => !agentId || state.runs.some(run => run.id === pair.simulatedId && run.agentId === agentId)),
        baseline: { from: "2026-09-07", to: "2026-09-13" },
        timezone: "America/New_York", fidelityNote: "Fixture comparison data",
      } });
    } else if (url.pathname === "/api/evals/sessions") {
      await route.fulfill({ json: {
        sessions: state.sessions.filter(session => !agentId || session.agentId === agentId),
        busy: state.busy, warnings: [], timezone: "America/New_York",
      } });
    } else if (url.pathname === "/api/evals/session-statuses") {
      await route.fulfill(state.statusesError
        ? { status: 503, json: { error: state.statusesError } }
        : { json: { statuses: state.statuses, agents: state.agents.map(agent => agent.id), busy: state.busy } });
    } else if (/^\/api\/evals\/sessions\/[^/]+\/history$/.test(url.pathname)) {
      const id = decodeURIComponent(url.pathname.split("/")[4]);
      await route.fulfill({ json: state.histories[id] || { attempts: [] } });
    } else if (url.pathname.startsWith("/api/evals/runs/")) {
      const result = state.runs.find(item => item.id === decodeURIComponent(url.pathname.split("/").pop()!));
      await route.fulfill({ status: result ? 200 : 404, json: result || { error: "Eval run not found" } });
    } else if (url.pathname === "/api/evals/jobs" && route.request().method() === "POST") {
      submissions.push(route.request().postDataJSON());
      state.busy = true;
      await route.fulfill({ json: { id: "fixture-job", status: "queued" } });
    } else {
      unexpectedRequests.push(url.pathname);
      await route.fulfill({ status: 404, body: "Unexpected fixture request" });
    }
  });
  await page.goto(`/dashboards/evals?${new URLSearchParams(view)}`);
  await expect(page.locator("#agent-panel")).toHaveAttribute("aria-busy", "false");
  if (!state.dashboardError) await expect(page.locator("#cards .number")).toHaveCount(4);
  return { state, errors, unexpectedRequests, submissions };
}
