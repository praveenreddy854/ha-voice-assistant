# Offline assistant evals

The shared implementation in `service/src/evals/` supports TVAgent, ScheduledTaskAgent and the Realtime Voice Agent. Each has a registered adapter, a bounded simulated suite, recorded-run import and agent-specific judge reference cases. This document records the design and remaining refinements; domain terminology lives in [CONTEXT.md](../CONTEXT.md#assistant-evaluation). See [testing instructions](./offline-eval-testing.md) for the dashboard and on-demand commands.

## Agreed modes and cadence

Both modes are in scope and must remain distinguishable in execution, reports, and aggregate results.

| Mode | Assessed behavior | When it runs |
| --- | --- | --- |
| Simulated eval | A new run of the selected agent against its controlled simulated environment | Daily from 3:00 a.m. America/New_York, sequentially by agent |
| Recorded-run eval | A completed real run of the selected agent, graded from retained evidence | On demand for all supported agents; TVAgent also daily at 1:00 a.m. America/New_York |

"Real evals" is the user's term for recorded-run evals. These read the original run's telemetry and Cosmos data; they do not replay its device actions. Keep simulated and recorded-run scores separate.

Simulated evals check orchestration in a controlled environment. Recorded-run evals assess completed real runs end to end, from the original request through intermediate objectives, recovery, and the task outcome supported by retained evidence. End-to-end assessment does not authorize new live-device execution, and incomplete retained evidence must remain distinguishable from task failure.

Spending limits are deferred by user choice. The runner, dashboard at `/dashboards/evals`, and backend-host scheduler are implemented. `OFFLINE_EVAL_ENABLED=false` disables daily scheduling; it is enabled by default when the backend starts.

### Agreed recorded-run scheduling direction

TVAgent recorded-run evals support scheduled execution as well as manual launches from the existing eval portal. This replaces the earlier on-demand-only policy for TVAgent; ScheduledTaskAgent and Realtime recorded evaluations remain on demand. It does not authorize replaying real device actions.

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
- Scope daily claims and duplicate checks by agent, eval mode and local schedule date; legacy jobs without an agent ID belong to TV. Supervisor admission, runner deduplication, and the worker's simulated skipped-day lookup preserve this separation, so a recorded batch neither suppresses any 3:00 a.m. simulated suite nor changes its historical bookkeeping.
- Pass scheduled provenance through the recorded worker and runner into jobs, batches, and per-run results. Recorded scheduling must not be saved as an on-demand batch or enter simulated regression baselines.
- Keep the existing single-worker admission, interruption recovery, and explicit portal retry behavior. A failed automatic job is visible and terminal for its scheduled date, not permission to repeatedly start paid work that day.
- Show both schedules and their enabled state in the portal while retaining manual recorded evaluation and re-evaluation controls. Honor explicit scheduler-disable configuration without disabling those manual actions.
- Cover default enablement, persisted cutoff across restart/re-enable, exclusion of old history and non-TV sessions, all prior-attempt exclusions, the 100-session oldest-first limit and carryover, no-op days, partial/failed discovery, unreadable attempt history, portal races, same-day catch-up, agent/mode-separated daily identities, and the repeated autumn 1:00 a.m. hour.

## Agreed recorded-run selection dialog

Implemented in the backend-served eval dashboard and telemetry viewer. Session discovery reads metadata only; opening evaluation details loads the retained evidence for the chosen attempt.

- Provide a dialog listing sessions with multi-selection for on-demand recorded-run evaluation.
- Show only finished real runs for the selected agent, including runs that ended in error. Exclude unfinished runs and unsupported agents.
- Discover TV sessions from retained telemetry and Cosmos TV-flow records, deduplicating by session ID and labeling the sources. ScheduledTaskAgent and Realtime sessions use retained telemetry only; they never query TV-flow storage. Cosmos-only TV sessions remain eligible; missing evidence may yield unknown verdicts.
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
- Preserve selections separately when switching agents. Each submission contains exactly one agent's sessions, and uncertain submissions retain both the agent and request ID.
- Before submission, show an inline breakdown of new evaluations and re-evaluations, the total selection, and a notice that grading makes paid model calls without repeating device actions. Use one explicit Run button, without a second confirmation dialog.

### Session discovery and attempt persistence

- `GET /api/evals/sessions?agentId=tv|scheduled_task|realtime` combines eligible metadata with saved evaluation status. Omit the filter to discover all supported agents. Discovery is cached per agent for 15 seconds; `?refresh=true` retries the applicable sources immediately.
- `GET /api/evals/session-statuses` supplies the telemetry viewer's status badges without querying Cosmos or loading full evidence. An unavailable status store is an error, never a claim that sessions have not been evaluated.
- `GET /api/evals/sessions/:sessionId/history` returns all retained attempts, including failures before a grading result exists. Existing run-detail links continue to use `/api/evals/runs/:id`.
- Recorded submissions to `POST /api/evals/jobs` accept an optional UUID `requestId`. The picker reuses it when resolving an uncertain submission, so a lost response or repeated click does not create another paid batch. An intentional later re-evaluation uses a new identifier.
- Every accepted session has a durable attempt before worker startup, retaining its source-session identity even when evidence loading fails. Completed run summaries from before this feature remain visible in history; older jobs supply session associations where retained.
- Queued/running work is reconciled after worker interruption without re-running it. A completed result already saved before an interruption is preserved rather than mislabeled as an evaluation failure.

## Agreed daily schedule

- Start the TVAgent recorded-run evaluation batch daily at 1:00 a.m. in `America/New_York`.
- Start the registered simulated suites daily from 3:00 a.m. in `America/New_York`, sequentially.
- Run the eval workload on the same machine as the backend.
- Use `America/New_York` for dashboard day boundaries and the previous-seven-complete-days comparison window.
- Use the named timezone so the schedule follows local daylight-saving changes.

The backend supervisor launches a separate worker process for eval execution. It checks both schedules and, from 3:00 a.m., runs each registered agent's simulated suite sequentially, starting the next available agent on a subsequent scheduler tick. It persists jobs and batches and prevents duplicate scheduled attempts for the same agent, mode and local day. A recorded batch or failed TV startup does not suppress the other simulated suites. There is still only one active worker and no persistent queue of additional jobs.

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
- Each registered suite has twelve scenarios: thirty-six scheduled attempts across TV, ScheduledTask and Realtime, plus at most thirty-six confirmation attempts. The dashboard reports the selected suite size. No automatic model matrix or unbounded retries are introduced.

## Agreed cost policy

- Do not block implementation or initial eval runs on setting a spending cap or measuring a pilot batch's cost.
- The user will adjust cost controls later after observing actual usage. No eval-specific monetary cap is required for now.
- Retain available model usage by run and batch, distinguishing assessed-agent calls from offline grouping/grading calls and scheduled attempts from confirmation attempts, to support that later adjustment. Missing usage or pricing information must remain unavailable rather than be reported as zero cost.
- This decision leaves the agreed scenario and confirmation-attempt limits in place; it does not authorize unlimited retries or expansion of the daily suite.

## Simulated trial telemetry

Each simulated scenario attempt is an **Eval trial**. The implementation follows Anthropic's [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): retain the trial transcript and observed outcome, track efficiency separately from quality, and inspect failed traces rather than trusting an aggregate score alone. Existing independent state assertions, grading rules, fresh environments, and bounded confirmation attempts remain unchanged.

Every new TV, ScheduledTask, and Realtime simulated assessment retains versioned `metrics`, `usage`, and a structured `trace`. The history table exposes assistant turns, requested tool calls, agent tokens, and agent execution time. **Inspect** adds counts, timing and token breakdowns, model response IDs, tool arguments/results, errors, stop reasons, and the full retained transcript. **Download trial JSON** exports the exact inspected attempt, including its evidence and configuration identifiers.

| Metric | Definition |
| --- | --- |
| `userTurns` | Fixture user messages actually started. Injected screenshots and tool outputs are not additional user turns. |
| `assistantTurns` | Returned model responses, including text, tool requests, completion signals, and failed/incomplete native Realtime responses. A transport failure before any response is not an assistant turn. |
| `modelRequests` | Individual AI SDK provider attempts for TV/ScheduledTask, including SDK retries, or native Realtime `response.create` requests. Session setup and tool-result messages are not model requests. |
| `toolCalls` | Every returned tool invocation, including `complete_task`, invalid/rejected calls, and calls stopped by a limit. Repeated requests are retained; duplicate deliveries of the same Realtime response are counted once. |
| `toolExecutions` | Invocations that reached an isolated simulator. Completion signals and rejected calls are not simulator executions. |
| `toolErrors` | Executed tools that threw, were interrupted, or reported `toolSuccess: false` / `success: false`. A failed completion claim is not itself a tool execution failure. |
| `rejectedToolCalls`, `unexecutedToolCalls`, `completionCalls` | Rejected requests, remaining unexecuted requests, and completion signals, respectively. These distinguish SDK argument-validation errors, one-tool-per-turn rejections, premature completion, and iteration-limit stops. |
| `modelErrors` | Provider request failures, failed/incomplete Realtime responses, or interrupted requests. Tool validation rejections remain distinct from provider failures. |
| `durationMs` | Monotonic agent trial wall time, excluding offline grading. It includes local orchestration and, for Realtime, connection setup/cleanup. It is not measured real-device latency. |
| `modelTimeMs`, `toolTimeMs` | Wall time inside provider requests and isolated tool executions. Model time excludes retry backoff between provider attempts. These do not include virtual device waits. |
| `timeToFirstResponseMs` | Trial start to the first complete model response. This is **not** streaming time to first token or audio latency. |
| `virtualDeviceTimeMs` | TV simulator waits, kept separate from measured elapsed time and never added to it. |
| `gradingDurationMs` | Offline judge-call and validation time, retained at the run level even when grading fails. |
| `evaluationDurationMs` | Runner execution/import, group lookup, and grading time, before final artifact persistence. It does not replace the assessed agent's duration. |
| `stopReason` | `completed`, `iteration_limit`, `response_limit`, `tool_limit`, `error`, `aborted`, or `timeout`. Completion of execution does not imply task fulfillment. |

Token totals sum provider-reported input/output/total usage, not estimates from message length. Cache-read tokens are a subset of input; reasoning tokens are a subset of output. They are displayed only when explicitly reported, not when the SDK defaults absent detail counters to zero. `usageReportedResponses` shows how many returned responses have all three primary counts. If any contributing response or request lacks a count, that aggregate field remains unavailable; the known per-response counts remain inspectable. Actual reported zeroes remain zero. An unreported retry is not assumed to be free.

Assessed-agent usage and offline-judge usage stay separate. Invalid judge JSON or a rejected grading schema retains available judge usage without claiming a completed grade. Deployment pricing is not configured, so monetary cost remains unavailable rather than zero or an inferred price. No new spending cap or extra model calls are introduced.

Handled execution errors, cancellations, and timeouts retain the partial assessment and trace; they remain `execution_error` and are not sent to the judge. Grading failures preserve the completed agent assessment and remain `grading_error`. Late Realtime tool results cannot overwrite the saved interrupted trace. A hard worker kill or power loss before an assessment is saved can still leave no per-trial trace; interruption recovery must not invent those measurements.

`runs/:id` stores full assessment details; lightweight `summaries/:id` stores metrics and usage without the transcript or screenshots. `/api/evals/runs/:id` returns the full attempt; `/api/evals` reads summaries and supplies batch `metricsByAttempt`. Batch totals, median (p50), nearest-rank p95, sample counts, and execution/grading error counts remain separate for scheduled, confirmation, and on-demand trials within each agent and batch. Latency samples include unsuccessful attempts, with coverage shown. Missing summaries are explicitly reported and excluded, not presented as complete batch coverage. Legacy runs without counters make corresponding totals unavailable.

Recorded and older simulated evaluations are not backfilled by counting evidence entries, which are not equivalent to model turns or tool executions. Existing durations and token usage remain visible where available. Telemetry is not a new quality grader: it does not penalize valid alternative tool sequences, justified recovery, or slow devices. Targeted confirmation attempts are not independent random trials, so this change does not infer Anthropic's `pass@k` or `pass^k` measures from them.

## Agreed model and prompt selection

- Daily simulated evals assess the backend's currently configured model and prompts. TVAgent and ScheduledTaskAgent use `AI_MODEL_ADVANCED`; Realtime uses `AI_MODEL_REALTIME` through the native Azure Realtime API, not a substituted chat-completions model. No automatic matrix of alternative models or prompts is run.
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

- The initial TVAgent implementation supplies the twelve-scenario suite below.
- Phase 2 adds ScheduledTaskAgent and Realtime Voice Agent adapters while reusing scheduling, result storage, comparisons, recorded-attempt lifecycle and the dashboard.
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
- `registry.ts` registers the `tv`, `scheduled_task` and `realtime` adapters, pure scenario catalogs and retained-run loaders. The worker selects the registration for every mode; recorded grading and judge calibration do not construct or run the assessed live agent.
- `loop.ts` shares isolated model-loop execution between TVAgent and ScheduledTaskAgent. Realtime uses its native WebSocket protocol with text-only fixture turns. It does not call the production WebSocket proxy or start real specialist jobs.
- The dashboard's agent selector scopes simulations, session selection, histories, alerts, batches and reference checks. Legacy records without an agent field retain their original TV attribution.

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

Numeric scores apply only to TVAgent recorded-run evals in this version. ScheduledTaskAgent and Realtime recorded evaluations, and all simulated evaluations, retain categorical judgments without a numeric score. Show scoring as not applicable for those results, not as a legacy missing score or insufficient-evidence outcome. Do not mix simulated results into recorded task-score trends.

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

The combined multi-agent retained-evidence importer uses `recorded-import-3`, shared by the registry and runner. It preserves agent identity, LLM step numbers, tool call IDs and timestamped lifecycle events, without duplicating events or inventing tool-result timestamps. Evidence remains grouped by source/type; missing chronology stays an explicit gap.

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

TVAgent judge validation has its own [reference cases](./offline-eval-judge-reference-cases.md), separate from the twelve scenarios used to test TVAgent. Six categorical examples cover verified success, unsupported success, wrong content, valid alternative methods, honest failure, and missing evidence. Nine additional synthetic recorded-scoring fixtures check progress, mistake severity, calculation, duplicated evidence, and component-specific evidence sufficiency. They include concise completion messages so correct behavior is not rewarded merely for a longer explanation.

The user accepted the six TV categorical reference judgments; the nine TV scoring fixture expectations derive from the negotiated rubric. TV calibration checks all fifteen, retaining expected and actual scores and semantic assessments where applicable. Scoring fixtures do not introduce new categorical handling thresholds, so handling is `not_checked` for those nine cases.

ScheduledTaskAgent and Realtime each have six categorical starter cases covering their own successful outcomes, incorrect actions or claims, and incomplete evidence. **Validate judge** and `eval:calibrate -- --agent <id>` check only the selected agent and persist separate calibration reports. The new starter labels are not represented as user-reviewed. Keep separate reviewed held-out cases for validation when tuning the rubric; these smoke checks do not establish general judge accuracy. Judge self-confidence is not a measurement of accuracy.

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

### ScheduledTaskAgent suite

The twelve fixtures cover absolute-time announcements, relative time across the spring DST transition, recurring actions with resolved entities, today's task query, an update preserving other fields, occurrence cancellation, family cancellation, ambiguous deletion, a missing entity, past dates, invalid dates and storage-write failure. Clocks and `America/New_York` are fixed per fixture, including confirmation attempts. Assertions check exact requested storage effects and unchanged unrelated records; rejected writes never become successful scheduling.

### Realtime Voice Agent suite

The twelve Realtime fixtures exercise routing to direct Home Assistant, ScheduledTaskAgent and TV capabilities, clarification and protected/bulk-action confirmation, multi-turn confirmation and paused-run control, conversation, fixture-backed web information and scoped memory. Tool outputs represent accepted asynchronous jobs rather than completed device actions. The actual configured Realtime deployment receives text and production tool contracts, with no microphone input, audio output or live effectful executors. Text/tool quality must not be reported as speech or end-to-end audio quality.

Only newly retained, terminal Realtime turn traces are discoverable. Earlier voice turns without lifecycle telemetry are not manufactured from partial conversation memory. Recorded traces retain their source model and partial-evidence status; regrading does not execute a new voice or device turn.

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
- The judge deployment is configurable independently through `OFFLINE_EVAL_JUDGE_MODEL`. TV calibration checks six reviewed categorical cases and nine rubric-derived recorded-scoring fixtures; ScheduledTaskAgent and Realtime each check their six categorical starter cases. Reports are agent-scoped. A separately reviewed held-out set is still needed before claiming broader grader accuracy.
- ScheduledTask fixtures model task-management behavior, not future firing reliability. Realtime fixtures assess native-model text/tool decisions, not wake-word detection, ASR, microphone timing, audio rendering or a real specialist's eventual execution.
- Spending caps remain deferred. Timing comparisons are simulated execution wall times with virtual device waits, not a measurement of real device latency.
- Notifications currently use persistent dashboard alerts. External delivery has no selected destination.
- Recorded runs are selected through the multi-select session dialog, or by session ID through the CLI/API. Missing metadata or evidence remains unknown; historic system-only prompt hashes cannot claim equivalence with full simulated prompt/skill/tool manifests.
- Fidelity comparisons are conservative: incompatible or unknown configurations remain unmatched. No aggregate simulation-accuracy score is inferred from unmatched data.
