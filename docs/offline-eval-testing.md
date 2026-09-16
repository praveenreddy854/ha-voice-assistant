# Testing offline assistant evals

## Open the backend-served page

On the backend machine, open **http://localhost:3005/dashboards/evals**. The heading should be **Offline assistant evals**.

The general telemetry page is **http://localhost:3005/dashboards**; its **Offline evals** button opens the eval page. Opening `service/src/tracing/dashboardViewer.html` as a local file does not connect the page to the backend API and produces “Dashboard API unavailable” / “Failed to fetch”.

From another computer, use the backend machine's hostname or IP in place of `localhost`, retaining port `3005`. Use your configured port if it differs.

If the backend is not running, start it from the service directory:

```sh
cd /Users/praveengaddam/Desktop/projects/ha-voice-assistant/service
npm run dev
```

If it is already running, use that instance. Do not start a second backend on the same port. The eval browser script is compiled during the normal backend build; after changing code, rebuild/restart the backend if it is not running the development watcher.

Use **Agent** to select **TVAgent**, **ScheduledTaskAgent**, or **Realtime Voice Agent**. That selection controls the simulation suite, recorded-session picker, history, alerts and judge reference cases. Selections in the recorded-session picker are preserved separately per agent. Switching agents never submits a mixed-agent batch.

## 1. Validate the judge

Select **TVAgent**, wait for any running batch to finish, then scroll to **Judge validation** and click **Validate judge**. The dashboard refreshes automatically; **Refresh** also retrieves current results. Expand the new validation result to inspect the six cases.

The expected results below are for the fixed reference examples, not predictions about how a newly simulated agent run will behave:

| Case | Task fulfillment | Handling | Reporting |
| --- | --- | --- | --- |
| J1: YouTube already open | pass | pass | pass |
| J2: claims Smart STB opened while observations still show Home | fail | fail | fail |
| J3: plays older content but claims latest Telugu songs | fail | fail | fail |
| J4: direct launch fails, remote navigation recovers and verifies | pass | pass | pass |
| J5: TV unreachable; reasonable recovery and honest failure | fail | pass | pass |
| J6: retained record lacks the final verification evidence | unknown | unknown | unknown |

All six cases should agree with these reviewed labels. Inspect any disagreement before trusting the affected grading criterion. Model/service errors are validation failures, not evidence of TVAgent failure. This initial check does not establish broad judge accuracy; it is a small reviewed reference set.

The full evidence examples are in [the judge reference cases](./offline-eval-judge-reference-cases.md).

ScheduledTaskAgent and Realtime each have six additional **starter** reference cases, selected by the same Agent control. Their reports stay separate from TV calibration. These new labels are not claimed to have been reviewed by the user; inspect disagreements and use held-out examples before claiming broader judge accuracy.

## 2. Run the TV simulation suite

Under **Run a simulation**, leave **Alternative deployment** blank and click **Run simulated suite**. This starts a new model-driven run for each of the twelve scenarios, with simulated device tools and rendered screen images. It must not change your real TV, apps, playback, or persistent assistant memory.

Check **Batch coverage**: the batch should move from `running` to `completed` with twelve on-demand attempts. An `incomplete` batch means at least one execution or grading operation could not finish; it does not mean the assistant failed all twelve tasks.

Check **Run history and weekly comparison**: the new rows should say `simulated` and `on_demand`. There are multiple variants of the same request; open **Inspect** to see the scenario and its starting-state context.

Use the **All** (default), **Simulated**, and **Real** tabs above the history table to switch between both modes, simulations only, and recorded-run evaluations only. The tabs and the top-level **Mode** filter stay synchronized, including the summary counts. Switching tabs keeps each run's prior-week comparison and Inspect action intact; automatic and manual refreshes preserve the selected tab. Use Left/Right arrows or Home/End to navigate the tabs with a keyboard.

Select **ScheduledTaskAgent** to run twelve scheduling fixtures against the production advanced-model loop and tool schemas. Inspect absolute/relative dates, the DST transition, resolved entities, unchanged fields, occurrence-versus-family cancellation and failed persistence. No real tasks are saved or fired.

Select **Realtime Voice Agent** to run twelve fixtures on the native Realtime deployment with text input and simulated tools. Some fixtures include follow-up turns in the same fresh session. Inspect routing, preserved request qualifiers, follow-up/confirmation ordering, paused-run identity and memory scope. `On it` acknowledges a simulated asynchronous job; it does not establish device completion. These evals do not exercise microphone capture, wake words, ASR or speech quality. An alternative deployment for this agent must support the Realtime API.

## 3. Inspect a few representative results

Click **Inspect** on a row. Read the request and final response, then the task and step judgments. Expand the referenced evidence IDs under **Source evidence** to see the actual tool arguments, observations, and available images.

- **YouTube already open:** the task may pass without a launch call. The app-readiness step should be marked already satisfied.
- **Fresh Telugu search:** inspect the keyboard image, typed query, selected result, and final playback observation. A correct result must preserve Telugu, latest, the target Apple TV, and active playback.
- **Paused selection:** selecting the right content is not sufficient; a correct run needs to detect paused playback, start it, and verify.
- **Launch recovery:** a failed first tool can coexist with a passing whole task if later actions verify success.
- **Unreachable Netflix or unconfirmed Smart STB:** task fulfillment should fail. Handling and reporting can pass if the agent makes reasonable recovery attempts and honestly reports inability to finish. A false success claim should fail handling/reporting.

The LLM's explanation must point to evidence that actually supports it. A screenshot proves only what is visible; an accepted command does not prove completion. The simulated final-state assertion checks the actual fixture outcome independently of the agent's success claim.

## 4. Grade an existing real run on demand

Under **Grade completed real runs**, click **Select sessions**. The dialog lists finished sessions for the selected agent, including assistant runs that ended in error. TVAgent uses retained telemetry and configured Cosmos records; ScheduledTaskAgent and Realtime use telemetry only. Duplicate session IDs appear once with their sources. Applicable source failures remain visible with a retry action. Realtime turns predating retained lifecycle traces are not available for backfilling.

Search by request or session ID, filter by session start dates in **America/New_York**, or choose an evaluation status. Select individual sessions or **Select this page**. Selections persist across pages and filters; the total and hidden-selection count must remain accurate. **Review selected** exposes the complete selection and **Clear selection** resets it. A batch is limited to 100 sessions.

Review the inline breakdown of new evaluations and re-evaluations, then click **Run selected evaluations**. Paid model grading uses retained evidence only and never replays device actions. Closing the dialog or browser does not cancel accepted work. If another eval job is running, submission stays disabled with the selection preserved until the worker becomes available.

Each session independently moves through **Queued**, **Running**, and then **Evaluated** or **Eval error**. A failing or unknown verdict still counts as Evaluated; Eval error means the evaluation could not finish. Only the actively evaluated session should say Running, not every member of its batch. Queued and Running sessions cannot be selected again.

The telemetry viewer at **http://localhost:3005/telemetry** shows the same evaluation status beside all supported agents' sessions, with agent-aware links to their history. Re-evaluation keeps prior attempts and their evidence. If a later attempt is pending or fails, its status remains primary and the last completed verdict is labeled **Previous evaluation** with its grading timestamp. A worker interruption preserves completed results and marks unfinished attempts as errors requiring explicit retry, including attempts that never started.

The resulting rows should say `recorded` and `on_demand`. Open **Inspect** and compare the judgment with the retained observations and final message. The importer can supplement telemetry with the matching Cosmos flow when configured. It must not replay device actions.

For an older trace without enough verification evidence, `unknown` is an expected result. A missing or nonterminal session should produce an execution error, not a successful grade.

## 5. Validate historical comparisons

- Daily suites start at **3:00 a.m. America/New_York** on the backend host and run sequentially by agent under the single-worker limit. Same-day catch-up runs once per agent after missed availability; older missed days are skipped. A failed startup for one agent does not retry indefinitely or suppress the others.
- Historical regression comparisons need **at least three comparable scheduled results from the preceding seven complete local days**. `Collecting baseline` is expected until then.
- On-demand and confirmation attempts do not fill the scheduled baseline. Do not backdate results to make the baseline appear ready.
- Failures and successful-task durations above twice the prior median receive at most one confirmation attempt under the agreed rules. Inspect the original and confirmation separately.
- **Simulation fidelity** requires matching task, target/app, starting state, assessed configuration, and grader versions. Old traces often lack configuration metadata, so `No comparison data yet` is expected. It is not a measured fidelity score.

## CLI alternatives

Run these from the service directory. The browser and CLI use the same configured eval directory; keep `OFFLINE_EVAL_DIR` consistent and avoid changing it when comparing history. Relative paths resolve from the command's working directory. An absolute path avoids accidentally creating separate histories.

```sh
# Check the six judge reference cases
npm run eval:calibrate

# Run all twelve simulated scenarios on demand
npm run eval:simulated

# Run one scenario on demand
npm run eval -- simulated telugu-fresh-search

# Run the other agents with their configured models
npm run eval:simulated -- --agent scheduled_task
npm run eval:simulated -- --agent realtime

# Check scheduling across daylight saving time with an alternative deployment
npm run eval -- simulated --agent scheduled_task --model CANDIDATE_DEPLOYMENT announcement-relative-dst

# Validate the selected agent's judge reference cases
npm run eval:calibrate -- --agent scheduled_task
npm run eval:calibrate -- --agent realtime

# Grade a completed real session; replace the example ID
npm run eval:recorded -- COMPLETED_SESSION_ID
npm run eval:recorded -- --agent scheduled_task COMPLETED_SCHEDULED_SESSION_ID
npm run eval:recorded -- --agent realtime COMPLETED_REALTIME_SESSION_ID

# Verify framework behavior without live model/device calls
node --import tsx --test tests/offlineEvals.test.ts tests/offlineMultiAgentEvals.test.ts tests/offlineWorker.test.ts tests/offlineTvAdapter.test.ts tests/offlineScheduledTaskAdapter.test.ts tests/offlineScheduledTaskEnvironment.test.ts tests/offlineRealtimeAdapter.test.ts tests/realtimeTrace.test.ts tests/recordedSessionDiscovery.test.ts tests/recordedEvalLifecycle.test.ts
```

Omitting `--agent` preserves the existing TV default. `OFFLINE_EVAL_JUDGE_MODEL` selects the judge deployment independently of the assessed agent; `AI_MODEL_ADVANCED` supplies TV/scheduling defaults and `AI_MODEL_REALTIME` supplies the native Realtime default. Recorded grading does not construct or execute that agent. `OFFLINE_EVAL_ENABLED=false` disables all daily suites while retaining manual runs. Alerts remain agent-scoped in the dashboard.

The history-tab browser checks use mocked API responses and do not start the backend or make paid model calls. With dependencies and Playwright Chromium installed, run from the repository root:

```sh
cd service && npx tsc
cd ../ha-voice-assistant && npm run test:e2e -- e2e/eval-history.spec.ts
```
