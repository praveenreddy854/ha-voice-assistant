import { z } from "zod";
import { digest } from "./store";
import type { Assessment, Grade, ScoringComponent, TaskEvalScore } from "./types";

export const SCORING_RUBRIC = {
  policy: 1,
  progress: { none: 0, prerequisites: 15, partial: 30, nearly_complete: 45, complete: 100 },
  deductions: { minor: 5, moderate: 15, major: 30 },
  completedBand: { min: 50, max: 100 },
  incompleteBand: { min: 0, max: 49 },
  reportingCeiling: 20,
} as const;
export const SCORING_VERSION = digest(SCORING_RUBRIC);
const reason = z.string().trim().min(1);
const evidenceIds = z.array(z.string().min(1)).refine(ids => new Set(ids).size === ids.length, "Duplicate evidence reference");
const sufficiency = z.object({ sufficient: z.boolean(), reason, evidenceIds }).strict();
export const scoringAssessmentSchema = z.object({
  progress: z.object({
    level: z.enum(["none", "prerequisites", "partial", "nearly_complete", "complete", "unknown"]),
    reason, evidenceIds,
  }).strict(),
  mistakes: z.array(z.object({
    id: z.string().trim().min(1),
    severity: z.enum(["minor", "moderate", "major"]),
    reason, evidenceIds: evidenceIds.refine(ids => ids.length > 0, "A mistake must cite evidence"),
  }).strict()),
  evidence: z.object({ progress: sufficiency, execution: sufficiency, reporting: sufficiency }).strict(),
}).strict();

const components: ScoringComponent[] = ["progress", "execution", "reporting"];
export function supportsTaskScoring(assessment: Pick<Assessment, "mode" | "agentId">): boolean {
  return assessment.mode === "recorded" && assessment.agentId === "tv";
}
export function computeTaskScore(raw: unknown, grade: Pick<Grade, "task" | "reporting">, assessment: Assessment): TaskEvalScore {
  if (!supportsTaskScoring(assessment)) throw new Error("Task scoring applies only to recorded TVAgent runs");
  const scoring = scoringAssessmentSchema.parse(raw);
  const evidence = new Map(assessment.evidence.map(item => [item.id, item]));
  for (const item of [scoring.progress, ...scoring.mistakes, ...Object.values(scoring.evidence)]) {
    if (item.evidenceIds.some(id => !evidence.has(id))) throw new Error("Task scoring cited nonexistent evidence");
  }
  for (const component of components) {
    if (scoring.evidence[component].sufficient && !scoring.evidence[component].evidenceIds.length) {
      throw new Error(`Sufficient ${component} evidence requires references`);
    }
  }
  if (scoring.progress.level !== "unknown" && !scoring.progress.evidenceIds.length) {
    throw new Error("Known task progress requires evidence");
  }
  const episodeIds = new Set<string>(), episodeEvidence = new Set<string>();
  for (const mistake of scoring.mistakes) {
    // A context snapshot can describe multiple distinct actions; a tool result identifies one action.
    const actions = mistake.evidenceIds.map(id => evidence.get(id)!).filter(item => item.kind === "tool");
    const signature = actions.length ? JSON.stringify([...new Set(actions.map(item => item.source || item.id))].sort()) : undefined;
    if (episodeIds.has(mistake.id) || (signature !== undefined && episodeEvidence.has(signature))) {
      throw new Error("Duplicate mistake episode; cite distinct actions instead of charging repeated evidence");
    }
    episodeIds.add(mistake.id);
    if (signature !== undefined) episodeEvidence.add(signature);
  }
  const level = scoring.progress.level;
  if (scoring.evidence.progress.sufficient && level === "unknown") throw new Error("Sufficient progress evidence cannot have unknown progress");
  if ((grade.task.verdict === "pass" && level !== "complete") ||
      (level === "complete" && grade.task.verdict !== "pass") ||
      (!["pass", "fail"].includes(grade.task.verdict) && level !== "unknown")) {
    throw new Error("Task progress contradicts the task fulfillment judgment");
  }
  if (scoring.evidence.reporting.sufficient && grade.reporting.verdict === "unknown") {
    throw new Error("Sufficient reporting evidence cannot have an unknown reporting judgment");
  }
  const blockingComponents = components.filter(component => !scoring.evidence[component].sufficient);
  if (blockingComponents.length) return {
    status: "unscored", rubricVersion: SCORING_VERSION, value: null, blockingComponents,
    reason: blockingComponents.map(component => `${component}: ${scoring.evidence[component].reason}`).join("; "),
  };
  if (level === "unknown") throw new Error("Unknown progress cannot produce a task score");
  const baseScore = SCORING_RUBRIC.progress[level];
  const deductions = scoring.mistakes.map(mistake => ({ ...mistake, points: SCORING_RUBRIC.deductions[mistake.severity] }));
  const totalDeductions = deductions.reduce((sum, item) => sum + item.points, 0);
  const band = level === "complete" ? SCORING_RUBRIC.completedBand : SCORING_RUBRIC.incompleteBand;
  const bandAdjustedScore = Math.max(band.min, Math.min(band.max, baseScore - totalDeductions));
  const reportingCeiling = grade.reporting.verdict === "fail" ? SCORING_RUBRIC.reportingCeiling : undefined;
  return { status: "scored", rubricVersion: SCORING_VERSION,
    value: reportingCeiling === undefined ? bandAdjustedScore : Math.min(bandAdjustedScore, reportingCeiling),
    baseScore, deductions, totalDeductions, band: { ...band }, bandAdjustedScore,
    ...(reportingCeiling === undefined ? {} : { reportingCeiling }) };
}
