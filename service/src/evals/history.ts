import { EvalStore } from "./store";
import type { EvalJob } from "./worker";
import type { EvalBatch, EvalRunSummary, RecordedEvalAttempt, RecordedSessionEvaluation, RecordedSessionHistory } from "./types";

export async function recordedHistories(store: EvalStore): Promise<Map<string, RecordedSessionHistory>> {
  const [attempts, summaries, jobs, batches] = await Promise.all([
    store.list<RecordedEvalAttempt>("attempts"), store.list<EvalRunSummary>("summaries"),
    store.list<EvalJob>("jobs"), store.list<EvalBatch>("batches"),
  ]);
  const runs = new Map(summaries.filter(run => run.mode === "recorded").map(run => [run.id, run]));
  const linkedRuns = new Set(attempts.map(attempt => attempt.runId).filter(Boolean));
  const linkedJobs = new Set(attempts.map(attempt => attempt.jobId));
  const histories = new Map<string, RecordedSessionHistory>();
  const add = (attempt: RecordedEvalAttempt, run?: EvalRunSummary) => {
    const history = histories.get(attempt.sourceSessionId) || { attempts: [] };
    history.attempts.push({ ...attempt, run });
    histories.set(attempt.sourceSessionId, history);
  };
  for (const attempt of attempts) add(attempt, attempt.runId ? runs.get(attempt.runId) : undefined);
  // Old jobs retain the selection even when evidence import failed before recording a source ID.
  for (const job of jobs.filter(job => job.mode === "recorded" && !linkedJobs.has(job.id))) {
    const batch = batches.find(batch => batch.id === job.batchId || batch.jobId === job.id);
    for (const [index, sessionId] of (job.sessionIds || []).entries()) {
      const run = batch?.runIds[index] ? runs.get(batch.runIds[index]) : undefined;
      if (run) linkedRuns.add(run.id);
      add({
        id: `legacy-${job.id}-${index}`, jobId: job.id, agentId: run?.agentId || job.agentId || "tv", sourceSessionId: sessionId,
        status: run ? run.status === "completed" ? "evaluated" : "eval_error"
          : job.status === "queued" || job.status === "running" ? "queued" : "eval_error",
        requestedAt: job.createdAt || batch?.startedAt || run?.gradedAt || "",
        finishedAt: run?.gradedAt || job.finishedAt, runId: run?.id,
        error: run?.error || (!run && job.status === "failed" ? job.error || "Evaluation did not finish" : undefined),
      }, run);
    }
  }
  for (const run of runs.values()) {
    if (!run.sourceSessionId || linkedRuns.has(run.id)) continue;
    add({ id: `legacy-${run.id}`, jobId: run.batchId, agentId: run.agentId, sourceSessionId: run.sourceSessionId, runId: run.id,
      status: run.status === "completed" ? "evaluated" : "eval_error", requestedAt: run.gradedAt, finishedAt: run.gradedAt, error: run.error }, run);
  }
  for (const history of histories.values()) history.attempts.sort((a, b) =>
    b.requestedAt.localeCompare(a.requestedAt) || (b.finishedAt || "").localeCompare(a.finishedAt || "") || b.id.localeCompare(a.id));
  return histories;
}

export function sessionEvaluations(histories: Map<string, RecordedSessionHistory>): Record<string, RecordedSessionEvaluation> {
  const statuses: Record<string, RecordedSessionEvaluation> = Object.create(null);
  for (const [sessionId, history] of histories) {
    const latest = history.attempts[0];
    if (!latest) continue;
    const { run: _run, ...latestAttempt } = latest;
    statuses[sessionId] = {
      status: latest.status, attemptCount: history.attempts.length, latestAttempt,
      latestCompleted: history.attempts.find(attempt => attempt.run?.status === "completed")?.run,
    };
  }
  return statuses;
}
