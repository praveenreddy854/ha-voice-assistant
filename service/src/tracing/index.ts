/**
 * OpenTelemetry Configuration for TV Agent Tracing
 * Sets up tracing with file export to logs directory
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { trace, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { FileSpanExporter } from "./fileExporter";
import path from "path";

const LOG_DIRECTORY = path.join(__dirname, "../../logs");

// Initialize the file exporter
const fileExporter = new FileSpanExporter({
  logDirectory: LOG_DIRECTORY,
  filename: "tv-agent-traces.jsonl",
});

// Create the SDK with file exporter (using SimpleSpanProcessor for immediate export)
const sdk = new NodeSDK({
  spanProcessors: [new SimpleSpanProcessor(fileExporter)],
  serviceName: "tv-agent-service",
});

// Initialize tracing
export function initializeTracing(): void {
  sdk.start();
  console.log(
    "OpenTelemetry tracing initialized with file export to:",
    LOG_DIRECTORY
  );
}

// Get tracer instance
export const getTracer = () => trace.getTracer("tv-agent", "1.0.0");

// Helper function to create a span for TV Agent operations
export function createTVAgentSpan(
  operationName: string,
  attributes: Record<string, string | number | boolean> = {}
) {
  const tracer = getTracer();
  return tracer.startSpan(operationName, {
    kind: SpanKind.INTERNAL,
    attributes: {
      "service.name": "tv-agent",
      "operation.type": "tv-control",
      ...attributes,
    },
  });
}

// Helper to log prompt and response
export function logPromptAndResponse(
  span: any,
  prompt: string,
  response: string,
  additionalContext?: Record<string, any>
) {
  // Add prompt as span event
  span.addEvent("prompt.input", {
    "prompt.content": prompt,
    "prompt.timestamp": Date.now(),
    "prompt.length": prompt.length,
    ...(additionalContext?.prompt || {}),
  });

  // Add response as span event
  span.addEvent("response.output", {
    "response.content": response,
    "response.timestamp": Date.now(),
    "response.length": response.length,
    ...(additionalContext?.response || {}),
  });

  // Set span attributes for searchability
  span.setAttributes({
    "prompt.hash": hashString(prompt),
    "response.hash": hashString(response),
    "interaction.completed": true,
  });
}

// Simple hash function for content identification
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16);
}

// Graceful shutdown
export function shutdownTracing(): Promise<void> {
  return sdk.shutdown();
}

export { SpanKind, SpanStatusCode };
