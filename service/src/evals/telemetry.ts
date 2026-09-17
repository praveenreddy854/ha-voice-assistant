import type {
  Assessment, EvalAttemptMetrics, EvalMetrics, EvalModelCall, EvalModelResponse,
  EvalRunSummary, EvalStopReason, EvalToolCall, EvalTrace, Usage,
} from "./types";

const tokenKeys = ["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "reasoningTokens"] as const;
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const validCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const mainTokenKeys = ["inputTokens", "outputTokens", "totalTokens"] as const;

export function reportedModelUsage(usage: Usage, raw?: unknown): Usage {
  const result: Usage = {};
  for (const key of mainTokenKeys) result[key] = validCount(usage[key]) ? usage[key] : undefined;
  if (!raw || typeof raw !== "object") return result;
  // The SDK defaults absent detail counts to zero. Only retain explicitly reported details.
  const input = "input_tokens_details" in raw ? raw.input_tokens_details
    : "prompt_tokens_details" in raw ? raw.prompt_tokens_details : undefined;
  const output = "output_tokens_details" in raw ? raw.output_tokens_details
    : "completion_tokens_details" in raw ? raw.completion_tokens_details : undefined;
  if (input && typeof input === "object" && "cached_tokens" in input) {
    result.cacheReadTokens = validCount(input.cached_tokens) ? input.cached_tokens : undefined;
  }
  if (output && typeof output === "object" && "reasoning_tokens" in output) {
    result.reasoningTokens = validCount(output.reasoning_tokens) ? output.reasoning_tokens : undefined;
  }
  return result;
}

/** A missing contribution makes that total unknown; detail counters are subsets, not extra tokens. */
export function sumUsage(values: Array<Usage | undefined>): Usage {
  const result: Usage = {};
  for (const key of tokenKeys) {
    if (key === "cacheReadTokens" || key === "reasoningTokens") {
      if (!values.some(value => value?.[key] !== undefined)) continue;
    }
    const counts = values.map(value => value?.[key]);
    const total = counts.length && counts.every(validCount) ? counts.reduce((sum, value) => sum + value, 0) : undefined;
    result[key] = validCount(total) ? total : undefined;
  }
  return result;
}

function reportedToolFailure(result: unknown): boolean {
  if (typeof result === "string") {
    try { result = JSON.parse(result); }
    catch (error) {
      // Plain-text observations are valid tool results, not reported failures.
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  }
  return result !== null && typeof result === "object" &&
    (("toolSuccess" in result && result.toolSuccess === false) ||
      ("success" in result && result.success === false) ||
      ("executionError" in result && Boolean(result.executionError)));
}

export class TrialTelemetry {
  readonly startedAt = new Date().toISOString();
  readonly trace: EvalTrace = { modelCalls: [], toolCalls: [], messages: [] };
  private readonly started: number;
  private userTurns = 0;
  private assistantTurns = 0;
  private firstResponseMs?: number;
  private stopped?: EvalStopReason;
  private finished = false;
  virtualDeviceTimeMs?: number;

  constructor(private readonly clock: () => number = () => performance.now()) {
    this.started = clock();
  }

  elapsed(): number { return Math.max(0, this.clock() - this.started); }
  beginUserTurn(): void { this.userTurns++; }
  stop(reason: EvalStopReason): void { this.stopped = reason; }

  beginModel(model?: string): EvalModelCall {
    const call: EvalModelCall = {
      id: `model-${this.trace.modelCalls.length + 1}`, userTurn: this.userTurns,
      offsetMs: this.elapsed(), model, status: "running", responses: [],
    };
    this.trace.modelCalls.push(call);
    return call;
  }

  response(call: EvalModelCall, response: Omit<EvalModelResponse, "turn">): EvalModelResponse {
    const item = { ...response, turn: ++this.assistantTurns };
    this.firstResponseMs ??= this.elapsed();
    call.responses.push(item);
    return item;
  }

  endModel(call: EvalModelCall, error?: unknown): void {
    if (this.finished) return;
    call.durationMs = Math.max(0, this.elapsed() - call.offsetMs);
    call.status = error === undefined ? "completed" : "error";
    if (error !== undefined) call.error = errorMessage(error);
  }

  requestTool(call: EvalModelCall, turn: number, toolCallId: string, name: string, args: unknown): EvalToolCall {
    const tool: EvalToolCall = {
      id: `tool-${this.trace.toolCalls.length + 1}`, modelCallId: call.id, turn, userTurn: call.userTurn,
      toolCallId, name, arguments: args, offsetMs: this.elapsed(), executed: false, status: "not_executed",
    };
    this.trace.toolCalls.push(tool);
    return tool;
  }

  findTool(call: EvalModelCall | EvalModelCall[], toolCallId: string): EvalToolCall {
    const calls = Array.isArray(call) ? call : [call];
    const tool = this.trace.toolCalls.find(item => calls.some(call => item.modelCallId === call.id) && item.toolCallId === toolCallId);
    if (!tool) throw new Error(`Missing offline tool-call telemetry for ${toolCallId}`);
    return tool;
  }

  rejectTool(tool: EvalToolCall, reason: string): void {
    tool.status = "rejected";
    tool.error = reason;
    tool.result = reason;
  }

  completeTool(tool: EvalToolCall, result: unknown): void {
    if (this.finished) return;
    tool.result = result;
    tool.status = reportedToolFailure(result) ? "error" : "completed";
    if (tool.executed) tool.durationMs = Math.max(0, this.elapsed() - tool.offsetMs);
  }

  async executeTool<T>(tool: EvalToolCall, execute: () => Promise<T> | T, result: (value: T) => unknown = value => value): Promise<T> {
    tool.executed = true;
    tool.offsetMs = this.elapsed();
    try {
      const value = await execute();
      this.completeTool(tool, result(value));
      return value;
    } catch (error) {
      if (!this.finished) {
        tool.status = "error";
        tool.error = errorMessage(error);
        tool.durationMs = Math.max(0, this.elapsed() - tool.offsetMs);
      }
      throw error;
    }
  }

  usage(): Usage {
    return sumUsage(this.trace.modelCalls.flatMap(call =>
      call.responses.length ? call.responses.map(response => response.usage) : [undefined]));
  }

  finish(error?: unknown, signal?: AbortSignal): { metrics: EvalMetrics; trace: EvalTrace; usage: Usage; durationMs: number } {
    if (error !== undefined) {
      const reason = signal?.aborted ? signal.reason : error;
      this.stopped = reason instanceof Error && reason.name === "TimeoutError" ? "timeout"
        : signal?.aborted ? "aborted" : this.stopped || "error";
      for (const call of this.trace.modelCalls) if (call.status === "running") this.endModel(call, error);
      for (const tool of this.trace.toolCalls) if (tool.executed && tool.status === "not_executed") {
        tool.status = "error";
        tool.error = errorMessage(error);
        tool.durationMs = Math.max(0, this.elapsed() - tool.offsetMs);
      }
    }
    this.finished = true;
    const { modelCalls, toolCalls } = this.trace;
    const responses = modelCalls.flatMap(call => call.responses);
    return {
      durationMs: this.elapsed(), usage: this.usage(), trace: structuredClone(this.trace),
      metrics: {
        version: 1, userTurns: this.userTurns, assistantTurns: this.assistantTurns,
        modelRequests: modelCalls.length, toolCalls: toolCalls.length,
        toolExecutions: toolCalls.filter(tool => tool.executed).length,
        toolErrors: toolCalls.filter(tool => tool.status === "error").length,
        rejectedToolCalls: toolCalls.filter(tool => tool.status === "rejected").length,
        unexecutedToolCalls: toolCalls.filter(tool => tool.status === "not_executed").length,
        completionCalls: toolCalls.filter(tool => tool.name === "complete_task").length,
        modelErrors: modelCalls.filter(call => call.status === "error").length,
        modelTimeMs: modelCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0),
        toolTimeMs: toolCalls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0),
        timeToFirstResponseMs: this.firstResponseMs,
        usageReportedResponses: responses.filter(response =>
          mainTokenKeys.every(key => validCount(response.usage?.[key]))).length,
        stopReason: this.stopped || "completed", virtualDeviceTimeMs: this.virtualDeviceTimeMs,
      },
    };
  }
}

export class EvalExecutionError extends Error {
  constructor(error: unknown, readonly assessment: Assessment) {
    super(errorMessage(error));
    this.name = "EvalExecutionError";
  }
}

export class EvalGradingError extends Error {
  constructor(error: unknown, readonly usage?: Usage) {
    super(errorMessage(error));
    this.name = "EvalGradingError";
  }
}

type TrialInput = Pick<Assessment, "agentId" | "request" | "model" | "promptVersion" | "evidence" | "context" | "expectations">;

export async function captureTrial(
  input: TrialInput, signal: AbortSignal,
  execute: (telemetry: TrialTelemetry) => Promise<Pick<Assessment, "finalResponse" | "taskAssertion">>,
): Promise<Assessment> {
  const telemetry = new TrialTelemetry();
  const assessment: Assessment = {
    ...input, mode: "simulated", startedAt: telemetry.startedAt, finalResponse: "", coverage: "complete",
  };
  let failure: unknown;
  try {
    signal.throwIfAborted();
    Object.assign(assessment, await execute(telemetry));
    signal.throwIfAborted();
    return assessment;
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
    assessment.coverage = "partial";
    throw new EvalExecutionError(failure, assessment);
  } finally {
    Object.assign(assessment, telemetry.finish(failure, signal));
    // A cancelled Realtime tool can settle after the socket has already closed.
    assessment.evidence = structuredClone(assessment.evidence);
  }
}

export function aggregateTrialMetrics(runs: EvalRunSummary[]): EvalAttemptMetrics[] {
  return (["scheduled", "confirmation", "on_demand"] as const).flatMap(attempt => {
    const selected = runs.filter(run => run.mode === "simulated" && run.attempt === attempt);
    if (!selected.length) return [];
    const measured = selected.filter(run => run.metrics);
    const durations = selected.map(run => run.durationMs)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)
      .sort((a, b) => a - b);
    const total = (key: "assistantTurns" | "toolCalls" | "toolErrors") =>
      measured.length === selected.length ? measured.reduce((sum, run) => sum + run.metrics![key], 0) : undefined;
    const midpoint = Math.floor(durations.length / 2);
    return [{
      attempt, runCount: selected.length, measuredRuns: measured.length,
      assistantTurns: total("assistantTurns"), toolCalls: total("toolCalls"), toolErrors: total("toolErrors"),
      executionErrors: selected.filter(run => run.status === "execution_error").length,
      gradingErrors: selected.filter(run => run.status === "grading_error").length,
      usage: sumUsage(selected.map(run => run.usage)), judgeUsage: sumUsage(selected.map(run => run.judgeUsage)),
      latencySamples: durations.length,
      p50DurationMs: durations.length ? durations.length % 2 ? durations[midpoint] : (durations[midpoint - 1] + durations[midpoint]) / 2 : undefined,
      p95DurationMs: durations.length ? durations[Math.ceil(durations.length * .95) - 1] : undefined,
    }];
  });
}
