# Telemetry review — November 8, 2026

## New evidence

Read the LAN service at `10.0.0.202:3005`. It retains 170 production session
summaries and 1,343 evaluation summaries, an increase of two sessions and 24
evaluations since the November 7 review completed at 17:39:45 UTC.

All 24 new evaluations completed on November 8: 12 TV evaluations passed, and
nine scheduling evaluations passed the handling/reporting run verdict. Three
scheduling evaluations failed:

| Scenario | Live run ID | Failure |
| --- | --- | --- |
| `announcement-at-time` | `a4736123-b9a1-407b-a0ff-ebe6f0abd9a2` | Extra description and recurrence fields |
| `announcement-relative-dst` | `13d8d822-855e-4c1b-8195-70f92bebffed` | Extra description and recurrence fields |
| `update-preserve-fields` | `cb499b56-d613-4735-80cf-00ffa723d5b5` | Seven unrelated fields in a dueDate-only patch |

These repeat the failures addressed by `b842554`. The live scheduling runs use
`scheduled-task-simulator-1` and prompt fingerprint
`18a98ff0c84a903272bbbb49`. The current repository uses simulator version 2,
and today's confirmations use fingerprint `229cb53235e0216f8d1c0db8`.
The live relative-DST scenario is version 1; the corrected repository fixture
is version 2. This establishes that the live eval runtime predates the current
fixes; it does not identify the exact deployed Git revision. The online eval
endpoint still returns HTTP 404.

The two new voice sessions concern a device-off request followed by a report
that it remained on. Both retained traces show successful background-job
acceptance and an acknowledgement, without downstream execution evidence.
The queried follow-up job trace returns HTTP 404. Neither successful physical
completion nor the cause of the reported failure can be established from this
record. Current repository code already retains downstream Home Assistant
execution traces and rejects unavailable/restored devices.

Passing handling/reporting verdicts above include expected unavailable-device
and rejected-write scenarios; they are not counts of fulfilled tasks.

## Validation and deep review

- Service build passed: `npm --ignore-scripts run build`.
- Full service suite passed: 371 tests, zero failures or skips.
- All three failing scenarios passed isolated current-code confirmations using
  assessed model `gpt-6.1-sol` and judge `gpt-6-astra`. Each passed task, handling,
  and reporting grades, exact storage and mutation assertions, and preservation
  checks for unrelated memory and device state. No execution or grading errors.
- Confirmation batch: `c0ae85be-f37d-47d8-a460-58813e752e96`, completed at
  2026-11-08T14:06:53.992Z. Results remain separate from scheduled live history.
- Reviewed the previous fix through the scheduling tool contract, orchestrator,
  AI SDK request construction, prompt fingerprint, relative-time fixture, and
  schema-validation boundaries. Existing tests exercise serialized requests
  through both simulator and production orchestration and preserve independent
  final-state and mutation checks.
- Inspected the new failing update's full tool evidence: the resulting stored
  values were correct, but the submitted patch still exceeded the requested
  field scope. The current-code confirmation submitted only the dueDate patch.

No additional application change is justified by this evidence. This commit
records the review; application source remains at the already validated fix.
Private raw traces and model results remain outside Git under `/tmp/ha-*20261108*`.

## Operational follow-up

Deploy/rebuild and restart the LAN service and its eval worker from the current
repository, then verify the new simulator/prompt versions and online endpoint.
Check the next scheduled run for these three cases. Revisit the device-off
failure after a new attempt retains downstream execution and device-state
evidence. No deployment, restart, or real-device action was performed here.
