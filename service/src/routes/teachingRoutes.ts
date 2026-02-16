import fs from "fs";
import path from "path";
import { Router } from "express";
import {
  TEACHING_DIR,
  TEACHING_TRIGGERS,
  addScreenshotCapture,
  analyzeScreenshot,
  cancelTeachingSession,
  cleanupExpiredSessions,
  completeTeachingSession,
  deleteRecording,
  findGuidanceForTask,
  getActiveSessions,
  getTeachingSession,
  isBlobStorageAvailable,
  listAllRecordings,
  loadRecording,
  recordStep,
  startTeachingSession,
  uploadScreenshotToBlob,
} from "../agents/tv/teaching";
import { asyncHandler } from "../server/http";

interface PreviousStepInput {
  stepNumber: number;
  title: string;
  description: string;
  aiAnalysis?: {
    description?: string;
    focusedElement?: string;
    inferredAction?: string;
  };
}

interface FinetuneStepInput {
  stepNumber: number;
  action: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  screenshotBase64?: string;
}

export const registerTeachingRoutes = (router: Router): void => {
  router.post(
    "/checkTeachingTrigger",
    asyncHandler(async (req, res) => {
      const userPrompt = String(req.body?.userPrompt || "").trim();

      if (!userPrompt) {
        res.status(400).json({ error: "User prompt is required" });
        return;
      }

      const normalized = userPrompt.toLowerCase();
      const isTeachingTrigger = TEACHING_TRIGGERS.some((trigger) =>
        normalized.includes(trigger.toLowerCase())
      );

      res.json({
        isTeachingTrigger,
        triggers: TEACHING_TRIGGERS,
      });
    })
  );

  router.post(
    "/teaching/start",
    asyncHandler(async (req, res) => {
      const taskName = String(req.body?.taskName || "").trim();

      if (!taskName) {
        res.status(400).json({ error: "Task name is required" });
        return;
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
    })
  );

  router.post(
    "/teaching/step",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.body?.sessionId || "").trim();
      const action = String(req.body?.action || "").trim();
      const screenshotBase64 =
        typeof req.body?.screenshotBase64 === "string"
          ? req.body.screenshotBase64
          : undefined;
      const contentType =
        typeof req.body?.contentType === "string"
          ? req.body.contentType
          : "image/jpeg";

      if (!sessionId) {
        res.status(400).json({ error: "Session ID is required" });
        return;
      }

      if (!action) {
        res.status(400).json({ error: "Action description is required" });
        return;
      }

      const step = await recordStep(
        sessionId,
        action,
        screenshotBase64,
        contentType
      );

      if (!step) {
        res
          .status(404)
          .json({ error: "Teaching session not found or not in recording state" });
        return;
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
    })
  );

  router.post(
    "/teaching/analyze-screenshot",
    asyncHandler(async (req, res) => {
      const screenshotBase64 =
        typeof req.body?.screenshotBase64 === "string"
          ? req.body.screenshotBase64
          : "";

      if (!screenshotBase64) {
        res.status(400).json({ error: "Screenshot base64 data is required" });
        return;
      }

      const contentType =
        typeof req.body?.contentType === "string"
          ? req.body.contentType
          : "image/png";

      const context =
        typeof req.body?.taskName === "string" && req.body.taskName.trim()
          ? req.body.taskName.trim()
          : typeof req.body?.context === "string"
          ? req.body.context
          : "Unknown task";

      const previousSteps = (Array.isArray(req.body?.previousSteps)
        ? req.body.previousSteps
        : []) as PreviousStepInput[];

      const previousStepsContext = previousSteps.map((step) => ({
        stepNumber: step.stepNumber,
        description:
          step.aiAnalysis?.description || step.description || step.title,
        focusedElement: step.aiAnalysis?.focusedElement,
        inferredAction: step.aiAnalysis?.inferredAction,
      }));

      const analysis = await analyzeScreenshot(
        screenshotBase64,
        contentType,
        context,
        previousStepsContext
      );

      res.json({
        success: true,
        description: analysis.description,
        focusedElement: analysis.focusedElement,
        inferredAction: analysis.inferredAction,
      });
    })
  );

  router.post(
    "/teaching/capture",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.body?.sessionId || "").trim();
      const screenshotBase64 =
        typeof req.body?.screenshotBase64 === "string"
          ? req.body.screenshotBase64
          : "";
      const contentType =
        typeof req.body?.contentType === "string"
          ? req.body.contentType
          : "image/png";
      const captureIndex =
        typeof req.body?.captureIndex === "number" ? req.body.captureIndex : 0;

      if (!sessionId) {
        res.status(400).json({ error: "Session ID is required" });
        return;
      }

      if (!screenshotBase64) {
        res.status(400).json({ error: "Screenshot base64 data is required" });
        return;
      }

      const step = await addScreenshotCapture(
        sessionId,
        screenshotBase64,
        contentType,
        captureIndex
      );

      if (!step) {
        res
          .status(404)
          .json({ error: "Teaching session not found or not in recording state" });
        return;
      }

      res.json({
        success: true,
        step: {
          stepNumber: step.stepNumber,
          action: step.action,
          description: step.description,
        },
        message: `Screenshot capture ${captureIndex} added as step ${step.stepNumber}`,
      });
    })
  );

  router.post(
    "/teaching/complete",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.body?.sessionId || "").trim();

      if (!sessionId) {
        res.status(400).json({ error: "Session ID is required" });
        return;
      }

      const recording = await completeTeachingSession(sessionId);

      if (!recording) {
        res
          .status(404)
          .json({ error: "Teaching session not found or has no steps" });
        return;
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
    })
  );

  router.post(
    "/teaching/cancel",
    asyncHandler(async (req, res) => {
      const sessionId = String(req.body?.sessionId || "").trim();

      if (!sessionId) {
        res.status(400).json({ error: "Session ID is required" });
        return;
      }

      const cancelled = cancelTeachingSession(sessionId);

      if (!cancelled) {
        res.status(404).json({ error: "Teaching session not found" });
        return;
      }

      res.json({
        success: true,
        message: "Teaching session cancelled",
      });
    })
  );

  router.get(
    "/teaching/session/:sessionId",
    asyncHandler(async (req, res) => {
      const session = getTeachingSession(req.params.sessionId);

      if (!session) {
        res.status(404).json({ error: "Teaching session not found" });
        return;
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
    })
  );

  router.get(
    "/teaching/sessions",
    asyncHandler(async (_req, res) => {
      const sessions = getActiveSessions();

      res.json({
        success: true,
        sessions: sessions.map((session) => ({
          sessionId: session.sessionId,
          taskName: session.taskName,
          status: session.status,
          stepsRecorded: session.recording.steps.length,
        })),
        count: sessions.length,
      });
    })
  );

  router.post(
    "/teaching/guidance",
    asyncHandler(async (req, res) => {
      const taskDescription = String(req.body?.taskDescription || "").trim();

      if (!taskDescription) {
        res.status(400).json({ error: "Task description is required" });
        return;
      }

      const similarityThreshold =
        typeof req.body?.similarityThreshold === "number"
          ? req.body.similarityThreshold
          : undefined;

      const guidance = await findGuidanceForTask(
        taskDescription,
        similarityThreshold
      );

      if (!guidance) {
        res.json({
          success: true,
          hasGuidance: false,
          message: "No similar recordings found",
        });
        return;
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
    })
  );

  router.get(
    "/teaching/recordings",
    asyncHandler(async (_req, res) => {
      const recordings = await listAllRecordings();

      res.json({
        success: true,
        recordings: recordings.map((recording) => ({
          id: recording.id,
          taskName: recording.taskName,
          totalSteps: recording.totalSteps,
          isComplete: recording.isComplete,
          createdAt: recording.createdAt,
        })),
        count: recordings.length,
      });
    })
  );

  router.get(
    "/teaching/recordings/:id",
    asyncHandler(async (req, res) => {
      const recording = await loadRecording(req.params.id);

      if (!recording) {
        res.status(404).json({ error: "Recording not found" });
        return;
      }

      res.json({
        success: true,
        recording,
      });
    })
  );

  router.delete(
    "/teaching/recordings/:id",
    asyncHandler(async (req, res) => {
      const deleted = await deleteRecording(req.params.id);

      if (!deleted) {
        res.status(404).json({ error: "Recording not found" });
        return;
      }

      res.json({
        success: true,
        message: "Recording deleted successfully",
      });
    })
  );

  router.post(
    "/teaching/save-finetune",
    asyncHandler(async (req, res) => {
      const taskName = String(req.body?.taskName || "").trim();
      const steps = (Array.isArray(req.body?.steps)
        ? req.body.steps
        : []) as FinetuneStepInput[];

      if (!taskName) {
        res.status(400).json({
          success: false,
          error: "Task name is required",
        });
        return;
      }

      if (steps.length === 0) {
        res.status(400).json({
          success: false,
          error: "At least one step is required",
        });
        return;
      }

      const useBlobStorage = isBlobStorageAvailable();
      const finetuneDir = path.join(TEACHING_DIR, "finetune");

      if (!fs.existsSync(finetuneDir)) {
        fs.mkdirSync(finetuneDir, { recursive: true });
      }

      const jsonlPath = path.join(finetuneDir, "tv-agent-training.jsonl");
      const lines: string[] = [];

      for (const step of steps) {
        const userContent: Array<{
          type: string;
          text?: string;
          image_url?: { url: string; detail?: string };
        }> = [
          {
            type: "text",
            text: `Task: ${taskName}\n\nStep ${step.stepNumber} of ${steps.length}.\n\nLooking at the current TV screen, what action should be taken next?`,
          },
        ];

        if (step.screenshotBase64) {
          let imageUrl = `data:image/jpeg;base64,${step.screenshotBase64}`;

          if (useBlobStorage) {
            const blobUrl = await uploadScreenshotToBlob(
              step.screenshotBase64,
              "image/jpeg",
              taskName,
              step.stepNumber
            );

            if (blobUrl) {
              imageUrl = blobUrl;
            }
          }

          userContent.push({
            type: "image_url",
            image_url: {
              url: imageUrl,
              detail: "auto",
            },
          });
        }

        const assistantMessage: Record<string, unknown> =
          step.toolName && step.toolArgs
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    id: `call_${String(step.stepNumber).padStart(3, "0")}`,
                    type: "function",
                    function: {
                      name: step.toolName,
                      arguments: JSON.stringify(step.toolArgs),
                    },
                  },
                ],
              }
            : {
                role: "assistant",
                content: step.action,
              };

        const trainingExample = {
          messages: [
            {
              role: "system",
              content:
                "You are a TV navigation assistant that controls smart TVs through function calls. Use the most relevant tool and arguments based on the task and visual state.",
            },
            {
              role: "user",
              content: userContent,
            },
            assistantMessage,
          ],
        };

        lines.push(JSON.stringify(trainingExample));
      }

      fs.appendFileSync(jsonlPath, `${lines.join("\n")}\n`, "utf8");

      res.json({
        success: true,
        message: `Added ${lines.length} training examples for task "${taskName}"`,
        filePath: jsonlPath,
        linesWritten: lines.length,
        blobStorageUsed: useBlobStorage,
      });
    })
  );

  router.post(
    "/teaching/cleanup",
    asyncHandler(async (_req, res) => {
      const cleanedCount = cleanupExpiredSessions();
      res.json({
        success: true,
        message: `Cleaned up ${cleanedCount} expired sessions`,
        cleanedCount,
      });
    })
  );
};
