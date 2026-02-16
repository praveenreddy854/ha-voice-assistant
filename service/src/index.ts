import cors from "cors";
import express from "express";
import {
  addStoryEvent,
  createTVAgentSpan,
  recordSpanError,
  shutdownTracing,
  SpanStatusCode,
  initializeTracing,
} from "./tracing";
import { createApiRouter } from "./routes/apiRoutes";
import {
  createRequestTelemetryMiddleware,
  createPayloadTooLargeHandler,
  errorHandler,
} from "./server/http";
import { startDeviceStateLogging } from "./deviceStateLogger";
import { homeAssistantService } from "./services/homeAssistantService";
import { intentService } from "./services/intentService";
import { reminderService } from "./services/reminderService";
import { reminderStore } from "./services/reminderStore";
import { speechService } from "./services/speechService";
import { createHomeChecksService } from "./services/homeChecksService";

initializeTracing();

declare global {
  var pendingAnnouncement: string | null;
}

if (typeof global.pendingAnnouncement === "undefined") {
  global.pendingAnnouncement = null;
}

const app = express();
const port = Number.parseInt(process.env.PORT || "3005", 10);
const jsonBodyLimit = process.env.JSON_BODY_LIMIT || "15mb";

app.use(createRequestTelemetryMiddleware());
app.use(express.json({ limit: jsonBodyLimit }));
app.use(express.urlencoded({ extended: true, limit: jsonBodyLimit }));
app.use(cors());
app.use(createPayloadTooLargeHandler(jsonBodyLimit));

const homeChecksService = createHomeChecksService(homeAssistantService);

app.get("/", (_req, res) => {
  res.send("HA Voice Assistant Service");
});

app.use(
  "/api",
  createApiRouter({
    homeAssistantService,
    intentService,
    reminderService,
    reminderStore,
    speechService,
    homeChecksService,
  })
);

app.use(errorHandler);

startDeviceStateLogging();
homeChecksService.start();

const startupSpan = createTVAgentSpan("service.startup", {
  "service.port": port,
  "service.json_body_limit": jsonBodyLimit,
});

addStoryEvent(startupSpan, "startup.begin", {
  "startup.port": port,
  "startup.json_body_limit": jsonBodyLimit,
});

const server = app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  addStoryEvent(startupSpan, "startup.http_server_listening", {
    "startup.port": port,
  });
  startupSpan.setStatus({ code: SpanStatusCode.OK });
  startupSpan.end();
});

const gracefulShutdown = async (signal: string): Promise<void> => {
  console.log(`${signal} received, shutting down gracefully...`);
  const shutdownSpan = createTVAgentSpan("service.shutdown", {
    "shutdown.signal": signal,
  });
  addStoryEvent(shutdownSpan, "shutdown.requested", {
    "shutdown.signal": signal,
  });

  server.close(async () => {
    try {
      addStoryEvent(shutdownSpan, "shutdown.server_closed");
      await shutdownTracing();
      addStoryEvent(shutdownSpan, "shutdown.telemetry_flushed");
      shutdownSpan.setStatus({ code: SpanStatusCode.OK });
    } catch (error) {
      recordSpanError(shutdownSpan, error, {
        "shutdown.stage": "telemetry_flush",
      });
    } finally {
      shutdownSpan.end();
      process.exit(0);
    }
  });
};

process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});
