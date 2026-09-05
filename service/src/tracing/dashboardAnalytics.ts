import type { AgentTrace, TraceLLMStep } from "./agentTraceStore";

export type DashboardRange = "24h" | "7d" | "30d" | "all";

export interface DashboardFilters {
  range?: DashboardRange;
  from?: string;
  to?: string;
  agentType?: string;
  model?: string;
}

interface DashboardOverview {
  sessions: number;
  finalizedSessions: number;
  activeSessions: number;
  successfulSessions: number;
  failedSessions: number;
  cancelledSessions: number;
  reportedSuccessRate: number | null;
  completionRate: number | null;
  cleanRunRate: number | null;
  singleStepSuccessRate: number | null;
  toolSuccessRate: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface DashboardModelRow {
  model: string;
  provider: string;
  sessions: number;
  calls: number;
  successfulSessions: number;
  failedSessions: number;
  reportedSuccessRate: number | null;
  cleanRunRate: number | null;
  p50ResponseTimeMs: number | null;
  p95ResponseTimeMs: number | null;
  averageStepTimeMs: number | null;
  averageInputTokens: number | null;
  averageOutputTokens: number | null;
  totalTokens: number;
  tokensPerSuccessfulSession: number | null;
  averageStepsPerSession: number;
}

export interface DashboardAgentRow {
  agentType: string;
  sessions: number;
  successfulSessions: number;
  failedSessions: number;
  cancelledSessions: number;
  reportedSuccessRate: number | null;
  errorRate: number;
  toolFailureRate: number | null;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  averageSteps: number;
}

export interface DashboardToolRow {
  toolName: string;
  calls: number;
  failures: number;
  successRate: number;
  averageDurationMs: number;
  p95DurationMs: number;
}

export interface DashboardTimeBucket {
  date: string;
  sessions: number;
  successes: number;
  failures: number;
  averageDurationMs: number | null;
}

export interface DashboardSnapshot {
  generatedAt: string;
  filters: Required<Pick<DashboardFilters, "range">> & Omit<DashboardFilters, "range">;
  options: {
    agentTypes: string[];
    models: string[];
  };
  overview: DashboardOverview;
  models: DashboardModelRow[];
  agents: DashboardAgentRow[];
  tools: DashboardToolRow[];
  timeline: DashboardTimeBucket[];
  quality: {
    status: "proxy_only";
    message: string;
    verifiedOutcomeCount: number;
  };
}

const UNKNOWN_MODEL = "unknown (legacy)";

export function buildDashboardSnapshot(
  traces: AgentTrace[],
  filters: DashboardFilters = {},
  now = new Date()
): DashboardSnapshot {
  const range = filters.range ?? "30d";
  const fromMs = resolveFromMs(filters.from, range, now);
  const toMs = resolveTimestamp(filters.to) ?? now.getTime();
  const withinRange = traces.filter((trace) => {
    const startedAt = Date.parse(trace.startedAt);
    return Number.isFinite(startedAt) && startedAt >= fromMs && startedAt <= toMs;
  });

  const options = {
    agentTypes: uniqueSorted(withinRange.map((trace) => trace.agentType)),
    models: uniqueSorted(withinRange.flatMap(getTraceModels)),
  };

  const selected = withinRange.filter((trace) => {
    if (filters.agentType && trace.agentType !== filters.agentType) {
      return false;
    }
    if (filters.model && !getTraceModels(trace).includes(filters.model)) {
      return false;
    }
    return true;
  });

  return {
    generatedAt: now.toISOString(),
    filters: {
      range,
      from: filters.from,
      to: filters.to,
      agentType: filters.agentType,
      model: filters.model,
    },
    options,
    overview: buildOverview(selected),
    models: buildModelRows(selected),
    agents: buildAgentRows(selected),
    tools: buildToolRows(selected),
    timeline: buildTimeline(selected),
    quality: {
      status: "proxy_only",
      message:
        "Quality uses reported task success, clean runs, and single-step completion. No independently verified outcome or user-rating signal is recorded yet.",
      verifiedOutcomeCount: 0,
    },
  };
}

function buildOverview(traces: AgentTrace[]): DashboardOverview {
  const finalized = traces.filter((trace) => trace.success !== undefined);
  const successes = finalized.filter((trace) => trace.success === true);
  const failed = finalized.filter((trace) => trace.success === false);
  const completed = traces.filter(
    (trace) => trace.status === "completed" || trace.status === "error"
  );
  const durations = numericValues(traces.map((trace) => trace.durationMs));
  const tools = traces.flatMap((trace) => trace.toolResults);
  const modelSteps = traces.flatMap((trace) => trace.llmSteps);
  const inputTokens = sum(modelSteps.map((step) => step.inputTokens));
  const outputTokens = sum(modelSteps.map((step) => step.outputTokens));

  return {
    sessions: traces.length,
    finalizedSessions: finalized.length,
    activeSessions: traces.filter(
      (trace) => trace.status === "running" || trace.status === "awaiting_external_input"
    ).length,
    successfulSessions: successes.length,
    failedSessions: failed.length,
    cancelledSessions: traces.filter(isCancelled).length,
    reportedSuccessRate: ratio(successes.length, finalized.length),
    completionRate: ratio(completed.length, traces.length),
    cleanRunRate: ratio(successes.filter(hasNoFailedTools).length, finalized.length),
    singleStepSuccessRate: ratio(
      successes.filter((trace) => trace.llmSteps.length <= 1).length,
      finalized.length
    ),
    toolSuccessRate: ratio(
      tools.filter((tool) => tool.toolSuccess !== false).length,
      tools.length
    ),
    p50DurationMs: percentile(durations, 0.5),
    p95DurationMs: percentile(durations, 0.95),
    modelCalls: modelSteps.length,
    inputTokens,
    outputTokens,
  };
}

function buildModelRows(traces: AgentTrace[]): DashboardModelRow[] {
  const groups = new Map<string, { provider: string; traces: Set<AgentTrace>; steps: TraceLLMStep[] }>();

  for (const trace of traces) {
    const traceSteps = trace.llmSteps.length ? trace.llmSteps : [legacyStep()];
    for (const step of traceSteps) {
      const model = getStepModel(step);
      const group = groups.get(model) ?? {
        provider: step.provider ?? (model === UNKNOWN_MODEL ? "unknown" : "azure.ai.openai"),
        traces: new Set<AgentTrace>(),
        steps: [],
      };
      group.traces.add(trace);
      group.steps.push(step);
      groups.set(model, group);
    }
  }

  return Array.from(groups.entries())
    .map(([model, group]) => {
      const modelTraces = Array.from(group.traces);
      const actualSteps = group.steps.filter((step) => step.stepNumber > 0);
      const finalized = modelTraces.filter((trace) => trace.success !== undefined);
      const successes = finalized.filter((trace) => trace.success === true);
      const responseTimes = numericValues(group.steps.map((step) => step.responseTimeMs));
      const stepTimes = numericValues(group.steps.map((step) => step.stepTimeMs));
      const inputTokens = numericValues(group.steps.map((step) => step.inputTokens));
      const outputTokens = numericValues(group.steps.map((step) => step.outputTokens));
      const totalTokens = sum(group.steps.map((step) => step.totalTokens));

      return {
        model,
        provider: group.provider,
        sessions: modelTraces.length,
        calls: actualSteps.length,
        successfulSessions: successes.length,
        failedSessions: finalized.length - successes.length,
        reportedSuccessRate: ratio(successes.length, finalized.length),
        cleanRunRate: ratio(successes.filter(hasNoFailedTools).length, finalized.length),
        p50ResponseTimeMs: percentile(responseTimes, 0.5),
        p95ResponseTimeMs: percentile(responseTimes, 0.95),
        averageStepTimeMs: average(stepTimes),
        averageInputTokens: average(inputTokens),
        averageOutputTokens: average(outputTokens),
        totalTokens,
        tokensPerSuccessfulSession: successes.length ? totalTokens / successes.length : null,
        averageStepsPerSession: round(actualSteps.length / Math.max(modelTraces.length, 1)),
      };
    })
    .sort((left, right) => right.sessions - left.sessions || left.model.localeCompare(right.model));
}

function buildAgentRows(traces: AgentTrace[]): DashboardAgentRow[] {
  return groupBy(traces, (trace) => trace.agentType)
    .map(([agentType, agentTraces]) => {
      const finalized = agentTraces.filter((trace) => trace.success !== undefined);
      const successes = finalized.filter((trace) => trace.success === true);
      const tools = agentTraces.flatMap((trace) => trace.toolResults);
      const durations = numericValues(agentTraces.map((trace) => trace.durationMs));
      return {
        agentType,
        sessions: agentTraces.length,
        successfulSessions: successes.length,
        failedSessions: finalized.length - successes.length,
        cancelledSessions: agentTraces.filter(isCancelled).length,
        reportedSuccessRate: ratio(successes.length, finalized.length),
        errorRate: agentTraces.length
          ? round(agentTraces.filter((trace) => trace.status === "error").length / agentTraces.length)
          : 0,
        toolFailureRate: ratio(
          tools.filter((tool) => tool.toolSuccess === false).length,
          tools.length
        ),
        p50DurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        averageSteps: round(
          sum(agentTraces.map((trace) => trace.llmSteps.length)) /
            Math.max(agentTraces.length, 1)
        ),
      };
    })
    .sort((left, right) => right.sessions - left.sessions);
}

function buildToolRows(traces: AgentTrace[]): DashboardToolRow[] {
  const tools = traces.flatMap((trace) => trace.toolResults);
  return groupBy(tools, (tool) => tool.toolName)
    .map(([toolName, calls]) => {
      const durations = calls.map((call) => call.durationMs);
      const failures = calls.filter((call) => call.toolSuccess === false).length;
      return {
        toolName,
        calls: calls.length,
        failures,
        successRate: round((calls.length - failures) / Math.max(calls.length, 1)),
        averageDurationMs: round(sum(durations) / Math.max(durations.length, 1)),
        p95DurationMs: percentile(durations, 0.95) ?? 0,
      };
    })
    .sort((left, right) => right.calls - left.calls || left.toolName.localeCompare(right.toolName));
}

function buildTimeline(traces: AgentTrace[]): DashboardTimeBucket[] {
  const buckets = groupBy(traces, (trace) => trace.startedAt.slice(0, 10));
  return buckets
    .map(([date, bucketTraces]) => {
      const durations = numericValues(bucketTraces.map((trace) => trace.durationMs));
      return {
        date,
        sessions: bucketTraces.length,
        successes: bucketTraces.filter((trace) => trace.success === true).length,
        failures: bucketTraces.filter((trace) => trace.success === false).length,
        averageDurationMs: average(durations),
      };
    })
    .sort((left, right) => left.date.localeCompare(right.date));
}

function getTraceModels(trace: AgentTrace): string[] {
  if (!trace.llmSteps.length) {
    return [UNKNOWN_MODEL];
  }
  return uniqueSorted(trace.llmSteps.map(getStepModel));
}

function getStepModel(step: TraceLLMStep): string {
  return step.responseModel || step.requestModel || UNKNOWN_MODEL;
}

function legacyStep(): TraceLLMStep {
  return {
    stepNumber: 0,
    timestamp: "",
    finishReason: "unknown",
    text: "",
    toolCalls: [],
  };
}

function hasNoFailedTools(trace: AgentTrace): boolean {
  return trace.toolResults.every((tool) => tool.toolSuccess !== false);
}

function isCancelled(trace: AgentTrace): boolean {
  return trace.events.some((event) => event.type === "agent.session.cancelled");
}

function resolveFromMs(from: string | undefined, range: DashboardRange, now: Date): number {
  const explicit = resolveTimestamp(from);
  if (explicit !== undefined) {
    return explicit;
  }
  const durationMs: Record<Exclude<DashboardRange, "all">, number> = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
  };
  return range === "all" ? Number.NEGATIVE_INFINITY : now.getTime() - durationMs[range];
}

function resolveTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function percentile(values: number[], quantile: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return round(sorted[Math.max(index, 0)]);
}

function average(values: number[]): number | null {
  return values.length ? round(sum(values) / values.length) : null;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator ? round(numerator / denominator) : null;
}

function sum(values: Array<number | undefined>): number {
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function numericValues(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => Number.isFinite(value));
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function groupBy<T>(values: T[], keyFor: (value: T) => string): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    groups.set(key, [...(groups.get(key) ?? []), value]);
  }
  return Array.from(groups.entries());
}
