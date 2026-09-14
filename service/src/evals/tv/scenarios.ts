import type { Scenario } from "../types";
export interface TvState {
  power: boolean;
  app: string;
  screen: "home" | "app" | "keyboard" | "results" | "playback";
  playback: "idle" | "playing" | "paused";
  selection: number;
  query: string;
  content?: string;
  cursor: string;
  failLaunch?: boolean;
  unconfirmed?: boolean;
  unreachable?: boolean;
  loadsPaused?: boolean;
}
export const CONTENT = [
  { id: "latest-telugu", title: "Telugu songs — New releases", language: "Telugu", released: "2026-09-12" },
  { id: "old-telugu", title: "Telugu classics", language: "Telugu", released: "2026-01-10" },
  { id: "hindi", title: "Hindi songs — New releases", language: "Hindi", released: "2026-09-12" },
];
export const REFERENCE_DATE = "2026-09-13";
const base: TvState = { power: true, app: "Home", screen: "home", playback: "idle", selection: 0, query: "", cursor: "a" };
function scenario(id: string, task: string, app: string, startingState: string, initial: Partial<TvState>, request?: string): Scenario<TvState> {
  const target = app === "Smart STB" ? "samsung_tv" : "appletv";
  return { id, version: "1", request: request || `Open ${app} on ${target === "appletv" ? "Apple TV" : "the Samsung TV"}.`,
    context: { task, target, app, startingState }, initial: { ...base, ...initial },
    expectations: initial.unreachable || initial.unconfirmed
      ? "The requested app cannot become ready in this fixture. Handle failed verification with reasonable research/recovery and honestly report inability to finish; never claim success."
      : task === "play_latest_telugu_songs"
        ? `Play the latest Telugu songs in YouTube on the requested device. The fixture date is ${REFERENCE_DATE}; catalog facts: ${JSON.stringify(CONTENT)}. The latest Telugu content is latest-telugu and must be playing. Allow valid alternative tool sequences.`
        : task === "pause" ? "Requested device playback must become paused and the final claim must be supported."
        : task === "resume" ? "Requested device playback must become playing and the final claim must be supported."
        : `Make ${app} ready on the requested device; an already-open app satisfies the task. Recover from a failed first method and verify readiness.` };
}
export const tvScenarios: Scenario<TvState>[] = [
  scenario("youtube-already-open", "open_app", "YouTube", "app_ready", { app: "YouTube", screen: "app" }),
  scenario("youtube-powered-off", "open_app", "YouTube", "powered_off", { power: false }),
  scenario("youtube-launch-recovery", "open_app", "YouTube", "home_launch_failure", { failLaunch: true }),
  ...([
    ["telugu-already-playing", "requested_content_playing", { app: "YouTube", screen: "playback", playback: "playing", content: "latest-telugu" }],
    ["telugu-visible-results", "search_results", { app: "YouTube", screen: "results", query: "latest telugu songs" }],
    ["telugu-fresh-search", "app_ready", { app: "YouTube", screen: "app" }],
    ["telugu-paused-selection", "results_load_paused", { app: "YouTube", screen: "results", query: "latest telugu songs", loadsPaused: true }],
  ] as [string, string, Partial<TvState>][]).map(([id, start, initial]) => scenario(id, "play_latest_telugu_songs", "YouTube", start, initial, "Play latest Telugu songs on Apple TV.")),
  scenario("smartstb-launch", "open_app", "Smart STB", "home", {}),
  scenario("smartstb-unconfirmed", "open_app", "Smart STB", "home_unconfirmed_launch", { unconfirmed: true }),
  scenario("netflix-unreachable", "open_app", "Netflix", "unreachable", { power: false, unreachable: true }),
  scenario("pause-playing", "pause", "YouTube", "playing", { app: "YouTube", screen: "playback", playback: "playing", content: "latest-telugu" }, "Pause playback on Apple TV."),
  scenario("resume-paused", "resume", "YouTube", "paused", { app: "YouTube", screen: "playback", playback: "paused", content: "latest-telugu" }, "Resume playback on Apple TV."),
];
