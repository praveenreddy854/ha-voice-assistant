# Telemetry review — November 7, 2026

## Evidence

Reviewed the LAN service at `10.0.0.202:3005`: 168 retained production sessions
and 1,319 recorded/simulated evaluation summaries. Between November 1 and 7,
174 evaluations completed: 90 TV passes, 63 scheduling passes, and 21 scheduling
failures. All 21 failures were the same three scenarios, each failing daily:

- `announcement-at-time`: unwanted empty description and daily recurrence metadata.
- `announcement-relative-dst`: the same unwanted fields on a one-time reminder.
- `update-preserve-fields`: a due-time edit submitted seven unrelated fields.

Inspected full evidence for runs `61922498-cf60-4522-92e7-10b3ed8adcbe`
and `52831dfc-d82c-4b9e-b1cd-9a59b017cab3`, including model arguments,
returned storage state, and independent mutation assertions. The latest retained
recorded TV evaluation passed. Recent production summaries do not establish
physical completion of delegated Home Assistant commands. The online evaluation
endpoint returned HTTP 404 on the running service.

## Changes and review

Scheduling schemas deliberately have optional properties, but Responses requests
omitted `strict`. Provider normalization then required every property, prompting
invented recurrence metadata and full-object update patches. The unchanged-code
model reproduction also filled both mutually exclusive time fields and invented
an announcement follow-up phase, preventing saves with the current schema.

Added an explicit strictness field to the common tool contract, preserved it
through the production orchestrator and SDK, and selected `strict: false` for
scheduling tools. SDK and executor Zod validation still reject malformed calls.
Other agents keep their existing provider settings. Scheduling instructions now
explicitly omit unused creation fields and demonstrate a dueDate-only patch.
The evaluation prompt fingerprint includes strictness.

The fixed relative-time execution exposed a stale fixture: it expected a
client-calculated absolute timestamp and omitted the new server timing metadata.
Updated that fixture to require `delaySeconds: 600`, retain the immutable receipt,
and keep the independently expected 07:05Z DST-crossing deadline. Its scenario
version is now 2; exact storage and mutation comparisons remain enforced.

Reviewed production and simulator propagation, schema rejection paths, prompt
fingerprinting, recurrence, and timed-phase preservation. Regression checks
inspect serialized model requests through both simulator and production paths.
Also isolated the HA tracing test from pre-existing retained sessions, so repeated
test runs do not count older traces as new results.

## Validation

- Service build passed: `npm --ignore-scripts run build` (TypeScript and asset copy).
- Full service suite passed: 371 tests, zero failures. API tests required loopback
  socket access outside the filesystem sandbox.
- Model-backed isolated runs used `gpt-6.1-sol` and judge `gpt-6-astra`.
  Absolute reminder, dueDate-only update, recurring action, and atomic timed
  shutoff passed both exact simulator assertions and task/handling/reporting grades.
- The corrected relative-DST run passed exact storage and mutation assertions;
  its first judge call encountered `ECONNRESET`. A separate recheck passed exact
  assertions and task/handling/reporting grades. All five final cases passed.
- The baseline had no successful task assertions across the three targeted cases;
  execution and judge errors are retained separately from assessed failures.

Private raw results remain in `/tmp/ha-telemetry-*-20261107`, outside Git.
These small synthetic checks establish regression coverage, not general model
accuracy or physical device completion. Commit/push does not deploy the service;
the LAN deployment must receive the change before runtime behavior improves.
