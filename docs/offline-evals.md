# Offline assistant evals

Phase 1 implementation is available in `service/src/evals/`. This document records the design and remaining refinements; domain terminology lives in [CONTEXT.md](../CONTEXT.md#assistant-evaluation). See [testing instructions](./offline-eval-testing.md) for the dashboard, judge checks, and on-demand runs.

## Agreed modes and cadence

Both modes are in scope and must remain distinguishable in execution, reports, and aggregate results.

| Mode | Assessed behavior | When it runs |
| --- | --- | --- |
| Simulated eval | A new assistant run against a controlled simulated environment; TVAgent in phase 1 | Daily in the background to detect regressions |
| Recorded-run eval | A completed real assistant run, graded from retained evidence; TVAgent in phase 1 | Daily at 1:00 a.m. America/New_York and on demand through the portal |

"Real evals" is the user's term for recorded-run evals. These read the original run's telemetry and Cosmos data; they do not replay its device actions. Keep simulated and recorded-run scores separate.

Simulated evals check orchestration in a controlled environment. Recorded-run evals assess completed real runs end to end, from the original request through intermediate objectives, recovery, and the task outcome supported by retained evidence. End-to-end assessment does not authorize new live-device execution, and incomplete retained evidence must remain distinguishable from task failure.

Spending limits are deferred by user choice. The runner, dashboard at `/dashboards/evals`, and backend-host scheduler are implemented. `OFFLINE_EVAL_ENABLED=false` disables daily scheduling; it is enabled by default. The running development backend has started scheduled batches through its file watcher.

### Agreed recorded-run scheduling direction

Recorded-run evals support scheduled execution as well as manual launches from the existing eval portal. This replaces the earlier on-demand-only policy; it does not authorize replaying real device actions.

Run recorded-run evals daily at 1:00 a.m. in the existing `America/New_York` timezone. Keep the simulated suite's 3:00 a.m. schedule unchanged. Manual selection and explicit re-evaluation remain available independently of scheduled execution.

Automatically select only finished TVAgent runs with no previous evaluation attempt. A real run ending in error is eligible if it has never been evaluated. Any prior eval attempt excludes the session from automatic selection, including queued/running attempts, completed fail or unscored judgments, and eval errors. Re-evaluating those sessions requires an explicit portal action; the daily schedule must not retry paid grading until it obtains a preferred result.

Enable recorded scheduling by default when the feature is deployed, while honoring explicit scheduler-disable configuration and preserving manual portal evaluation. Initialize its eligibility boundary when the recorded scheduler first becomes effectively enabled, normally the first backend start after deployment.

Automatic eligibility begins with new runs from that initial enablement onward. Persist the boundary rather than resetting it on backend restart or later disable/re-enable cycles. Older retained sessions remain available for explicit portal evaluation; enabling the schedule must not automatically backfill that historical backlog.

Carry eligible, never-attempted runs forward across missed days until they are selected. Do not use a rolling 24-hour cutoff that silently loses pending runs.

Select the oldest available eligible runs first, with at most 100 sessions in the nightly recorded batch. Carry overflow to later nights rather than starting additional automatic batches to drain the backlog in one night.

If a configured discovery source fails, proceed with eligible runs from the available sources and retain a visible incomplete-discovery warning naming the unavailable source. Oldest-first ordering then applies to the discovered subset, not an asserted complete list. Missing-source sessions remain eligible for a later night if they still have no prior attempt.

The evaluation-history store must be readable before selection: without it, the scheduler cannot establish that a session has never been evaluated and must not launch grading. If discovery is wholly unavailable, report selection failure rather than claiming an empty backlog.

Preserve the shared single-job worker. If the backend or worker is unavailable at 1:00 a.m., start that day's recorded batch once both become available later the same day. Do not interrupt another job or introduce parallel grading. The simulated suite retains its 3:00 a.m. due time but may likewise start later if the recorded batch still occupies the worker.

Recorded scheduling is implemented in `service/src/evals/supervisor.ts` and `scheduling.ts`. `OFFLINE_EVAL_ENABLED=false` disables both schedules; `OFFLINE_RECORDED_EVAL_ENABLED=false` disables recorded scheduling only. Manual portal evaluation remains available with either switch disabled.

Within `OFFLINE_EVAL_DIR`, `schedules/recorded.json` retains the initial enrollment cutoff and `schedule-days/recorded-YYYY-MM-DD.json` retains each daily selection/execution outcome. Schedule-status API reads do not initialize the cutoff or launch work. Admission rechecks the local date and enabled state after asynchronous discovery; crossing midnight or disabling scheduling while discovery is in progress leaves the sessions pending rather than accepting an expired slot.

### Recorded scheduling implementation requirements

The implemented scheduler preserves these constraints:

- Persist initial enablement separately from daily execution records. Apply the new-run boundary using the existing session start metadata and require a finished TVAgent run; do not guess eligibility from missing or invalid timestamps.
- Reuse existing discovery and evaluation-history resolution, including legacy completed results and error-only attempts. Refresh status when admitting the job under the shared submission lock so a portal evaluation cannot race automatic selection into a duplicate paid attempt.
- Freeze the selected session IDs when the nightly job is accepted. Do not append newly arriving runs, replace unsuccessful evaluations, or top up the same night's batch after it finishes. Preserve the existing per-session queued/running/completed/error lifecycle.
- Persist a daily scheduling outcome when there are no eligible sessions, without making judge calls. Distinguish a verified empty selection from incomplete discovery and discovery/history errors; show warnings and failures instead of presenting them as complete coverage. A terminal daily outcome must not cause repeated polling launches for that date.
- Scope daily claims and duplicate checks by eval mode and local schedule date. Supervisor admission, runner deduplication, and the worker's simulated skipped-day lookup are mode-aware, so a recorded batch neither suppresses the 3:00 a.m. simulated batch nor changes its historical bookkeeping.
- Pass scheduled provenance through the recorded worker and runner into jobs, batches, and per-run results. Recorded scheduling must not be saved as an on-demand batch or enter simulated regression baselines.
- Keep the existing single-worker admission, interruption recovery, and explicit portal retry behavior. A failed automatic job is visible and terminal for its scheduled date, not permission to repeatedly start paid work that day.
- Show both schedules and their enabled state in the portal while retaining manual recorded evaluation and re-evaluation controls. Honor explicit scheduler-disable configuration without disabling those manual actions.
- Cover default enablement, persisted cutoff across restart/re-enable, old-history exclusion, all prior-attempt exclusions, the 100-session oldest-first limit and carryover, no-op days, partial/failed discovery, unreadable attempt history, portal races, same-day catch-up, mode-separated daily identities, and the repeated autumn 1:00 a.m. hour.

## Agreed recorded-run selection dialog

Implemented in the backend-served eval dashboard and telemetry viewer. Session discovery reads metadata only; opening evaluation details loads the retained evidence for the chosen attempt.

- Provide a dialog listing sessions with multi-selection for on-demand recorded-run evaluation.
- Show only finished real TVAgent runs, including runs that ended in error. Exclude unfinished runs and other agents.
- Discover sessions from both retained telemetry and Cosmos TV-flow records, deduplicating by session ID and labeling the available evidence sources. Cosmos-only sessions remain eligible; missing evidence may yield unknown verdicts.
- If a source fails, keep sessions from the available source selectable, show a prominent incomplete-list warning naming the unavailable source, and provide retry. Do not present a partial list as complete.
- Show per-session eval status: **Not evaluated**, **Queued**, **Running**, **Evaluated**, or **Eval error**, with the verdict separate.
- **Evaluated** includes pass, fail, and unknown verdicts. **Eval error** means evaluation did not finish, not that the assessed assistant failed its task.
- Allow explicit re-evaluation of already evaluated sessions and retries after eval errors, preserving every previous attempt.
- Re-evaluation rereads the currently retained sources and preserves the evidence snapshot used by each attempt. Changes in evidence coverage remain visible; a changed verdict must not be attributed solely to a judge change when the evidence also changed.
- Disable selection of sessions whose eval is Queued or Running to prevent duplicate in-flight work.
- Use the latest attempt for the session's primary eval status. If a re-evaluation is pending or fails, retain the most recent completed result separately with its timestamp and a **Previous evaluation** label.
- Open the selection dialog from the eval dashboard. Show the same per-session eval status in the dialog and beside sessions in the telemetry viewer, with access to evaluation details.
- Preserve the single-job execution limit. While any eval job is active, disable submission with an explicit busy message, preserve the selection, and re-enable submission when the worker becomes free; do not add a persistent queue of additional jobs.
- Within an accepted batch, show **Queued** for selected sessions awaiting evaluation and **Running** only for the session currently being evaluated.
- If the worker stops, preserve completed results and mark unfinished attempts **Eval error** with an interruption reason that distinguishes attempts never started. Require explicit retry; backend restart must not silently resume paid grading or leave sessions indefinitely Queued or Running.
- Provide **Select this page**, preserving explicit selections across pages and displaying the total selected count. Keep the existing maximum of 100 sessions per batch; do not silently select matching sessions on other pages.
- Provide request-text/session-ID search, a date-range filter, and an eval-status filter. Default to all eligible sessions, newest first, rather than hiding previously evaluated sessions.
- Preserve selections hidden by changed search or filters. Show the total selected and hidden-selected counts, provide **Review selected** and **Clear selection**, and include all selected sessions in the launch summary.
- Before submission, show an inline breakdown of new evaluations and re-evaluations, the total selection, and a notice that grading makes paid model calls without repeating device actions. Use one explicit Run button, without a second confirmation dialog.

### Session discovery and attempt persistence

- `GET /api/evals/sessions` combines eligible telemetry and Cosmos metadata with saved evaluation status. Discovery is cached for 15 seconds; `?refresh=true` retries the sources immediately.
- `GET /api/evals/session-statuses` supplies the telemetry viewer's status badges without querying Cosmos or loading full evidence. An unavailable status store is an error, never a claim that sessions have not been evaluated.
- `GET /api/evals/sessions/:sessionId/history` returns all retained attempts, including failures before a grading result exists. Existing run-detail links continue to use `/api/evals/runs/:id`.
- Recorded submissions to `POST /api/evals/jobs` accept an optional UUID `requestId`. The picker reuses it when resolving an uncertain submission, so a lost response or repeated click does not create another paid batch. An intentional later re-evaluation uses a new identifier.
- Every accepted session has a durable attempt before worker startup, retaining its source-session identity even when evidence loading fails. Completed run summaries from before this feature remain visible in history; older jobs supply session associations where retained.
- Queued/running work is reconciled after worker interruption without re-running it. A completed result already saved before an interruption is preserved rather than mislabeled as an evaluation failure.

## Agreed daily schedule

- Start the recorded-run evaluation batch daily at 1:00 a.m. in `America/New_York`.
- Start the simulated suite daily at 3:00 a.m. in `America/New_York`.
- Run the eval workload on the same machine as the backend.
- Use `America/New_York` for dashboard day boundaries and the previous-seven-complete-days comparison window.
- Use the named timezone so the schedule follows local daylight-saving changes.

The backend supervisor launches a separate worker process for eval execution. It checks both schedules, persists jobs and batches, and prevents duplicate scheduled work using mode-separated daily identities.

## Agreed missed-run handling

### Simulated evals

- If the machine misses the 3:00 a.m. run and becomes available later that day, run that day's suite once.
- Mark older missed days as skipped instead of executing a backlog of suites.
- Preserve the intended schedule date and actual execution timestamps; do not backdate results into days when no eval ran.
- Skipped days provide no scenario result for the historical baseline.
- Prevent a same-day catch-up from duplicating a batch already started for that scheduled day.

### Recorded-run evals

- If the backend is offline or the worker is busy at 1:00 a.m., catch up once when both are available later that local day.
- Do not launch a separate catch-up batch for every older missed day. Eligible, never-attempted sessions remain in the backlog for the current or a later nightly batch.
- Preserve the intended local schedule date and actual execution timestamps, with at most one automatic recorded batch for that date.
- Keep simulated and recorded daily identities separate so one mode does not suppress the other. The repeated 1:00 a.m. hour at the autumn daylight-saving transition must not cause a second recorded batch.
- Catch-up is not permission to automatically retry a session with an existing evaluation attempt; interrupted and failed attempts retain the explicit portal-retry policy.

## Agreed daily workload

The following limits apply to simulated batches. Recorded scheduling has its separate limit of 100 selected sessions per local day.

- Run every simulated scenario once in each daily batch.
- Add at most one confirmation attempt for a scenario with a new failure or qualifying slowdown under the agreed alert rules.
- Distinguish scheduled attempts from confirmation attempts in saved results and dashboard views.
- Preserve the original scheduled outcome even when a confirmation attempt succeeds.
- Phase 1 has twelve scenarios, bounding a daily batch to twelve scheduled attempts plus at most twelve confirmation attempts. Per-run execution and cancellation limits remain an implementation concern; a monetary cap is not required for the initial version.

## Agreed cost policy

- Do not block implementation or initial eval runs on setting a spending cap or measuring a pilot batch's cost.
- The user will adjust cost controls later after observing actual usage. No eval-specific monetary cap is required for now.
- Retain available model usage by run and batch, distinguishing assessed-agent calls from offline grouping/grading calls and scheduled attempts from confirmation attempts, to support that later adjustment. Missing usage or pricing information must remain unavailable rather than be reported as zero cost.
- This decision leaves the agreed scenario and confirmation-attempt limits in place; it does not authorize unlimited retries or expansion of the daily suite.

## Agreed model and prompt selection

- Daily simulated evals assess the backend's currently configured model and prompts. Phase 1 does not run an automatic matrix of alternative models or prompts.
- Alternative model or prompt configurations are evaluated on demand through simulated evals. Recorded-run evals continue to assess the configuration used by the original completed run; they cannot test a replacement model's behavior.
- Resolve and record the effective assessed configuration at batch start, including relevant prompt and skill versions, and keep it fixed for the batch and any confirmation attempts. Do not silently mix configurations if the backend changes during a batch.
- Retain configuration identifiers with every result. Historical regression comparisons may cross assessed model/prompt versions intentionally; display that change while holding scenario, simulator, and grading conditions comparable. Simulated-to-real fidelity comparisons still align assessed configurations where known.
- Label on-demand alternative-configuration results separately from scheduled results. They do not enter the daily scheduled baseline merely because they ran on the same date.
- Select and version the offline grading model independently from the assistant model under evaluation. Prioritize grading quality over cost, and keep the judge configuration fixed across comparisons of assistant configurations.

## Agreed notifications

- Notify the user when daily simulated evals identify a new regression or an eval run fails to complete.
- Keep successful checks and unchanged issues quiet.
- Preserve every run and its results in the dashboard, including runs that do not produce a notification.
- Distinguish a failure to execute the eval from a failure in the assistant behavior being evaluated.

## Agreed confirmation of new failures

- When a scenario that passed consistently last week fails in the daily simulated suite, rerun the affected scenario once from the same starting state before sending a regression notification.
- Keep the scenario definition, model/prompt configuration, and simulated inputs the same for that confirmation attempt, using a fresh run.
- Preserve both attempts. If the failure repeats, notify the user; if the results differ, show an intermittent failure in the dashboard.
- A successful confirmation attempt does not erase the original failed result or turn the original run into a pass.
- This is a bounded notification check, not permission to rerun until the scenario passes. Failure to execute the eval remains distinguishable from an assistant failure.

## Agreed slowdown alerts

- A task that still succeeds can trigger a regression notification if its assistant execution time exceeds twice last week's median for the same simulated scenario and the slowdown repeats in one confirmation run.
- Preserve both timing measurements and apply the same starting-state and configuration controls used for failure confirmation.
- Exclude offline grouping, grading, and report-generation time from assistant execution time.
- Show smaller timing changes in the dashboard without generating slowdown alerts.
- Compare equivalent simulated executions for this alert; keep the distinction between simulated and real-run timing visible in the dashboard.

## Agreed historical comparison window

- Compare against the previous seven complete days, excluding the current batch's day.
- Require at least three comparable scheduled results for historical regression comparisons.
- Use scheduled attempts only for the baseline; retain confirmation attempts separately in the dashboard.
- Before enough history exists, show "Collecting baseline" alongside the current eval results.
- Missing historical coverage does not erase or change the current pass/fail or unknown outcome.

The method-selection percentages in `docs/orchestrator-learning.md` are advisory preferences for the agent, not additional eval alert thresholds.

## Agreed execution boundary

- Grading happens after the assessed assistant run finishes, outside the live assistant response path. The live assistant does not wait for an eval verdict.
- Simulated evals make new Azure model calls while simulating device responses and keeping storage isolated from the live assistant.
- Recorded-run evals consume retained data from completed real runs, using the agreed combination of LLM grading and deterministic evidence checks.
- Eval execution must not control real home devices.

## Agreed phases and extensibility

- Phase 1 evaluates TVAgent only, in both simulated and recorded-run modes, with the twelve-scenario simulated suite below.
- Other agents are phase 2. The framework must support adding them without rebuilding scheduling, result storage, comparisons, or the dashboard.
- The first suite should help answer: "Can I change TVAgent's model or prompts without making task execution or completion reporting worse?"
- Simulated evals support controlled regression checks. Recorded-run evals assess actual historical behavior and cannot establish how a different model would behave after choosing different actions.
- Assess both execution decisions and whether completion claims are supported by the observations available to the agent.
- An accepted app-launch command with the requested app still unconfirmed is a representative failure case for unsupported success reporting.

### Framework extension boundaries

Implement the extensibility requirement through a shared eval core and registered agent adapters:

| Shared eval core | Agent adapter |
| --- | --- |
| Batch lifecycle, scheduling, limits, cancellation, and confirmation attempts | Agent execution entry point and scenario definitions |
| Common run records, evidence references, and result persistence | Simulated state, tool responses, external inputs, and isolated dependencies |
| Historical comparisons, notifications, and dashboard views | Retained-run evidence import and interpretation |
| Task and step result structure, evidence coverage, and grading lifecycle | Domain objectives, expected outcomes, validation reuse, and grouping criteria |

- Keep agent-specific behavior behind typed adapter interfaces; the core must not import TV tools or require TV state, playback fields, or screenshots.
- Identify every scenario, run, and task-step group by agent and the relevant comparison context. Record eval mode on each run and step occurrence; a matching group can contain occurrences from both modes while keeping their results separate. Preserve scenario, model/prompt, adapter, and grading versions so comparisons can explain configuration differences. Historical metadata that is unavailable remains unknown.
- Keep common task and step outcomes, timing, and evidence coverage available to all adapters. Allow typed domain-specific context and optional evidence such as images. An agent that does not use screens must not need placeholder screenshot data.
- Keep baseline and fidelity comparisons within the relevant agent and compatible scenario/context. Expose agent filtering in the shared dashboard without pooling unrelated agent outcomes into a regression verdict.
- For simulation, each adapter must substitute all effectful dependencies, including initial context reads, tool execution, external input, memory, and completion persistence. Missing simulated capabilities fail explicitly rather than falling through to live services. Recorded-run evaluation reads retained evidence without invoking live agent actions.
- The first implementation supplies only the TV adapter. Adding another agent in phase 2 should consist of registering its adapter, scenarios, and domain checks, while reusing the core lifecycle and reporting.

The existing `AgentDefinition` contract and registry in `service/src/agents/core/` already separate agent definitions from shared orchestration; TVAgent and ScheduledTaskAgent both use that contract. Reuse the applicable production agent behavior through isolated dependencies so evals exercise the agent being assessed. The production registry alone is not an eval isolation boundary: TV initialization reads current device state, and completion can persist flow memory. Other entry points can be supported through their eval adapter without requiring every future agent to use the same production loop.

## Agreed dashboard direction

- Provide a dashboard that compares simulated eval results against last week's data.
- Include a separate comparison with recorded-run eval results to help assess how well the simulation reflects real assistant behavior.
- Preserve the distinction between simulated and recorded-run evals in reports and metrics.
- Recorded-run evals support both the daily schedule and on-demand portal launches. Displaying a comparison does not itself trigger grading.

"Last week" means the preceding seven complete days in `America/New_York`, excluding the day of the current simulated batch, with at least three comparable scheduled results required for regression comparisons. Display the exact date range. Proposed timestamp convention: use the assessed assistant run's date for behavior trends and retain the grading date separately.

The user described the simulated-to-real comparison as judging "the accuracy of simulated runs." The resolved term is simulation fidelity, assessed through comparable task-step and whole-task behavior. Raw aggregate pass-rate agreement does not establish fidelity: different task difficulty, initial device state, model/prompt versions, or missing evidence can explain a gap or hide one.

Agreed comparison direction: match task, target device/app, and starting state; show unmatched runs separately, with sample counts and missing-evidence coverage visible. Align model/prompt versions where known. Grading-version compatibility, the exact matching rules, and an accuracy formula or regression threshold remain to be specified.

The existing service dashboard at `/dashboards` and its `/api/dashboards` endpoint provide a place to add eval views. Its current analytics explicitly label success measures as telemetry proxies (`quality.status: "proxy_only"`); those existing reported-success metrics must remain distinguishable from eval verdicts.

## Agreed task and step comparisons

- Compare both the overall task and its individual task steps across simulated and recorded-run evals, as well as across time.
- The user's example is "Play latest Telugu songs on Apple TV", with intermediate steps including turning on the TV and launching YouTube.
- Whole-task matching must retain the requested intent and meaningful qualifiers, including "latest", "Telugu songs", and the target Apple TV.
- Keep individual step outcomes visible alongside the overall task outcome; reaching YouTube does not establish that the requested songs are playing.

Match task steps by their intermediate objective, allowing different execution methods. A direct YouTube launch and reaching YouTube through remote navigation both match "YouTube ready". Preserve and compare the differences in methods, tool calls, observations, retries, and timing within that matched step. A different valid tool sequence alone does not fail a step or prevent matching; the agreed device/app and starting-state matching criteria still apply.

The dashboard aligns rows by task-step objective, then exposes the exact tool calls, arguments, observations, retries, and available timing within each row. Compare step starting states separately so an already-satisfied objective is visible. Grouping tools into objectives must preserve links to the source evidence and identify uncertain boundaries.

The current code does not persist these domain-level step boundaries. In `service/src/agents/core/orchestrator.ts`, `session.steps` is populated for external-input tools; automatically executed tools are recorded through telemetry callbacks and TV tool-result spans. `tvAgentDefinition.onComplete` copies `session.steps` into Cosmos flow memory. Therefore the Cosmos `steps` array alone is not a complete execution trace, and step comparisons should use telemetry where available.

Existing behavior already allows skipping an app launch when the app is open, and the task-history baseline distinguishes already-satisfied starting states from measured executions. Carry that distinction into eval comparisons rather than treating an absent launch call as failure or evidence of a faster launch method.

## Agreed numeric scoring direction

The recorded-run judge produces categorical judgments and a structured scoring assessment. The deterministic calculator in `service/src/evals/scoring.ts` produces a 0–100 **Task eval score** driven primarily by fulfillment of the user's whole request, with limited partial credit for incomplete progress. It is not an average of passing steps: turning on the TV, opening YouTube, and finding the requested playlist must not look like a successfully completed playback request when playback never starts.

The first scoring unit is one completed TVAgent run identified by its existing source session ID. Assess that run's full request and all internal recovery, including runs ending in error. Do not combine multiple TVAgent runs or reconstruct a score for the original voice request across other agents in this version.

Numeric scores apply only to recorded-run evals in this version. Simulated evals retain their existing categorical orchestration checks; do not add a simulated orchestration score or mix simulated results into recorded task-score trends.

Keep individual task-step results and the existing task fulfillment, handling, recovery, and reporting judgments visible separately.

Successful recovery remains eligible for 100 when the failed method and subsequent actions were reasonable given the observations available at the time. Penalize avoidable mistakes and repeated ineffective actions, not failure counts or tool-call counts by themselves. An unavailable direct-launch method followed by justified navigation and verified task completion is not inherently worse than a successful direct launch.

Keep elapsed time and model cost separate from the task-quality score in this version. A slow device response or expensive model does not itself cause a deduction. Avoidable loops can still be penalized as execution mistakes; retain available duration and usage as separate metrics.

When retained evidence cannot establish any required scoring component, show **Unscored — insufficient evidence** and explain the gap. This includes an unknown task outcome, or a verified outcome with too little execution/reporting evidence to assess deductions or the reporting ceiling. Small irrelevant gaps do not block scoring. Do not assign zero, invent a middle score, assume missing mistake evidence means no mistakes, or infer that missing telemetry proves the agent skipped verification. Preserve each supported or unknown categorical judgment independently; task fulfillment may still pass while the numeric score is unavailable. This completed-but-unscored evaluation is distinct from an execution or grading error.

The current recorded importer labels all retained assessments `coverage: "partial"`. That broad label must neither blanket-block scores nor establish that the evidence is sufficient: assess sufficiency for the scoring components and retain the specific blocking gaps.

A demonstrably contradicted or unsupported completion claim imposes a hard ceiling of 20/100, not an ordinary deduction that successful intermediate steps can outweigh. This is a maximum, not an automatic award of 20; the task may score lower, including zero. Keep the reporting failure explicit alongside the score. Missing historical evidence alone does not trigger this ceiling.

Tasks known to be unfulfilled are capped at 49/100, with partial credit based on meaningful progress rather than the fraction of passing steps. Verified fulfillment normally occupies 50–100, subject to the separate completion-claim ceiling. These are rubric bands, not probabilities of task success.

Anchor 0 at no achieved task objective or useful intermediate progress. An unreachable TV that remains unreachable after reasonable recovery scores 0 even when handling and reporting both pass; correct reasoning alone is not task-fulfillment credit.

Use the LLM to assess meaningful progress and the severity of avoidable mistakes, with evidence references and explanations. Code computes the numeric score from a fixed rubric and enforces its ceilings; the judge does not choose an unconstrained final number.

Use these fixed progress values before mistake deductions:

| Task progress level | Starting score | Interpretation |
| --- | ---: | --- |
| No useful progress | 0 | No requested objective or useful intermediate progress was achieved |
| Prerequisites only | 15 | Setup such as TV or app readiness, without meaningful fulfillment of the remaining request |
| Meaningful partial fulfillment | 30 | Some requested outcome is supported, but important parts or qualifiers remain unmet |
| Nearly fulfilled | 45 | Requested target/content is ready, but the final required outcome is missing |
| Verified full fulfillment | 100 | The whole request, including its meaningful qualifiers, is supported by evidence |

The same device state can represent different progress depending on the request: YouTube readiness fully fulfills "Open YouTube" but is only a prerequisite for "Play latest Telugu songs." Missing evidence is not another progress level and does not map to a numeric starting score.

Apply deductions for distinct evidence-backed mistake episodes:

| Severity | Deduction | Interpretation |
| --- | ---: | --- |
| Minor | 5 | A small unnecessary action |
| Moderate | 15 | An avoidable episode such as repeating a clearly ineffective method before recovering |
| Major | 30 | A substantial avoidable departure from the request, or premature abandonment despite an evidenced workable path |

Do not multiply a deduction merely because the same episode appears in multiple trace snapshots or evidence sources. Tool failures, tool-call counts, and justified recovery are not mistake episodes by themselves.

Calculate the starting score minus episode deductions, keeping verified full fulfillment within 50–100 and known incomplete fulfillment within 0–49. Then apply the 20-point reporting ceiling when applicable. Insufficient evidence produces no numeric score rather than entering this arithmetic as zero.

### Calculation examples

These examples check the arithmetic given the stated semantic assessments; they do not establish that the judge can reliably identify those assessments in arbitrary traces.

| Assessed progress and mistakes | Reporting | Final score |
| --- | --- | ---: |
| Verified full fulfillment, no avoidable mistakes, including justified recovery | Supported | 100 |
| Verified full fulfillment, one moderate mistake episode | Supported | 85 |
| Verified full fulfillment, two major mistake episodes | Supported | 50 |
| Nearly fulfilled, no avoidable mistake episodes | Supported | 45 |
| Nearly fulfilled, no separate execution mistake episodes | Unjustified completion claim | 20 |
| Nearly fulfilled, one major execution mistake episode | Unjustified completion claim | 15 |
| No useful progress despite appropriate recovery | Supported honest failure | 0 |
| Any required scoring component cannot be assessed | Any independently supported judgment | Unscored |

### Implementation requirements derived from the scoring contract

The scoring contract is implemented in the shared grade types, mode-aware judge, deterministic calculator, retained evidence importer, and portal views:

- Extend the existing LLM judge rather than adding a second unconstrained scorer. Retain the selected progress level, evidence-backed mistake episodes and severities, evidence sufficiency, and explanations alongside the existing judgments.
- Use validated semantic judgments as calculator inputs. Missing required fields, invalid severities, nonexistent evidence references, or contradictory scoring inputs are grading errors, not a score of zero or an invented unscored result. Legitimate insufficient evidence is an explicit assessment outcome.
- Compute and persist the starting value, individual deductions, applicable band limits and reporting ceiling, and final score or explicit unscored reason. Reporting applies its ceiling; a separate execution-mistake deduction requires its own supported episode.
- Version the deterministic rubric, including progress values, severity weights, band limits, and ceilings, together with the judge/schema configuration. Preserve the evidence snapshot and configuration used for each evaluation attempt.
- Show scores and unscored reasons beside the existing judgments in recorded-run results, session selection/status views, and attempt history. Expose the calculation and source evidence in details. A score of zero with passing handling is valid and must not be relabeled as a successful user task.
- Keep historical attempts intact. Older results without numeric scoring are not zero and are not automatically insufficient-evidence results; show that scoring was not available for that evaluation. Obtaining a new score requires an explicit re-evaluation through the existing paid, on-demand workflow.
- Numeric scoring alone does not change scheduling, confirmation, notification, or categorical comparisons. The separately agreed recorded-run scheduling extension must preserve the simulated schedule and portal launches; automatic selection excludes sessions with any previous eval attempt. Do not introduce live-device execution, new score-based alert thresholds, or a combined simulated/recorded score.
- Add deterministic calculator cases for the examples above, band floors and ceilings, accumulated deductions, zero, and unavailable scores. Extend judge reference cases to assess progress selection, mistake severity, justified recovery, duplicated evidence, reporting support, and component-specific evidence sufficiency; the existing categorical reference checks alone do not validate numeric scoring.

The saved `GRADER_VERSION` identifies the shared configuration of both categorical and recorded-scoring prompts/schemas, allowing comparable new simulated and recorded results to use the existing matching rules. The scoring rubric also has its own version in each numeric result, and calibration records retain the recorded prompt/schema version. This configuration upgrade does not rewrite old results or claim compatibility with their older grader version; historical comparisons may show **Collecting baseline** until enough comparable new results exist. Simulated judgments remain categorical and use the existing categorical prompt.

## Existing verification evidence and agreed reuse

The real TVAgent already collects verification evidence; missing task-step labels do not mean missing verification:

- `launch_app` reads Home Assistant state after its command, compares app-related attributes with the requested app, returns the observed fields, and sets `toolSuccess` according to that match.
- `get_device_state` returns device state and attributes, including available app and media metadata. `media_control` also returns state after its command, but does not itself assert that the requested playback state or content was reached.
- The `playback-verification` skill instructs the agent to check `playing` and a matching `media_title`, with recovery when playback is paused or selection failed. This is agent guidance, not an independently enforced check on every completion.
- `validate_screen` uses a vision model to check a camera image against the expected screen and user's request; it is distinct from Home Assistant state validation.
- TV tool-result telemetry stores these observations with the call arguments and timing where recorded. The completion guard checks for pending command research, rather than universally rechecking every task objective.

Reuse explicit state checks as evidence for matching objectives such as "YouTube ready" and "requested content playing". Extract straightforward facts and known step associations in code, and use LLM interpretation for task meaning, semantic step alignment, action quality, and completion claims. The user clarified that eval quality takes priority over minimizing model calls: LLM grading is a normal part of evaluation, not restricted to an ambiguity fallback. Preserve source references and keep uncertain assignments visibly uncertain. Missing evidence remains unknown.

All grouping and grading occur after the assessed assistant run, using retained evidence. No new live state checks are needed to assess the historical run, and current device state would not establish what happened during that run. Verification that YouTube is active alone does not establish that the requested latest Telugu songs were played.

## Agreed use of LLM grading

Use an LLM wherever semantic interpretation improves evaluation, supported by deterministic checks where the facts are directly testable. Every assessed run receives a semantic review after execution; recorded-run grading is initiated by an accepted manual request or the daily recorded schedule, never by replaying device actions. The following division makes that quality-first direction concrete:

| Assessment | Responsibility |
| --- | --- |
| Task intent and fulfillment | LLM interprets the request and assesses whether observed behavior satisfies its qualifiers; simulator assertions or retained observations establish the available state facts |
| Task-step alignment | LLM aligns intermediate objectives across valid execution methods, reusing existing groups and validation evidence; code retains ordered tool events and enforces agent/context constraints |
| Action and recovery quality | LLM assesses choices against the observations available at the time, including appropriate recovery, redundant actions, and premature abandonment |
| Completion reporting | LLM checks whether the final response accurately describes the supported outcome, including honest failure and unjustified success claims |
| Screen and content interpretation | A vision-capable judge interprets relevant retained images when needed; missing images and unverified content attributes remain evidence gaps |
| Exact state, timing, and arithmetic | Code checks explicit simulator state and retained fields, measures duration and retries, and computes baseline statistics |

For "Play latest Telugu songs on Apple TV", confirmed YouTube playback alone does not establish the language or recency of the selected content. Evaluate those qualifiers against scenario content metadata and visible or retained evidence. A judge cannot infer that songs were the latest merely because the agent searched for "latest". Simulated fixtures must define their reference date and content facts; recorded-run evaluation must retain uncertainty when the historical evidence cannot establish those facts.

### Evidence and verdict contract

- Give the judge the request, relevant context, ordered actions and observations, existing validation results, relevant images where available, and final response. Supply independently defined scenario expectations for simulated runs, without exposing those expectations to the assessed agent.
- Assess task fulfillment, step outcomes, recovery, and completion reporting separately using explicit rubric criteria and pass/fail/unknown labels where applicable. Mark inapplicable criteria separately. Do not hide an unsupported success claim inside an average quality score.
- Preserve evidence references and a concise justification for every judgment. Validate referenced event IDs and structured output in code. Retain raw observations alongside interpretations so users can inspect disagreements.
- The judge cannot override a direct, applicable state contradiction with a plausible narrative. Resolve observations in their temporal and device context; a later verified recovery is different from ignoring an earlier failure. If sources conflict and cannot be reconciled, expose that conflict instead of inventing certainty.
- Distinguish unavailable historical evidence from evidence that a claim is false. Failure to retain a final state may leave a recorded outcome unknown; a complete simulated trace can establish that an agent claimed success without verification. Preserve the agreed difference between task completion and correct handling of an impossible scenario.
- Evaluate action quality using information the agent had at that point. Hidden simulator state can establish the actual outcome, but must not give the judge hindsight grounds to demand an action the agent could not have justified.
- Treat recorded messages, tool outputs, and screen text as evidence rather than judge instructions. The grading process has no live device actions, and grader errors or invalid outputs produce a grading failure rather than an assistant pass or failure.
- Keep the judge model, rubric, evidence extraction, and simulator versions explicit. Judge changes require revalidation; compare compatible grades or explicitly regrade selected retained runs, preserving previous verdicts. Changing the judge must not silently appear as assistant regression.

### Judge validation and proposed initial review

The judge has its own [reference cases](./offline-eval-judge-reference-cases.md), separate from the twelve scenarios used to test TVAgent. Six categorical examples cover verified success, unsupported success, wrong content, valid alternative methods, honest failure, and missing evidence. Nine additional synthetic recorded-scoring fixtures check progress, mistake severity, calculation, duplicated evidence, and component-specific evidence sufficiency. They include concise completion messages so correct behavior is not rewarded merely for a longer explanation.

The user accepted the six categorical reference judgments; the nine scoring fixture expectations derive from the negotiated rubric. The **Validate judge** action and `eval:calibrate` command check all fifteen, retaining expected and actual scores and semantic assessments where applicable. Scoring fixtures do not introduce new categorical handling thresholds, so handling is `not_checked` for those nine cases. Keep separate reviewed held-out cases for validation when tuning the rubric; these smoke checks do not establish general judge accuracy. Judge self-confidence is not a measurement of accuracy.

These reference checks assess the grader itself. Simulation fidelity remains a separate comparison of simulated and real task/step behavior. The proposed review workflow follows the guidance to use specific criteria and calibrate automated grading against human judgments in [OpenAI's evaluation best practices](https://developers.openai.com/api/docs/guides/evaluation-best-practices).

## Agreed group reuse and creation

- Reuse existing validation results and assign each occurrence to an existing matching task-step group.
- Create a new group when no matching objective/context group exists.
- An occurrence with missing validation evidence remains in its matching group with an unknown outcome. Missing evidence alone does not create a different group or a successful result.

The user's phrase "If the result doesn't exist then create a new group" is resolved as absence of a matching group.

For dashboard comparisons, a group without comparable data from last week has no historical baseline. Show that absence separately from its current eval outcome; do not infer improvement or regression from missing history. The same distinction applies when no comparable recorded-run eval is available. Existing scenario expectations can still be assessed independently of historical comparisons.

## Agreed simulated-task coverage

- Evaluate complete, multi-step TV tasks, including inspection, actions, recovery, and completion.
- Each scenario defines an initial simulated TV environment. Subsequent observations depend on the actions the agent actually takes.
- Judge the outcome and supporting evidence while allowing different valid action sequences.
- A saved historical sequence can inform a scenario but does not prescribe the agent's tool-call order.

### Agreed initial phase-1 suite

Start with twelve scenarios grounded in the request families and failure cases in the task-history baseline:

| Request family | Scenarios | Starting states or behavior |
| --- | ---: | --- |
| YouTube readiness | 3 | Already open; TV/device off; failed first launch followed by a recoverable path |
| Latest Telugu-song playback | 4 | Matching content already playing; visible search results; fresh keyboard search; selected content loads paused |
| Samsung Smart STB launch | 2 | Confirmed app readiness; accepted command with app remaining unconfirmed |
| Netflix launch | 1 | Power recovery fails and the device remains unavailable |
| Pause/resume | 2 | Pause playing content; resume paused content |

The twelve scenarios are agreed for TVAgent in phase 1. New task-step groups discovered in recorded data remain visible in the dashboard; adding a comparison group does not itself define a new simulated scenario or bring another agent into phase 1.

## Agreed visual coverage

- Include actual images for screenshot-based navigation, search, typing, and verification in v1.
- Use a small set of saved or rendered TV screens tied to the simulated state.
- Supply those images to the model so the eval exercises screenshot interpretation, including search-result selection and keyboard-position recognition.
- Screen images and other observations must correspond to the scenario state reached by the agent's actions.

## Agreed outcome interpretation

- Distinguish whether the requested task was completed from whether the agent handled the scenario correctly.
- An impossible scenario, such as a persistently unreachable TV, can pass when the agent attempts appropriate recovery and honestly reports that it cannot finish.
- Giving up on a solvable scenario fails that scenario.
- Claiming success without supporting evidence fails the scenario, even if the simulated device happens to reach the requested state.
- Report task completion and correct scenario handling separately so honest failure does not inflate task-success results.

For recorded-run evals, retained observations may not establish whether a task was solvable or what the final device state actually was. The evaluator must identify missing evidence rather than infer a complete simulated-world ground truth from the record.

## Existing evidence

The [task-history baseline](./orchestrator-history-baseline.md) identifies representative TV requests and cases where reported success contradicts observed outcomes. It provides candidate scenarios, but its historical success flags are not reliable expected-outcome labels.

Existing service tests include mocked model responses; these test implementation behavior rather than the quality of new model decisions.

The [local data audit](./offline-eval-data-audit.md) supports starting recorded-run evals with telemetry, supplemented by Cosmos. It documents missing images, context, and model metadata, as well as the limits of historical success labels.

## Remaining refinements and current limits

- TV fixtures render simplified screens and model tool effects. They exercise the current prompt, skills, tool contracts, and shared model loop, while replacing live executors and persistence. They do not establish full fidelity to every real TV UI or device integration.
- The judge deployment is configurable independently through `OFFLINE_EVAL_JUDGE_MODEL`; calibration checks six reviewed categorical cases and nine rubric-derived recorded-scoring fixtures. A separately reviewed held-out set is still needed before claiming broader grader accuracy.
- Spending caps remain deferred. Timing comparisons are simulated execution wall times with virtual device waits, not a measurement of real device latency.
- Notifications currently use persistent dashboard alerts. External delivery has no selected destination.
- Recorded runs are selected through the multi-select session dialog, or by session ID through the CLI/API. Missing metadata or evidence remains unknown; historic system-only prompt hashes cannot claim equivalence with full simulated prompt/skill/tool manifests.
- Fidelity comparisons are conservative: incompatible or unknown configurations remain unmatched. No aggregate simulation-accuracy score is inferred from unmatched data.
