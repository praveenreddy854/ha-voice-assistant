import { digest } from "../store";
import { GRADER_VERSION, validateGrade } from "../judge";
import { sumUsage } from "../telemetry";
import type { Assessment, Grade, Judge, Usage, Verdict } from "../types";

export const ONLINE_REVIEW_INSTRUCTIONS = `Independently audit this production run. Prioritize request qualifiers, wrong-device actions, repeated ineffective recovery, and contradictions between screenshots and device metadata. For scheduling, verify all requested phases and their timing: a natural-language promise to wait is not a persisted shutoff. Recalculating an expired relative deadline from a later tool response changes the requested deadline. A single song does not establish a requested playlist or mix. These are failure patterns, not assumptions that this run failed. Cite applicable evidence, preserve unknowns, and accept valid alternative implementations. You have not seen another evaluator's judgment.`;
export const ONLINE_GRADER_VERSION = digest({ grader: GRADER_VERSION, review: ONLINE_REVIEW_INSTRUCTIONS, consensus: 2 });
export const dimensions = ["task", "handling", "reporting", "recovery"] as const;
export interface OnlineQuality {
  primary: Grade;
  reviewer: Grade;
  verdicts: Record<typeof dimensions[number], Verdict>;
  disagreements: string[];
  reviewRequired: boolean;
  score: number | null;
  usage?: Usage;
}

/** No averaging away a disagreement or converting missing evidence into a pass. */
export async function evaluateOnline(assessment: Assessment, primary: Judge, reviewer: Judge, signal: AbortSignal): Promise<OnlineQuality> {
  const first = await primary(assessment, [], signal);
  signal.throwIfAborted();
  const a = validateGrade(first.grade, assessment);
  const second = await reviewer(assessment, [], signal);
  signal.throwIfAborted();
  // Validate injected judges too, so neither the worker nor tests bypass citation checks.
  const b = validateGrade(second.grade, assessment);
  const verdicts = {} as OnlineQuality["verdicts"], disagreements: string[] = [];
  for (const key of dimensions) {
    verdicts[key] = a[key].verdict === b[key].verdict ? a[key].verdict : "unknown";
    if (a[key].verdict !== b[key].verdict) disagreements.push(key);
  }
  if (a.scoringAssessment?.progress.level !== b.scoringAssessment?.progress.level ||
      a.score?.value !== b.score?.value ||
      JSON.stringify(a.scoringAssessment?.mistakes.map(m => JSON.stringify([m.severity, [...m.evidenceIds].sort()])).sort()) !==
        JSON.stringify(b.scoringAssessment?.mistakes.map(m => JSON.stringify([m.severity, [...m.evidenceIds].sort()])).sort())) disagreements.push("scoring");
  const steps = (grade: Grade) => grade.steps.map(step => `${step.objective}:${step.verdict}`).sort();
  if (JSON.stringify(steps(a)) !== JSON.stringify(steps(b))) disagreements.push("steps");
  return {
    primary: a, reviewer: b, verdicts, disagreements,
    reviewRequired: disagreements.length > 0,
    score: disagreements.length ? null : a.score?.value ?? null,
    usage: sumUsage([first.usage, second.usage]),
  };
}
