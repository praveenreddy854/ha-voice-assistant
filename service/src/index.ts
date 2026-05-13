// Initialize tracing first
import { context as otelContext, trace as otelTrace, SpanStatusCode } from "@opentelemetry/api";
import {
  initializeTracing,
  shutdownTracing,
  getTracer,
  getSessionTraceContext,
} from "./tracing";
initializeTracing();

import express from "express";
import type {
  ErrorRequestHandler,
  NextFunction,
  Request,
  Response,
} from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs";
import path from "path";
import {
  HOME_ASSISTANT_URL,
  HOME_ASSISTANT_TOKEN,
  SPEECH_KEY,
  SPEECH_REGION,
  VACUUM_CLEANER_ENTITY_ID,
} from "./config";
import { fetchAllStates, getHACommandBody } from "./ha";
import { classifyIntent } from "./intent";
import { processReminderRequest } from "./reminder";
import { startDeviceStateLogging } from "./deviceStateLogger";
import { runAgent, getRegisteredAgentTypes } from "./agents/core";
// Import TV agent to trigger registration via side-effect
import "./agents/tv/tvAgent";
import { saveScreenshot, getLatestScreenshot } from "./agents/common/screenshotStore";
import { isRtspMode, startRtspCapture, stopRtspCapture } from "./agents/common/rtspCapture";
import { startGestureMonitor } from "./gestureMonitor";
import { traceRouter } from "./tracing/traceApi";
import { setupRealtimeChatProxy } from "./realtimeChat";
// Teaching mode imports - for recording manual steps and fine-tuning data
import {
  startTeachingSession,
  recordStep,
  addScreenshotCapture,
  completeTeachingSession,
  cancelTeachingSession,
  getTeachingSession,
  getActiveSessions,
  hasActiveSession,
  cleanupExpiredSessions,
  findGuidanceForTask,
  listAllRecordings,
  loadRecording,
  deleteRecording,
  TEACHING_TRIGGERS,
  analyzeScreenshot,
  TEACHING_DIR,
  uploadScreenshotToBlob,
  isBlobStorageAvailable,
} from "./agents/tv/teaching";

// Global declaration for announcement storage
declare global {
  var pendingAnnouncement: string | null;
}

const app = express();
const port = process.env.PORT || 3005;
const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || "15mb";

// File paths for storage
const GENERATED_DATA_DIR = path.join(__dirname, "../generated_data");
const REMINDERS_FILE = path.join(GENERATED_DATA_DIR, "reminders.json");
const PROCESSED_REMINDERS_FILE = path.join(
  GENERATED_DATA_DIR,
  "processed_reminders.json"
);

// Ensure data directory exists
const DATA_DIR = path.join(__dirname, "../data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Middleware to parse JSON bodies
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: JSON_BODY_LIMIT }));
app.use(cors());

// Handle payload-too-large errors gracefully
const payloadTooLargeHandler: ErrorRequestHandler = (
  err: Error & { type?: string },
  _req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (err?.type === "entity.too.large") {
    res.status(413).json({
      error: "Payload too large",
      message: `Submitted payload exceeds the limit of ${JSON_BODY_LIMIT}.`,
    });
    return;
  }
  next(err);
};

app.use(payloadTooLargeHandler);

// ── Trace viewer routes ──
app.use(traceRouter);

// Serve telemetry viewer HTML
app.get("/telemetry", (_req, res) => {
  res.sendFile(path.join(__dirname, "./tracing/traceViewer.html"));
});

app.get("/traces", (_req, res) => {
  res.redirect("/telemetry");
});

startDeviceStateLogging();

// Start gesture monitor for fist-to-pause TV control (RTSP mode only)
if (isRtspMode()) {
  startGestureMonitor();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.get("/", (req, res, next) => {
  res.send("Hello, Node.js + TypeScript!");
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/classifyIntent", (req, res, next) => {
  (async () => {
    try {
      const { userPrompt: prompt, messageHistory } = req.body;
      if (!prompt) {
        return res.status(400).json({ error: "User prompt is required" });
      }
      const intent = await classifyIntent(prompt, messageHistory);
      res.json(intent);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error classifying intent:", err);
      res.status(500).json({
        error: "Error classifying intent",
        message: err.message,
        stack: err.stack,
      });
    }
  })();
});

// ============================================================================
// Agent API
// ============================================================================

/**
 * Run any registered agent. Works for both new sessions and continuations.
 *
 * POST /api/agent/run
 * Body: {
 *   agentType: string,         // required — which agent to run
 *   userPrompt?: string,      // required for new sessions
 *   sessionId?: string,       // to continue an existing session
 *   maxSteps?: number,
 *   messageHistory?: Array<{ role: string; content: string }>,
 *   externalInput?: { type: string; data: Record<string, unknown>; error?: string }
 * }
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/agent/run", (req, res, next) => {
  (async () => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const requestedSessionId = typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined;
    const requestedAgentType = typeof req.body?.agentType === "string" ? req.body.agentType : "unknown";
    const requestParentContext = requestedSessionId
      ? getSessionTraceContext(requestedSessionId) || otelContext.active()
      : otelContext.active();
    const requestSpan = getTracer().startSpan(
      "http.request.agent.run",
      {
        attributes: {
          "telemetry.kind": "http_request",
          "http.request_id": requestId,
          "http.method": req.method,
          "http.route": "/api/agent/run",
          "agent.type": requestedAgentType,
          "agent.session.id": requestedSessionId || "",
          "agent.session.resume": Boolean(requestedSessionId),
        },
      },
      requestParentContext
    );
    const requestContext = otelTrace.setSpan(requestParentContext, requestSpan);

    let responseSettled = false;
    const finalizeRequestSpan = (): void => {
      if (responseSettled) {
        return;
      }
      responseSettled = true;
      requestSpan.addEvent("http.response.sent", {
        "http.request_id": requestId,
        "http.status_code": res.statusCode,
      });
      requestSpan.end();
    };

    res.once("finish", finalizeRequestSpan);
    res.once("close", finalizeRequestSpan);

    try {
      await otelContext.with(requestContext, async () => {
        requestSpan.addEvent("http.request.received", {
          "http.request_id": requestId,
          "agent.type": requestedAgentType,
          "agent.session.requested_id": requestedSessionId || "",
        });

        const { agentType, userPrompt, sessionId, maxSteps, messageHistory, externalInput } = req.body;

        if (!agentType) {
          requestSpan.setStatus({ code: SpanStatusCode.ERROR, message: "agentType is required" });
          requestSpan.setAttribute("http.status_code", 400);
          res.status(400).json({ error: "agentType is required" });
          return;
        }

        if (!sessionId && !userPrompt) {
          requestSpan.setStatus({ code: SpanStatusCode.ERROR, message: "userPrompt is required to start a new session" });
          requestSpan.setAttribute("http.status_code", 400);
          res.status(400).json({ error: "userPrompt is required to start a new session" });
          return;
        }

        const result = await runAgent({
          agentType,
          userPrompt,
          sessionId,
          maxSteps,
          messageHistory,
          externalInput,
        });

        requestSpan.setAttribute("agent.session.id", result.sessionId);
        requestSpan.setAttribute("agent.type", agentType);
        requestSpan.setAttribute("agent.result.status", result.status);
        requestSpan.setAttribute("agent.result.message", result.message);
        requestSpan.setAttribute("http.status_code", 200);
        requestSpan.setStatus({
          code: result.success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
          message: result.message,
        });

        requestSpan.addEvent("http.response.ready", {
          "agent.session.id": result.sessionId,
          "agent.result.status": result.status,
          "agent.result.success": result.success,
        });

        res.json(result);
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error running agent:", err);
      requestSpan.recordException(err);
      requestSpan.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      requestSpan.setAttribute("http.status_code", 500);
      res.status(500).json({
        error: "Error running agent",
        message: err.message,
      });
    }
  })();
});

/**
 * List all registered agents.
 *
 * GET /api/agent/list
 */
app.get("/api/agent/list", (_req, res) => {
  res.json({ agents: getRegisteredAgentTypes() });
});

// ============================================================================
// Camera config — tells the client whether to use the on-device camera
// ============================================================================

app.get("/api/camera/config", (_req, res) => {
  res.json({ onDevice: !isRtspMode() });
});

// ============================================================================
// Screenshot — SSE subscription + upload endpoint
// ============================================================================

const SCREENSHOT_CAPTURE_INTERVAL_MS = 1000;

app.get("/api/screenshot/subscribe", (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId query param is required" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  if (isRtspMode()) {
    // RTSP mode: server captures frames directly from the RTSP stream
    startRtspCapture(sessionId).catch((err) => {
      console.error(`[RTSP] Failed to start capture for session ${sessionId}:`, err.message);
    });

    req.on("close", () => {
      stopRtspCapture(sessionId);
      console.log(`[Screenshot SSE] Client disconnected, RTSP stopped (session ${sessionId})`);
    });
  } else {
    // On-device camera mode: tell client to capture at a regular interval
    const timer = setInterval(() => {
      res.write(`event: capture\ndata: ${Date.now()}\n\n`);
    }, SCREENSHOT_CAPTURE_INTERVAL_MS);

    req.on("close", () => {
      clearInterval(timer);
      console.log(`[Screenshot SSE] Client disconnected (session ${sessionId})`);
    });
  }
});

app.get("/api/screenshot/latest", async (req, res) => {
  const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
  if (!sessionId) {
    res.status(400).json({ error: "sessionId query param is required" });
    return;
  }
  const result = await getLatestScreenshot(sessionId);
  if (!result) {
    res.status(404).json({ error: "No screenshot available" });
    return;
  }
  res.json({ base64: result.base64, contentType: result.contentType });
});

app.post("/api/screenshot", (req, res) => {
  const { sessionId, base64 } = req.body;
  if (!sessionId || !base64) {
    res.status(400).json({ error: "sessionId and base64 are required" });
    return;
  }
  saveScreenshot(sessionId, base64)
    .then((filePath) => res.json({ saved: true, filePath }))
    .catch((err) => res.status(500).json({ error: err.message }));
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/postHACommand", (req, res, next) => {
  (async () => {
    try {
      const { command, messageHistory } = req.body;
      const haBody = await getHACommandBody(command, messageHistory);
      
      // Handle array of commands (multi-step operations)
      if (Array.isArray(haBody)) {
        const results: any[] = [];
        const errors: string[] = [];
        
        for (let i = 0; i < haBody.length; i++) {
          const cmd = haBody[i];
          let urlPath = cmd.url_path;
          const entityId = cmd.entity_id;
          
          if (!urlPath || urlPath.split("/").length !== 2) {
            errors.push(`Step ${i + 1}: Invalid url_path`);
            continue;
          }
          
          if (!entityId) {
            errors.push(`Step ${i + 1}: Missing entity_id`);
            continue;
          }
          
          if (urlPath.startsWith("/")) {
            urlPath = urlPath.substring(1);
          }
          
          const requestBody: any = { entity_id: cmd.entity_id };
          if (cmd.service_data) {
            Object.assign(requestBody, cmd.service_data);
          }
          
          try {
            const haResponse = await axios.post(
              `${HOME_ASSISTANT_URL}/api/services/${urlPath}`,
              requestBody,
              {
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
                },
              }
            );
            results.push(haResponse.data);
            console.log(`Step ${i + 1} executed:`, cmd);
          } catch (stepError) {
            errors.push(`Step ${i + 1}: ${stepError instanceof Error ? stepError.message : 'Unknown error'}`);
          }
          
          // Add delay between commands
          if (i < haBody.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 300));
          }
        }
        
        res.json({
          success: errors.length === 0,
          message: errors.length === 0 
            ? `All ${haBody.length} commands executed successfully`
            : `${haBody.length - errors.length}/${haBody.length} commands succeeded. Errors: ${errors.join('; ')}`,
          data: results,
        });
        console.log(`Received multi-command: ${command}; Steps: ${haBody.length}`);
        return;
      }
      
      // Handle single command (original logic)
      let urlPath = haBody.url_path;
      const entityId = haBody.entity_id;

      if (!urlPath || urlPath.split("/").length !== 2) {
        return res.status(400).json({
          error: "Invalid services home assistant path",
          message:
            "Command body must contain a valid 'url_path' in the format '<domain>/<service>'",
        });
      }

      if (!entityId) {
        return res.status(400).json({
          error: "Missing entity_id",
          message: "Command body must contain 'entity_id'",
        });
      }

      // Remove leading and trailing slashes from the URL path
      if (urlPath.startsWith("/")) {
        urlPath = urlPath.substring(1);
      }

      // Prepare the request body
      const requestBody: any = { entity_id: haBody.entity_id };

      // Add service_data if present (for play_media and other services that need additional data)
      if (haBody.service_data) {
        // For Home Assistant API, merge service_data fields directly at the top level
        Object.assign(requestBody, haBody.service_data);
      }

      const haResponse = await axios.post(
        `${HOME_ASSISTANT_URL}/api/services/${urlPath}`,
        requestBody,
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
          },
        }
      );

      if (haResponse.status < 200 || haResponse.status >= 300) {
        const errorText = haResponse.data;
        console.error("Home Assistant error response:", errorText);
      }

      res.json({
        success: true,
        message: `Command ${command} sent successfully`,
      });
      console.log(`Received command: ${command}; Response:`, haResponse.data);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error posting command to Home Assistant:", err);
      res.status(500).json({
        error: "Error posting command to Home Assistant",
        message: err.message,
        stack: err.stack,
      });
    }
  })();
});

app.get("/api/fetchAllDeviceStates", (req, res, next) => {
  (async () => {
    try {
      const states = await fetchAllStates();
      res.json(states);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error fetching all device states:", err);
      res.status(500).json({
        error: "Error fetching all device states",
        message: err.message,
        stack: err.stack,
      });
    }
  })();
});

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.get("/api/get-speech-token", (req, res, next) => {
  (async () => {
    try {
      if (!SPEECH_KEY) {
        return res.status(400).json({
          error: "Azure Speech Service key is not configured",
        });
      }
      // Token endpoint for Speech Services
      const tokenEndpoint = `https://${SPEECH_REGION}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
      const response = await axios({
        method: "post",
        url: tokenEndpoint,
        headers: {
          "Ocp-Apim-Subscription-Key": SPEECH_KEY,
          "Content-Type": "application/json",
        },
      });
      res.json({
        token: response.data,
        region: SPEECH_REGION,
      });
    } catch (error) {
      // Allow for err.response (from axios)
      const err =
        error && typeof error === "object" && "message" in error
          ? (error as any)
          : new Error(String(error));
      console.error(
        "Error getting speech token:",
        err?.response?.data || err.message
      );
      res.status(err?.response?.status || 500).json({
        error: "Error retrieving token",
        details: err.message,
      });
    }
  })();
});

// New endpoint to check available services for a device
app.get("/api/check-device-services/:entity_id", (req, res, next) => {
  (async () => {
    try {
      const { entity_id } = req.params;
      // Get device state and attributes
      const deviceResponse = await fetch(
        `${HOME_ASSISTANT_URL}/api/states/${entity_id}`,
        {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!deviceResponse.ok) {
        throw new Error(`Failed to fetch device: ${deviceResponse.statusText}`);
      }

      const deviceState = await deviceResponse.json();

      // Get available services for media_player domain
      const servicesResponse = await fetch(
        `${HOME_ASSISTANT_URL}/api/services/media_player`,
        {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!servicesResponse.ok) {
        throw new Error(
          `Failed to fetch services: ${servicesResponse.statusText}`
        );
      }

      const services = await servicesResponse.json();

      res.json({
        device_state: deviceState,
        available_services: services,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error checking device services:", err);
      res.status(500).json({
        error: "Error checking device services",
        message: err.message,
      });
    }
  })();
});

// New endpoint to check available notify services
app.get("/api/check-notify-services", (req, res, next) => {
  (async () => {
    try {
      const servicesResponse = await fetch(
        `${HOME_ASSISTANT_URL}/api/services/notify`,
        {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      if (!servicesResponse.ok) {
        throw new Error(
          `Failed to fetch notify services: ${servicesResponse.statusText}`
        );
      }

      const services = await servicesResponse.json();
      res.json({
        available_notify_services: services,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error checking notify services:", err);
      res.status(500).json({
        error: "Error checking notify services",
        message: err.message,
      });
    }
  })();
});

app.get("/api/get-speech-credentials", (req, res, next) => {
  (async () => {
    try {
      if (!SPEECH_KEY || !SPEECH_REGION) {
        return res.status(400).json({
          error: "Azure Speech Service key or region is not configured",
        });
      }
      res.json({
        speechKey: SPEECH_KEY,
        speechRegion: SPEECH_REGION,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error retrieving speech credentials:", err);
      res.status(500).json({
        error: "Error retrieving speech credentials",
        message: err.message,
        stack: err.stack,
      });
    }
  })();
});

// MAI-Transcribe-1: Speech-to-text via Azure LLM Speech API
app.post("/api/transcribe", (req, res, next) => {
  (async () => {
    try {
      if (!SPEECH_KEY || !SPEECH_REGION) {
        return res.status(400).json({
          error: "Azure Speech Service key or region is not configured",
        });
      }

      const { audio, mimeType } = req.body;
      if (!audio) {
        return res.status(400).json({ error: "No audio data provided" });
      }

      const audioBuffer = Buffer.from(audio, "base64");

      // Build multipart form data for the Azure LLM Speech API
      const boundary = `----FormBoundary${Date.now()}`;
      const definition = JSON.stringify({
        locales: ["en-US"],
        enhancedMode: {
          enabled: true,
          model: "mai-transcribe-1",
        },
      });

      // Determine file extension from MIME type
      const ext = (mimeType || "audio/webm").includes("ogg") ? "ogg" : "webm";

      // Construct multipart body manually
      const parts: Buffer[] = [];
      // Definition part
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="definition"\r\nContent-Type: application/json\r\n\r\n${definition}\r\n`
        )
      );
      // Audio part
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="audio.${ext}"\r\nContent-Type: ${mimeType || "audio/webm"}\r\n\r\n`
        )
      );
      parts.push(audioBuffer);
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

      const body = Buffer.concat(parts);

      const apiUrl = `https://${SPEECH_REGION}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2024-11-15`;
      const response = await axios.post<{
        combinedPhrases?: { text: string }[];
        phrases?: { text: string }[];
      }>(apiUrl, body, {
        headers: {
          "Ocp-Apim-Subscription-Key": SPEECH_KEY,
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
        },
        maxBodyLength: Infinity,
      } as any);

      // Extract text from response
      const combinedText =
        response.data?.combinedPhrases?.[0]?.text ||
        response.data?.phrases?.map((p) => p.text).join(" ") ||
        "";

      res.json({ text: combinedText, raw: response.data });
    } catch (error) {
      const err =
        error instanceof Error
          ? error
          : new Error(String(error));
      console.error(
        "Transcription error:",
        (error as any)?.response?.data || err.message
      );
      res.status((error as any)?.response?.status || 500).json({
        error: "Transcription failed",
        message: (error as any)?.response?.data?.error?.message || err.message,
      });
    }
  })();
});

// Endpoint to check laundry switch status
app.get("/api/laundry-status", (req, res, next) => {
  (async () => {
    try {
      const entityId = "switch.laundry_switch";
      const response = await axios.get(
        `${HOME_ASSISTANT_URL}/api/states/${entityId}`,
        {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      const state = response.data as any;
      res.json({
        entity_id: entityId,
        state: state.state,
        last_changed: state.last_changed,
        last_updated: state.last_updated,
        attributes: state.attributes,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error checking laundry status:", err);
      res.status(500).json({
        error: "Error checking laundry status",
        message: err.message,
      });
    }
  })();
});

// Endpoint to check vacuum status
app.get("/api/vacuum-status", (req, res, next) => {
  (async () => {
    try {
      const entityId = VACUUM_CLEANER_ENTITY_ID;
      const response = await axios.get(
        `${HOME_ASSISTANT_URL}/api/states/${entityId}`,
        {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
            "Content-Type": "application/json",
          },
        }
      );

      const state = response.data as any;
      res.json({
        entity_id: entityId,
        state: state.state,
        last_changed: state.last_changed,
        last_updated: state.last_updated,
        attributes: state.attributes,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error checking vacuum status:", err);
      res.status(500).json({
        error: "Error checking vacuum status",
        message: err.message,
      });
    }
  })();
});

// Unified endpoint to process all reminder requests (CREATE, LIST, QUERY)
app.post("/api/processReminder", (req, res, next) => {
  (async () => {
    try {
      const { userPrompt, reminders, messageHistory } = req.body;
      if (!userPrompt) {
        return res.status(400).json({ error: "User prompt is required" });
      }
      if (!reminders || !Array.isArray(reminders)) {
        return res.status(400).json({ error: "Reminders array is required" });
      }

      const reminderData = await processReminderRequest(
        userPrompt,
        reminders,
        messageHistory
      );

      if (reminderData.action === "CREATE") {
        // Handle reminder creation
        const reminderId =
          Date.now().toString(36) + Math.random().toString(36).substring(2);

        const reminder = {
          id: reminderId,
          ...reminderData,
          status: "active",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          notificationSent: false,
        };

        res.json({
          success: true,
          action: "CREATE",
          reminder,
          message: `Reminder created: ${reminder.title} at ${new Date(
            reminder.dueDate
          ).toLocaleString()}`,
        });

        console.log("Reminder created:", reminder);
      } else if (reminderData.action === "LIST") {
        // Handle reminder listing with intelligent filtering
        let filteredReminders = reminders.filter((r) => r.status === "active");
        const now = new Date();

        // Handle intelligent prioritization from LLM
        if (reminderData.prioritizeOverdue) {
          const overdueReminders = filteredReminders.filter(
            (r) => new Date(r.dueDate) < now
          );
          const upcomingReminders = filteredReminders.filter(
            (r) => new Date(r.dueDate) >= now
          );

          overdueReminders.sort(
            (a: any, b: any) =>
              new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
          );

          upcomingReminders.sort((a: any, b: any) => {
            const priorityOrder: { [key: string]: number } = {
              urgent: 0,
              high: 1,
              medium: 2,
              low: 3,
            };
            const aPriority = priorityOrder[a.priority] || 2;
            const bPriority = priorityOrder[b.priority] || 2;

            if (aPriority !== bPriority) {
              return aPriority - bPriority;
            }
            return (
              new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
            );
          });

          filteredReminders = [...overdueReminders, ...upcomingReminders];
        } else {
          filteredReminders.sort((a: any, b: any) => {
            const priorityOrder: { [key: string]: number } = {
              urgent: 0,
              high: 1,
              medium: 2,
              low: 3,
            };
            const aPriority = priorityOrder[a.priority] || 2;
            const bPriority = priorityOrder[b.priority] || 2;

            if (aPriority !== bPriority) {
              return aPriority - bPriority;
            }
            return (
              new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
            );
          });
        }

        if (reminderData.limit) {
          filteredReminders = filteredReminders.slice(0, reminderData.limit);
        }

        let message = "";
        if (reminderData.intelligentSuggestion) {
          message = reminderData.intelligentSuggestion;
          if (filteredReminders.length > 0) {
            message += " ";
            filteredReminders.forEach((reminder, index) => {
              const dueDate = new Date(reminder.dueDate);
              const isOverdue = dueDate < now;
              const timeStr =
                dueDate.toLocaleDateString() +
                " at " +
                dueDate.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              const overdueTag = isOverdue ? " (OVERDUE)" : "";
              message += `${index + 1}. ${
                reminder.title
              } - ${timeStr}${overdueTag}. `;
            });
          }
        } else {
          if (filteredReminders.length === 0) {
            message = "You have no active reminders.";
          } else {
            const count = reminderData.limit
              ? `top ${Math.min(reminderData.limit, filteredReminders.length)}`
              : "all";
            message = `Here are your ${count} reminders: `;

            filteredReminders.forEach((reminder, index) => {
              const dueDate = new Date(reminder.dueDate);
              const timeStr =
                dueDate.toLocaleDateString() +
                " at " +
                dueDate.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              message += `${index + 1}. ${reminder.title} - ${timeStr}. `;
            });
          }
        }

        res.json({
          success: true,
          action: "LIST",
          reminders: filteredReminders,
          message,
        });
      } else if (reminderData.action === "QUERY") {
        // Handle reminder queries with filtering
        let filteredReminders = reminders.filter((r) => r.status === "active");

        if (reminderData.category) {
          filteredReminders = filteredReminders.filter(
            (r) => r.category === reminderData.category
          );
        }

        if (reminderData.dateFilter) {
          const today = new Date();
          const tomorrow = new Date(today);
          tomorrow.setDate(tomorrow.getDate() + 1);

          if (reminderData.dateFilter === "tomorrow") {
            filteredReminders = filteredReminders.filter((r) => {
              const reminderDate = new Date(r.dueDate);
              return reminderDate.toDateString() === tomorrow.toDateString();
            });
          }
        }

        let message = "";
        if (reminderData.intelligentSuggestion) {
          message = reminderData.intelligentSuggestion;
          if (filteredReminders.length > 0) {
            message += " ";
            filteredReminders.forEach((reminder, index) => {
              const dueDate = new Date(reminder.dueDate);
              const now = new Date();
              const isOverdue = dueDate < now;
              const timeStr =
                dueDate.toLocaleDateString() +
                " at " +
                dueDate.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              const overdueTag = isOverdue ? " (OVERDUE)" : "";
              message += `${index + 1}. ${
                reminder.title
              } - ${timeStr}${overdueTag}. `;
            });
          }
        } else {
          if (filteredReminders.length === 0) {
            if (reminderData.category) {
              message = `You have no ${reminderData.category} reminders.`;
            } else if (reminderData.dateFilter) {
              message = `You have no reminders for ${reminderData.dateFilter}.`;
            } else {
              message = "No reminders found matching your criteria.";
            }
          } else {
            if (reminderData.category) {
              message = `You have ${filteredReminders.length} ${
                reminderData.category
              } reminder${filteredReminders.length > 1 ? "s" : ""}: `;
            } else {
              message = `Found ${filteredReminders.length} reminder${
                filteredReminders.length > 1 ? "s" : ""
              }: `;
            }

            filteredReminders.forEach((reminder, index) => {
              const dueDate = new Date(reminder.dueDate);
              const timeStr =
                dueDate.toLocaleDateString() +
                " at " +
                dueDate.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                });
              message += `${index + 1}. ${reminder.title} - ${timeStr}. `;
            });
          }
        }

        res.json({
          success: true,
          action: "QUERY",
          reminders: filteredReminders,
          message,
        });
      }

      console.log("Reminder processed:", reminderData);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error processing reminder:", err);
      res.status(500).json({
        error: "Error processing reminder",
        message: err.message,
        stack: err.stack,
      });
    }
  })();
});

// Endpoint to read reminders from JSON file
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.get("/api/reminders", (req, res, next) => {
  try {
    if (fs.existsSync(REMINDERS_FILE)) {
      const data = fs.readFileSync(REMINDERS_FILE, "utf8");
      const reminders = JSON.parse(data);
      res.json(reminders);
    } else {
      res.json([]);
    }
  } catch (error) {
    console.error("Error reading reminders:", error);
    res.status(500).json({ error: "Failed to read reminders" });
  }
});

// Endpoint to write reminders to JSON file
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/reminders", (req, res, next) => {
  (async () => {
    try {
      const { reminders } = req.body;
      if (!Array.isArray(reminders)) {
        return res.status(400).json({ error: "Reminders must be an array" });
      }

      if (!fs.existsSync(GENERATED_DATA_DIR)) {
          fs.mkdirSync(GENERATED_DATA_DIR, { recursive: true });
    }

      fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
      res.json({ success: true, message: "Reminders saved successfully" });
    } catch (error) {
      console.error("Error writing reminders:", error);
      res.status(500).json({ error: "Failed to save reminders" });
    }
  })();
});

// Endpoint to read processed reminders from JSON file
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.get("/api/processed-reminders", (req, res, next) => {
  try {
    if (fs.existsSync(PROCESSED_REMINDERS_FILE)) {
      const data = fs.readFileSync(PROCESSED_REMINDERS_FILE, "utf8");
      const processedReminders = JSON.parse(data);
      res.json(processedReminders);
    } else {
      res.json([]);
    }
  } catch (error) {
    console.error("Error reading processed reminders:", error);
    res.status(500).json({ error: "Failed to read processed reminders" });
  }
});

// Endpoint to write processed reminders to JSON file
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/processed-reminders", (req, res, next) => {
  (async () => {
    try {
      const { processedReminders } = req.body;
      if (!Array.isArray(processedReminders)) {
        return res
          .status(400)
          .json({ error: "Processed reminders must be an array" });
      }

      fs.writeFileSync(
        PROCESSED_REMINDERS_FILE,
        JSON.stringify(processedReminders, null, 2)
      );
      res.json({
        success: true,
        message: "Processed reminders saved successfully",
      });
    } catch (error) {
      console.error("Error writing processed reminders:", error);
      res.status(500).json({ error: "Failed to save processed reminders" });
    }
  })();
});

// ============================================================================
// Teaching Mode API Endpoints
// Recording-based flow: User manually performs steps while system records
// ============================================================================

// Check if a prompt triggers teaching mode
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/checkTeachingTrigger", (req, res, next) => {
  (async () => {
    try {
      const { userPrompt } = req.body;
      if (!userPrompt) {
        return res.status(400).json({ error: "User prompt is required" });
      }

      const lowerPrompt = userPrompt.toLowerCase();
      const isTeachingTrigger = TEACHING_TRIGGERS.some(trigger => 
        lowerPrompt.includes(trigger.toLowerCase())
      );

      res.json({
        isTeachingTrigger,
        triggers: TEACHING_TRIGGERS,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error checking teaching trigger:", err);
      res.status(500).json({
        error: "Error checking teaching trigger",
        message: err.message,
      });
    }
  })();
});

// Start a new teaching session (after user provides task name)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/teaching/start", (req, res, next) => {
  (async () => {
    try {
      const { taskName } = req.body;
      if (!taskName) {
        return res.status(400).json({ error: "Task name is required" });
      }

      const session = await startTeachingSession(taskName);
      res.json({
        success: true,
        session: {
          sessionId: session.sessionId,
          taskName: session.taskName,
          status: session.status,
        },
        message: `Teaching session started for "${taskName}". Perform steps on your TV and call /api/teaching/step to record each action.`,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error starting teaching session:", err);
      res.status(500).json({
        error: "Error starting teaching session",
        message: err.message,
      });
    }
  })();
});

// Record a step in the active teaching session (manual mode)
// User describes what they did, optionally with a screenshot
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/teaching/step", (req, res, next) => {
  (async () => {
    try {
      const { sessionId, action, screenshotBase64, contentType } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
      }
      if (!action) {
        return res.status(400).json({ error: "Action description is required" });
      }

      const step = await recordStep(
        sessionId,
        action,
        screenshotBase64,
        contentType || "image/jpeg"
      );

      if (!step) {
        return res.status(404).json({ error: "Teaching session not found or not in recording state" });
      }

      res.json({
        success: true,
        step: {
          stepNumber: step.stepNumber,
          action: step.action,
          description: step.description,
        },
        message: `Step ${step.stepNumber} recorded: ${step.action}`,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error recording teaching step:", err);
      res.status(500).json({
        error: "Error recording teaching step",
        message: err.message,
      });
    }
  })();
});

// Analyze a screenshot and return AI description
// Supports both:
//   1. Old format: { screenshotBase64, contentType, context } - for automatic capture
//   2. New UI format: { screenshotBase64, contentType, taskName, stepTitle, stepDescription, previousSteps } - for manual UI
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/teaching/analyze-screenshot", (req, res, next) => {
  (async () => {
    try {
      const { 
        screenshotBase64, 
        contentType, 
        context,
        // New UI format fields
        taskName,
        stepTitle,
        stepDescription,
        previousSteps 
      } = req.body;
      
      if (!screenshotBase64) {
        return res.status(400).json({ error: "Screenshot base64 data is required" });
      }

      // Convert previousSteps from UI format to PreviousStepContext format
      const previousStepsContext = (previousSteps || []).map((step: {
        stepNumber: number;
        title: string;
        description: string;
        aiAnalysis?: {
          description?: string;
          focusedElement?: string;
          inferredAction?: string;
        };
      }) => ({
        stepNumber: step.stepNumber,
        description: step.aiAnalysis?.description || step.description || step.title,
        focusedElement: step.aiAnalysis?.focusedElement,
        inferredAction: step.aiAnalysis?.inferredAction,
      }));

      // Use taskName from UI or fall back to context
      const task = taskName || context || "Unknown task";

      const analysis = await analyzeScreenshot(
        screenshotBase64,
        contentType || "image/png",
        task,
        previousStepsContext
      );

      res.json({
        success: true,
        description: analysis.description,
        focusedElement: analysis.focusedElement,
        inferredAction: analysis.inferredAction,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error analyzing screenshot:", err);
      res.status(500).json({
        success: false,
        error: "Error analyzing screenshot",
        message: err.message,
      });
    }
  })();
});

// Add a screenshot capture to a teaching session (for automatic capture mode)
// Client captures screenshots every 1 second and sends them here for AI analysis
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/teaching/capture", (req, res, next) => {
  (async () => {
    try {
      const { sessionId, screenshotBase64, contentType, captureIndex } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
      }
      if (!screenshotBase64) {
        return res.status(400).json({ error: "Screenshot base64 data is required" });
      }

      const step = await addScreenshotCapture(
        sessionId,
        screenshotBase64,
        contentType || "image/png",
        captureIndex || 0
      );

      if (!step) {
        return res.status(404).json({ error: "Teaching session not found or not in recording state" });
      }

      res.json({
        success: true,
        step: {
          stepNumber: step.stepNumber,
          action: step.action,
          description: step.description,
        },
        message: `Screenshot capture ${captureIndex || 0} added as step ${step.stepNumber}`,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error adding screenshot capture:", err);
      res.status(500).json({
        error: "Error adding screenshot capture",
        message: err.message,
      });
    }
  })();
});

// Complete a teaching session and save the recording
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/teaching/complete", (req, res, next) => {
  (async () => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
      }

      const recording = await completeTeachingSession(sessionId);
      if (!recording) {
        return res.status(404).json({ error: "Teaching session not found or has no steps" });
      }

      res.json({
        success: true,
        recording: {
          id: recording.id,
          taskName: recording.taskName,
          totalSteps: recording.totalSteps,
          isComplete: recording.isComplete,
        },
        message: `Teaching complete! Recorded ${recording.totalSteps} steps for "${recording.taskName}"`,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error completing teaching session:", err);
      res.status(500).json({
        error: "Error completing teaching session",
        message: err.message,
      });
    }
  })();
});

// Cancel a teaching session
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/teaching/cancel", (req, res, next) => {
  (async () => {
    try {
      const { sessionId } = req.body;
      if (!sessionId) {
        return res.status(400).json({ error: "Session ID is required" });
      }

      const cancelled = cancelTeachingSession(sessionId);
      if (!cancelled) {
        return res.status(404).json({ error: "Teaching session not found" });
      }

      res.json({
        success: true,
        message: "Teaching session cancelled",
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error cancelling teaching session:", err);
      res.status(500).json({
        error: "Error cancelling teaching session",
        message: err.message,
      });
    }
  })();
});

// Get current teaching session state
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.get("/api/teaching/session/:sessionId", (req, res, next) => {
  (async () => {
    try {
      const { sessionId } = req.params;
      const session = getTeachingSession(sessionId);
      
      if (!session) {
        return res.status(404).json({ error: "Teaching session not found" });
      }

      res.json({
        success: true,
        session: {
          sessionId: session.sessionId,
          taskName: session.taskName,
          status: session.status,
          currentStepIndex: session.currentStepIndex,
          stepsRecorded: session.recording.steps.length,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error getting teaching session:", err);
      res.status(500).json({
        error: "Error getting teaching session",
        message: err.message,
      });
    }
  })();
});

// Get all active teaching sessions
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.get("/api/teaching/sessions", (req, res, next) => {
  (async () => {
    try {
      const sessions = getActiveSessions();
      res.json({
        success: true,
        sessions: sessions.map(s => ({
          sessionId: s.sessionId,
          taskName: s.taskName,
          status: s.status,
          stepsRecorded: s.recording.steps.length,
        })),
        count: sessions.length,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error listing teaching sessions:", err);
      res.status(500).json({
        error: "Error listing teaching sessions",
        message: err.message,
      });
    }
  })();
});

// Find guidance for a task (used by TV agent to follow learned steps)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/teaching/guidance", (req, res, next) => {
  (async () => {
    try {
      const { taskDescription, similarityThreshold } = req.body;
      if (!taskDescription) {
        return res.status(400).json({ error: "Task description is required" });
      }

      const guidance = await findGuidanceForTask(taskDescription, similarityThreshold);
      
      if (!guidance) {
        return res.json({
          success: true,
          hasGuidance: false,
          message: "No similar recordings found",
        });
      }

      res.json({
        success: true,
        hasGuidance: true,
        guidance: {
          matchedTaskName: guidance.matchedTaskName,
          confidence: guidance.confidence,
          totalSteps: guidance.totalSteps,
          steps: guidance.steps,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error finding guidance:", err);
      res.status(500).json({
        error: "Error finding guidance",
        message: err.message,
      });
    }
  })();
});

// List all saved recordings
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.get("/api/teaching/recordings", (req, res, next) => {
  (async () => {
    try {
      const recordings = await listAllRecordings();
      res.json({
        success: true,
        recordings: recordings.map(r => ({
          id: r.id,
          taskName: r.taskName,
          totalSteps: r.totalSteps,
          isComplete: r.isComplete,
          createdAt: r.createdAt,
        })),
        count: recordings.length,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error listing recordings:", err);
      res.status(500).json({
        error: "Error listing recordings",
        message: err.message,
      });
    }
  })();
});

// Get a specific recording by ID
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.get("/api/teaching/recordings/:id", (req, res, next) => {
  (async () => {
    try {
      const { id } = req.params;
      const recording = await loadRecording(id);
      
      if (!recording) {
        return res.status(404).json({ error: "Recording not found" });
      }

      res.json({
        success: true,
        recording,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error loading recording:", err);
      res.status(500).json({
        error: "Error loading recording",
        message: err.message,
      });
    }
  })();
});

// Delete a recording by ID
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.delete("/api/teaching/recordings/:id", (req, res, next) => {
  (async () => {
    try {
      const { id } = req.params;
      const deleted = await deleteRecording(id);
      
      if (!deleted) {
        return res.status(404).json({ error: "Recording not found" });
      }

      res.json({
        success: true,
        message: "Recording deleted successfully",
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error deleting recording:", err);
      res.status(500).json({
        error: "Error deleting recording",
        message: err.message,
      });
    }
  })();
});

// Save teaching data as JSONL for OpenAI fine-tuning with function calling format
// Each step creates a training example with:
// - User message: the task/request + optional screenshot (uploaded to blob storage)
// - Assistant message: tool_calls array with function name and arguments
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/teaching/save-finetune", (req, res, next) => {
  (async () => {
    try {
      const { taskName, steps } = req.body;

      if (!taskName || typeof taskName !== "string" || !taskName.trim()) {
        return res.status(400).json({ 
          success: false,
          error: "Task name is required" 
        });
      }

      if (!steps || !Array.isArray(steps) || steps.length === 0) {
        return res.status(400).json({ 
          success: false,
          error: "At least one step is required" 
        });
      }

      console.log(`[Teaching Fine-tune] Creating JSONL for task: "${taskName}" with ${steps.length} steps`);
      
      // Check if blob storage is available for screenshots
      const useBlobStorage = isBlobStorageAvailable();
      if (useBlobStorage) {
        console.log(`[Teaching Fine-tune] Blob storage available - screenshots will be uploaded to Azure`);
      } else {
        console.log(`[Teaching Fine-tune] Blob storage NOT configured - screenshots will use base64 (not recommended for fine-tuning)`);
      }

      // Ensure teaching directory exists
      const finetuneDir = path.join(TEACHING_DIR, "finetune");
      if (!fs.existsSync(finetuneDir)) {
        fs.mkdirSync(finetuneDir, { recursive: true });
      }

      // JSONL file path - append to a single file for all training data
      const jsonlPath = path.join(finetuneDir, "tv-agent-training.jsonl");

      // Build JSONL entries - one per step
      // Format follows OpenAI fine-tuning format with function calling
      const jsonlLines: string[] = [];

      for (const step of steps as Array<{
        stepNumber: number;
        action: string;
        toolName?: string;
        toolArgs?: Record<string, unknown>;
        screenshotBase64?: string;
      }>) {
        // Create a training example for this step
        // The model learns: given this screen state + task, what tool to call
        const userContent: Array<{ type: string; text?: string; image_url?: { url: string; detail?: string } }> = [
          {
            type: "text",
            text: `Task: ${taskName.trim()}\n\nStep ${step.stepNumber} of ${steps.length}.\n\nLooking at the current TV screen, what action should be taken next?`,
          },
        ];

        // Add screenshot as image if available
        // Upload to blob storage if available, otherwise use base64 (not recommended)
        if (step.screenshotBase64) {
          let imageUrl: string;
          
          if (useBlobStorage) {
            // Upload to Azure Blob Storage and use the URL
            const blobUrl = await uploadScreenshotToBlob(
              step.screenshotBase64,
              "image/jpeg",
              taskName.trim(),
              step.stepNumber
            );
            
            if (blobUrl) {
              imageUrl = blobUrl;
              console.log(`[Teaching Fine-tune] Step ${step.stepNumber}: Uploaded screenshot to ${blobUrl}`);
            } else {
              // Fallback to base64 if blob upload fails
              imageUrl = `data:image/jpeg;base64,${step.screenshotBase64}`;
              console.warn(`[Teaching Fine-tune] Step ${step.stepNumber}: Blob upload failed, using base64 fallback`);
            }
          } else {
            // No blob storage configured - use base64
            imageUrl = `data:image/jpeg;base64,${step.screenshotBase64}`;
          }
          
          userContent.push({
            type: "image_url",
            image_url: {
              url: imageUrl,
              detail: "auto",
            },
          });
        }

        // Build assistant message with tool_calls if tool info provided
        let assistantMessage: Record<string, unknown>;
        
        if (step.toolName && step.toolArgs) {
          // Function calling format - do NOT include content field when using tool_calls
          assistantMessage = {
            role: "assistant",
            tool_calls: [
              {
                id: `call_${String(step.stepNumber).padStart(3, '0')}`,
                type: "function",
                function: {
                  name: step.toolName,
                  arguments: JSON.stringify(step.toolArgs),
                },
              },
            ],
          };
        } else {
          // Fallback to plain text (for backward compatibility)
          assistantMessage = {
            role: "assistant",
            content: step.action,
          };
        }

        const trainingExample = {
          messages: [
            {
              role: "system",
              content: `You are a TV navigation assistant that controls smart TVs through function calls. You have access to these tools:
- click_power_button: Turn TV on/off
- media_control: Play, pause, volume, etc.
- click_select_button: Press SELECT/OK to confirm
- go_back: Go back to previous screen
- go_home: Return to home screen
- navigate: Move cursor in a direction (up/down/left/right)
- find_search: Locate and activate search using vision AI
- deterministic_typing: Type text on on-screen keyboard
- delete_typed_text: Delete typed characters
- get_latest_screenshot: Get visual feedback
- get_device_state: Check device status
- launch_app: Open apps like YouTube, Netflix
- load_skill: Load detailed skill instructions when needed

Given a task and screen state, call the appropriate tool with correct arguments.`,
            },
            {
              role: "user",
              content: userContent,
            },
            assistantMessage,
          ],
        };

        jsonlLines.push(JSON.stringify(trainingExample));
      }

      // Append to JSONL file
      const jsonlContent = jsonlLines.join("\n") + "\n";
      fs.appendFileSync(jsonlPath, jsonlContent, "utf-8");

      console.log(`[Teaching Fine-tune] Appended ${jsonlLines.length} training examples to: ${jsonlPath}`);

      res.json({
        success: true,
        message: `Added ${jsonlLines.length} training examples for task "${taskName}"`,
        filePath: jsonlPath,
        linesWritten: jsonlLines.length,
        blobStorageUsed: useBlobStorage,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("[Teaching Fine-tune] Error saving JSONL:", err);
      res.status(500).json({
        success: false,
        error: "Error saving fine-tuning data",
        message: err.message,
      });
    }
  })();
});

// Cleanup expired teaching sessions
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.post("/api/teaching/cleanup", (req, res, next) => {
  (async () => {
    try {
      const cleanedCount = cleanupExpiredSessions();
      res.json({
        success: true,
        message: `Cleaned up ${cleanedCount} expired sessions`,
        cleanedCount,
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error("Error cleaning up sessions:", err);
      res.status(500).json({
        error: "Error cleaning up sessions",
        message: err.message,
      });
    }
  })();
});

const server = app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Visit http://localhost:${port} to access the application`);
  console.log(`Telemetry Viewer: http://localhost:${port}/telemetry`);
});

setupRealtimeChatProxy(server);

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, shutting down gracefully...");
  await shutdownTracing();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("SIGINT received, shutting down gracefully...");
  await shutdownTracing();
  process.exit(0);
});
