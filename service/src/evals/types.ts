export type Verdict = "pass" | "fail" | "unknown" | "not_applicable";
export type EvalMode = "simulated" | "recorded";
export type Attempt = "scheduled" | "confirmation" | "on_demand";
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
export interface Grade {
  task: Judgment;
  handling: Judgment;
  reporting: Judgment;
  recovery: Judgment;
  steps: StepGrade[];
  context: ComparisonContext;
  gaps: string[];
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
  comparison?: { baselineCount: number; medianMs?: number; signal?: "failure" | "slowdown"; confirmation?: "confirmed" | "intermittent" | "incomplete" };
}
export interface EvalBatch {
  id: string;
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
