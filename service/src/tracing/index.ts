/**
 * OpenTelemetry configuration and telemetry helpers.
 * Provides:
 * - Trace spans with structured story events
 * - Metric counters/histograms for request and workflow visibility
 * - Configurable exporters for local debugging and dashboards
 */

import {
  context,
  metrics,
  trace,
  type Attributes,
  type Span,
  type SpanOptions,
  SpanKind,
  SpanStatusCode,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import path from "path";
import { FileSpanExporter } from "./fileExporter";
import { FileMetricExporter } from "./metricExporter";

const LOG_DIRECTORY = path.join(__dirname, "../../logs");
const TELEMETRY_SPAN_FILE = path.join(LOG_DIRECTORY, "telemetry-spans.jsonl");
const TELEMETRY_METRIC_FILE = path.join(
  LOG_DIRECTORY,
  "telemetry-metrics.jsonl"
);

const TELEMETRY_VERSION = "2.1.0";
const TELEMETRY_NAMESPACE = "ha-voice-assistant.telemetry";
const MAX_ATTRIBUTE_TEXT_LENGTH = 1024;
const MAX_EVENT_TEXT_LENGTH = 4000;

const SERVICE_NAME =
  process.env.OTEL_SERVICE_NAME || "ha-voice-assistant-service";
const EXPORT_MODE = resolveExportMode(process.env.OTEL_EXPORT_MODE);
const OTLP_ENDPOINT =
  (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318").replace(
    /\/+$/,
    ""
  );
const OTLP_HEADERS = parseOtlpHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS);

const METRIC_EXPORT_INTERVAL_MS = parsePositiveInt(
  process.env.OTEL_METRIC_EXPORT_INTERVAL_MS,
  10000
);
const METRIC_EXPORT_TIMEOUT_MS = parsePositiveInt(
  process.env.OTEL_METRIC_EXPORT_TIMEOUT_MS,
  5000
);

type TelemetryExportMode = "file" | "otlp" | "both";

const spanProcessors: BatchSpanProcessor[] = [];
const metricReaders: PeriodicExportingMetricReader[] = [];
const telemetryOutputs: string[] = [];

const fileSpanExporter = new FileSpanExporter({
  logDirectory: LOG_DIRECTORY,
  filename: "telemetry-spans.jsonl",
  maxAttributeLength: MAX_ATTRIBUTE_TEXT_LENGTH,
});

const fileMetricExporter = new FileMetricExporter({
  logDirectory: LOG_DIRECTORY,
  filename: "telemetry-metrics.jsonl",
  maxAttributeLength: MAX_ATTRIBUTE_TEXT_LENGTH,
});

const shouldExportToFile = EXPORT_MODE === "file" || EXPORT_MODE === "both";
const shouldExportToOtlp = EXPORT_MODE === "otlp" || EXPORT_MODE === "both";

if (shouldExportToFile) {
  spanProcessors.push(createBatchSpanProcessor(fileSpanExporter));
  metricReaders.push(createMetricReader(fileMetricExporter));
  telemetryOutputs.push(`file:${TELEMETRY_SPAN_FILE}`);
  telemetryOutputs.push(`file:${TELEMETRY_METRIC_FILE}`);
}

if (shouldExportToOtlp) {
  const otlpTraceExporter = new OTLPTraceExporter({
    url: `${OTLP_ENDPOINT}/v1/traces`,
    headers: OTLP_HEADERS,
  });
  const otlpMetricExporter = new OTLPMetricExporter({
    url: `${OTLP_ENDPOINT}/v1/metrics`,
    headers: OTLP_HEADERS,
  });

  spanProcessors.push(createBatchSpanProcessor(otlpTraceExporter));
  metricReaders.push(createMetricReader(otlpMetricExporter));
  telemetryOutputs.push(`otlp-http:${OTLP_ENDPOINT}`);
}

if (spanProcessors.length === 0 || metricReaders.length === 0) {
  if (spanProcessors.length === 0) {
    spanProcessors.push(createBatchSpanProcessor(fileSpanExporter));
    telemetryOutputs.push(`file:${TELEMETRY_SPAN_FILE}`);
  }

  if (metricReaders.length === 0) {
    metricReaders.push(createMetricReader(fileMetricExporter));
    telemetryOutputs.push(`file:${TELEMETRY_METRIC_FILE}`);
  }
}

const sdk = new NodeSDK({
  serviceName: SERVICE_NAME,
  spanProcessors,
  metricReaders,
  instrumentations: [new HttpInstrumentation()],
});

type TelemetryMetrics = {
  httpRequestsTotal: ReturnType<
    ReturnType<typeof metrics.getMeter>["createCounter"]
  >;
  httpRequestDurationMs: ReturnType<
    ReturnType<typeof metrics.getMeter>["createHistogram"]
  >;
  httpActiveRequests: ReturnType<
    ReturnType<typeof metrics.getMeter>["createUpDownCounter"]
  >;
  workflowRunsTotal: ReturnType<
    ReturnType<typeof metrics.getMeter>["createCounter"]
  >;
  workflowStepsTotal: ReturnType<
    ReturnType<typeof metrics.getMeter>["createCounter"]
  >;
  toolCallsTotal: ReturnType<
    ReturnType<typeof metrics.getMeter>["createCounter"]
  >;
  externalCallsTotal: ReturnType<
    ReturnType<typeof metrics.getMeter>["createCounter"]
  >;
  externalCallDurationMs: ReturnType<
    ReturnType<typeof metrics.getMeter>["createHistogram"]
  >;
  retriesTotal: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
  errorsTotal: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
  tvAgentActiveSessions: ReturnType<
    ReturnType<typeof metrics.getMeter>["createUpDownCounter"]
  >;
  tvAgentScreenshotEvents: ReturnType<
    ReturnType<typeof metrics.getMeter>["createCounter"]
  >;
};

let tracingStarted = false;
let telemetryMetrics: TelemetryMetrics | null = null;

function getMeter() {
  return metrics.getMeter(TELEMETRY_NAMESPACE, TELEMETRY_VERSION);
}

function initializeMetrics(): TelemetryMetrics {
  if (telemetryMetrics) {
    return telemetryMetrics;
  }

  const meter = getMeter();
  telemetryMetrics = {
    httpRequestsTotal: meter.createCounter("http.requests.total", {
      description: "Total number of HTTP requests processed",
    }),
    httpRequestDurationMs: meter.createHistogram("http.request.duration_ms", {
      description: "HTTP request duration in milliseconds",
      unit: "ms",
    }),
    httpActiveRequests: meter.createUpDownCounter("http.requests.active", {
      description: "Number of in-flight HTTP requests",
    }),
    workflowRunsTotal: meter.createCounter("workflow.runs.total", {
      description: "Total workflow executions",
    }),
    workflowStepsTotal: meter.createCounter("workflow.steps.total", {
      description: "Total workflow step transitions",
    }),
    toolCallsTotal: meter.createCounter("workflow.tool_calls.total", {
      description: "Total tool calls requested by models",
    }),
    externalCallsTotal: meter.createCounter("external.calls.total", {
      description: "Total external dependency calls",
    }),
    externalCallDurationMs: meter.createHistogram("external.call.duration_ms", {
      description: "Duration of external dependency calls",
      unit: "ms",
    }),
    retriesTotal: meter.createCounter("external.retries.total", {
      description: "Total retry attempts across dependencies",
    }),
    errorsTotal: meter.createCounter("errors.total", {
      description: "Total number of handled errors",
    }),
    tvAgentActiveSessions: meter.createUpDownCounter("tv_agent.sessions.active", {
      description: "Active TV agent sessions",
    }),
    tvAgentScreenshotEvents: meter.createCounter("tv_agent.screenshots.total", {
      description: "TV agent screenshot-related events",
    }),
  };

  return telemetryMetrics;
}

export function getTelemetryMetrics(): TelemetryMetrics {
  return initializeMetrics();
}

export function initializeTracing(): void {
  if (tracingStarted) {
    return;
  }

  sdk.start();
  tracingStarted = true;
  initializeMetrics();

  console.log("OpenTelemetry initialized", {
    serviceName: SERVICE_NAME,
    exportMode: EXPORT_MODE,
    outputs: telemetryOutputs,
    metricExportIntervalMs: METRIC_EXPORT_INTERVAL_MS,
    metricExportTimeoutMs: METRIC_EXPORT_TIMEOUT_MS,
  });
}

export async function shutdownTracing(): Promise<void> {
  if (!tracingStarted) {
    return;
  }
  await sdk.shutdown();
  tracingStarted = false;
}

export const getTracer = () =>
  trace.getTracer(TELEMETRY_NAMESPACE, TELEMETRY_VERSION);

export const getActiveSpan = (): Span | undefined => trace.getActiveSpan();

export async function withSpan<T>(
  name: string,
  options: SpanOptions | undefined,
  run: (span: Span) => Promise<T>
): Promise<T> {
  const span = getTracer().startSpan(name, {
    ...options,
    attributes: toSpanAttributes(options?.attributes),
  });

  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      return await run(span);
    } catch (error) {
      recordSpanError(span, error);
      throw error;
    } finally {
      span.end();
    }
  });
}

export function addStoryEvent(
  span: Span | undefined,
  name: string,
  attributes?: Record<string, unknown>
): void {
  if (!span) {
    return;
  }

  span.addEvent(name, toSpanAttributes(attributes, MAX_EVENT_TEXT_LENGTH));
}

export function setSpanAttributes(
  span: Span | undefined,
  attributes?: Record<string, unknown>
): void {
  if (!span || !attributes) {
    return;
  }
  span.setAttributes(toSpanAttributes(attributes));
}

export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function recordSpanError(
  span: Span | undefined,
  error: unknown,
  attributes?: Record<string, unknown>
): void {
  if (!span) {
    return;
  }

  const err = error instanceof Error ? error : new Error(String(error));
  span.recordException(err);
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: err.message,
  });
  addStoryEvent(span, "error", {
    "error.name": err.name,
    "error.message": err.message,
    ...attributes,
  });
}

export function createTVAgentSpan(
  operationName: string,
  attributes: Record<string, string | number | boolean> = {}
): Span {
  return getTracer().startSpan(operationName, {
    kind: SpanKind.INTERNAL,
    attributes: toSpanAttributes({
      "service.name": SERVICE_NAME,
      "agent.name": "tv-agent",
      "operation.type": "tv-control",
      ...attributes,
    }),
  });
}

export function logPromptAndResponse(
  span: Span,
  prompt: string,
  response: string,
  additionalContext?: Record<string, unknown>
): void {
  const promptPreview = truncate(prompt, MAX_EVENT_TEXT_LENGTH);
  const responsePreview = truncate(response, MAX_EVENT_TEXT_LENGTH);

  addStoryEvent(span, "llm.prompt", {
    "llm.prompt.length": prompt.length,
    "llm.prompt.hash": hashString(prompt),
    "llm.prompt.preview": promptPreview,
    ...(additionalContext?.prompt as Record<string, unknown>),
  });

  addStoryEvent(span, "llm.response", {
    "llm.response.length": response.length,
    "llm.response.hash": hashString(response),
    "llm.response.preview": responsePreview,
    ...(additionalContext?.response as Record<string, unknown>),
  });

  setSpanAttributes(span, {
    "interaction.completed": true,
    "interaction.prompt_hash": hashString(prompt),
    "interaction.response_hash": hashString(response),
  });
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength)}…`;
}

function toSpanAttributes(
  attributes: Record<string, unknown> | undefined,
  maxLength: number = MAX_ATTRIBUTE_TEXT_LENGTH
): Attributes {
  const mapped: Attributes = {};
  if (!attributes) {
    return mapped;
  }

  for (const [key, value] of Object.entries(attributes)) {
    const normalized = normalizeAttributeValue(value, maxLength);
    if (normalized !== undefined) {
      mapped[key] = normalized;
    }
  }

  return mapped;
}

function normalizeAttributeValue(
  value: unknown,
  maxLength: number
): string | number | boolean | undefined {
  if (typeof value === "string") {
    return truncate(value, maxLength);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === null || value === undefined) {
    return undefined;
  }

  if (value instanceof Error) {
    return truncate(`${value.name}: ${value.message}`, maxLength);
  }

  if (Array.isArray(value)) {
    return truncate(JSON.stringify(value.slice(0, 20)), maxLength);
  }

  return truncate(JSON.stringify(value), maxLength);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw || "", 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  return fallback;
}

function resolveExportMode(raw: string | undefined): TelemetryExportMode {
  const normalized = (raw || "file").trim().toLowerCase();
  if (normalized === "otlp" || normalized === "file" || normalized === "both") {
    return normalized;
  }

  console.warn(
    `Invalid OTEL_EXPORT_MODE=\"${raw}\". Falling back to \"file\".`
  );
  return "file";
}

function parseOtlpHeaders(
  rawHeaders: string | undefined
): Record<string, string> | undefined {
  if (!rawHeaders) {
    return undefined;
  }

  const entries = rawHeaders
    .split(",")
    .map((header) => header.trim())
    .filter(Boolean)
    .map((header) => {
      const separatorIndex = header.indexOf("=");
      if (separatorIndex <= 0) {
        return null;
      }

      const key = header.slice(0, separatorIndex).trim();
      const value = header.slice(separatorIndex + 1).trim();
      if (!key || !value) {
        return null;
      }

      return [key, value] as const;
    })
    .filter((pair): pair is readonly [string, string] => pair !== null);

  if (entries.length === 0) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function createBatchSpanProcessor(exporter: SpanExporter): BatchSpanProcessor {
  return new BatchSpanProcessor(exporter, {
    maxExportBatchSize: 128,
    maxQueueSize: 2048,
    scheduledDelayMillis: 1000,
    exportTimeoutMillis: 5000,
  });
}

function createMetricReader(
  exporter: PushMetricExporter
): PeriodicExportingMetricReader {
  return new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS,
    exportTimeoutMillis: METRIC_EXPORT_TIMEOUT_MS,
  });
}

export { SpanKind, SpanStatusCode };
