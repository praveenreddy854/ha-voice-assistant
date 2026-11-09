# Telemetry review — November 9, 2026

## Evidence since the previous review

Read the LAN service at `10.0.0.202:3005`. It retains 173 production session
summaries and 1,371 eval summaries: three sessions and 28 evaluations added
since the November 8 review finished at 14:58:24 UTC.

All 28 new scheduled synthetic cases completed and passed handling/reporting:
12 TV cases and 16 scheduling cases. Independent task assertions passed for 20
cases and were false for eight expected rejection/unavailable outcomes. Those
eight are not fulfilled tasks. Both batches have no missing run summaries,
execution errors or grading errors. There are no new regression alerts.

The scheduling worker now reports `scheduled-task-simulator-2`, prompt
fingerprint `229cb53235e0216f8d1c0db8`, and relative-DST scenario version 2.
The three previously failing cases now pass on the deployed eval runtime:

| Scenario | Live run | Evidence checked |
| --- | --- | --- |
| `announcement-at-time` | `e6949c8e-c92d-48b9-aba1-32f79155b3fe` | Exact save fields, no extra description/recurrence |
| `announcement-relative-dst` | `c4c1e7ca-64e0-4a67-8256-80e909279f75` | `delaySeconds=600`, request anchor retained, due at 07:05Z across DST |
| `update-preserve-fields` | `13c8063c-4bba-492b-a164-62d2ebc2f5cb` | Only `dueDate` patched; following occurrence and unrelated fields preserved |

Inspected full saved assertions, not only judge verdicts. All three match exact
storage and mutations, preserve memory/device fixture state, and report no
policy violations. No additional paid model confirmation was needed.

## New monitoring defect and fix

The Realtime synthetic worker failed before creating a batch/run on November 9:
job `scheduled-realtime-simulated-2026-11-09` reports
`Configure AI_MODEL_REALTIME before running Realtime evals` at 08:15:04 UTC.
However, its open `realtime:worker-failure` alert still displayed a September 21
batch with the generic message `Batch contains incomplete evals`.

`EvalStore.alert` discarded every subsequent occurrence of an unresolved key.
It now refreshes the existing alert's evidence, message and occurrence timestamp
while retaining its ID. Older delayed occurrences cannot overwrite newer ones.
Resolved history remains intact and a later recurrence creates a new alert.
Individual jobs/batches remain the history of each attempt. This fixes stale
monitoring details; it does not restore the missing Realtime coverage or
retroactively rewrite deployed alert records.

## Production and online evidence

The online eval API now returns HTTP 200, is enabled at sample rate 1, and has a
healthy worker. Its enrollment began November 8 at 20:27:31.998Z, after the two
new voice sessions. It has one completed Home Assistant evaluation with no
judge/reviewer disagreement or review requirement.

That session retained translation and HTTP evidence for a device-off request.
Both judges explicitly base task fulfillment on the supplied already-off
starting state. Reporting passes because it says the command was sent; no
post-command observation proves a physical transition. Do not interpret this
as verified shutdown or broad voice-quality coverage.

The other two new voice traces retain async acceptance and an acknowledgement,
including a follow-up off request resolved to the preceding target. Both job
trace lookups return HTTP 404. Their eventual device effect cannot be established.
No device actions were issued during this review.

## Validation and deep review

- Worked from clean `origin/master` at `dc80bf8` in a separate managed worktree;
  preserved all pre-existing uncommitted client/telemetry changes.
- The new repeated-worker-failure regression fails against the original store
  implementation and passes with the fix.
- Full service suite: 373 tests passed, no failures or skips. Covers latest
  failure evidence, stable ID/no duplicate, delayed older reports, agent
  isolation, resolved history and recurrence.
- Service TypeScript build passed. Required AI review policy fixtures: 10 passed.
- Reviewed callers in worker failure/recovery and scenario alerting, existing
  atomic file persistence, timestamp ordering, cross-agent keys, dashboard
  message/time rendering, and resolution behavior. No API/schema change or
  voice/device execution change; no frontend behavior changed.
- Private raw traces and model evidence remain outside Git in `/tmp/ha-*20261109*`.

## Remaining follow-up

Deploy the alert fix through the normal review/release process. A subsequent
failure will refresh the stale open alert; historical job records already show
its current cause. Existing alerts are not automatically resolved by this change.

Realtime synthetic coverage needs alignment with the production GPT Live and
AI SDK reasoning path. Its current adapter still builds the legacy native
Realtime preview WebSocket request, and its latest retained scenario results
are October 7 preview-API retirement errors. Simply setting `AI_MODEL_REALTIME`
would neither verify the current production pipeline nor address the old
protocol. Track this as a coverage migration; the passing TV/scheduling suites
must not hide today's failed Realtime worker.

Inspect a future voice attempt that retains downstream job execution and
state evidence before attributing physical failures. Browser diagnostics are
still uncommitted work in the original checkout and were not included here.
