# Telemetry review — November 10, 2026

## Scope and new evidence

Read the LAN service at `10.0.0.202:3005` on November 10 around 11:03 UTC.
Compared against the previous review completed November 9 at 12:56:34 UTC.
The service retains 173 production sessions and 1,399 eval summaries: no new
production sessions and 28 new scheduled synthetic evaluations.

| Agent | Batch | Completed cases | Task assertion true | Handling/reporting pass |
| --- | --- | ---: | ---: | ---: |
| TV | `ff0fc508-fca6-407e-935a-7f50ca9754b1` | 12 | 10 | 12 |
| ScheduledTask | `f2d95604-2c09-4088-8e7e-e25924a79d7e` | 16 | 10 | 16 |

Both batches completed with zero missing run summaries and no execution or
grading errors. The eight false task assertions are expected unfulfilled
outcomes: two unavailable/unconfirmed TV cases and six scheduling cases
requiring rejection, clarification, or reporting a storage failure. Passing
handling/reporting does not turn those into fulfilled tasks.

The recorded daily selection is `empty`, with zero eligible sessions. Online
evals remain enabled at sample rate 1; the worker heartbeat was current at
11:02:38.806Z. Its sole completed Home Assistant record is unchanged, with no
review requirement or judge disagreement. This supplies no new production
outcome or voice-quality evidence.

## Detailed regression review

Inspected full saved evidence for six cases, rather than relying solely on
summary grades. All assessed models are `gpt-6.1-sol`, judged by `gpt-6-astra`.

| Scenario | Run | Evidence |
| --- | --- | --- |
| `announcement-at-time` | `e3e7d59f-93f7-401c-b2dd-c5055462b297` | Exact save fields; no invented description or recurrence |
| `announcement-relative-dst` | `4fdcbc05-c66c-489d-be98-a4a0b3ff0c42` | `delaySeconds=600`, preserved request anchor, due 07:05Z across DST |
| `update-preserve-fields` | `0a89733f-f0ab-400d-a860-6b55c73c9736` | Only `dueDate` patched; following occurrence and all unrelated state preserved |
| `youtube-launch-recovery` | `7522f456-1383-4bfa-bde5-03c48f5f0e23` | Failed direct launch recovered through navigation; independent final state shows YouTube open |
| `netflix-unreachable` | `e93cf700-b738-4d6c-9669-440dd701fb37` | Device unavailable; final response reports inability to open Netflix |
| `smartstb-unconfirmed` | `51bc4020-927d-4e28-8e2c-d50a72c8b6fa` | Independent final state remains Home; final response reports unsuccessful launch |

The three scheduling cases retain `scheduled-task-simulator-2`, prompt
`229cb53235e0216f8d1c0db8`, and relative-DST fixture version 2. Their assertions
confirm exact storage/mutations, unchanged memory/entity state, and no policy
violations. Previous scheduling repairs continue to work in the live eval
runtime. These are isolated fixture results, not physical-device checks.

## Known gaps remain actionable

The November 10 realtime job, `scheduled-realtime-simulated-2026-11-10`, failed
at 08:13:10.190Z before creating a batch with:
`Configure AI_MODEL_REALTIME before running Realtime evals`.
The open worker-failure alert still points at the September 21 batch with a
generic incomplete-eval message. PR #62 remains open and unmerged at the time
of this review; today's evidence repeats the defect it already fixes.

Reviewed the pending fix, worker/recovery callers, timestamp ordering, stable
alert identity, per-agent keys, atomic storage, and resolved-history behavior.
No second implementation change is warranted. This run adds its audit to the
existing PR rather than duplicating that fix.

Realtime simulation still uses `/openai/realtime` and native Realtime
text/tool responses. Current production uses `/openai/v1/live/sessions` plus
`runLiveVoiceAgent` and the AI SDK reasoning loop with `AI_MODEL_ADVANCED`.
Simply setting the old variable would not demonstrate production coverage.
Restoring this coverage requires an adapter migration with isolated tool,
memory, and device fixtures and bounded execution. Today's passing suites
must not be presented as complete voice coverage.

No new voice attempt exists to close the previous downstream-job evidence
gap. No device action, remote configuration change, deployment, or restart
was performed.

## Validation and disposition

- Preserved all pre-existing uncommitted client telemetry and voice changes in
  the original checkout. Used an isolated managed worktree based on PR #62's
  `654cee1`, with no runtime source edits in this run.
- Service TypeScript compilation and prompt/skill copying passed.
- Full service suite: 373 passed, zero failures or skips. All 10 AI review
  policy fixtures passed. Diff whitespace check passed.
- No additional model-backed run was needed: the six retained full runs supply
  current model evidence without repeating paid execution.
- Private raw traces and test logs remain in `/tmp/ha-*20261110*`, outside Git.

Next release action: merge/release PR #62 through the required review gate,
then inspect a subsequent worker failure to verify refreshed alert evidence.
Separately migrate realtime evaluation to the production reasoning path and
verify future production voice attempts with downstream execution/state
observations. Browser diagnostic work remains outside this PR.
