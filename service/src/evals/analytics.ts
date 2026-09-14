import type { EvalRun } from "./types";

export const EVAL_TIMEZONE = "America/New_York";
export function localDay(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: EVAL_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}
export function shiftDay(day: string, delta: number): string {
  const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + delta); return date.toISOString().slice(0, 10);
}
export function isDue(date = new Date()): boolean {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: EVAL_TIMEZONE, hour: "2-digit", hourCycle: "h23" }).format(date)) >= 3;
}
export function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
export function runVerdict(run: EvalRun): "pass" | "fail" | "unknown" | "error" {
  if (run.status !== "completed" || !run.grade) return "error";
  if (run.grade.handling.verdict === "fail" || run.grade.reporting.verdict === "fail") return "fail";
  if (run.grade.handling.verdict === "pass" && run.grade.reporting.verdict === "pass") return "pass";
  return "unknown";
}
export function baselineFor(current: EvalRun, runs: EvalRun[]) {
  const day = current.scheduledDay || localDay(new Date(current.assessedAt));
  const prior = runs.filter(r => r.mode === "simulated" && r.attempt === "scheduled" && r.agentId === current.agentId &&
    r.scenarioId === current.scenarioId && r.scenarioVersion === current.scenarioVersion && r.adapterVersion === current.adapterVersion &&
    r.graderVersion === current.graderVersion && r.judgeModel === current.judgeModel &&
    r.scheduledDay && r.scheduledDay >= shiftDay(day, -7) && r.scheduledDay < day);
  const comparable = prior.filter(r => ["pass", "fail"].includes(runVerdict(r)));
  const successfulTimes = comparable.filter(r => runVerdict(r) === "pass" && r.grade?.task.verdict === "pass" && r.durationMs != null).map(r => r.durationMs!);
  const medianMs = successfulTimes.length >= 3 ? median(successfulTimes) : undefined;
  let signal: "failure" | "slowdown" | undefined;
  if (comparable.length >= 3 && comparable.every(r => runVerdict(r) === "pass") && runVerdict(current) === "fail") signal = "failure";
  if (medianMs != null && medianMs > 0 && runVerdict(current) === "pass" && current.grade?.task.verdict === "pass" && (current.durationMs ?? 0) > medianMs * 2) signal = "slowdown";
  return { baselineCount: comparable.length, medianMs, signal };
}
export function fidelityPairs(runs: EvalRun[]) {
  return runs.filter(r => r.mode === "simulated" && r.grade).map(simulated => {
    const matches = runs.filter(real => real.mode === "recorded" && real.status === "completed" && real.agentId === simulated.agentId && real.grade &&
      simulated.assessedModel && simulated.promptVersion && real.assessedModel === simulated.assessedModel && real.promptVersion === simulated.promptVersion &&
      real.graderVersion === simulated.graderVersion && real.judgeModel === simulated.judgeModel &&
      !Object.values(real.grade.context).includes("unknown") && JSON.stringify(real.grade.context) === JSON.stringify(simulated.grade!.context));
    return { simulatedId: simulated.id, recordedIds: matches.map(m => m.id), status: matches.length ? "comparable" : "No comparison data yet" };
  });
}
