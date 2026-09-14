# Data available for grading completed TVAgent runs

Read-only inspection on 2026-09-12 of current source and local telemetry exports. No assistant runs, device actions, camera captures, or Cosmos writes were performed.

## Local export coverage

Scanned 27 JSONL files in `service/logs`, deduplicating spans by span ID within each session and grouping by `agent.session.id`. All lines parsed successfully. Found 112 attributed sessions, including 103 TV sessions; 84 TV sessions explicitly have a terminal status of `completed` or `error`.

| Evidence present in the 84 terminal TV sessions | Sessions |
| --- | ---: |
| User request | 84 |
| Final message | 84 |
| At least one model-step message snapshot | 62 |
| At least one retained screenshot payload | 31 |
| At least one model identifier in current telemetry fields | 2 |

These counts establish field presence, not complete evidence for every decision. Screenshot payloads were counted without visually validating or decoding every image. A session without screenshots may still be assessable from device-state observations. The most recent exported terminal TV sessions date to September 5–6 and include model identifiers, message snapshots, system context, token usage, tool observations, and images.

The service API could not be inspected because the sandbox blocked the localhost request; the counts above come directly from exported files. Cosmos was not queried in this inspection. Earlier observed Cosmos contents are documented in the [September 5 task-history baseline](./orchestrator-history-baseline.md).

## What each source preserves

- Telemetry: `service/src/tracing/agentTraceStore.ts` records requests, final messages, model-step text and tool calls, tool arguments and observations, timing, optional model/token metadata, and optional system and conversation context. Model-step message serialization replaces image content with an omission marker; separate screenshot spans can retain the image data URL.
- Cosmos TV-flow memory: `service/src/agents/tv/flowMemory.ts` preserves the request, final message, ordered step summaries, tool arguments, observations, reported tool outcomes, screenshot outcome markers, and UI summaries. Its current document schema does not preserve screenshot images, full model messages, model identity, or per-step timing.
- Screenshot saving: `service/src/agents/tv/screenshotSaver.ts` can write captures beneath the service working directory's `out` folder. No JPG or PNG files were found in the current `service/out`; the retained screenshot payloads counted above are in telemetry.

## Assessment

Follow-up code inspection for step-level comparisons: the current orchestrator adds to `session.steps` in its external-input tool handler, while its model-step callback records automatically executed tools in telemetry without adding corresponding entries to that array. `tvAgentDefinition.onComplete` persists that array to Cosmos. Consequently, current Cosmos flow steps can omit ordinary automatically executed actions; they must not be treated as a complete tool sequence. Existing historical records may reflect older capture behavior. Domain-level objectives such as "YouTube ready" also need to be identified from the evidence rather than equated with raw step indexes.

Existing data supports an initial retrospective evaluator for evidence-supported completion, contradictory success claims, visible failures and recovery attempts, and timing where available. Join telemetry and Cosmos by session ID, preserving source disagreements and missing fields.

Existing verification is useful evidence: app-launch results contain Home Assistant app-state checks, device-state and media-control observations expose playback metadata, and the playback-verification skill directs the agent to check state and title. The separate screen-validation tool produces a vision-model verdict. These can support recorded-run judgments where retained; a missing domain-level task-step label does not mean that verification evidence is absent. They do not guarantee that every run verified every part of its requested outcome.

Do not use stored `success` or `executionScore` as independent expected outcomes. The current execution-score function returns 1 for a run marked completed and successful, and the earlier data inspection found success flags contradicting explicit completion arguments and final messages.

Report insufficient evidence when the retained record cannot support a judgment. Neither source guarantees an independent final observation, complete visual history, or proof that a failed task was impossible. Missing model identity also limits historical model comparisons.

Recorded runs describe actions the original assistant chose. They do not provide the responses a new model would have received after different actions; evaluating those alternative trajectories requires additional scenario simulation or other controlled execution.
