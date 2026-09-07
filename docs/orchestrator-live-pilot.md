# TV history pilot — 2026-09-05 evening (2026-09-06 UTC)

The initial pilot did **not** demonstrate a latency or reliability improvement from adding curated history. It exposed a conversation-persistence defect that should be fixed before evaluating the learning design further.

## Experiment

Request: “Open YouTube on Apple TV and leave it on the YouTube home screen without playing a video.”

Both arms used the existing TV definition, tools, model (`gpt-5.6-sol`), memory retrieval, and completion validation in fresh processes. Both began with a visually inspected Apple TV app-grid home screen. The evidence arm added the compact historical examples and the user's advisory latency/reliability guidance preserved in [the pilot script](../service/scripts/tv-history-pilot.ts). It did not implement automatic history retrieval, confidence estimation, context replacement, or background learning.

Execution was timed around `runAgent`, including initial device-state and memory preparation. Both arms excluded channel routing, TV job management, reset/setup, Cosmos flow persistence/embedding, and human image-review time. A separate camera captured the starting and final screens. Experimental flow records were excluded from production Cosmos flow history; existing memory retrieval remained enabled.

## Observations

| Arm | Agent wall time | Time through final camera attempt | Outcome |
| --- | ---: | ---: | --- |
| Existing runtime | 120.005 s | 121.013 s | Timed out; camera showed YouTube profile selection, not its home feed |
| Existing runtime + curated history/guidance | 214.349 s | 226.483 s | Timed out; fresh final camera frame unavailable, final screen unverified |

The nominal 120-second timeout is cooperative. The second run exceeded it; its actual elapsed time is reported rather than counting the deadline as a successful completion. This pair cannot establish a reliability percentage, rank execution methods, or establish that added history caused the longer run.

The baseline recorded 23 completed model steps, 341,404 cumulative input tokens, 1,415 output tokens, 19 recorded tool results, and three captured screenshots. Cumulative input tokens count repeated context across requests; they are not the size of a single context window and do not represent uncached billing. The inspected tool sequence repeatedly loaded the same skills after screenshot boundaries.

Home Assistant reported paused YouTube playback while the independently inspected screen showed the Apple TV app grid. Its app/playback attributes did not establish the visible UI. Resetting with the `home` command also sometimes opened the Apple TV app; setup required another command and visual inspection before the comparable app-grid state was accepted. The pilot must not assume a reset command proves the starting screen.

The configured service RTSP camera worked for initial captures and baseline outcome inspection. A three-second capture from the MacBook Air microphone also succeeded (mean -57.8 dBFS, peak -45.1 dBFS). This was a microphone availability check, not a speech-recognition or TV-audio accuracy benchmark.

## Confirmed issue to fix separately

`service/src/agents/core/agentLoop.ts` persists `result.response.messages` after a `generateText` call. In the installed AI SDK 7.0.83, that property contains the final step's response. The SDK exposes the accumulated messages as `result.responseMessages`. When a screenshot interrupts a multi-tool call, the current implementation loses preceding skill loads, state observations, actions, and waits before resuming.

The repeated skill loading is consistent with that defect. A regression test should run the real SDK with a mock model through multiple automatic tools and two screenshot continuations, checking that every previous call/result survives exactly once and that an explicit failed completion remains failed. A subsequent live run should separate this persistence fix from the curated-history intervention.

## Reproduction and evidence limits

Run from `service/`, with the normal local backend credentials configured and live TV testing authorized:

```sh
npx tsx scripts/tv-history-pilot.ts reset baseline-1
# Inspect generated_data/history-pilot/baseline-1/before.jpg.
npx tsx scripts/tv-history-pilot.ts baseline baseline-1
npx tsx scripts/tv-history-pilot.ts reset evidence-1
# Inspect the starting screen again; correct setup before running the next arm.
npx tsx scripts/tv-history-pilot.ts evidence evidence-1
```

The script preserves the model's completion claim separately from an initially unknown verified outcome. Check `ready.jpg` as well as `before.jpg`; a nonterminal result or missing final image is incomplete evidence, not a fast success. Raw camera frames remain disposable. The script now stores compact results and review images under ignored `generated_data/history-pilot/`, outside the disposable camera tree.

The first runs used `out/history-pilot/`; those JSON/image artifacts were no longer present at the later resume. This report's timings and sequences are preserved in the local run logs (`/tmp/ha-tv-pilot-b1.log`, `/tmp/ha-tv-pilot-e1.log`) and the earlier in-session inspections. Raw room imagery and microphone audio are not committed.

## Follow-up after preserving tool history — 2026-09-06

The separate runtime fix changes the persisted response to the SDK's accumulated `responseMessages`. A real-SDK mock-model regression checks complete call/result contents and ordering through two screenshot continuations, including images and an explicit unsuccessful completion. It fails with the former `response.messages` behavior and passes with the fix. All five service tests, service TypeScript checking, and whitespace checks pass.

Live session `f5c32736-1e9f-4d5b-a894-23ab8ab7b50f` ran with that fix and no added history context. The agent reported completion in **83.289 seconds**; the independent final camera capture arrived at **83.794 seconds**. It made 14 completed model steps, using 196,449 cumulative input tokens and 957 output tokens. Each of the two skills was loaded once, with no skill reload after either screenshot continuation. The agent launched YouTube, selected the highlighted profile, and its screen-validation tool reported the home/browse feed with no player open. Independent final imagery also showed a YouTube browse feed without a full-screen player, although glare limited text legibility.

This is a successful continuation smoke check, not a controlled latency improvement estimate. The display was off at the later resume; setup powered it on and selected HDMI, and the fresh starting image showed an animated screen rather than the earlier app grid. Conditions and time differed from the original pair. One follow-up does not establish reliability, and exact Home-tab selection cannot be established from the overexposed final image alone. The task-history retrieval and context-budget design remains future work.
