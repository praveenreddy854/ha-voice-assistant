import type { AgentTrace } from "../../tracing/agentTraceStore";
import { digest, EvalStore } from "../store";
import type { Assessment, Judge } from "../types";
import { isOnlineAgentId, onlineAssessment, type OnlineAgentId } from "./snapshot";
import type { OnlineEvalConfig } from "./config";
import { evaluateOnline, ONLINE_GRADER_VERSION, type OnlineQuality } from "./quality";

export interface OnlineRecord {
  id: string;
  sourceSessionId: string;
  agentId: OnlineAgentId;
  requestedAt: string;
  sourceStartedAt: string;
  status: "queued" | "running" | "completed" | "eval_error" | "skipped";
  startedAt?: string;
  finishedAt?: string;
  request: string;
  model?: string;
  promptVersion?: string;
  evidenceHash?: string;
  graderVersion: string;
  judgeModel?: string;
  reviewerModel?: string;
  error?: string;
  verdicts?: OnlineQuality["verdicts"];
  reviewRequired?: boolean;
  disagreements?: string[];
  score?: number | null;
  judgeUsage?: OnlineQuality["usage"];
}
export interface OnlineResult { id: string; evidenceHash: string; quality: OnlineQuality; finishedAt: string }
export interface OnlineSnapshot { id: string; evidenceHash: string; assessment: Assessment }
export interface OnlineEnrollment { id: "enrollment"; enabledAt: string }
export interface OnlineJudges { primary: Judge; reviewer: Judge; judgeModel: string; reviewerModel: string }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export function onlineRecordId(trace: Pick<AgentTrace, "agentType" | "sessionId" | "startedAt">): string {
  // Late HTTP spans can move a reconstructed start time; that must not create
  // another paid attempt for the same session.
  return digest([trace.agentType, trace.sessionId]);
}
export function isSampled(id: string, rate: number): boolean {
  return parseInt(digest(id).slice(0, 12), 16) / 0x1000000000000 < rate;
}

/** Runs exclusively in the child process. No agent actions, Cosmos writes or request-path hooks. */
export class OnlineEvalEngine {
  private active = false;
  constructor(readonly store: EvalStore, readonly config: OnlineEvalConfig,
    private readonly judges: () => Promise<OnlineJudges>, private readonly now = () => new Date()) {}

  async enroll(): Promise<OnlineEnrollment> {
    const enrollment = await this.store.writeOnce<OnlineEnrollment>("state", { id: "enrollment", enabledAt: this.now().toISOString() });
    if (!Number.isFinite(Date.parse(enrollment.enabledAt))) throw new Error("Invalid online evaluation enrollment cutoff");
    return enrollment;
  }

  async discover(traces: AgentTrace[], enabledAt: string): Promise<void> {
    const release = await this.store.acquire("submission.lock");
    if (!release) return;
    try { await this.capture(traces, enabledAt); }
    finally { await release(); }
  }

  private async capture(traces: AgentTrace[], enabledAt: string): Promise<void> {
    const records = await this.store.list<OnlineRecord>("records");
    const seen = new Set(records.map(record => record.id));
    let pending = records.filter(record => record.status === "queued" || record.status === "running").length;
    for (const trace of [...traces].sort((a, b) => a.startedAt.localeCompare(b.startedAt))) {
      if (!isOnlineAgentId(trace.agentType) || !["completed", "error"].includes(trace.status) || !trace.completedAt ||
          !Number.isFinite(Date.parse(trace.completedAt)) || !Number.isFinite(Date.parse(trace.startedAt)) ||
          Date.parse(trace.startedAt) < Date.parse(enabledAt) || Date.parse(trace.completedAt) > this.now().getTime() - 2_000) continue;
      const id = onlineRecordId(trace);
      if (seen.has(id)) continue;
      seen.add(id);
      const record: OnlineRecord = {
        id, sourceSessionId: trace.sessionId, agentId: trace.agentType, request: trace.userPrompt,
        sourceStartedAt: trace.startedAt, requestedAt: this.now().toISOString(), status: "queued", graderVersion: ONLINE_GRADER_VERSION,
      };
      if (!isSampled(id, this.config.sampleRate)) {
        record.status = "skipped"; record.error = "Excluded by deterministic sampling";
      } else if (pending >= this.config.maxPending) {
        record.status = "skipped"; record.error = "Online evaluation queue capacity reached; this run was not graded";
      } else {
        try {
          const assessment = onlineAssessment(trace);
          const bytes = Buffer.byteLength(JSON.stringify(assessment));
          const textBytes = Buffer.byteLength(JSON.stringify({ ...assessment, evidence: assessment.evidence.map(({ image, ...item }) => item) }));
          if (bytes > this.config.maxEvidenceBytes || textBytes > this.config.maxTextBytes) throw new Error("Evidence exceeds the configured evaluation limit; no evidence was silently truncated and no judge was called");
          const evidenceHash = digest(assessment);
          const snapshot = await this.store.writeOnce<OnlineSnapshot>("snapshots", { id, evidenceHash, assessment });
          record.evidenceHash = snapshot.evidenceHash;
          record.model = snapshot.assessment.model;
          record.promptVersion = snapshot.assessment.promptVersion;
          pending++;
        } catch (error) { record.status = "eval_error"; record.error = message(error); }
      }
      if (record.status !== "queued") record.finishedAt = this.now().toISOString();
      await this.store.writeOnce("records", record);
    }
  }

  private async finish(record: OnlineRecord, result: OnlineResult): Promise<void> {
    await this.store.write<OnlineRecord>("records", {
      ...record, status: "completed", finishedAt: result.finishedAt, error: undefined,
      verdicts: result.quality.verdicts, reviewRequired: result.quality.reviewRequired,
      disagreements: result.quality.disagreements, score: result.quality.score, judgeUsage: result.quality.usage,
    });
  }

  /** Never silently repeat a possibly paid call. Preserve results published before a crash. */
  async recover(): Promise<void> {
    for (const record of await this.store.list<OnlineRecord>("records")) if (record.status === "running") {
      const result = await this.store.read<OnlineResult>("results", record.id);
      if (result && result.evidenceHash === record.evidenceHash) await this.finish(record, result);
      else await this.store.write<OnlineRecord>("records", {
        ...record, status: "eval_error", finishedAt: this.now().toISOString(),
        error: "Online worker interrupted during grading; explicit retry required. The assistant's task outcome is unknown.",
      });
    }
  }

  async runNext(signal: AbortSignal): Promise<boolean> {
    if (this.active) return false;
    this.active = true;
    try {
      signal.throwIfAborted();
      const record = (await this.store.list<OnlineRecord>("records")).filter(record => record.status === "queued")
        .sort((a, b) => a.sourceStartedAt.localeCompare(b.sourceStartedAt) || a.id.localeCompare(b.id))[0];
      if (!record) return false;
      record.status = "running"; record.startedAt = this.now().toISOString();
      await this.store.write("records", record);
      try {
        const snapshot = await this.store.read<OnlineSnapshot>("snapshots", record.id);
        if (!snapshot || snapshot.evidenceHash !== record.evidenceHash || digest(snapshot.assessment) !== record.evidenceHash) throw new Error("Evidence snapshot missing or changed");
        const judges = await this.judges();
        record.judgeModel = judges.judgeModel; record.reviewerModel = judges.reviewerModel;
        await this.store.write("records", record);
        const gradingSignal = AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]);
        let onAbort: (() => void) | undefined;
        try {
          // Bound even a provider that fails to honor cancellation.
          const quality = await Promise.race([
            evaluateOnline(snapshot.assessment, judges.primary, judges.reviewer, gradingSignal),
            new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(gradingSignal.reason);
              if (gradingSignal.aborted) onAbort();
              else gradingSignal.addEventListener("abort", onAbort, { once: true });
            }),
          ]);
          const result = await this.store.writeOnce<OnlineResult>("results", {
            id: record.id, evidenceHash: snapshot.evidenceHash, quality, finishedAt: this.now().toISOString(),
          });
          await this.finish(record, result);
        } finally { if (onAbort) gradingSignal.removeEventListener("abort", onAbort); }
      } catch (error) {
        await this.store.write<OnlineRecord>("records", { ...record, status: "eval_error", error: message(error), finishedAt: this.now().toISOString() });
      }
      return true;
    } finally { this.active = false; }
  }
}
