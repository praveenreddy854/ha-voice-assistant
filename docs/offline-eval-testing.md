# Testing offline TVAgent evals

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

## 1. Validate the judge

Wait for any running batch to finish, then scroll to **Judge validation** and click **Validate judge**. The dashboard refreshes automatically; **Refresh** also retrieves current results. Expand the new validation result to inspect the six cases.

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

## 2. Run the TV simulation suite

Under **Run a simulation**, leave **Alternative deployment** blank and click **Run simulated suite**. This starts a new model-driven run for each of the twelve scenarios, with simulated device tools and rendered screen images. It must not change your real TV, apps, playback, or persistent assistant memory.

Check **Batch coverage**: the batch should move from `running` to `completed` with twelve on-demand attempts. An `incomplete` batch means at least one execution or grading operation could not finish; it does not mean the assistant failed all twelve tasks.

Check **Run history and weekly comparison**: the new rows should say `simulated` and `on_demand`. There are multiple variants of the same request; open **Inspect** to see the scenario and its starting-state context.

## 3. Inspect a few representative results

Click **Inspect** on a row. Read the request and final response, then the task and step judgments. Expand the referenced evidence IDs under **Source evidence** to see the actual tool arguments, observations, and available images.

- **YouTube already open:** the task may pass without a launch call. The app-readiness step should be marked already satisfied.
- **Fresh Telugu search:** inspect the keyboard image, typed query, selected result, and final playback observation. A correct result must preserve Telugu, latest, the target Apple TV, and active playback.
- **Paused selection:** selecting the right content is not sufficient; a correct run needs to detect paused playback, start it, and verify.
- **Launch recovery:** a failed first tool can coexist with a passing whole task if later actions verify success.
- **Unreachable Netflix or unconfirmed Smart STB:** task fulfillment should fail. Handling and reporting can pass if the agent makes reasonable recovery attempts and honestly reports inability to finish. A false success claim should fail handling/reporting.

The LLM's explanation must point to evidence that actually supports it. A screenshot proves only what is visible; an accepted command does not prove completion. The simulated final-state assertion checks the actual fixture outcome independently of the agent's success claim.

## 4. Grade an existing real run on demand

Open **http://localhost:3005/telemetry**, choose a completed TVAgent session, and copy its session ID. Return to **Grade completed real runs**, paste one or more IDs, and click **Grade selected runs**.

The resulting rows should say `recorded` and `on_demand`. Open **Inspect** and compare the judgment with the retained observations and final message. The importer can supplement telemetry with the matching Cosmos flow when configured. It must not replay device actions.

For an older trace without enough verification evidence, `unknown` is an expected result. A missing or nonterminal session should produce an execution error, not a successful grade.

## 5. Validate historical comparisons

- The daily suite runs at **3:00 a.m. America/New_York** on the backend host. Same-day catch-up runs once after missed availability; older missed days are skipped.
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

# Grade a completed real session; replace the example ID
npm run eval:recorded -- COMPLETED_SESSION_ID

# Verify framework behavior without live model/device calls
node --import tsx --test tests/offlineEvals.test.ts tests/offlineTvAdapter.test.ts
```

`OFFLINE_EVAL_JUDGE_MODEL` selects the Azure judge deployment independently from the assessed TVAgent model. `OFFLINE_EVAL_ENABLED=false` disables the daily scheduler while retaining manual runs. Alerts currently appear persistently in the eval dashboard.
