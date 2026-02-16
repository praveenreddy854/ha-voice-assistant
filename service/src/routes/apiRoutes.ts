import { Router } from "express";
import {
  LAUNDRY_SWITCH_ENTITY_ID,
  VACUUM_CLEANER_ENTITY_ID,
} from "../config";
import { runTvAgenticFlow } from "../tvAgent";
import { asyncHandler, HttpError } from "../server/http";
import { HomeAssistantService, ChatMessage } from "../services/homeAssistantService";
import { IntentService } from "../services/intentService";
import { ReminderService } from "../services/reminderService";
import { ReminderStore } from "../services/reminderStore";
import { SpeechService } from "../services/speechService";
import { HomeChecksService } from "../services/homeChecksService";
import { registerTeachingRoutes } from "./teachingRoutes";

type ApiDependencies = {
  homeAssistantService: HomeAssistantService;
  intentService: IntentService;
  reminderService: ReminderService;
  reminderStore: ReminderStore;
  speechService: SpeechService;
  homeChecksService: HomeChecksService;
};

const toChatHistory = (value: unknown): ChatMessage[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const history = value
    .map((item) => {
      if (!item || typeof item !== "object") {
        return null;
      }

      const candidate = item as { role?: unknown; content?: unknown };
      if (typeof candidate.role !== "string" || typeof candidate.content !== "string") {
        return null;
      }

      return {
        role: candidate.role,
        content: candidate.content,
      };
    })
    .filter((item): item is ChatMessage => item !== null);

  return history.length > 0 ? history : undefined;
};

export const createApiRouter = (deps: ApiDependencies): Router => {
  const router = Router();

  router.post(
    "/classifyIntent",
    asyncHandler(async (req, res) => {
      const userPrompt = String(req.body?.userPrompt || "").trim();
      const messageHistory = toChatHistory(req.body?.messageHistory);

      if (!userPrompt) {
        throw new HttpError(400, "User prompt is required");
      }

      const intent = await deps.intentService.classify(userPrompt, messageHistory);
      res.json(intent);
    })
  );

  router.post(
    "/runTvAgenticFlow",
    asyncHandler(async (req, res) => {
      const {
        userPrompt,
        messageHistory,
        maxSteps,
        sessionId,
        screenshotDataUrl,
        screenshotBase64,
        screenshotContentType,
        screenshotError,
      } = req.body ?? {};

      if (!sessionId && !userPrompt) {
        throw new HttpError(
          400,
          "User prompt is required to start a new session"
        );
      }

      const result = await runTvAgenticFlow({
        userPrompt,
        messageHistory: toChatHistory(messageHistory),
        maxSteps: typeof maxSteps === "number" ? maxSteps : undefined,
        sessionId: typeof sessionId === "string" ? sessionId : undefined,
        screenshotDataUrl:
          typeof screenshotDataUrl === "string" ? screenshotDataUrl : undefined,
        screenshotBase64:
          typeof screenshotBase64 === "string" ? screenshotBase64 : undefined,
        screenshotContentType:
          typeof screenshotContentType === "string"
            ? screenshotContentType
            : undefined,
        screenshotError:
          typeof screenshotError === "string" ? screenshotError : undefined,
      });

      res.json(result);
    })
  );

  router.post(
    "/postHACommand",
    asyncHandler(async (req, res) => {
      const command = String(req.body?.command || "").trim();
      const messageHistory = toChatHistory(req.body?.messageHistory);

      if (!command) {
        throw new HttpError(400, "Command is required");
      }

      const result = await deps.homeAssistantService.executeNaturalLanguageCommand(
        command,
        messageHistory
      );

      if (!result.success) {
        res.status(500).json(result);
        return;
      }

      res.json(result);
    })
  );

  router.get(
    "/fetchAllDeviceStates",
    asyncHandler(async (_req, res) => {
      const states = await deps.homeAssistantService.fetchAllStates();
      res.json(states);
    })
  );

  router.get(
    "/check-device-services/:entity_id",
    asyncHandler(async (req, res) => {
      const entityId = req.params.entity_id;
      const deviceState = await deps.homeAssistantService.fetchEntityState(entityId);
      const services = await deps.homeAssistantService.fetchDomainServices(
        "media_player"
      );

      res.json({
        device_state: deviceState,
        available_services: services,
      });
    })
  );

  router.get(
    "/check-notify-services",
    asyncHandler(async (_req, res) => {
      const services = await deps.homeAssistantService.fetchDomainServices("notify");

      res.json({
        available_notify_services: services,
      });
    })
  );

  router.get(
    "/get-speech-token",
    asyncHandler(async (_req, res) => {
      const token = await deps.speechService.getSpeechToken();
      res.json(token);
    })
  );

  router.get(
    "/get-speech-credentials",
    asyncHandler(async (_req, res) => {
      const credentials = deps.speechService.getSpeechCredentials();
      res.json(credentials);
    })
  );

  router.get(
    "/laundry-status",
    asyncHandler(async (_req, res) => {
      const state = await deps.homeAssistantService.fetchEntityState(
        LAUNDRY_SWITCH_ENTITY_ID
      );

      res.json(state);
    })
  );

  router.get(
    "/vacuum-status",
    asyncHandler(async (_req, res) => {
      if (!VACUUM_CLEANER_ENTITY_ID) {
        throw new HttpError(400, "VACUUM_CLEANER_ENTITY_ID is not configured");
      }

      const state = await deps.homeAssistantService.fetchEntityState(
        VACUUM_CLEANER_ENTITY_ID
      );

      res.json(state);
    })
  );

  router.post(
    "/processReminder",
    asyncHandler(async (req, res) => {
      const userPrompt = String(req.body?.userPrompt || "").trim();
      const reminders = Array.isArray(req.body?.reminders) ? req.body.reminders : null;
      const messageHistory = toChatHistory(req.body?.messageHistory);

      if (!userPrompt) {
        throw new HttpError(400, "User prompt is required");
      }

      if (!reminders) {
        throw new HttpError(400, "Reminders array is required");
      }

      const result = await deps.reminderService.processPrompt(
        userPrompt,
        reminders,
        messageHistory
      );

      res.json(result);
    })
  );

  router.get(
    "/reminders",
    asyncHandler(async (_req, res) => {
      const reminders = deps.reminderStore.readReminders();
      res.json(reminders);
    })
  );

  router.post(
    "/reminders",
    asyncHandler(async (req, res) => {
      const reminders = req.body?.reminders;

      if (!Array.isArray(reminders)) {
        throw new HttpError(400, "Reminders must be an array");
      }

      deps.reminderStore.writeReminders(reminders);
      res.json({
        success: true,
        message: "Reminders saved successfully",
      });
    })
  );

  router.get(
    "/processed-reminders",
    asyncHandler(async (_req, res) => {
      const processed = deps.reminderStore.readProcessedReminders();
      res.json(processed);
    })
  );

  router.post(
    "/processed-reminders",
    asyncHandler(async (req, res) => {
      const processed = req.body?.processedReminders;

      if (!Array.isArray(processed)) {
        throw new HttpError(400, "Processed reminders must be an array");
      }

      const valid = processed
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean);

      deps.reminderStore.writeProcessedReminders(valid);

      res.json({
        success: true,
        message: "Processed reminders saved successfully",
      });
    })
  );

  router.post(
    "/notifications/run-home-checks",
    asyncHandler(async (_req, res) => {
      const result = await deps.homeChecksService.runChecks("manual-api");
      res.json({
        success: true,
        result,
      });
    })
  );

  router.get(
    "/notifications/status",
    asyncHandler(async (_req, res) => {
      res.json(deps.homeChecksService.getStatus());
    })
  );

  router.get(
    "/pending-announcement",
    asyncHandler(async (req, res) => {
      const announcement = global.pendingAnnouncement;
      const clear = String(req.query?.clear || "false").toLowerCase() === "true";

      if (clear) {
        global.pendingAnnouncement = null;
      }

      res.json({
        pendingAnnouncement: announcement,
      });
    })
  );

  registerTeachingRoutes(router);

  return router;
};
