import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { z } from "zod";
import type { TextAssistantSessionService } from "./textAssistantSessions";

export interface AppleShortcutRouterOptions {
  sessions: TextAssistantSessionService;
  rateLimitPerMinute?: number;
  now?: () => number;
}

interface RateWindow {
  startedAt: number;
  count: number;
}

const commandSchema = z.object({
  command: z.string().trim().min(1).max(2000),
});
const answerSchema = z.object({
  answer: z.string().trim().min(1).max(1000),
});
const SHORTCUT_HISTORY_SCOPE = "apple-shortcuts";

export function createAppleShortcutRouter(
  options: AppleShortcutRouterOptions
): express.Router {
  const router = express.Router();
  const rateWindows = new Map<string, RateWindow>();
  const now = options.now ?? Date.now;
  const rateLimit = options.rateLimitPerMinute ?? 120;

  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.use((req, res, next) => {
    const rateLimitKey = req.ip || req.socket.remoteAddress || "unknown";
    const current = now();
    const existing = rateWindows.get(rateLimitKey);
    const window =
      !existing || current - existing.startedAt >= 60_000
        ? { startedAt: current, count: 0 }
        : existing;
    window.count += 1;
    rateWindows.set(rateLimitKey, window);
    if (window.count > rateLimit) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "Shortcut request rate exceeded." });
      return;
    }
    next();
  });

  router.use(express.json({ limit: "16kb", strict: true }));
  const jsonErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    const status = (error as { status?: number }).status;
    const type = (error as { type?: string }).type;
    if (status === 400) {
      res.status(400).json({ error: "Malformed JSON payload." });
      return;
    }
    if (status === 413 || type === "entity.too.large") {
      res.status(413).json({ error: "Shortcut payload is too large." });
      return;
    }
    next(error);
  };
  router.use(jsonErrorHandler);

  router.post("/sessions", (req, res) => {
    const parsed = commandSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "A command between 1 and 2000 characters is required.",
      });
      return;
    }
    const snapshot = options.sessions.start(
      SHORTCUT_HISTORY_SCOPE,
      parsed.data.command
    );
    res.status(202).json(snapshot);
  });

  router.get("/sessions/:conversationId", (req, res) => {
    const snapshot = options.sessions.get(
      SHORTCUT_HISTORY_SCOPE,
      req.params.conversationId
    );
    if (!snapshot) {
      res.status(404).json({ error: "Shortcut conversation not found." });
      return;
    }
    res.json(snapshot);
  });

  router.post("/sessions/:conversationId/input", (req, res) => {
    const parsed = answerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "An answer between 1 and 1000 characters is required.",
      });
      return;
    }
    const snapshot = options.sessions.submitInput(
      SHORTCUT_HISTORY_SCOPE,
      req.params.conversationId,
      parsed.data.answer
    );
    if (!snapshot) {
      res.status(404).json({ error: "Shortcut conversation not found." });
      return;
    }
    res.status(snapshot.status === "running" ? 202 : 200).json(snapshot);
  });

  router.delete("/sessions/:conversationId", (req, res) => {
    const snapshot = options.sessions.cancel(
      SHORTCUT_HISTORY_SCOPE,
      req.params.conversationId
    );
    if (!snapshot) {
      res.status(404).json({ error: "Shortcut conversation not found." });
      return;
    }
    res.json(snapshot);
  });

  router.use(
    (
      error: unknown,
      _req: Request,
      res: Response,
      _next: NextFunction
    ) => {
      console.error("[AppleShortcut] Request failed:", error);
      res.status(500).json({ error: "Apple Shortcut request failed." });
    }
  );

  return router;
}
