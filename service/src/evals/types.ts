export type Verdict = "pass" | "fail" | "unknown" | "not_applicable";
export type EvalMode = "simulated" | "recorded";
export type Attempt = "scheduled" | "confirmation" | "on_demand";
export const EVAL_AGENT_IDS = ["tv", "scheduled_task", "realtime"] as const;
export type EvalAgentId = typeof EVAL_AGENT_IDS[number];
export const RECORDED_IMPORT_VERSION = "recorded-import-3";
export interface Evidence {
  id: string;
  kind: "initial" | "tool" | "image" | "final" | "context" | "assertion";
  text: string;
  timestamp?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  durationMs?: number;
  image?: string;
  source?: string;
}
export interface Judgment { verdict: Verdict; reason: string; evidenceIds: string[] }
export interface ComparisonContext { task: string; target: string; app: string; startingState: string }
export interface StepGrade extends Judgment {
  objective: string;
  startingState: string;
  alreadySatisfied: boolean;
  groupId?: string;
}
export type TaskProgressLevel = "none" | "prerequisites" | "partial" | "nearly_complete" | "complete";
export type MistakeSeverity = "minor" | "moderate" | "major";
export type ScoringComponent = "progress" | "execution" | "reporting";
export interface ScoringEvidence {
  sufficient: boolean;
  reason: string;
  evidenceIds: string[];
}
export interface TaskMistakeEpisode {
  id: string;
  severity: MistakeSeverity;
  reason: string;
  evidenceIds: string[];
}
export interface TaskScoringAssessment {
  progress: { level: TaskProgressLevel | "unknown"; reason: string; evidenceIds: string[] };
  mistakes: TaskMistakeEpisode[];
  evidence: Record<ScoringComponent, ScoringEvidence>;
}
export type TaskEvalScore = {
  status: "scored";
  rubricVersion: string;
  value: number;
  baseScore: number;
  deductions: Array<TaskMistakeEpisode & { points: number }>;
  totalDeductions: number;
  band: { min: number; max: number };
  bandAdjustedScore: number;
  reportingCeiling?: number;
} | {
  status: "unscored";
  rubricVersion: string;
  value: null;
  reason: string;
  blockingComponents: ScoringComponent[];
};
export interface Grade {
  task: Judgment;
  handling: Judgment;
  reporting: Judgment;
  recovery: Judgment;
  steps: StepGrade[];
  context: ComparisonContext;
  gaps: string[];
  scoringAssessment?: TaskScoringAssessment;
  score?: TaskEvalScore;
}
export interface Usage { inputTokens?: number; outputTokens?: number; totalTokens?: number }
export interface Assessment {
  agentId: string;
  mode: EvalMode;
  request: string;
  finalResponse: string;
  startedAt: string;
  durationMs?: number;
  model?: string;
  promptVersion?: string;
  evidence: Evidence[];
  coverage: "complete" | "partial";
  context?: ComparisonContext;
  expectations?: string;
  taskAssertion?: boolean;
  sourceSessionId?: string;
  usage?: Usage;
}
export interface Scenario<T = unknown> {
  id: string;
  version: string;
  request: string;
  context: ComparisonContext;
  expectations: string;
  initial: T;
}
export interface AgentAdapter {
  id: string;
  version: string;
  scenarios: Scenario[];
  model: string;
  promptVersion: string;
  execute(scenario: Scenario, signal: AbortSignal): Promise<Assessment>;
}
export interface EvalRun {
  id: string;
  batchId: string;
  agentId: string;
  mode: EvalMode;
  attempt: Attempt;
  scenarioId?: string;
  scenarioVersion?: string;
  adapterVersion: string;
  graderVersion: string;
  judgeModel: string;
  assessedModel?: string;
  promptVersion?: string;
  scheduledDay?: string;
  assessedAt: string;
  gradedAt: string;
  status: "completed" | "execution_error" | "grading_error";
  error?: string;
  durationMs?: number;
  assessment?: Assessment;
  grade?: Grade;
  judgeUsage?: Usage;
  sourceSessionId?: string;
  recordedAttemptId?: string;
  comparison?: { baselineCount: number; medianMs?: number; signal?: "failure" | "slowdown"; confirmation?: "confirmed" | "intermittent" | "incomplete" };
}
export interface EvalBatch {
  id: string;
  jobId?: string;
  agentId: string;
  mode: EvalMode;
  attempt: "scheduled" | "on_demand";
  scheduledDay?: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "completed" | "incomplete" | "skipped";
  runIds: string[];
  error?: string;
}
export interface EvalAlert {
  id: string;
  agentId?: string;
  key: string;
  batchId: string;
  createdAt: string;
  resolvedAt?: string;
  kind: "failure" | "slowdown" | "incomplete";
  message: string;
  runIds: string[];
}
export interface StepGroup { id: string; agentId: string; objective: string; target: string; app: string; startingState: string }
export type Judge = (assessment: Assessment, groups: StepGroup[], signal: AbortSignal) => Promise<{ grade: Grade; usage?: Usage }>;

export interface EvalRunSummary extends Omit<EvalRun, "assessment"> {
  request?: string;
  usage?: Usage;
  taskAssertion?: boolean;
}
export interface RecordedEvalAttempt {
  id: string;
  jobId: string;
  agentId?: string;
  sourceSessionId: string;
  status: "queued" | "running" | "evaluated" | "eval_error";
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  runId?: string;
  error?: string;
}
export interface RecordedSessionEvaluation {
  status: RecordedEvalAttempt["status"] | "not_evaluated";
  attemptCount: number;
  latestAttempt?: RecordedEvalAttempt;
  latestCompleted?: EvalRunSummary;
}
export interface RecordedSession {
  sessionId: string;
  agentId: string;
  userPrompt: string;
  startedAt: string;
  completedAt?: string;
  status: "completed" | "error" | "failed";
  sources: Array<"telemetry" | "cosmos">;
  evaluation: RecordedSessionEvaluation;
}
export interface RecordedSessionsResponse {
  sessions: RecordedSession[];
  warnings: string[];
  timezone: string;
  busy: boolean;
}
export interface RecordedSessionHistory {
  attempts: Array<RecordedEvalAttempt & { run?: EvalRunSummary }>;
}
