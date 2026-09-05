/**
 * OpenTelemetry-backed telemetry store.
 *
 * The viewer reconstructs session history from exported spans so telemetry
 * survives page refreshes and service restarts.
 */

import fs from "fs";
import path from "path";
import {
  context,
  trace,
  Span,
  SpanStatusCode,
  type Context,
} from "@opentelemetry/api";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import { isTelemetryLogFilename } from "./fileExporter";

export interface TraceToolCall {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  actionSummary: string;
}

export interface TraceToolResult {
  toolCallId: string;
  toolName: string;
  observation: string;
  toolSuccess?: boolean;
  durationMs: number;
  args?: Record<string, unknown>;
}

export interface TraceScreenshot {
  stepIndex: number;
  dataUrl?: string;
  timestamp: string;
  outcome: "captured" | "error" | "skipped";
  error?: string;
}

export interface TraceLLMStep {
  stepNumber: number;
  timestamp: string;
  finishReason: string;
  requestModel?: string;
  responseModel?: string;
  responseId?: string;
  provider?: string;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  totalTokens?: number;
  responseTimeMs?: number;
  stepTimeMs?: number;
  outputTokensPerSecond?: number;
  text: string;
  toolCalls: TraceToolCall[];
  /** Per-run system context, including retrieved memory injected before the step. */
  systemMessages?: string[];
  /** Snapshot of the conversation messages at the time of this LLM step. */
  messages?: Array<{ role: string; content: unknown }>;
}

export interface TraceEvent {
  type: string;
  timestamp: string;
  message: string;
  data?: Record<string, unknown>;
}

export interface AgentTrace {
  sessionId: string;
  agentType: string;
  userPrompt: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "awaiting_external_input" | "completed" | "error";
  success?: boolean;
  finalMessage?: string;
  events: TraceEvent[];
  llmSteps: TraceLLMStep[];
  toolResults: TraceToolResult[];
  screenshots: TraceScreenshot[];
  durationMs?: number;
}

interface ExportedTelemetrySpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  status: { code: number; message?: string };
  startTime: [number, number];
  endTime: [number, number];
  duration: [number, number];
  attributes: Record<string, unknown>;
  resourceAttributes?: Record<string, unknown>;
  events: Array<{
    name: string;
    time: [number, number];
    attributes?: Record<string, unknown>;
  }>;
}

interface ActiveTraceSession {
  sessionId: string;
  agentType: string;
  userPrompt: string;
  status: AgentTrace["status"];
  startedAt: string;
  rootSpan: Span;
  rootContext: Context;
}

interface PersistedSpanCache {
  mtimeMs: number;
  spans: ExportedTelemetrySpan[];
}

const LEGACY_TELEMETRY_LOG_FILENAMES = ["tv-agent-traces.jsonl"];

const tracer = trace.getTracer("service-telemetry", "1.0.0");
const MAX_EXPORTED_SPANS = 5000;
const activeSessions = new Map<string, ActiveTraceSession>();
const exportedSpans: ExportedTelemetrySpan[] = [];
const persistedSpanCache: PersistedSpanCache = { mtimeMs: -1, spans: [] };

let activeSessionId: string | null = null;

export class TelemetrySpanExporter implements SpanExporter {
  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void
  ): void {
    try {
      for (const span of spans) {
        exportedSpans.push(serializeSpan(span));
      }

      if (exportedSpans.length > MAX_EXPORTED_SPANS) {
        exportedSpans.splice(0, exportedSpans.length - MAX_EXPORTED_SPANS);
      }

      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  shutdown(): Promise<void> {
    return Promise.resolve();
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }
}

export const telemetrySpanExporter = new TelemetrySpanExporter();

export function setActiveSession(sessionId: string | null): void {
  activeSessionId = sessionId;
}

export function getActiveSessionId(): string | null {
  return activeSessionId;
}

export function getSessionTraceContext(sessionId: string): Context | undefined {
  return activeSessions.get(sessionId)?.rootContext;
}

export function createTrace(
  sessionId: string,
  agentType: string,
  userPrompt: string
): AgentTrace {
  const rootSpan = tracer.startSpan("agent.session.lifecycle", {
    attributes: {
      "agent.session.id": sessionId,
      "agent.type": agentType,
      "agent.user_prompt": userPrompt,
      "agent.session.status": "running",
      "telemetry.kind": "session",
    },
  });

  const rootContext = trace.setSpan(context.active(), rootSpan);
  const startedAt = new Date().toISOString();

  activeSessions.set(sessionId, {
    sessionId,
    agentType,
    userPrompt,
    status: "running",
    startedAt,
    rootSpan,
    rootContext,
  });

  addEvent(sessionId, "agent.session.created", `Session created for ${agentType}`, {
    userPrompt,
  });

  return getTrace(sessionId) || {
    sessionId,
    agentType,
    userPrompt,
    startedAt,
    status: "running",
    events: [],
    llmSteps: [],
    toolResults: [],
    screenshots: [],
  };
}

export function getTrace(sessionId: string): AgentTrace | undefined {
  return buildTraceMap().get(sessionId);
}

export function getAllTraces(): AgentTrace[] {
  return Array.from(buildTraceMap().values()).sort((left, right) => {
    return new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime();
  });
}

export function addEvent(
  sessionId: string,
  type: string,
  message: string,
  data?: Record<string, unknown>
): void {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return;
  }

  const normalizedData = normalizeAttributes(data);
  session.rootSpan.addEvent(type, {
    ...normalizedData,
    "telemetry.message": message,
  });

  const eventSpan = tracer.startSpan(
    "telemetry.event",
    {
      attributes: {
        "agent.session.id": sessionId,
        "agent.type": session.agentType,
        "telemetry.kind": "event",
        "telemetry.event.type": type,
        "telemetry.message": message,
        ...normalizedData,
      },
    },
    session.rootContext
  );
  eventSpan.end();
}

export function addLLMStep(sessionId: string, step: TraceLLMStep): void {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return;
  }

  // Strip base64 image data from messages to keep span size manageable
  const sanitizedMessages = step.messages
    ? step.messages.map((msg) => {
        if (Array.isArray(msg.content)) {
          return {
            role: msg.role,
            content: (msg.content as Array<Record<string, unknown>>).map((part) => {
              if (part.type === "image") {
                return { type: "image", note: "[base64 image omitted]" };
              }
              return part;
            }),
          };
        }
        return msg;
      })
    : undefined;

  const now = Date.now();
  const responseTimeMs = Math.max(step.responseTimeMs ?? 0, 0);
  const modelAttributes: Record<string, string | number> = {};
  setOptionalAttribute(modelAttributes, "gen_ai.request.model", step.requestModel);
  setOptionalAttribute(modelAttributes, "gen_ai.response.model", step.responseModel);
  setOptionalAttribute(modelAttributes, "gen_ai.response.id", step.responseId);
  setOptionalAttribute(modelAttributes, "gen_ai.provider.name", step.provider);
  setOptionalAttribute(modelAttributes, "gen_ai.usage.input_tokens", step.inputTokens);
  setOptionalAttribute(modelAttributes, "gen_ai.usage.output_tokens", step.outputTokens);
  setOptionalAttribute(
    modelAttributes,
    "gen_ai.usage.reasoning.output_tokens",
    step.reasoningTokens
  );
  setOptionalAttribute(
    modelAttributes,
    "gen_ai.usage.cache_read.input_tokens",
    step.cacheReadTokens
  );
  setOptionalAttribute(modelAttributes, "agent.step.total_tokens", step.totalTokens);
  setOptionalAttribute(modelAttributes, "agent.step.response_time_ms", step.responseTimeMs);
  setOptionalAttribute(modelAttributes, "agent.step.total_time_ms", step.stepTimeMs);
  setOptionalAttribute(
    modelAttributes,
    "agent.step.output_tokens_per_second",
    step.outputTokensPerSecond
  );

  const llmSpan = tracer.startSpan(
    "agent.step.llm",
    {
      startTime: new Date(now - responseTimeMs),
      attributes: {
        "agent.session.id": sessionId,
        "agent.type": session.agentType,
        "telemetry.kind": "llm_step",
        "agent.step.number": step.stepNumber,
        "agent.step.finish_reason": step.finishReason,
        "agent.step.text": step.text,
        "agent.step.tool_calls": JSON.stringify(step.toolCalls),
        "agent.step.system_messages": step.systemMessages
          ? JSON.stringify(step.systemMessages)
          : "",
        "agent.step.messages": sanitizedMessages ? JSON.stringify(sanitizedMessages) : "",
        ...modelAttributes,
      },
    },
    session.rootContext
  );
  llmSpan.end(new Date(now));
}

export function trackToolResult(sessionId: string, result: TraceToolResult): void {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return;
  }

  const now = Date.now();
  const startTime = new Date(now - Math.max(result.durationMs, 0));
  const toolSpan = tracer.startSpan(
    "agent.tool.execute",
    {
      startTime,
      attributes: {
        "agent.session.id": sessionId,
        "agent.type": session.agentType,
        "telemetry.kind": "tool_result",
        "agent.tool.name": result.toolName,
        "agent.tool.call_id": result.toolCallId,
        "agent.tool.duration_ms": result.durationMs,
        "agent.tool.success": result.toolSuccess ?? true,
        "agent.tool.observation": result.observation,
        "agent.tool.args": JSON.stringify(result.args || {}),
      },
    },
    session.rootContext
  );

  if (result.toolSuccess === false) {
    toolSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: result.observation,
    });
  } else {
    toolSpan.setStatus({ code: SpanStatusCode.OK });
  }

  toolSpan.end(new Date(now));
}

export function addScreenshot(sessionId: string, screenshot: TraceScreenshot): void {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return;
  }

  const screenshotSpan = tracer.startSpan(
    "agent.input.screenshot",
    {
      attributes: {
        "agent.session.id": sessionId,
        "agent.type": session.agentType,
        "telemetry.kind": "screenshot",
        "agent.step.index": screenshot.stepIndex,
        "screenshot.outcome": screenshot.outcome,
        "screenshot.error": screenshot.error ?? "",
        "screenshot.has_data": Boolean(screenshot.dataUrl),
        "screenshot.data_url": screenshot.dataUrl ?? "",
      },
    },
    session.rootContext
  );
  screenshotSpan.end();
}

export function completeTrace(
  sessionId: string,
  success: boolean,
  finalMessage: string,
  status: "completed" | "error" = "completed"
): void {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return;
  }

  session.status = status;
  addEvent(
    sessionId,
    status === "completed" ? "agent.session.completed" : "agent.session.failed",
    finalMessage,
    { success }
  );

  session.rootSpan.setAttribute("agent.session.status", status);
  session.rootSpan.setAttribute("agent.session.success", success);
  session.rootSpan.setAttribute("agent.session.final_message", finalMessage);
  session.rootSpan.setStatus({
    code: success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
    message: finalMessage,
  });
  session.rootSpan.end();

  activeSessions.delete(sessionId);
}

export function updateTraceStatus(
  sessionId: string,
  status: AgentTrace["status"]
): void {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return;
  }

  session.status = status;
  session.rootSpan.setAttribute("agent.session.status", status);
}

function buildTraceMap(): Map<string, AgentTrace> {
  const traces = new Map<string, AgentTrace>();

  for (const session of activeSessions.values()) {
    traces.set(session.sessionId, {
      sessionId: session.sessionId,
      agentType: session.agentType,
      userPrompt: session.userPrompt,
      startedAt: session.startedAt,
      status: session.status,
      events: [],
      llmSteps: [],
      toolResults: [],
      screenshots: [],
    });
  }

  for (const span of getAllKnownSpans()) {
    const sessionId = getStringAttribute(span.attributes, "agent.session.id");
    if (!sessionId) {
      continue;
    }

    const traceEntry = getOrCreateTrace(traces, sessionId, span);
    hydrateTraceFromSpan(traceEntry, span);
  }

  for (const traceEntry of traces.values()) {
    traceEntry.events.sort(compareByTimestamp);
    traceEntry.llmSteps.sort(compareByTimestamp);
    traceEntry.screenshots.sort(compareByTimestamp);
  }

  return traces;
}

function getAllKnownSpans(): ExportedTelemetrySpan[] {
  const spanMap = new Map<string, ExportedTelemetrySpan>();

  for (const span of loadPersistedSpans()) {
    spanMap.set(`${span.traceId}:${span.spanId}`, span);
  }

  for (const span of exportedSpans) {
    spanMap.set(`${span.traceId}:${span.spanId}`, span);
  }

  return Array.from(spanMap.values()).sort((left, right) => {
    return hrTimeToMilliseconds(left.startTime) - hrTimeToMilliseconds(right.startTime);
  });
}

function loadPersistedSpans(): ExportedTelemetrySpan[] {
  const filePaths = getTelemetryLogPaths();
  const existingPaths = filePaths.filter((filePath) => fs.existsSync(filePath));

  if (existingPaths.length === 0) {
    persistedSpanCache.mtimeMs = -1;
    persistedSpanCache.spans = [];
    return [];
  }

  const combinedMtimeMs = existingPaths.reduce((latest, filePath) => {
    return Math.max(latest, fs.statSync(filePath).mtimeMs);
  }, 0);

  if (combinedMtimeMs === persistedSpanCache.mtimeMs) {
    return persistedSpanCache.spans;
  }

  const spans: ExportedTelemetrySpan[] = [];

  for (const filePath of existingPaths) {
    const content = fs.readFileSync(filePath, "utf8");

    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }

      try {
        const parsed = loadPersistedSpansUnsafe(trimmed);
        if (parsed) {
          spans.push(parsed);
        }
      } catch {
        // Ignore malformed log lines to keep the viewer resilient.
      }
    }
  }

  persistedSpanCache.mtimeMs = combinedMtimeMs;
  persistedSpanCache.spans = spans;
  return spans;
}

function getTelemetryLogPaths(): string[] {
  const logDirectory = path.join(__dirname, "../../logs");
  const monthlyFiles = fs.existsSync(logDirectory)
    ? fs.readdirSync(logDirectory)
        .filter((filename) => isTelemetryLogFilename(filename))
        .sort()
        .map((filename) => path.join(logDirectory, filename))
    : [];

  return [
    ...monthlyFiles,
    ...LEGACY_TELEMETRY_LOG_FILENAMES.map((filename) => path.join(logDirectory, filename)),
  ];
}

function getOrCreateTrace(
  traces: Map<string, AgentTrace>,
  sessionId: string,
  span: ExportedTelemetrySpan
): AgentTrace {
  const existing = traces.get(sessionId);
  if (existing) {
    return existing;
  }

  const created: AgentTrace = {
    sessionId,
    agentType: getStringAttribute(span.attributes, "agent.type") || "unknown",
    userPrompt: getStringAttribute(span.attributes, "agent.user_prompt") || "",
    startedAt: hrTimeToISOString(span.startTime),
    status: "completed",
    events: [],
    llmSteps: [],
    toolResults: [],
    screenshots: [],
  };

  traces.set(sessionId, created);
  return created;
}

function hydrateTraceFromSpan(traceEntry: AgentTrace, span: ExportedTelemetrySpan): void {
  const telemetryKind = getStringAttribute(span.attributes, "telemetry.kind");

  if (telemetryKind === "session") {
    hydrateSession(traceEntry, span);
    return;
  }

  if (telemetryKind === "http_request") {
    hydrateHttpRequest(traceEntry, span);
    return;
  }

  if (telemetryKind === "llm_step") {
    hydrateLlmStep(traceEntry, span);
    return;
  }

  if (telemetryKind === "tool_result") {
    hydrateToolResult(traceEntry, span);
    return;
  }

  if (telemetryKind === "screenshot") {
    hydrateScreenshot(traceEntry, span);
    return;
  }

  if (telemetryKind === "event") {
    hydrateEvent(traceEntry, span);
  }
}

function hydrateSession(traceEntry: AgentTrace, span: ExportedTelemetrySpan): void {
  traceEntry.agentType = getStringAttribute(span.attributes, "agent.type") || traceEntry.agentType;
  traceEntry.userPrompt = getStringAttribute(span.attributes, "agent.user_prompt") || traceEntry.userPrompt;
  traceEntry.startedAt = earliestTimestamp(traceEntry.startedAt, hrTimeToISOString(span.startTime));
  traceEntry.completedAt = hrTimeToISOString(span.endTime);
  traceEntry.durationMs = hrTimeToMilliseconds(span.duration);
  traceEntry.status =
    (getStringAttribute(span.attributes, "agent.session.status") as AgentTrace["status"]) ||
    (span.status.code === SpanStatusCode.ERROR ? "error" : "completed");
  traceEntry.success = getBooleanAttribute(span.attributes, "agent.session.success");
  traceEntry.finalMessage = getStringAttribute(span.attributes, "agent.session.final_message");
}

function hydrateHttpRequest(traceEntry: AgentTrace, span: ExportedTelemetrySpan): void {
  const startTimestamp = hrTimeToISOString(span.startTime);
  const endTimestamp = hrTimeToISOString(span.endTime);
  traceEntry.startedAt = earliestTimestamp(traceEntry.startedAt, startTimestamp);

  traceEntry.events.push({
    type: "http.request.received",
    timestamp: startTimestamp,
    message: `${getStringAttribute(span.attributes, "http.method") || "POST"} ${getStringAttribute(span.attributes, "http.route") || "/api/agent/run"}`,
    data: {
      requestId: getStringAttribute(span.attributes, "http.request_id"),
      sessionId: getStringAttribute(span.attributes, "agent.session.id"),
      agentType: getStringAttribute(span.attributes, "agent.type"),
      existingSession: getBooleanAttribute(span.attributes, "agent.session.resume"),
    },
  });

  traceEntry.events.push({
    type: span.status.code === SpanStatusCode.ERROR ? "http.response.failed" : "http.response.sent",
    timestamp: endTimestamp,
    message: `HTTP ${getNumberAttribute(span.attributes, "http.status_code") || 200} response sent`,
    data: {
      requestId: getStringAttribute(span.attributes, "http.request_id"),
      durationMs: hrTimeToMilliseconds(span.duration),
      statusCode: getNumberAttribute(span.attributes, "http.status_code") || 200,
      resultStatus: getStringAttribute(span.attributes, "agent.result.status"),
      resultMessage: getStringAttribute(span.attributes, "agent.result.message"),
    },
  });
}

function hydrateLlmStep(traceEntry: AgentTrace, span: ExportedTelemetrySpan): void {
  const stepNumber = getNumberAttribute(span.attributes, "agent.step.number") || 0;
  const toolCalls = parseToolCalls(span.attributes["agent.step.tool_calls"]);
  const systemMessages = parseStringArray(
    getStringAttribute(span.attributes, "agent.step.system_messages")
  );
  const messages = parseMessages(getStringAttribute(span.attributes, "agent.step.messages"));

  traceEntry.llmSteps.push({
    stepNumber,
    timestamp: hrTimeToISOString(span.startTime),
    finishReason: getStringAttribute(span.attributes, "agent.step.finish_reason") || "unknown",
    requestModel: getStringAttribute(span.attributes, "gen_ai.request.model"),
    responseModel: getStringAttribute(span.attributes, "gen_ai.response.model"),
    responseId: getStringAttribute(span.attributes, "gen_ai.response.id"),
    provider: getStringAttribute(span.attributes, "gen_ai.provider.name"),
    inputTokens: getNumberAttribute(span.attributes, "gen_ai.usage.input_tokens"),
    outputTokens: getNumberAttribute(span.attributes, "gen_ai.usage.output_tokens"),
    reasoningTokens: getNumberAttribute(
      span.attributes,
      "gen_ai.usage.reasoning.output_tokens"
    ),
    cacheReadTokens: getNumberAttribute(
      span.attributes,
      "gen_ai.usage.cache_read.input_tokens"
    ),
    totalTokens: getNumberAttribute(span.attributes, "agent.step.total_tokens"),
    responseTimeMs: getNumberAttribute(span.attributes, "agent.step.response_time_ms"),
    stepTimeMs: getNumberAttribute(span.attributes, "agent.step.total_time_ms"),
    outputTokensPerSecond: getNumberAttribute(
      span.attributes,
      "agent.step.output_tokens_per_second"
    ),
    text: getStringAttribute(span.attributes, "agent.step.text") || "",
    toolCalls,
    systemMessages,
    messages,
  });

  traceEntry.events.push({
    type: "agent.llm.step.completed",
    timestamp: hrTimeToISOString(span.startTime),
    message: `LLM step ${stepNumber} finished with ${getStringAttribute(span.attributes, "agent.step.finish_reason") || "unknown"}`,
    data: {
      toolCalls: toolCalls.map((toolCall) => toolCall.toolName),
    },
  });
}

function hydrateToolResult(traceEntry: AgentTrace, span: ExportedTelemetrySpan): void {
  const toolName = getStringAttribute(span.attributes, "agent.tool.name") || "unknown";
  const durationMs = getNumberAttribute(span.attributes, "agent.tool.duration_ms") || hrTimeToMilliseconds(span.duration);
  const args = parseArgs(getStringAttribute(span.attributes, "agent.tool.args"));

  traceEntry.toolResults.push({
    toolCallId: getStringAttribute(span.attributes, "agent.tool.call_id") || "",
    toolName,
    observation: getStringAttribute(span.attributes, "agent.tool.observation") || "",
    toolSuccess: getBooleanAttribute(span.attributes, "agent.tool.success"),
    durationMs,
    args,
  });

  traceEntry.events.push({
    type: getBooleanAttribute(span.attributes, "agent.tool.success") === false
      ? "agent.tool.failed"
      : "agent.tool.completed",
    timestamp: hrTimeToISOString(span.endTime),
    message: getBooleanAttribute(span.attributes, "agent.tool.success") === false
      ? `${toolName} failed after ${durationMs}ms`
      : `${toolName} completed in ${durationMs}ms`,
    data: {
      toolName,
      durationMs,
      success: getBooleanAttribute(span.attributes, "agent.tool.success"),
      args,
    },
  });
}

function hydrateScreenshot(traceEntry: AgentTrace, span: ExportedTelemetrySpan): void {
  const screenshot: TraceScreenshot = {
    stepIndex: getNumberAttribute(span.attributes, "agent.step.index") || 0,
    timestamp: hrTimeToISOString(span.startTime),
    outcome: (getStringAttribute(span.attributes, "screenshot.outcome") as TraceScreenshot["outcome"]) || "captured",
    error: getStringAttribute(span.attributes, "screenshot.error") || undefined,
    dataUrl: getStringAttribute(span.attributes, "screenshot.data_url") || undefined,
  };

  traceEntry.screenshots.push(screenshot);
  traceEntry.events.push({
    type: screenshot.outcome === "error" ? "agent.screenshot.failed" : "agent.screenshot.received",
    timestamp: screenshot.timestamp,
    message: `Screenshot ${screenshot.outcome}`,
    data: {
      stepIndex: screenshot.stepIndex,
      hasData: Boolean(screenshot.dataUrl),
      error: screenshot.error,
    },
  });
}

function hydrateEvent(traceEntry: AgentTrace, span: ExportedTelemetrySpan): void {
  traceEntry.events.push({
    type: getStringAttribute(span.attributes, "telemetry.event.type") || "telemetry.event",
    timestamp: hrTimeToISOString(span.startTime),
    message: getStringAttribute(span.attributes, "telemetry.message") || span.name,
    data: extractEventData(span.attributes),
  });
}

function loadPersistedSpansUnsafe(line: string): ExportedTelemetrySpan | undefined {
  const parsed = JSON.parse(line) as Partial<ExportedTelemetrySpan>;
  if (!parsed.traceId || !parsed.spanId || !parsed.attributes) {
    return undefined;
  }

  return {
    traceId: parsed.traceId,
    spanId: parsed.spanId,
    parentSpanId: parsed.parentSpanId,
    name: parsed.name || "unknown",
    status: parsed.status || { code: 0 },
    startTime: parsed.startTime || [0, 0],
    endTime: parsed.endTime || [0, 0],
    duration: parsed.duration || [0, 0],
    attributes: parsed.attributes,
    resourceAttributes: parsed.resourceAttributes,
    events: parsed.events || [],
  };
}

function serializeSpan(span: ReadableSpan): ExportedTelemetrySpan {
  return {
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentSpanId: span.parentSpanContext?.spanId,
    name: span.name,
    status: {
      code: span.status.code,
      message: span.status.message,
    },
    startTime: span.startTime,
    endTime: span.endTime,
    duration: span.duration,
    attributes: { ...span.attributes },
    resourceAttributes: { ...span.resource.attributes },
    events: span.events.map((event) => ({
      name: event.name,
      time: event.time,
      attributes: event.attributes ? { ...event.attributes } : undefined,
    })),
  };
}

function normalizeAttributes(data?: Record<string, unknown>): Record<string, string | number | boolean> {
  if (!data) {
    return {};
  }

  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(data)) {
    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      normalized[key] = value;
    } else {
      normalized[key] = JSON.stringify(value);
    }
  }

  return normalized;
}

function setOptionalAttribute(
  attributes: Record<string, string | number>,
  key: string,
  value: string | number | undefined
): void {
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      attributes[key] = value;
    }
    return;
  }
  if (value) {
    attributes[key] = value;
  }
}

function extractEventData(attributes: Record<string, unknown>): Record<string, unknown> | undefined {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("agent.") || key.startsWith("telemetry.") || key.startsWith("http.")) {
      continue;
    }

    data[key] = parseMaybeJson(value);
  }

  return Object.keys(data).length > 0 ? data : undefined;
}

function parseToolCalls(value: unknown): TraceToolCall[] {
  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as Array<Record<string, unknown>>;
    return parsed.map((entry) => ({
      toolName: typeof entry.toolName === "string" ? entry.toolName : "unknown",
      toolCallId: typeof entry.toolCallId === "string" ? entry.toolCallId : "",
      args: isRecord(entry.args) ? entry.args : {},
      actionSummary: typeof entry.actionSummary === "string" ? entry.actionSummary : "",
    }));
  } catch {
    return [];
  }
}

function parseMessages(value: string | undefined): Array<{ role: string; content: unknown }> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
    return undefined;
  } catch {
    return undefined;
  }
}

function parseStringArray(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const values = parsed.filter((entry): entry is string => typeof entry === "string");
    return values.length ? values : undefined;
  } catch {
    return undefined;
  }
}

function parseArgs(value: string | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getStringAttribute(attributes: Record<string, unknown>, key: string): string | undefined {
  const value = attributes[key];
  return typeof value === "string" ? value : undefined;
}

function getBooleanAttribute(attributes: Record<string, unknown>, key: string): boolean | undefined {
  const value = attributes[key];
  return typeof value === "boolean" ? value : undefined;
}

function getNumberAttribute(attributes: Record<string, unknown>, key: string): number | undefined {
  const value = attributes[key];
  return typeof value === "number" ? value : undefined;
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function hrTimeToISOString(time: [number, number]): string {
  return new Date(time[0] * 1000 + Math.floor(time[1] / 1_000_000)).toISOString();
}

function hrTimeToMilliseconds(time: [number, number]): number {
  return Math.round(time[0] * 1000 + time[1] / 1_000_000);
}

function compareByTimestamp(left: { timestamp: string }, right: { timestamp: string }): number {
  return new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime();
}

function earliestTimestamp(current: string, incoming: string): string {
  return new Date(incoming).getTime() < new Date(current).getTime() ? incoming : current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
