import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDashboardSnapshot,
  type DashboardModelRow,
} from "../src/tracing/dashboardAnalytics";
import type { AgentTrace, TraceLLMStep } from "../src/tracing/agentTraceStore";

const NOW = new Date("2026-01-10T12:00:00.000Z");

function llmStep(overrides: Partial<TraceLLMStep> = {}): TraceLLMStep {
  return {
    stepNumber: 1,
    timestamp: "2026-01-10T10:00:00.000Z",
    finishReason: "stop",
    requestModel: "gpt-mini",
    responseModel: "gpt-mini-2026-01-01",
    provider: "azure.ai.openai",
    inputTokens: 100,
    outputTokens: 10,
    totalTokens: 110,
    responseTimeMs: 100,
    stepTimeMs: 125,
    text: "done",
    toolCalls: [],
    ...overrides,
  };
}

function trace(overrides: Partial<AgentTrace> = {}): AgentTrace {
  return {
    sessionId: "session-1",
    agentType: "tv",
    userPrompt: "Play something",
    startedAt: "2026-01-10T10:00:00.000Z",
    completedAt: "2026-01-10T10:00:01.000Z",
    status: "completed",
    success: true,
    events: [],
    llmSteps: [llmStep()],
    toolResults: [
      {
        toolCallId: "tool-1",
        toolName: "launch_app",
        observation: "launched",
        toolSuccess: true,
        durationMs: 250,
      },
    ],
    screenshots: [],
    durationMs: 1000,
    ...overrides,
  };
}

function model(rows: DashboardModelRow[], name: string): DashboardModelRow {
  const found = rows.find((row) => row.model === name);
  assert.ok(found, `Expected model row ${name}`);
  return found;
}

test("builds overview, model, agent, and tool dashboard metrics", () => {
  const traces = [
    trace({
      llmSteps: [
        llmStep(),
        llmStep({
          stepNumber: 2,
          inputTokens: 200,
          outputTokens: 20,
          totalTokens: 220,
          responseTimeMs: 300,
          stepTimeMs: 350,
        }),
      ],
    }),
    trace({
      sessionId: "session-2",
      success: false,
      status: "error",
      durationMs: 5000,
      llmSteps: [
        llmStep({
          requestModel: "gpt-advanced",
          responseModel: "gpt-advanced-2026-01-01",
          inputTokens: 400,
          outputTokens: 40,
          totalTokens: 440,
          responseTimeMs: 1000,
          stepTimeMs: 1100,
        }),
      ],
      toolResults: [
        {
          toolCallId: "tool-2",
          toolName: "launch_app",
          observation: "failed",
          toolSuccess: false,
          durationMs: 750,
        },
      ],
    }),
  ];

  const dashboard = buildDashboardSnapshot(traces, { range: "24h" }, NOW);

  assert.equal(dashboard.overview.sessions, 2);
  assert.equal(dashboard.overview.reportedSuccessRate, 0.5);
  assert.equal(dashboard.overview.cleanRunRate, 0.5);
  assert.equal(dashboard.overview.toolSuccessRate, 0.5);
  assert.equal(dashboard.overview.p50DurationMs, 1000);
  assert.equal(dashboard.overview.p95DurationMs, 5000);
  assert.equal(dashboard.overview.modelCalls, 3);
  assert.equal(dashboard.overview.inputTokens, 700);
  assert.equal(dashboard.overview.outputTokens, 70);

  const mini = model(dashboard.models, "gpt-mini-2026-01-01");
  assert.equal(mini.sessions, 1);
  assert.equal(mini.calls, 2);
  assert.equal(mini.p50ResponseTimeMs, 100);
  assert.equal(mini.p95ResponseTimeMs, 300);
  assert.equal(mini.averageInputTokens, 150);
  assert.equal(mini.totalTokens, 330);
  assert.equal(mini.tokensPerSuccessfulSession, 330);

  assert.equal(dashboard.agents[0].reportedSuccessRate, 0.5);
  assert.equal(dashboard.tools[0].toolName, "launch_app");
  assert.equal(dashboard.tools[0].successRate, 0.5);
  assert.equal(dashboard.tools[0].p95DurationMs, 750);
});

test("supports model filters while preserving filter options", () => {
  const dashboard = buildDashboardSnapshot(
    [
      trace(),
      trace({
        sessionId: "session-2",
        llmSteps: [
          llmStep({
            requestModel: "gpt-advanced",
            responseModel: "gpt-advanced-2026-01-01",
          }),
        ],
      }),
    ],
    { range: "24h", model: "gpt-mini-2026-01-01" },
    NOW
  );

  assert.equal(dashboard.overview.sessions, 1);
  assert.deepEqual(dashboard.options.models, [
    "gpt-advanced-2026-01-01",
    "gpt-mini-2026-01-01",
  ]);
  assert.deepEqual(dashboard.models.map((row) => row.model), ["gpt-mini-2026-01-01"]);
});

test("keeps historical sessions visible as unknown legacy model data", () => {
  const dashboard = buildDashboardSnapshot(
    [trace({ llmSteps: [] })],
    { range: "all" },
    NOW
  );

  assert.equal(dashboard.models[0].model, "unknown (legacy)");
  assert.equal(dashboard.models[0].sessions, 1);
  assert.equal(dashboard.models[0].calls, 0);
  assert.equal(dashboard.models[0].p50ResponseTimeMs, null);
});

test("excludes traces outside the requested time range", () => {
  const dashboard = buildDashboardSnapshot(
    [
      trace(),
      trace({
        sessionId: "old-session",
        startedAt: "2025-12-01T00:00:00.000Z",
      }),
    ],
    { range: "7d" },
    NOW
  );

  assert.equal(dashboard.overview.sessions, 1);
});

const missingUsage = { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined };

for (const steps of [[], [llmStep(missingUsage)]]) {
  test(`missing usage remains unknown with ${steps.length} recorded calls`, () => {
    const dashboard = buildDashboardSnapshot([trace({ llmSteps: steps })], { range: "all" }, NOW);
    const row = dashboard.models[0];
    assert.equal(dashboard.overview.inputTokens, null);
    assert.equal(dashboard.overview.outputTokens, null);
    assert.equal(dashboard.overview.totalTokens, null);
    assert.equal(row.totalTokens, null);
    assert.equal(row.tokensPerSuccessfulSession, null);
    assert.equal(row.averageInputTokens, null);
    assert.deepEqual(row.tokenUsageCoverage, {
      modelCalls: steps.length, inputTokenCalls: 0, outputTokenCalls: 0, totalTokenCalls: 0,
      sessionsWithoutCalls: steps.length ? 0 : 1,
    });
  });
}

test("measured zero is distinct from unknown usage", () => {
  const dashboard = buildDashboardSnapshot([trace({ llmSteps: [llmStep({
    inputTokens: 0, outputTokens: 0, totalTokens: 0,
  })] })], { range: "all" }, NOW);
  assert.equal(dashboard.overview.totalTokens, 0);
  assert.equal(dashboard.models[0].totalTokens, 0);
  assert.equal(dashboard.models[0].tokensPerSuccessfulSession, 0);
  assert.deepEqual(dashboard.overview.tokenUsageCoverage, {
    modelCalls: 1, inputTokenCalls: 1, outputTokenCalls: 1, totalTokenCalls: 1, sessionsWithoutCalls: 0,
  });
});

test("mixed legacy and measured calls expose partial totals without understating per-success cost", () => {
  const dashboard = buildDashboardSnapshot([
    trace(), trace({ sessionId: "missing", llmSteps: [llmStep(missingUsage)] }),
    trace({ sessionId: "legacy", llmSteps: [] }),
  ], { range: "all" }, NOW);
  assert.equal(dashboard.overview.totalTokens, 110);
  assert.equal(dashboard.overview.inputTokens, 100);
  assert.deepEqual(dashboard.overview.tokenUsageCoverage, {
    modelCalls: 2, inputTokenCalls: 1, outputTokenCalls: 1, totalTokenCalls: 1, sessionsWithoutCalls: 1,
  });
  const row = model(dashboard.models, "gpt-mini-2026-01-01");
  assert.equal(row.totalTokens, 110);
  assert.equal(row.averageInputTokens, 100);
  assert.equal(row.tokensPerSuccessfulSession, null);
  assert.equal(row.tokenUsageCoverage.totalTokenCalls, 1);
  assert.equal(row.tokenUsageCoverage.modelCalls, 2);
});

test("coverage is tracked independently for partial token fields", () => {
  const dashboard = buildDashboardSnapshot([trace({ llmSteps: [
    llmStep({ ...missingUsage, inputTokens: 7 }),
    llmStep({ ...missingUsage, stepNumber: 2, outputTokens: 0 }),
    llmStep({ ...missingUsage, stepNumber: 3, totalTokens: 12 }),
  ] })], { range: "all" }, NOW);
  assert.equal(dashboard.overview.inputTokens, 7);
  assert.equal(dashboard.overview.outputTokens, 0);
  assert.equal(dashboard.overview.totalTokens, 12);
  assert.deepEqual(dashboard.overview.tokenUsageCoverage, {
    modelCalls: 3, inputTokenCalls: 1, outputTokenCalls: 1, totalTokenCalls: 1, sessionsWithoutCalls: 0,
  });
  assert.equal(dashboard.models[0].tokensPerSuccessfulSession, null);
});
