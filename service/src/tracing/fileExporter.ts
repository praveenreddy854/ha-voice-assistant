/**
 * Custom File Exporter for OpenTelemetry Traces
 * Writes trace spans to local log files
 */

import { ExportResult, ExportResultCode } from "@opentelemetry/core";
import { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import fs from "fs";
import path from "path";

export const TELEMETRY_LOG_BASENAME = "service-telemetry";

export function getTelemetryLogFilename(date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${TELEMETRY_LOG_BASENAME}-${year}-${month}-${day}.jsonl`;
}

export function isTelemetryLogFilename(filename: string): boolean {
  // Match both daily (YYYY-MM-DD) and legacy monthly (YYYY-MM) formats
  return new RegExp(`^${TELEMETRY_LOG_BASENAME}-\\d{4}-\\d{2}(-\\d{2})?\\.jsonl$`).test(filename);
}

export interface FileExporterOptions {
  logDirectory: string;
  filename?: string;
}

export class FileSpanExporter implements SpanExporter {
  private logDirectory: string;
  private filenamePrefix: string;

  constructor(options: FileExporterOptions) {
    this.logDirectory = options.logDirectory;
    this.filenamePrefix = options.filename || TELEMETRY_LOG_BASENAME;

    // Ensure log directory exists
    if (!fs.existsSync(this.logDirectory)) {
      fs.mkdirSync(this.logDirectory, { recursive: true });
    }
  }

  async export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void
  ): Promise<void> {
    try {
      const filePath = path.join(
        this.logDirectory,
        this.filenamePrefix === TELEMETRY_LOG_BASENAME
          ? getTelemetryLogFilename()
          : `${this.filenamePrefix}-${getTelemetryLogFilename().replace(`${TELEMETRY_LOG_BASENAME}-`, "")}`
      );

      for (const span of spans) {
        const traceData = {
          timestamp: new Date().toISOString(),
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          name: span.name,
          kind: span.kind,
          status: span.status,
          startTime: span.startTime,
          endTime: span.endTime,
          duration: span.duration,
          attributes: span.attributes,
          resourceAttributes: span.resource.attributes,
          events: span.events,
          links: span.links,
        };

        // Write each trace as a JSON line
        const logLine = JSON.stringify(traceData) + "\n";
        fs.appendFileSync(filePath, logLine, "utf8");
      }

      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      console.error("Failed to export spans to file:", error);
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  async shutdown(): Promise<void> {
    // No cleanup needed for file exporter
  }

  async forceFlush(): Promise<void> {
    // No buffering, so nothing to flush
  }
}
