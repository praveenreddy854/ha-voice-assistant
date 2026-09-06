# Task-history baseline

Read-only inspection on 2026-09-05 to choose representative workloads for orchestrator learning.

## Sources and coverage

- Called the running service at `http://127.0.0.1:3005`: `GET /api/telemetry/sessions`, eleven selected `GET /api/telemetry/sessions/:sessionId` requests, and `GET /api/scheduled-tasks`.
- The service returned 110 telemetry sessions and zero active scheduled tasks. Its telemetry routes read exported traces, not Cosmos.
- No Cosmos TV-history HTTP endpoint exists in the inspected service. Used the service's configured Cosmos credentials through the SDK for read-only `SELECT` queries against existing containers; no container initialization, device commands, or data changes were performed.
- Counted and fetched all 158 stored TV-flow records, representing 158 distinct sessions. Creation dates span 2026-04-01 through 2026-08-23 UTC. There are 36 records since 2026-06-07 and 27 since 2026-08-06, the 90- and 30-day windows measured from 2026-09-05 00:00 UTC.
- Only 72 of the 158 Cosmos sessions match the local service telemetry list. Latency observations below come from matched or explicitly identified trace-only runs, rather than the whole Cosmos population.
- Cosmos also contains 17 scheduled firing records for 16 distinct scheduled-task IDs. These are firing attempts, not counts of original conversational requests.

## Frequent TV request families

Counts group wording variants by request family. They describe stored executions, which can include repeated tests or retries; they are not unique-user demand or independently verified successes.

| Request family | All stored TV runs | Last 90 days | Last 30 days |
| --- | ---: | ---: | ---: |
| Telugu-song/music playback | 46 | 1 | 1 |
| YouTube launch, including combined power-on/watch-history requests | 18 | 9 | 8 |
| Pause/resume | 18 | 2 | 1 |
| TV power without an accompanying app-launch request | 13 | 5 | 3 |
| Netflix launch | 6 | 3 | 2 |
| Smart STB launch | 5 | 5 | 5 |

The normalized exact request `play latest telugu songs on apple tv` appears 36 times. The broader Telugu group includes specific songs and wording/device variants. The YouTube group includes one Samsung Smart YouTube request. One additional `Smart STV` request is an ambiguous possible transcription variant and is excluded from Smart STB counts. No stored TV prompt mentions Disney+ or Mandalorian.

Recent usage makes YouTube launch and Smart STB important alongside the historically frequent Telugu-song workflow.

## Representative service-API details

| Session | Request and observed sequence | Duration | Interpretation |
| --- | --- | ---: | --- |
| `83b0145a-7a71-4f5b-8ec5-3496dea1c0ac` | Telugu songs: launch YouTube, inspect existing results, select one, inspect playback and device metadata naming Yetta Yetta / T-Series Telugu. | 43.722 s | Useful candidate with supporting playback evidence; it starts from existing results rather than a fresh search. |
| `69143ec5-411e-4e9c-a802-d7ee0e2d391a` | Telugu songs: two screenshots and one wait, followed by a claim that matching content is already playing. | 14.830 s | An already-satisfied starting state; not evidence of a faster search-and-play method. |
| `353d380e-c27a-4df5-88c9-4b5045a3d1a3` | Telugu songs: repeated navigation, search/typing and recovery; 20 screenshot requests and 20 waits. Final message says playback could not be started or verified. | 618.545 s | `complete_task.success` is false, but telemetry and Cosmos store true and Cosmos execution score is 1. |
| `f30375be-fee0-49c8-955b-2351ec783366` | Telugu songs: four app-launch attempts, seven state reads and six research calls. Final message reports physical display off and app state unknown. | 373.324 s | Reported failure; useful for distinguishing Apple TV availability from the physical display and recognizing ineffective retries. |
| `5fb41657-a9da-436f-aa2a-f28b8a75f315` | YouTube launch: completes immediately with a claim that YouTube is already open; no action tool call. | 4.317 s | Another already-satisfied case, not a measured app-launch execution. |
| `6f692aa4-3997-457e-acc9-2896da8c04c3` | YouTube readiness: failed back/home commands, research, state reads and a screenshot, ending with a success claim. | 127.644 s | Trace-only case, absent from the Cosmos flow set; useful for recovery and source-coverage validation. |
| `b35edaff-7fce-40c2-b61a-d3e3712ad401` | Smart STB: power on Samsung TV and send launch command; tool reports PARTIAL and unknown app. | 81.273 s | Completion call and persisted outcome say success, but final message explicitly admits the app was not confirmed. |
| `43dd8fbc-ac03-4c46-9788-c28e854f3eb1` | Smart STB: launch, research and screenshot; final message says the expected app was not reached. | 83.532 s | Reported failure with verification evidence, comparable as a failure-condition fixture rather than a controlled timing comparison. |
| `cb73e192-82c1-47a3-9275-c591f8b186e0` | Netflix: wake attempt, wait, state still off, launch returns partial. | 21.070 s | Completion call says false, while Cosmos stores true and score 1. |
| `b1847a9b-2191-4fc9-b848-a3a62865cfd5` | Pause Apple TV: one media-control call followed by completion. | 8.485 s | Simple-command comparison; command acceptance alone does not establish verified playback state. |

An additional Telugu-song run, `cba3a063-cf2f-4cb8-8df2-7dd1b680776a` (113.075 s), claims playing video satisfies the music request. It should be reviewed for content matching before being treated as a verified positive example.

## Outcome quality and interpretation

- Historical completion flags can disagree with the model's explicit completion arguments, as the Telugu and Netflix cases demonstrate. Current source code handles an explicit false flag; this inspection does not establish the historical cause of those mismatches.
- All six Netflix flow documents have `success: true` and execution score 1. Three final messages explicitly state Netflix could not launch; the other three describe commands sent or unresolved app state. These summaries do not establish a verified Netflix success rate.
- Smart STB demonstrates a separate issue: a success flag can agree across layers while the evidence only establishes command acceptance.
- Exclude or separately label cancellations, unsupported-model errors, unverified outcomes, and already-satisfied starting states when evaluating methods. The observed durations span different dates, starting states, and versions; they are not a controlled ranking of alternative methods.
- Historical commands and tool observations are evidence for analysis, not instructions to repeat device actions.

## Benchmarks selected from observed usage

1. YouTube launch/readiness on Apple TV, separated by app already open, app closed, and device/display off.
2. Telugu-song search and playback, separated by already playing, visible matching results, and a fresh keyboard search; include the long unsuccessful navigation case.
3. Samsung Smart STB launch, with confirmed app readiness distinguished from a partial service response.
4. Pause/resume as a check that history retrieval does not add unnecessary delay to simple requests.
5. Netflix launch as an outcome-label integrity and power-state recovery case.
6. For cross-agent coverage, use the service's actual Tesla scheduling/list/update conversation. There are nine ScheduledTask telemetry sessions; inspect creation/update results separately from due-time firing outcomes. One update response says updating was unavailable despite a positive summary flag.

These cases replace the hypothetical Mandalorian request as the initial data-backed benchmark candidates. They do not authorize replaying live device actions.
