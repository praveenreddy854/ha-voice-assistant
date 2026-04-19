/**
 * Telemetry Viewer API Routes
 *
 * Provides endpoints for the telemetry viewer UI to fetch OTEL-backed
 * agent session data.
 */

import { Router, Request, Response } from "express";
import { getAllTraces, getTrace } from "./agentTraceStore";

export const traceRouter = Router();

function sendTraceSummaries(_req: Request, res: Response): void {
  const traces = getAllTraces().map((t) => ({
    sessionId: t.sessionId,
    agentType: t.agentType,
    userPrompt: t.userPrompt,
    startedAt: t.startedAt,
    completedAt: t.completedAt,
    status: t.status,
    success: t.success,
    finalMessage: t.finalMessage,
    durationMs: t.durationMs,
    eventCount: t.events.length,
    toolCallCount: t.toolResults.length,
    screenshotCount: t.screenshots.length,
  }));
  res.json(traces);
}

function sendTraceDetail(req: Request, res: Response): void {
  const trace = getTrace(req.params.sessionId);
  if (!trace) {
    res.status(404).json({ error: "Trace not found" });
    return;
  }
  res.json(trace);
}

traceRouter.get("/api/telemetry/sessions", sendTraceSummaries);
traceRouter.get("/api/telemetry/sessions/:sessionId", sendTraceDetail);

// Compatibility aliases for the in-progress viewer work.
traceRouter.get("/api/traces", sendTraceSummaries);
traceRouter.get("/api/traces/:sessionId", sendTraceDetail);
