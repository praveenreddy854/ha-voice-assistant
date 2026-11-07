import { Router } from "express";
import { z } from "zod";
import { EvalStore, processIsRunning } from "../store";
import { isOnlineAgentId } from "./snapshot";
import path from "node:path";
import { dimensions, ONLINE_GRADER_VERSION } from "./quality";
import type { OnlineEnrollment, OnlineRecord, OnlineResult, OnlineSnapshot } from "./engine";
import { onlineStore, onlineSupervisor, type OnlineEvalSupervisor } from "./supervisor";
import { onlinePage } from "./page";

export function onlineSummary(records: OnlineRecord[]) {
  const completed = records.filter(record => record.status === "completed");
  const outcomes = Object.fromEntries(dimensions.map(dimension => [dimension,
    Object.fromEntries(["pass", "fail", "unknown", "not_applicable"].map(verdict => [verdict,
      completed.filter(record => record.verdicts?.[dimension] === verdict).length]))]));
  // Keep model/prompt/judge versions separate: changing the task mix is not a causal model comparison.
  const cohorts = new Map<string, OnlineRecord[]>();
  for (const record of completed) {
    const key = JSON.stringify([record.agentId, record.model || "unreported", record.promptVersion || "unreported", record.graderVersion, record.judgeModel, record.reviewerModel]);
    cohorts.set(key, [...(cohorts.get(key) || []), record]);
  }
  return {
    total: records.length, completed: completed.length, reviewRequired: completed.filter(record => record.reviewRequired).length,
    states: Object.fromEntries(["queued", "running", "completed", "eval_error", "skipped"].map(state => [state, records.filter(record => record.status === state).length])),
    outcomes,
    cohorts: [...cohorts.values()].map(rows => ({
      agentId: rows[0].agentId, model: rows[0].model || "unreported", promptVersion: rows[0].promptVersion || "unreported",
      graderVersion: rows[0].graderVersion, judgeModel: rows[0].judgeModel, reviewerModel: rows[0].reviewerModel,
      count: rows.length, taskPass: rows.filter(record => record.verdicts?.task === "pass").length,
      taskFail: rows.filter(record => record.verdicts?.task === "fail").length,
      taskUnknown: rows.filter(record => record.verdicts?.task === "unknown").length,
      reportingFail: rows.filter(record => record.verdicts?.reporting === "fail").length,
    })),
  };
}

export function createOnlineRouter(supervisor: OnlineEvalSupervisor, store: EvalStore) {
  const router = Router();
  router.get("/dashboards/evals/online", (_req, res) => { res.type("html").send(onlinePage); });
  router.get("/dashboards/evals/online/browser.js", (_req, res) => {
    res.sendFile("browser.js", { root: __filename.endsWith(".ts") ? path.join(__dirname, "../../../dist/evals/online") : __dirname });
  });
  router.get("/api/evals/online", async (req, res) => {
    if (req.query.agentId !== undefined && !isOnlineAgentId(req.query.agentId)) { res.status(400).json({ error: "Unknown evaluation agent" }); return; }
    try {
      const [records, enrollment, worker] = await Promise.all([
        store.list<OnlineRecord>("records"), store.read<OnlineEnrollment>("state", "enrollment"),
        store.read<{ pid: number; updatedAt: string; stopped?: boolean; error?: string }>("state", "worker"),
      ]);
      const selected = records.filter(record => !req.query.agentId || record.agentId === req.query.agentId);
      res.json({
        enabled: supervisor.config.enabled, sampleRate: supervisor.config.sampleRate, enabledAt: enrollment?.enabledAt,
        worker: { running: Boolean(worker && !worker.stopped && processIsRunning(worker.pid) && Date.now() - Date.parse(worker.updatedAt) < 60_000),
          lastHeartbeat: worker?.updatedAt, error: worker?.error || supervisor.lastError },
        summary: onlineSummary(selected), records: selected.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)).slice(0, 200),
        total: selected.length, limit: 200,
      });
    } catch { res.status(503).json({ error: "Online evaluation history unavailable" }); }
  });
  const idSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/).max(100);
  router.get("/api/evals/online/:id", async (req, res) => {
    if (!idSchema.safeParse(req.params.id).success) { res.status(400).json({ error: "Invalid evaluation ID" }); return; }
    try {
      const id = String(req.params.id), record = await store.read<OnlineRecord>("records", id);
      if (!record) { res.status(404).json({ error: "Online evaluation not found" }); return; }
      const [snapshot, result] = await Promise.all([store.read<OnlineSnapshot>("snapshots", id), store.read<OnlineResult>("results", id)]);
      res.json({ record, snapshot, result });
    } catch { res.status(503).json({ error: "Online evaluation evidence unavailable" }); }
  });
  router.post("/api/evals/online/:id/retry", async (req, res) => {
    const body = z.object({ requestId: z.string().uuid() }).strict().safeParse(req.body);
    if (!body.success || !idSchema.safeParse(req.params.id).success) { res.status(400).json({ error: "Provide a valid evaluation ID and UUID requestId" }); return; }
    if (!supervisor.config.enabled) { res.status(409).json({ error: "Online evaluations are disabled" }); return; }
    let release: (() => Promise<void>) | undefined;
    try {
      release = await store.acquire("submission.lock");
      if (!release) { res.status(409).json({ error: "Another submission is in progress" }); return; }
      const original = await store.read<OnlineRecord>("records", String(req.params.id));
      if (!original) { res.status(404).json({ error: "Online evaluation not found" }); return; }
      const existing = await store.read<OnlineRecord>("records", body.data.requestId);
      if (existing) {
        if (existing.sourceSessionId !== original.sourceSessionId || existing.evidenceHash !== original.evidenceHash) {
          res.status(409).json({ error: "Request ID already belongs to a different evaluation" }); return;
        }
        res.status(202).json(existing); return;
      }
      const records = await store.list<OnlineRecord>("records");
      const pending = records.filter(record => record.status === "queued" || record.status === "running");
      if (pending.length >= supervisor.config.maxPending || pending.some(record => record.sourceSessionId === original.sourceSessionId && record.agentId === original.agentId)) {
        res.status(409).json({ error: "The queue is full or this session already has an active evaluation" }); return;
      }
      const snapshot = await store.read<OnlineSnapshot>("snapshots", original.id);
      if (!snapshot) { res.status(409).json({ error: "No retained snapshot; evaluate this session through recorded-run evaluation" }); return; }
      const id = body.data.requestId;
      await store.writeOnce("snapshots", { ...snapshot, id });
      const record: OnlineRecord = {
        id, sourceSessionId: original.sourceSessionId, agentId: original.agentId, request: original.request,
        sourceStartedAt: original.sourceStartedAt, requestedAt: new Date().toISOString(), status: "queued",
        evidenceHash: snapshot.evidenceHash, graderVersion: ONLINE_GRADER_VERSION, model: original.model, promptVersion: original.promptVersion,
      };
      await store.writeOnce("records", record);
      res.status(202).json(record);
    } catch { res.status(503).json({ error: "Online evaluation submission unavailable; reuse the requestId when retrying" }); }
    finally { await release?.(); }
  });
  return router;
}
export const onlineRouter = createOnlineRouter(onlineSupervisor, onlineStore);
