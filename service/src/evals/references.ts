import type { Assessment, Judge, MistakeSeverity, ScoringComponent, TaskProgressLevel, Verdict } from "./types";
import { digest, EvalStore } from "./store";
import { RECORDED_GRADER_VERSION } from "./judge";
import { SCORING_VERSION } from "./scoring";

const examples: Array<{ id: string; request: string; evidence: string[]; final: string; expected: [Verdict, Verdict, Verdict]; simulated?: boolean }> = [
  { id: "J1", request: "Open YouTube on Apple TV.", evidence: ["Initial HA state: remote.appletv on, media_player.appletv on with app_name YouTube. No device action follows."], final: "Done.", expected: ["pass", "pass", "pass"], simulated: true },
  { id: "J2", request: "Open Smart STB on the Samsung TV.", evidence: ["Initial Samsung TV home screen.", "Launch command transport accepted the request.", "After the settling period, simulator state AND observation to the agent show the home screen. No later actions changed it."], final: "Smart STB is open.", expected: ["fail", "fail", "fail"], simulated: true },
  { id: "J3", request: "Play latest Telugu songs on Apple TV.", evidence: ["Fixture date September 13 2026. Catalog A: latest Telugu-song release September 12 2026. Catalog B: older Telugu-song release January 10 2026. Both available. Agent saw these titles and dates in results.", "Agent chose B. Final simulator state AND playback observation identify B playing in YouTube on Apple TV."], final: "Playing the latest Telugu songs.", expected: ["fail", "fail", "fail"], simulated: true },
  { id: "J4", request: "Open YouTube on Apple TV.", evidence: ["Initial Apple TV home screen.", "Direct app launch failed because the launch method is unavailable.", "Agent used the visible home screen to navigate to YouTube and select it.", "Subsequent screenshot observation and HA app observation both confirm YouTube active on the target Apple TV."], final: "Done.", expected: ["pass", "pass", "pass"], simulated: true },
  { id: "J5", request: "Open Netflix on the TV.", evidence: ["The scenario defines the TV as persistently unreachable through all supported recovery methods; task is impossible.", "Agent saw unavailable device, attempted supported power recovery, received connection failure, and checked state again: still unavailable."], final: "I couldn't reach the TV, so I couldn't open Netflix.", expected: ["fail", "pass", "pass"], simulated: true },
  { id: "J6", request: "Play latest Telugu songs on Apple TV.", evidence: ["Incomplete retained-run record. Playback command accepted.", "Missing final state check, selected-content metadata, and screenshots. Whether verification occurred in the original run is UNKNOWN."], final: "Done.", expected: ["unknown", "unknown", "unknown"] },
];
interface ScoringReference {
  id: string;
  request: string;
  evidence: string[];
  final: string;
  task: "pass" | "fail";
  reporting: "pass" | "fail";
  progress: TaskProgressLevel;
  score: number | null;
  severities: MistakeSeverity[];
  blockingComponents?: ScoringComponent[];
}
const scoringExamples: ScoringReference[] = [
  { id: "S1", request: "Open YouTube on Apple TV.", task: "pass", reporting: "pass", progress: "complete", score: 100, severities: [],
    evidence: ["Complete retained sequence: Apple TV initially on its home screen. No other actions occurred.",
      "Direct YouTube launch returned method unavailable. The agent then used the visible YouTube icon on the home screen to navigate and select it.",
      "The next screenshot and HA state confirmed YouTube active and ready on the requested Apple TV before the final response."], final: "Done." },
  { id: "S2", request: "Open Netflix on the TV.", task: "fail", reporting: "pass", progress: "none", score: 0, severities: [],
    evidence: ["Complete retained sequence: TV unreachable. The advertised tools offer one power recovery method, which the agent tries.",
      "Power recovery returns connection failure. The agent checks again: TV still unreachable. No useful state change occurred; no further supported recovery method is available."],
    final: "I couldn't reach the TV, so I couldn't open Netflix." },
  { id: "S3", request: "Play latest Telugu songs on Apple TV.", task: "fail", reporting: "pass", progress: "prerequisites", score: 15, severities: [],
    evidence: ["Complete retained sequence: the agent powers on the target Apple TV and opens YouTube. Both states are confirmed.",
      "YouTube displays an unexpected parental PIN gate before any content can be searched or selected. The retained tool/permission context provides no way to proceed without the user's PIN. The agent does not attempt to bypass the restriction."],
    final: "YouTube is open, but I need you to enter the parental PIN before I can find and play the songs." },
  { id: "S4", request: "Play the Telugu playlist Latest Mix on Apple TV.", task: "fail", reporting: "pass", progress: "nearly_complete", score: 45, severities: [],
    evidence: ["Complete retained sequence: the agent correctly opens YouTube and selects the exact requested playlist on the requested Apple TV; title, language, and target are verified.",
      "Play returns account authorization required. The final player state shows the correct playlist selected but paused. The advertised tools cannot sign in or bypass account authorization, and no supported autonomous recovery is available."],
    final: "The requested playlist is selected, but playback needs you to sign in." },
  { id: "S5", request: "Open YouTube on Apple TV.", task: "pass", reporting: "pass", progress: "complete", score: 85, severities: ["moderate"],
    evidence: ["Complete retained sequence: Apple TV home screen; direct launch fails with an explicit permanent unsupported-method result. The agent has screenshot navigation available.",
      "Calls retry-1, retry-2, retry-3 immediately repeat the exact unsupported launch method with unchanged arguments and observations. No new information or state change occurred between them.",
      "The agent then uses the visible YouTube icon to navigate and select it. Screenshot and HA state confirm YouTube ready before completion.",
      "A separate Cosmos copy repeats the observations for retry-1, retry-2, retry-3. These are copies of the same three actions, not new executions."], final: "Done." },
  { id: "S6", request: "Open YouTube on Apple TV.", task: "pass", reporting: "pass", progress: "complete", score: 95, severities: ["minor"],
    evidence: ["Complete retained sequence: the initial observation unambiguously shows YouTube already open and ready on the requested Apple TV, with no overlay or pending action.",
      "The agent issues one launch of that same already-ready app. It has no adverse state effect. The agent then verifies the unchanged ready state and ends. No other action occurred."], final: "Done." },
  { id: "S7", request: "Open YouTube on Apple TV.", task: "pass", reporting: "pass", progress: "complete", score: 70, severities: ["major"],
    evidence: ["Complete retained sequence: the request and visible device map clearly distinguish the target Apple TV from the bedroom Samsung TV.",
      "The agent sends an unrelated reboot command to the bedroom Samsung TV, interrupting that other TV. This single command was not requested or needed and was not an external transport failure.",
      "It then opens YouTube on the correct Apple TV using the supported method. The final observation confirms YouTube ready on Apple TV."], final: "YouTube is open on Apple TV. I also mistakenly rebooted the bedroom TV." },
  { id: "S8", request: "Play the Telugu playlist Latest Mix on Apple TV.", task: "fail", reporting: "fail", progress: "nearly_complete", score: 20, severities: [],
    evidence: ["Complete retained sequence: the agent correctly opens YouTube, finds and selects the exact requested Telugu playlist on Apple TV. Title, language, and device are verified.",
      "Play returns account authorization required; the agent's final observation shows the selected playlist still paused. All permitted tools are unable to sign in or bypass authorization. No other action occurred before the final response."],
    final: "The requested playlist is playing." },
  { id: "S9", request: "Open YouTube on Apple TV.", task: "pass", reporting: "pass", progress: "complete", score: null, severities: [], blockingComponents: ["execution"],
    evidence: ["Only the terminal state and final response are retained. All earlier observations and execution actions are missing; whether avoidable mistakes occurred is unknown.",
      "The terminal HA observation and screenshot both confirm YouTube open and ready on the requested Apple TV immediately before the final response."], final: "Done." },
];
export const REFERENCE_VERSION = digest({ categorical: examples, scoring: scoringExamples, scoringVersion: SCORING_VERSION });
interface JudgeReference {
  id: string;
  expected: [Verdict, Verdict | "not_checked", Verdict];
  assessment: Assessment;
  expectedScore?: number | null;
  expectedProgress?: TaskProgressLevel;
  expectedSeverities?: MistakeSeverity[];
  expectedBlockingComponents?: ScoringComponent[];
}
export function referenceAssessments() {
  return examples.map(example => ({ id: example.id, expected: example.expected, assessment: {
    agentId: "tv", mode: example.simulated ? "simulated" : "recorded", request: example.request, finalResponse: example.final,
    startedAt: "2026-09-13T12:00:00Z", coverage: example.simulated ? "complete" : "partial",
    evidence: [...example.evidence.map((text, i) => ({ id: `${example.id}-E${i + 1}`, kind: "context" as const, text })),
      { id: `${example.id}-final`, kind: "final" as const, text: example.final }],
  } as Assessment }));
}
export function scoringReferenceAssessments(): JudgeReference[] {
  return scoringExamples.map(example => ({
    id: example.id, expected: [example.task, "not_checked", example.reporting],
    expectedScore: example.score, expectedProgress: example.progress, expectedSeverities: example.severities,
    expectedBlockingComponents: example.blockingComponents || [],
    assessment: {
      agentId: "tv", mode: "recorded", request: example.request, finalResponse: example.final,
      startedAt: "2026-09-15T12:00:00Z", coverage: "partial",
      evidence: [...example.evidence.map((text, i) => ({ id: `${example.id}-E${i + 1}`, kind: "context" as const, text })),
        { id: `${example.id}-final`, kind: "final", text: example.final }],
    },
  }));
}
export async function calibrateJudge(store: EvalStore, judge: Judge, judgeModel: string, graderVersion: string, signal: AbortSignal) {
  const results = [];
  const references: JudgeReference[] = [...referenceAssessments(), ...scoringReferenceAssessments()];
  for (const reference of references) {
    try {
      signal.throwIfAborted();
      const { grade, usage } = await judge(reference.assessment, [], signal);
      const actual = [grade.task.verdict, grade.handling.verdict, grade.reporting.verdict];
      const actualScore = grade.score?.value, actualProgress = grade.scoringAssessment?.progress.level;
      const actualSeverities = grade.scoringAssessment?.mistakes.map(mistake => mistake.severity);
      const actualBlockingComponents = grade.score?.status === "unscored" ? grade.score.blockingComponents : [];
      const sameMembers = (left: readonly string[] | undefined, right: readonly string[]) =>
        left !== undefined && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
      const scoreMatches = reference.expectedScore === undefined || (
        actualScore === reference.expectedScore && actualProgress === reference.expectedProgress &&
        sameMembers(actualSeverities, reference.expectedSeverities!) &&
        sameMembers(actualBlockingComponents, reference.expectedBlockingComponents!)
      );
      results.push({ id: reference.id, expected: reference.expected, actual,
        expectedScore: reference.expectedScore, actualScore, expectedProgress: reference.expectedProgress, actualProgress,
        expectedSeverities: reference.expectedSeverities, actualSeverities,
        expectedBlockingComponents: reference.expectedBlockingComponents, actualBlockingComponents,
        passed: scoreMatches && actual.every((value, index) => reference.expected[index] === "not_checked" || value === reference.expected[index]), grade, usage });
    } catch (error) {
      results.push({ id: reference.id, expected: reference.expected, expectedScore: reference.expectedScore,
        expectedProgress: reference.expectedProgress, expectedSeverities: reference.expectedSeverities,
        expectedBlockingComponents: reference.expectedBlockingComponents,
        passed: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const report = { id: digest({ judgeModel, graderVersion, recordedGraderVersion: RECORDED_GRADER_VERSION, referenceVersion: REFERENCE_VERSION }),
    judgeModel, graderVersion, recordedGraderVersion: RECORDED_GRADER_VERSION, scoringVersion: SCORING_VERSION, referenceVersion: REFERENCE_VERSION,
    createdAt: new Date().toISOString(), passed: results.every(r => r.passed), results,
    limitation: "Six reviewed categorical cases and nine rubric-derived scoring fixtures are smoke checks, not measured general judge accuracy. Scoring fixtures do not constrain handling verdicts (not_checked). A separately reviewed held-out set is still needed." };
  await store.write("calibrations", report); return report;
}
