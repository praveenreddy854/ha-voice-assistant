import { Router } from "express";
import path from "node:path";
import { z } from "zod";
import { EvalSupervisor } from "./supervisor";
import { EvalStore } from "./store";
import { EVAL_TIMEZONE, fidelityPairs, localDay, runVerdict, shiftDay } from "./analytics";
import type { EvalAlert, EvalBatch, EvalRun, RecordedSessionEvaluation, RecordedSessionsResponse, StepGroup } from "./types";
import { evalPage } from "./page";
import { discoverRecordedSessions } from "./sessions";
import { recordedHistories, sessionEvaluations } from "./history";

const jobSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("simulated"), scenarioIds: z.array(z.string().regex(/^[a-z0-9-]+$/)).min(1).optional(), model: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional() }).strict(),
  z.object({ mode: z.literal("recorded"), sessionIds: z.array(z.string().regex(/^[a-zA-Z0-9_-]+$/)).min(1).max(100)
    .refine(ids => new Set(ids).size === ids.length, "Session IDs must be unique"), requestId: z.string().uuid().optional() }).strict(),
  z.object({ mode: z.literal("calibrate") }).strict(),
]);
export function createEvalRouter(supervisor: EvalSupervisor, discover = discoverRecordedSessions) {
  const router = Router(), store = supervisor.store;
  let discovery: Awaited<ReturnType<typeof discover>> | undefined;
  let discoveredAt = 0;
  let pendingDiscovery: ReturnType<typeof discover> | undefined;
  async function getDiscovery(force: boolean) {
    if (!force && discovery && Date.now() - discoveredAt < 15_000) return discovery;
    if (!pendingDiscovery) pendingDiscovery = discover().then(result => {
      discovery = result; discoveredAt = Date.now(); return result;
    }).finally(() => { pendingDiscovery = undefined; });
    return pendingDiscovery;
  }
  router.get("/dashboards/evals", (_req, res) => { res.type("html").send(evalPage); });
  router.get("/dashboards/evals/browser.js", (_req, res) => {
    res.sendFile("browser.js", { root: path.join(__dirname, __filename.endsWith(".ts") ? "../../dist/evals" : ".") });
  });
  router.get("/dashboards/evals/telemetry.js", (_req, res) => {
    res.sendFile("telemetryBrowser.js", { root: path.join(__dirname, __filename.endsWith(".ts") ? "../../dist/evals" : ".") });
  });
  router.get("/api/evals/sessions", async (req, res) => {
    try {
      const busy = await supervisor.busy();
      const [sources, histories] = await Promise.all([getDiscovery(req.query.refresh === "true"), recordedHistories(store)]);
      const statuses = sessionEvaluations(histories);
      const notEvaluated: RecordedSessionEvaluation = { status: "not_evaluated", attemptCount: 0 };
      const body: RecordedSessionsResponse = { ...sources, timezone: EVAL_TIMEZONE, busy,
        sessions: sources.sessions.map(session => ({ ...session, evaluation: statuses[session.sessionId] || notEvaluated })) };
      res.json(body);
    } catch (error) {
      console.error("[Recorded eval sessions]", error);
      res.status(503).json({ error: error instanceof Error ? error.message : "Session discovery unavailable" });
    }
  });
  router.get("/api/evals/session-statuses", async (_req, res) => {
    try {
      const busy = await supervisor.busy();
      res.json({ statuses: sessionEvaluations(await recordedHistories(store)), busy });
    } catch (error) {
      console.error("[Recorded eval status]", error);
      res.status(503).json({ error: "Evaluation status unavailable; try again" });
    }
  });
  router.get("/api/evals/sessions/:sessionId/history", async (req, res) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(req.params.sessionId))) {
      res.status(400).json({ error: "Invalid session ID" }); return;
    }
    try {
      await supervisor.busy();
      res.json((await recordedHistories(store)).get(String(req.params.sessionId)) || { attempts: [] });
    } catch (error) {
      console.error("[Recorded eval history]", error);
      res.status(503).json({ error: "Evaluation history unavailable; try again" });
    }
  });
  router.get("/api/evals", async (req, res, next) => {
    try {
      const busy = await supervisor.busy();
      const [allRuns, batches, alerts, groups, calibrations, jobs, schedules] = await Promise.all([
        store.list<EvalRun>("summaries"), store.list<EvalBatch>("batches"), store.list<EvalAlert>("alerts"), store.list<StepGroup>("groups"), store.list("calibrations"), store.list("jobs"),
        supervisor.scheduleStatus(),
      ]);
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : undefined;
      const runs = allRuns.filter(r => !agentId || r.agentId === agentId).sort((a, b) => b.gradedAt.localeCompare(a.gradedAt));
      const day = localDay();
      res.json({ busy, timezone: EVAL_TIMEZONE, baseline: { from: shiftDay(day, -7), to: shiftDay(day, -1), minimumSamples: 3 },
        scheduleEnabled: process.env.OFFLINE_EVAL_ENABLED !== "false", schedules, runs: runs.map(r => ({ ...r, verdict: runVerdict(r) })),
        batches: batches.filter(b => !agentId || b.agentId === agentId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
        alerts, groups, calibrations, jobs, fidelity: fidelityPairs(runs),
        fidelityNote: "Only matching task, device/app, starting state, assessed model/prompt, and grading versions are comparable. Missing historical metadata stays unmatched; no aggregate accuracy is inferred." });
    } catch (error) { next(error); }
  });
  router.get("/api/evals/runs/:id", async (req, res, next) => {
    try {
      const run = await store.read<EvalRun>("runs", String(req.params.id));
      if (!run) { res.status(404).json({ error: "Eval run not found" }); return; }
      res.json(run);
    } catch (error) { next(error); }
  });
  router.post("/api/evals/jobs", async (req, res) => {
    // The existing dashboard is LAN-only; reject cross-origin browser submissions.
    const origin = req.get("origin");
    if (origin && (!URL.canParse(origin) || new URL(origin).host !== req.get("host"))) { res.status(403).json({ error: "Cross-origin eval submission rejected" }); return; }
    const parsed = jobSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Select a valid eval mode and identifiers", details: parsed.error.issues }); return; }
    try { res.status(202).json(await supervisor.launch(parsed.data)); }
    catch (error) { res.status(409).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  return router;
}
export const evalSupervisor = new EvalSupervisor(new EvalStore());
export const evalRouter = createEvalRouter(evalSupervisor);
