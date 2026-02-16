import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from "express";
import { randomUUID } from "crypto";
import { context, trace, type Span } from "@opentelemetry/api";
import {
  SpanKind,
  SpanStatusCode,
  addStoryEvent,
  getActiveSpan,
  getTelemetryMetrics,
  getTracer,
  recordSpanError,
  setSpanAttributes,
  toErrorMessage,
  withSpan,
} from "../tracing";

const REQUEST_SPAN_KEY = "__request_span__";
const REQUEST_ID_KEY = "__request_id__";

type TelemetryLocals = {
  [REQUEST_SPAN_KEY]?: Span;
  [REQUEST_ID_KEY]?: string;
};

export type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void>;

export class HttpError extends Error {
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(statusCode: number, message: string, details?: unknown) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
  }
}

export const createRequestTelemetryMiddleware = (): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const metrics = getTelemetryMetrics();
    const requestStartTime = Date.now();
    const routeHint = `${req.method} ${req.path}`;
    const requestId =
      req.header("x-request-id") ||
      req.header("x-correlation-id") ||
      randomUUID();

    const span = getTracer().startSpan(`http.request ${routeHint}`, {
      kind: SpanKind.SERVER,
      attributes: {
        "http.method": req.method,
        "http.path": req.path,
        "http.query": req.url.includes("?") ? req.url.split("?")[1] : "",
        "http.user_agent": req.header("user-agent") || "",
        "http.request_id": requestId,
      },
    });

    res.setHeader("x-request-id", requestId);
    (res.locals as TelemetryLocals)[REQUEST_SPAN_KEY] = span;
    (res.locals as TelemetryLocals)[REQUEST_ID_KEY] = requestId;

    metrics.httpActiveRequests.add(1, {
      "http.method": req.method,
      "http.path": req.path,
    });

    addStoryEvent(span, "request.accepted", {
      "request.id": requestId,
      "request.method": req.method,
      "request.path": req.path,
      "request.content_length": req.header("content-length") || "0",
    });

    let ended = false;
    const finish = (reason: "finish" | "close"): void => {
      if (ended) {
        return;
      }
      ended = true;

      const durationMs = Date.now() - requestStartTime;
      const route = req.route?.path ? String(req.route.path) : req.path;
      const statusCode = res.statusCode;
      const outcome = statusCode >= 500 ? "server_error" : statusCode >= 400 ? "client_error" : "success";

      metrics.httpRequestDurationMs.record(durationMs, {
        "http.method": req.method,
        "http.route": route,
        "http.status_code": String(statusCode),
        "http.outcome": outcome,
      });
      metrics.httpRequestsTotal.add(1, {
        "http.method": req.method,
        "http.route": route,
        "http.status_code": String(statusCode),
        "http.outcome": outcome,
      });
      metrics.httpActiveRequests.add(-1, {
        "http.method": req.method,
        "http.path": req.path,
      });

      setSpanAttributes(span, {
        "http.route": route,
        "http.status_code": statusCode,
        "request.duration_ms": durationMs,
        "request.ended_by": reason,
      });

      addStoryEvent(span, "request.completed", {
        "request.status_code": statusCode,
        "request.duration_ms": durationMs,
        "request.outcome": outcome,
        "request.end_reason": reason,
      });

      if (statusCode >= 500) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${statusCode}` });
      } else {
        span.setStatus({ code: SpanStatusCode.OK });
      }

      span.end();
    };

    res.once("finish", () => finish("finish"));
    res.once("close", () => finish("close"));

    context.with(trace.setSpan(context.active(), span), () => {
      next();
    });
  };
};

export const asyncHandler = (handler: AsyncRouteHandler): RequestHandler => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = (res.locals as TelemetryLocals)[REQUEST_ID_KEY] || "";
    const routeTemplate = req.route?.path ? String(req.route.path) : req.path;

    void withSpan(
      "http.route.handler",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "http.method": req.method,
          "http.route": routeTemplate,
          "http.request_id": requestId,
        },
      },
      async (span) => {
        addStoryEvent(span, "route.handler.start", {
          "route.method": req.method,
          "route.path": routeTemplate,
        });
        await handler(req, res, next);
        addStoryEvent(span, "route.handler.complete", {
          "route.method": req.method,
          "route.path": routeTemplate,
          "response.status_code": res.statusCode,
        });
      }
    ).catch((error) => {
      const activeSpan = getActiveSpan();
      if (activeSpan) {
        recordSpanError(activeSpan, error, {
          "http.route": routeTemplate,
          "http.request_id": requestId,
        });
      }
      next(error);
    });
  };
};

export const createPayloadTooLargeHandler = (
  bodyLimit: string
): ErrorRequestHandler => {
  return (
    err: Error & { type?: string },
    _req: Request,
    res: Response,
    next: NextFunction
  ): void => {
    if (err?.type === "entity.too.large") {
      res.status(413).json({
        error: "Payload too large",
        message: `Submitted payload exceeds the limit of ${bodyLimit}.`,
      });
      return;
    }

    next(err);
  };
};

export const errorHandler: ErrorRequestHandler = (
  err,
  req,
  res,
  _next
): void => {
  const statusCode =
    err instanceof HttpError
      ? err.statusCode
      : typeof (err as { status?: unknown }).status === "number"
      ? ((err as { status: number }).status as number)
      : 500;

  const message = err instanceof Error ? err.message : String(err);

  if (statusCode >= 500) {
    console.error("Unhandled server error:", err);
  }

  const metrics = getTelemetryMetrics();
  metrics.errorsTotal.add(1, {
    "error.kind": err instanceof HttpError ? "http_error" : "unhandled_error",
    "http.status_code": String(statusCode),
    "http.route": req.route?.path ? String(req.route.path) : req.path,
  });

  const requestSpan =
    (res.locals as TelemetryLocals)[REQUEST_SPAN_KEY] || getActiveSpan();
  recordSpanError(requestSpan, err, {
    "http.status_code": statusCode,
    "http.route": req.route?.path ? String(req.route.path) : req.path,
    "http.error_message": toErrorMessage(err),
  });

  const response: Record<string, unknown> = {
    error: statusCode >= 500 ? "Internal server error" : "Request failed",
    message,
  };

  if (err instanceof HttpError && err.details !== undefined) {
    response.details = err.details;
  }

  if (process.env.NODE_ENV !== "production") {
    response.stack = err instanceof Error ? err.stack : undefined;
  }

  res.status(statusCode).json(response);
};
