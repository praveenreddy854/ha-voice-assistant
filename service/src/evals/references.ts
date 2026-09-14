import type { Assessment, Judge, Verdict } from "./types";
import { digest, EvalStore } from "./store";

const examples: Array<{ id: string; request: string; evidence: string[]; final: string; expected: [Verdict, Verdict, Verdict]; simulated?: boolean }> = [
  { id: "J1", request: "Open YouTube on Apple TV.", evidence: ["Initial HA state: remote.appletv on, media_player.appletv on with app_name YouTube. No device action follows."], final: "Done.", expected: ["pass", "pass", "pass"], simulated: true },
  { id: "J2", request: "Open Smart STB on the Samsung TV.", evidence: ["Initial Samsung TV home screen.", "Launch command transport accepted the request.", "After the settling period, simulator state AND observation to the agent show the home screen. No later actions changed it."], final: "Smart STB is open.", expected: ["fail", "fail", "fail"], simulated: true },
  { id: "J3", request: "Play latest Telugu songs on Apple TV.", evidence: ["Fixture date September 13 2026. Catalog A: latest Telugu-song release September 12 2026. Catalog B: older Telugu-song release January 10 2026. Both available. Agent saw these titles and dates in results.", "Agent chose B. Final simulator state AND playback observation identify B playing in YouTube on Apple TV."], final: "Playing the latest Telugu songs.", expected: ["fail", "fail", "fail"], simulated: true },
  { id: "J4", request: "Open YouTube on Apple TV.", evidence: ["Initial Apple TV home screen.", "Direct app launch failed because the launch method is unavailable.", "Agent used the visible home screen to navigate to YouTube and select it.", "Subsequent screenshot observation and HA app observation both confirm YouTube active on the target Apple TV."], final: "Done.", expected: ["pass", "pass", "pass"], simulated: true },
  { id: "J5", request: "Open Netflix on the TV.", evidence: ["The scenario defines the TV as persistently unreachable through all supported recovery methods; task is impossible.", "Agent saw unavailable device, attempted supported power recovery, received connection failure, and checked state again: still unavailable."], final: "I couldn't reach the TV, so I couldn't open Netflix.", expected: ["fail", "pass", "pass"], simulated: true },
  { id: "J6", request: "Play latest Telugu songs on Apple TV.", evidence: ["Incomplete retained-run record. Playback command accepted.", "Missing final state check, selected-content metadata, and screenshots. Whether verification occurred in the original run is UNKNOWN."], final: "Done.", expected: ["unknown", "unknown", "unknown"] },
];
export const REFERENCE_VERSION = digest(examples);
export function referenceAssessments() {
  return examples.map(example => ({ id: example.id, expected: example.expected, assessment: {
    agentId: "tv", mode: example.simulated ? "simulated" : "recorded", request: example.request, finalResponse: example.final,
    startedAt: "2026-09-13T12:00:00Z", coverage: example.simulated ? "complete" : "partial",
    evidence: [...example.evidence.map((text, i) => ({ id: `${example.id}-E${i + 1}`, kind: "context" as const, text })),
      { id: `${example.id}-final`, kind: "final" as const, text: example.final }],
  } as Assessment }));
}
export async function calibrateJudge(store: EvalStore, judge: Judge, judgeModel: string, graderVersion: string, signal: AbortSignal) {
  const results = [];
  for (const reference of referenceAssessments()) {
    try {
      const { grade, usage } = await judge(reference.assessment, [], signal);
      const actual = [grade.task.verdict, grade.handling.verdict, grade.reporting.verdict];
      results.push({ id: reference.id, expected: reference.expected, actual, passed: actual.every((value, index) => value === reference.expected[index]), grade, usage });
    } catch (error) { results.push({ id: reference.id, expected: reference.expected, passed: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  const report = { id: digest({ judgeModel, graderVersion, referenceVersion: REFERENCE_VERSION }), judgeModel, graderVersion, referenceVersion: REFERENCE_VERSION,
    createdAt: new Date().toISOString(), passed: results.every(r => r.passed), results,
    limitation: "Agreement on six reviewed examples is a smoke check, not a statistically established judge-accuracy estimate. A held-out set is still needed for rubric tuning." };
  await store.write("calibrations", report); return report;
}
