/**
 * File-based OpenTelemetry span exporter for local debugging.
 * One JSON object per line.
 */

import type { Attributes, HrTime } from "@opentelemetry/api";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import fs from "fs";
import path from "path";

export interface FileExporterOptions {
  logDirectory: string;
  filename?: string;
  maxAttributeLength?: number;
}

type SerializedSpanEvent = {
  name: string;
  timeUnixMs: number;
  attributes: Record<string, string | number | boolean>;
};

type SerializedSpan = {
  exportedAt: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  statusCode: number;
  statusMessage?: string;
  durationMs: number;
  startTimeUnixMs: number;
  endTimeUnixMs: number;
  attributes: Record<string, string | number | boolean>;
  events: SerializedSpanEvent[];
  links: Array<{ traceId: string; spanId: string }>;
  instrumentationScope?: {
    name: string;
    version?: string;
  };
  resource?: Record<string, unknown>;
};

export class FileSpanExporter implements SpanExporter {
  private readonly logDirectory: string;
  private readonly filename: string;
  private readonly maxAttributeLength: number;

  constructor(options: FileExporterOptions) {
    this.logDirectory = options.logDirectory;
    this.filename = options.filename ?? "traces.jsonl";
    this.maxAttributeLength = options.maxAttributeLength ?? 1024;

    if (!fs.existsSync(this.logDirectory)) {
      fs.mkdirSync(this.logDirectory, { recursive: true });
    }
  }

  async export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void
  ): Promise<void> {
    try {
      const filePath = path.join(this.logDirectory, this.filename);
      const lines = spans.map((span) => {
        const serialized: SerializedSpan = {
          exportedAt: new Date().toISOString(),
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          parentSpanId: span.parentSpanContext?.spanId,
          name: span.name,
          kind: span.kind,
          statusCode: span.status.code,
          statusMessage: span.status.message,
          durationMs: this.hrTimeToMs(span.duration),
          startTimeUnixMs: this.hrTimeToEpochMs(span.startTime),
          endTimeUnixMs: this.hrTimeToEpochMs(span.endTime),
          attributes: this.sanitizeAttributes(span.attributes),
          events: span.events.map((event) => ({
            name: event.name,
            timeUnixMs: this.hrTimeToEpochMs(event.time),
            attributes: this.sanitizeAttributes(event.attributes),
          })),
          links: span.links.map((link) => ({
            traceId: link.context.traceId,
            spanId: link.context.spanId,
          })),
          instrumentationScope: span.instrumentationScope
            ? {
                name: span.instrumentationScope.name,
                version: span.instrumentationScope.version,
              }
            : undefined,
          resource: span.resource?.attributes,
        };

        return JSON.stringify(serialized);
      });

      fs.appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      console.error("Failed to export spans to file:", error);
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}

  private hrTimeToEpochMs(hrTime: HrTime): number {
    return hrTime[0] * 1_000 + hrTime[1] / 1_000_000;
  }

  private hrTimeToMs(hrTime: HrTime): number {
    return hrTime[0] * 1_000 + hrTime[1] / 1_000_000;
  }

  private sanitizeAttributes(
    attributes: Attributes | undefined
  ): Record<string, string | number | boolean> {
    const sanitized: Record<string, string | number | boolean> = {};
    if (!attributes) {
      return sanitized;
    }

    for (const [key, value] of Object.entries(attributes)) {
      const converted = this.convertAttributeValue(value);
      if (converted !== undefined) {
        sanitized[key] = converted;
      }
    }

    return sanitized;
  }

  private convertAttributeValue(
    value: unknown
  ): string | number | boolean | undefined {
    if (typeof value === "string") {
      if (value.length <= this.maxAttributeLength) {
        return value;
      }
      return `${value.slice(0, this.maxAttributeLength)}…`;
    }

    if (typeof value === "number") {
      return Number.isFinite(value) ? value : undefined;
    }

    if (typeof value === "boolean") {
      return value;
    }

    if (Array.isArray(value)) {
      const serialized = JSON.stringify(value.slice(0, 10));
      return serialized.length <= this.maxAttributeLength
        ? serialized
        : `${serialized.slice(0, this.maxAttributeLength)}…`;
    }

    if (value === null || value === undefined) {
      return undefined;
    }

    const serialized = JSON.stringify(value);
    if (serialized.length <= this.maxAttributeLength) {
      return serialized;
    }
    return `${serialized.slice(0, this.maxAttributeLength)}…`;
  }
}
