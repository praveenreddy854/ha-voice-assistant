import { randomUUID } from "node:crypto";
import type { AgentAdapter, Assessment, Attempt, EvalBatch, EvalRun, Judge, RecordedEvalAttempt, StepGroup } from "./types";
import type { EvalJob } from "./worker";
import { EvalStore } from "./store";
import { baselineFor, runVerdict } from "./analytics";
import { RECORDED_IMPORT_VERSION } from "./types";
import { EvalExecutionError, EvalGradingError } from "./telemetry";

export class EvalRunner {
  constructor(readonly store: EvalStore, readonly judge: Judge, readonly judgeModel: string, readonly graderVersion: string) {}
  async assess(batch: EvalBatch, attempt: Attempt, adapterVersion: string, execute: () => Promise<Assessment>, signal: AbortSignal,
    scenario?: { id: string; version: string }, recorded?: { sessionId: string; attempt?: RecordedEvalAttempt }): Promise<EvalRun> {
    const run: EvalRun = { id: randomUUID(), batchId: batch.id, agentId: batch.agentId, mode: batch.mode, attempt,
      scenarioId: scenario?.id, scenarioVersion: scenario?.version, adapterVersion, graderVersion: this.graderVersion, judgeModel: this.judgeModel,
      scheduledDay: batch.scheduledDay, assessedAt: new Date().toISOString(), gradedAt: new Date().toISOString(), status: "execution_error",
      sourceSessionId: recorded?.sessionId, recordedAttemptId: recorded?.attempt?.id };
    const started = performance.now();
    const retainAssessment = (assessment: Assessment) => {
      run.assessment = assessment; run.assessedAt = assessment.startedAt; run.durationMs = assessment.durationMs;
      run.assessedModel = assessment.model; run.promptVersion = assessment.promptVersion;
    };
    const startedAttempt: RecordedEvalAttempt | undefined = recorded?.attempt ? {
      ...recorded.attempt, status: "running", startedAt: new Date().toISOString(), runId: run.id,
    } : undefined;
    if (startedAttempt) await this.store.write("attempts", startedAttempt);
    try {
      signal.throwIfAborted();
      const assessment = await execute();
      if (assessment.agentId !== batch.agentId || assessment.mode !== batch.mode) throw new Error("Assessment agent or mode does not match its evaluation batch");
      if (recorded && assessment.sourceSessionId !== recorded.sessionId) throw new Error("Retained assessment does not match the selected session");
      retainAssessment(assessment); run.status = "grading_error";
      const groups = (await this.store.list<StepGroup>("groups")).filter(g => g.agentId === assessment.agentId);
      const gradingStarted = performance.now();
      try {
        const judged = await this.judge(assessment, groups, signal);
        run.grade = judged.grade; run.judgeUsage = judged.usage; run.status = "completed";
      } finally { run.gradingDurationMs = Math.max(0, performance.now() - gradingStarted); }
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error);
      if (run.status === "grading_error" && error instanceof EvalGradingError) run.judgeUsage = error.usage;
      if (error instanceof EvalExecutionError) {
        if (error.assessment.agentId === batch.agentId && error.assessment.mode === batch.mode) retainAssessment(error.assessment);
        else run.error += "; partial assessment did not match its evaluation batch";
      }
      if (run.mode === "simulated" && run.status === "execution_error") run.durationMs ??= Math.max(0, performance.now() - started);
    }
    run.evaluationDurationMs = Math.max(0, performance.now() - started);
    run.gradedAt = new Date().toISOString();
    await this.store.saveRun(run); batch.runIds.push(run.id); await this.store.write("batches", batch);
    if (startedAttempt) await this.store.write<RecordedEvalAttempt>("attempts", {
      ...startedAttempt, status: run.status === "completed" ? "evaluated" : "eval_error", finishedAt: run.gradedAt, error: run.error,
    });
    return run;
  }
  async simulated(adapter: AgentAdapter, signal: AbortSignal, options: { scheduledDay?: string; scenarioIds?: string[]; jobId?: string } = {}): Promise<EvalBatch> {
    const scheduledDay = options.scheduledDay;
    if (scheduledDay) {
      const existing = (await this.store.list<EvalBatch>("batches")).find(b => b.mode === "simulated" && (b.agentId || "tv") === adapter.id && b.scheduledDay === scheduledDay && b.attempt === "scheduled");
      if (existing) return existing;
    }
    const batch = this.newBatch(adapter.id, "simulated", scheduledDay);
    await this.saveNewBatch(batch, options.jobId);
    const prior = await this.store.list<EvalRun>("summaries");
    try {
      const scenarios = options.scenarioIds ? adapter.scenarios.filter(s => options.scenarioIds!.includes(s.id)) : adapter.scenarios;
      if (!scenarios.length || (options.scenarioIds && scenarios.length !== new Set(options.scenarioIds).size)) throw new Error("Unknown or empty scenario selection");
      for (const scenario of scenarios) {
        signal.throwIfAborted();
        const run = await this.assess(batch, scheduledDay ? "scheduled" : "on_demand", adapter.version, () => adapter.execute(scenario, signal), signal, scenario);
        if (scheduledDay) {
          run.comparison = baselineFor(run, prior);
          if (run.comparison.signal) {
            const confirmation = await this.assess(batch, "confirmation", adapter.version, () => adapter.execute(scenario, signal), signal, scenario);
            const repeated = baselineFor(confirmation, prior).signal === run.comparison.signal;
            run.comparison.confirmation = runVerdict(confirmation) === "error" ? "incomplete" : repeated ? "confirmed" : "intermittent";
            if (repeated) await this.store.alert({ id: randomUUID(), agentId: adapter.id, key: `${adapter.id}:${scenario.id}:${run.comparison.signal}`, kind: run.comparison.signal,
              batchId: batch.id, createdAt: new Date().toISOString(), message: `${scenario.request}: confirmed ${run.comparison.signal} against the previous seven complete days.`, runIds: [run.id, confirmation.id] });
          } else if (runVerdict(run) === "pass") {
            await this.store.resolveAlert(`${adapter.id}:${scenario.id}:failure`);
            await this.store.resolveAlert(`${adapter.id}:${scenario.id}:slowdown`);
          }
          await this.store.saveRun(run);
        }
      }
    } catch (error) { batch.error = error instanceof Error ? error.message : String(error); }
    return this.finish(batch);
  }
  async recorded(agentId: string, inputs: Array<(() => Promise<Assessment>) | { sessionId: string; load: () => Promise<Assessment> }>,
    signal: AbortSignal, options: { jobId?: string; scheduledDay?: string; adapterVersion?: string } = {}): Promise<EvalBatch> {
    const batch = this.newBatch(agentId, "recorded", options.scheduledDay); await this.saveNewBatch(batch, options.jobId);
    const job = options.jobId ? await this.store.read<EvalJob>("jobs", options.jobId) : undefined;
    const attempts = job ? await this.store.queueRecordedAttempts(job) : [];
    for (const input of inputs) {
      if (signal.aborted) { batch.error = "Recorded evaluation interrupted"; break; }
      await this.assess(batch, batch.attempt, options.adapterVersion ?? RECORDED_IMPORT_VERSION, typeof input === "function" ? input : input.load, signal, undefined,
        typeof input === "function" ? undefined : { sessionId: input.sessionId, attempt: attempts.find(attempt => attempt.sourceSessionId === input.sessionId) });
      if (signal.aborted) break;
    }
    if (signal.aborted) {
      batch.error = "Recorded evaluation interrupted";
      if (job) await this.store.finishRecordedAttempts(job, batch.error);
    }
    return this.finish(batch);
  }
  private async saveNewBatch(batch: EvalBatch, jobId?: string) {
    batch.jobId = jobId;
    await this.store.write("batches", batch);
    if (jobId) {
      const job = await this.store.read<EvalJob>("jobs", jobId);
      if (!job) throw new Error("Eval job is missing");
      await this.store.write("jobs", { ...job, batchId: batch.id });
    }
  }
  private newBatch(agentId: string, mode: EvalBatch["mode"], scheduledDay?: string): EvalBatch {
    return { id: randomUUID(), agentId, mode, attempt: scheduledDay ? "scheduled" : "on_demand", scheduledDay,
      startedAt: new Date().toISOString(), status: "running", runIds: [] };
  }
  private async finish(batch: EvalBatch): Promise<EvalBatch> {
    const runs = await Promise.all(batch.runIds.map(id => this.store.read<EvalRun>("summaries", id)));
    batch.status = batch.error || runs.some(run => !run || run.status !== "completed") ? "incomplete" : "completed";
    batch.finishedAt = new Date().toISOString(); await this.store.write("batches", batch);
    if (batch.status === "incomplete") await this.store.alert({ id: randomUUID(), agentId: batch.agentId, key: `${batch.agentId}:incomplete`, batchId: batch.id, createdAt: batch.finishedAt,
      kind: "incomplete", message: batch.error || "One or more eval runs could not finish execution or grading.", runIds: batch.runIds });
    else await this.store.resolveAlert(`${batch.agentId}:incomplete`);
    return batch;
  }
}
