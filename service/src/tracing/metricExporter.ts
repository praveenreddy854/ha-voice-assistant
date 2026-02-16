/**
 * File-based OpenTelemetry metric exporter for local debugging.
 * One JSON object per datapoint line.
 */

import type { ExportResult } from "@opentelemetry/core";
import { ExportResultCode } from "@opentelemetry/core";
import {
  AggregationTemporality,
  DataPointType,
  InstrumentType,
  type PushMetricExporter,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import fs from "fs";
import path from "path";

export interface FileMetricExporterOptions {
  logDirectory: string;
  filename?: string;
  maxAttributeLength?: number;
}

type SerializableMetricPoint = {
  exportedAt: string;
  metricName: string;
  metricDescription: string;
  metricUnit: string;
  dataPointType: string;
  aggregationTemporality: string;
  startTimeUnixMs: number;
  endTimeUnixMs: number;
  attributes: Record<string, string | number | boolean>;
  value: unknown;
  scope?: {
    name: string;
    version?: string;
  };
  resource?: Record<string, unknown>;
};

export class FileMetricExporter implements PushMetricExporter {
  private readonly logDirectory: string;
  private readonly filename: string;
  private readonly maxAttributeLength: number;
  private shutdownRequested: boolean;

  constructor(options: FileMetricExporterOptions) {
    this.logDirectory = options.logDirectory;
    this.filename = options.filename ?? "metrics.jsonl";
    this.maxAttributeLength = options.maxAttributeLength ?? 1024;
    this.shutdownRequested = false;

    if (!fs.existsSync(this.logDirectory)) {
      fs.mkdirSync(this.logDirectory, { recursive: true });
    }
  }

  export(
    metrics: ResourceMetrics,
    resultCallback: (result: ExportResult) => void
  ): void {
    if (this.shutdownRequested) {
      setImmediate(() => resultCallback({ code: ExportResultCode.FAILED }));
      return;
    }

    try {
      const lines: string[] = [];
      const exportedAt = new Date().toISOString();

      for (const scopeMetrics of metrics.scopeMetrics) {
        for (const metric of scopeMetrics.metrics) {
          for (const dataPoint of metric.dataPoints) {
            const serialized: SerializableMetricPoint = {
              exportedAt,
              metricName: metric.descriptor.name,
              metricDescription: metric.descriptor.description,
              metricUnit: metric.descriptor.unit,
              dataPointType: this.dataPointTypeLabel(metric.dataPointType),
              aggregationTemporality: String(metric.aggregationTemporality),
              startTimeUnixMs: this.hrTimeToEpochMs(dataPoint.startTime),
              endTimeUnixMs: this.hrTimeToEpochMs(dataPoint.endTime),
              attributes: this.sanitizeAttributes(dataPoint.attributes),
              value: this.normalizeValue(metric.dataPointType, dataPoint.value),
              scope: scopeMetrics.scope
                ? {
                    name: scopeMetrics.scope.name,
                    version: scopeMetrics.scope.version,
                  }
                : undefined,
              resource: metrics.resource?.attributes,
            };

            lines.push(JSON.stringify(serialized));
          }
        }
      }

      if (lines.length > 0) {
        const filePath = path.join(this.logDirectory, this.filename);
        fs.appendFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
      }

      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      console.error("Failed to export metrics to file:", error);
      resultCallback({
        code: ExportResultCode.FAILED,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }

  forceFlush(): Promise<void> {
    return Promise.resolve();
  }

  selectAggregationTemporality(
    _instrumentType: InstrumentType
  ): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE;
  }

  shutdown(): Promise<void> {
    this.shutdownRequested = true;
    return Promise.resolve();
  }

  private hrTimeToEpochMs(hrTime: [number, number]): number {
    return hrTime[0] * 1_000 + hrTime[1] / 1_000_000;
  }

  private dataPointTypeLabel(dataPointType: DataPointType): string {
    switch (dataPointType) {
      case DataPointType.SUM:
        return "sum";
      case DataPointType.GAUGE:
        return "gauge";
      case DataPointType.HISTOGRAM:
        return "histogram";
      case DataPointType.EXPONENTIAL_HISTOGRAM:
        return "exponential_histogram";
      default:
        return "unknown";
    }
  }

  private sanitizeAttributes(
    attributes: Record<string, unknown> | undefined
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
    if (value === null || value === undefined) {
      return undefined;
    }

    const serialized = JSON.stringify(value);
    if (serialized.length <= this.maxAttributeLength) {
      return serialized;
    }
    return `${serialized.slice(0, this.maxAttributeLength)}…`;
  }

  private normalizeValue(
    dataPointType: DataPointType,
    value: unknown
  ): Record<string, unknown> | number | string | null {
    if (typeof value === "number") {
      return value;
    }

    if (!value || typeof value !== "object") {
      return null;
    }

    if (
      dataPointType === DataPointType.HISTOGRAM ||
      dataPointType === DataPointType.EXPONENTIAL_HISTOGRAM
    ) {
      return value as Record<string, unknown>;
    }

    return value as Record<string, unknown>;
  }
}
