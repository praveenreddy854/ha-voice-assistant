# Offline assistant evals

The shared implementation in `service/src/evals/` supports TVAgent, ScheduledTaskAgent and the Realtime Voice Agent. Each has a registered adapter, a bounded simulated suite, recorded-run import and agent-specific judge reference cases. This document records the design and remaining refinements; domain terminology lives in [CONTEXT.md](../CONTEXT.md#assistant-evaluation). See [testing instructions](./offline-eval-testing.md) for the dashboard and on-demand commands.

## Agreed modes and cadence

Both modes are in scope and must remain distinguishable in execution, reports, and aggregate results.

| Mode | Assessed behavior | When it runs |
| --- | --- | --- |
| Simulated eval | A new run of the selected agent against its controlled simulated environment | Daily in the background to detect regressions |
| Recorded-run eval | A completed real run of the selected agent, graded from retained evidence | On demand only |

"Real evals" is the user's term for recorded-run evals. These read the original run's telemetry and Cosmos data; they do not replay its device actions. Keep simulated and recorded-run scores separate.

Spending limits are deferred by user choice. The runner, dashboard at `/dashboards/evals`, and backend-host scheduler are implemented. `OFFLINE_EVAL_ENABLED=false` disables daily scheduling; it is enabled by default when the backend starts.

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

- Start the simulated suite daily at 3:00 a.m. in `America/New_York`.
- Run the eval workload on the same machine as the backend.
- Use `America/New_York` for dashboard day boundaries and the previous-seven-complete-days comparison window.
- Use the named timezone so the schedule follows local daylight-saving changes.

The backend supervisor launches a separate worker process for eval execution. Starting at the named local schedule, it runs each registered agent's suite sequentially, starting the next available agent on a subsequent scheduler tick. It persists jobs and batches and prevents a duplicate scheduled attempt for the same agent and local day. A TV batch or failed TV startup no longer suppresses the other agents. There is still only one active worker and no persistent queue of additional jobs.

## Agreed missed-run handling

- If the machine misses the 3:00 a.m. run and becomes available later that day, run that day's suite once.
- Mark older missed days as skipped instead of executing a backlog of suites.
- Preserve the intended schedule date and actual execution timestamps; do not backdate results into days when no eval ran.
- Skipped days provide no scenario result for the historical baseline.
- Prevent a same-day catch-up from duplicating a batch already started for that scheduled day.

## Agreed daily workload

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
- Recorded-run evals remain on demand; displaying a comparison does not authorize automatically grading new real runs.

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

Use an LLM wherever semantic interpretation improves evaluation, supported by deterministic checks where the facts are directly testable. Every assessed run receives a semantic review after execution, including recorded runs only when their evaluation is requested. The following division makes that quality-first direction concrete:

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

The judge needs its own reference cases, separate from the twelve scenarios used to test TVAgent. The [six proposed reference cases](./offline-eval-judge-reference-cases.md) provide synthetic evidence packets and candidate labels covering verified success, unsupported success, wrong content, valid alternative methods, honest failure, and missing evidence. They include concise completion messages so correct behavior is not rewarded merely for a longer explanation.

The user accepted the six original TV reference judgments. Each added agent has six starter reference cases covering its own successful outcomes, incorrect actions or claims, and incomplete evidence. **Validate judge** and `eval:calibrate -- --agent <id>` check only the selected agent and persist separate calibration reports. The new starter labels are not represented as user-reviewed. Keep separate held-out cases for validation when tuning the rubric; a six-case check does not establish general judge accuracy.

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
- The judge deployment is configurable independently through `OFFLINE_EVAL_JUDGE_MODEL`; calibration checks the selected agent's six reference cases. A held-out labeled set is still needed before claiming broader grader accuracy.
- ScheduledTask fixtures model task-management behavior, not future firing reliability. Realtime fixtures assess native-model text/tool decisions, not wake-word detection, ASR, microphone timing, audio rendering or a real specialist's eventual execution.
- Spending caps remain deferred. Timing comparisons are simulated execution wall times with virtual device waits, not a measurement of real device latency.
- Notifications currently use persistent dashboard alerts. External delivery has no selected destination.
- Recorded runs are selected through the multi-select session dialog, or by session ID through the CLI/API. Missing metadata or evidence remains unknown; historic system-only prompt hashes cannot claim equivalence with full simulated prompt/skill/tool manifests.
- Fidelity comparisons are conservative: incompatible or unknown configurations remain unmatched. No aggregate simulation-accuracy score is inferred from unmatched data.
