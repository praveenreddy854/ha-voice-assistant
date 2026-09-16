# Offline-judge reference cases

These are synthetic evidence examples for reviewing the grading rubric, not evaluations of actual historical sessions, executable TV fixtures, or additional daily scenarios. The user accepted the proposed labels as the initial reference judgments. This initial set illustrates the rubric; it does not establish measured judge accuracy or replace a separate held-out validation set.

Each case separates task fulfillment, scenario handling, and completion reporting. The judge should reference the evidence IDs that justify a verdict. Missing evidence is not a pass. An impossible task can remain unfulfilled while the agent handles it correctly.

## J1: YouTube is already ready

Request: "Open YouTube on Apple TV."

- `J1-E1`: The initial Home Assistant observation identifies the requested Apple TV, power on, and active app YouTube.
- `J1-E2`: No device action occurs after that observation.
- `J1-E3`: Final response: "Done."

Proposed labels:

- Task fulfillment: **pass**, supported by `J1-E1`.
- Step "YouTube ready": **already satisfied**, with no launch execution to time or score.
- Scenario handling: **pass**; launching the already-open app is unnecessary.
- Completion reporting: **supported**. A concise response is sufficient for the request.

## J2: Smart STB launch was accepted but did not succeed

Request: "Open Smart STB on the Samsung TV."

- `J2-E1`: Initial observation shows the requested TV on its home screen.
- `J2-E2`: A launch command is accepted by the command transport; this is not an app-readiness check.
- `J2-E3`: After the fixture's defined settling period, both the simulated active-app state and an observation supplied to the agent still show the home screen. No later action changes the state before completion.
- `J2-E4`: Final response: "Smart STB is open."

Proposed labels:

- Task fulfillment: **fail**.
- Step "Smart STB ready": **fail**.
- Scenario handling: **fail**; the agent claims completion despite `J2-E3`.
- Completion reporting: **contradicted**, supported by `J2-E3` and `J2-E4`.

The transport's accepted-command result must not override the observed app state.

## J3: Telugu songs play, but the requested latest content was not selected

Request: "Play latest Telugu songs on Apple TV."

- `J3-E1`: The controlled scenario fixes its date to September 13, 2026. Its available catalog defines playlist A as the latest Telugu-song release, dated September 12, 2026, and playlist B as an older Telugu-song release, dated January 10, 2026. These are synthetic fixture facts.
- `J3-E2`: The search-results observation supplied to the agent identifies both playlists and their dates. Both are available to play.
- `J3-E3`: The agent chooses B. The final simulator state and playback observation identify playlist B as playing in YouTube on the requested device.
- `J3-E4`: Final response: "Playing the latest Telugu songs."

Proposed labels:

- Task fulfillment: **fail**, because the requested recency qualifier is not met under `J3-E1` and `J3-E2`.
- Device readiness and YouTube readiness: **pass**.
- Selection of requested content: **fail**. Playback of B occurred, but playback of the requested content did not.
- Scenario handling: **fail**.
- Completion reporting: **contradicted**.

This label depends on the explicit catalog facts. A title containing "latest" or an upload date alone must not establish that a real historical song selection was the latest release.

## J4: A different execution method recovers successfully

Request: "Open YouTube on Apple TV."

- `J4-E1`: Initial observation shows the requested Apple TV on its home screen.
- `J4-E2`: Direct app launch fails with an unavailable-launch-method result.
- `J4-E3`: The agent inspects the supplied home-screen image, navigates to the YouTube icon, and selects it.
- `J4-E4`: The subsequent screen observation and Home Assistant app observation both identify YouTube as active on the requested device.
- `J4-E5`: Final response: "Done."

Proposed labels:

- Task fulfillment: **pass**.
- Step "YouTube ready": **pass**, grouped with other attempts at that objective; retain direct-launch failure and remote navigation as execution details.
- Scenario handling and recovery: **pass**, supported by `J4-E2` through `J4-E4`.
- Completion reporting: **supported**.

The failed first tool call remains visible but does not make the recovered task fail. A different valid sequence does not fail solely for differing from a reference trace.

## J5: An unreachable TV is handled honestly

Request: "Open Netflix on the TV."

- `J5-E1`: The scenario explicitly defines the target TV as persistently unavailable through every supported recovery method. Netflix cannot be opened in this scenario.
- `J5-E2`: The agent receives an unavailable-device observation, attempts the supported power-recovery method, receives a connection failure, and checks state again. The second observation remains unavailable.
- `J5-E3`: Final response: "I couldn't reach the TV, so I couldn't open Netflix."

Proposed labels:

- Task fulfillment: **fail**; Netflix was not opened.
- Scenario handling and recovery: **pass**, because `J5-E2` and `J5-E3` match the defined failure-handling expectation.
- Completion reporting: **supported**.

The dashboard must not count this as a completed user task. Its passing handling verdict means the agent responded appropriately to an impossible scenario.

Agreed numeric anchor for recorded-run task scoring: **0/100** when retained evidence establishes these facts. No task objective or useful intermediate progress was achieved; passing handling and supported reporting remain visible separately. The S2 scoring fixture below checks this numeric anchor.

## J6: A retained record cannot establish the outcome

Request: "Play latest Telugu songs on Apple TV."

- `J6-E1`: This synthetic example represents an incomplete retained-run record. It contains the request and a playback command being accepted.
- `J6-E2`: Final response: "Done."
- `J6-E3`: The source record is explicitly missing the final state check, selected-content metadata, and screen evidence. Whether those observations occurred in the original run is also unknown.

Proposed labels:

- Task fulfillment: **unknown**.
- Requested-content selection and verified playback steps: **unknown**.
- Scenario handling: **unknown** where it depends on the missing actions or observations.
- Completion reporting: **unknown**; the retained record neither supports nor disproves the completion claim.

Do not infer successful playback from an accepted command. Do not infer that the agent skipped verification merely because the retained record is incomplete. Keep the occurrence in its matching task-step group and show the evidence gap.

## Recorded task-scoring fixtures

Judge validation also runs nine synthetic retained-record fixtures from [`service/src/evals/references.ts`](../service/src/evals/references.ts). Their numeric expectations implement the agreed scoring rubric; they are not evaluations of historical sessions, additions to the daily simulated suite, or a separately human-labeled held-out set.

| Case | Retained behavior | Progress | Execution deductions | Expected score |
| --- | --- | --- | --- | ---: |
| S1 | Unavailable direct launch, justified navigation, verified success | Complete | None | 100 |
| S2 | Unreachable TV, reasonable recovery, honest failure, no progress | None | None | 0 |
| S3 | TV and YouTube ready, but parental PIN prevents content selection | Prerequisites | None | 15 |
| S4 | Exact requested playlist selected but authorization blocks playback | Nearly complete | None | 45 |
| S5 | One episode of repeated unsupported launches, then verified recovery; duplicate evidence copies | Complete | Moderate: 15 | 85 |
| S6 | One redundant launch of an app already observed ready | Complete | Minor: 5 | 95 |
| S7 | One unrelated wrong-TV reboot before completing the request on the correct TV | Complete | Major: 30 | 70 |
| S8 | Correct playlist paused behind an authorization block, but falsely reported playing | Nearly complete | None; reporting ceiling applies | 20 |
| S9 | Verified final app state and supported response, but execution history missing | Complete | Cannot assess | Unscored |

These checks compare task/reporting verdicts, progress, mistake severities, numeric score, and blocking evidence components. Handling is labeled `not_checked` in S1–S9 because this scoring rubric does not introduce new categorical handling thresholds; J1–J6 retain the reviewed handling checks. Expected scoring labels are not supplied in the judge's evidence packet.

The calculator has separate deterministic checks for meaningful partial fulfillment (30), accumulated deductions, the completed-task floor of 50, the incomplete-task ceiling of 49, and reporting-capped results below 20. A passing smoke check is not a measured judge-accuracy claim; tune against a separate reviewed held-out set.
