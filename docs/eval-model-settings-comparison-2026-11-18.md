# Model settings evaluation comparison — November 18, 2026

The current configuration completed **28/28 agent scenarios**. Independent simulator task outcomes matched the remote baseline in **28/28** cases. Local agent latency and remote latency are measured separately from offline grading. See the common-judge results below for handling and reporting.

**No improvement or regression was observed in task fulfillment, handling or reporting on this suite.** Scheduling median latency improved by 33.7%, while TV median latency worsened by 28.9%; p95 improved for both. All 56 local/remote trace assessments passed handling and reporting, and the common judge agreed with all 23 reference cases.

## Settings and execution

| Role | Deployment | Reasoning |
| --- | --- | --- |
| Local nano (not exercised by these suites) | `gpt-6.1-terra` | `low` |
| Local mini (not exercised by these suites) | `gpt-6.2-sol` | `low` |
| Local advanced (assessed) | `gpt-6.2-sol` | `high` |
| Remote assessed model | `gpt-6.1-sol` | Not retained in baseline metadata |
| Common comparison judge | `gpt-6.2-sol` | `medium` |

Local agent execution ran from `2026-11-19T02:40:20.979Z` to `2026-11-19T02:45:35.970Z` (UTC; the evening of November 18 in America/New_York). The 28 advanced-model scenarios use the production loop and simulated device/task environments. They do not measure nano/mini tasks, browser voice, speech recognition, audio quality or real-device wait time.

The initial morning attempt failed Azure authentication and is retained under `current/`; those attempts are excluded here. After credentials were updated, the advanced deployment worked. An initial judge preflight using `gpt-6.1-sol` returned deployment-not-found, and the user authorized `gpt-6.2-sol` / `medium` as the common judge. The resumed configuration snapshot also records `gpt-6.2-sol` / `medium` for the judge. **This evaluation did not edit `.env`.** Agent assessments were retained first and then graded without replaying their tools.

Captured outbound settings confirm all **138 agent requests** used `gpt-6.2-sol` / `high`, and all **79 judge requests** used `gpt-6.2-sol` / `medium` (56 trace assessments plus 23 reference checks). Both evaluation workers finished and released their locks.

## Latency

| Agent | Remote median | Local median | Median change | Remote p95 | Local p95 | p95 change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| TVAgent | 13.43 s | 17.31 s | +28.9% | 66.54 s | 45.95 s | -31.0% |
| ScheduledTaskAgent | 6.53 s | 4.33 s | -33.7% | 13.14 s | 7.51 s | -42.9% |

Negative changes mean faster local execution. Durations include the agent’s model/tool workflow and exclude offline judge time. p95 uses nearest rank; with 12 TV and 16 scheduling samples it is the slowest attempt, so it is not a stable production-tail estimate.

| Agent | Remote mean | Local mean | Local faster by scenario | Remote / local tool calls |
| --- | ---: | ---: | ---: | ---: |
| TVAgent | 23.07 s | 20.02 s | 8/12 | 83 / 100 |
| ScheduledTaskAgent | 7.12 s | 4.61 s | 14/16 | 36 / 38 |

A median across scenario durations can increase even when most paired scenarios improve: different scenarios can cross the median rank. The per-scenario pairs below retain the exact changes.

## Quality

| Agent | Remote task fulfilled | Local task fulfilled | Matched outcomes |
| --- | ---: | ---: | ---: |
| TVAgent | 10/12 | 10/12 | 12/12 |
| ScheduledTaskAgent | 10/16 | 10/16 | 16/16 |

The eight unfulfilled requests are deliberately impossible or invalid: unreachable Netflix, unconfirmed Smart STB, expired relative deadline, ambiguous deletion, missing entity, past date, invalid date and unavailable storage. Task nonfulfillment on these fixtures is expected; handling and reporting determine whether the refusal/recovery was appropriate.

### Common-judge handling and reporting

| Agent | Remote handling | Local handling | Remote reporting | Local reporting |
| --- | ---: | ---: | ---: | ---: |
| TVAgent | 12/12 | 12/12 | 12/12 | 12/12 |
| ScheduledTaskAgent | 16/16 | 16/16 | 16/16 | 16/16 |

Both sources are graded from retained evidence using the same judge deployment/effort, rubric, scenario contexts and fixed empty grouping context. Model identity, execution timing and token usage are omitted from judgment packets; local/remote grading order alternates by scenario. No remote device actions are replayed. The judge shares the candidate model family, so calibration and independent simulator assertions are important checks, not proof of broad accuracy.

- tv judge reference agreement: **15/15**.
- scheduled_task judge reference agreement: **8/8**.


## Per-scenario latency and outcomes

| Agent / scenario | Remote | Local | Local change | Task outcome |
| --- | ---: | ---: | ---: | --- |
| tv / `netflix-unreachable` | 10.65 s | 12.52 s | +17.5% | unchanged |
| tv / `pause-playing` | 7.35 s | 6.71 s | -8.7% | unchanged |
| tv / `resume-paused` | 8.59 s | 9.52 s | +10.8% | unchanged |
| tv / `smartstb-launch` | 10.31 s | 26.35 s | +155.6% | unchanged |
| tv / `smartstb-unconfirmed` | 39.73 s | 41.22 s | +3.7% | unchanged |
| tv / `telugu-already-playing` | 11.21 s | 6.14 s | -45.2% | unchanged |
| tv / `telugu-fresh-search` | 66.54 s | 45.95 s | -31.0% | unchanged |
| tv / `telugu-paused-selection` | 33.56 s | 29.44 s | -12.3% | unchanged |
| tv / `telugu-visible-results` | 30.41 s | 23.41 s | -23.0% | unchanged |
| tv / `youtube-already-open` | 9.16 s | 6.06 s | -33.8% | unchanged |
| tv / `youtube-launch-recovery` | 33.67 s | 22.09 s | -34.4% | unchanged |
| tv / `youtube-powered-off` | 15.66 s | 10.89 s | -30.5% | unchanged |
| scheduled_task / `ambiguous-delete` | 7.72 s | 3.59 s | -53.5% | unchanged |
| scheduled_task / `announcement-at-time` | 4.81 s | 5.25 s | +9.1% | unchanged |
| scheduled_task / `announcement-relative-dst` | 5.56 s | 4.05 s | -27.1% | unchanged |
| scheduled_task / `cancel-family` | 8.86 s | 7.51 s | -15.2% | unchanged |
| scheduled_task / `cancel-occurrence` | 10.09 s | 4.61 s | -54.3% | unchanged |
| scheduled_task / `cancel-timed-action-occurrence` | 9.58 s | 6.38 s | -33.4% | unchanged |
| scheduled_task / `expired-short-relative-deadline` | 6.04 s | 3.58 s | -40.8% | unchanged |
| scheduled_task / `invalid-date` | 3.22 s | 1.80 s | -44.2% | unchanged |
| scheduled_task / `missing-entity` | 5.62 s | 6.12 s | +8.9% | unchanged |
| scheduled_task / `past-date` | 3.59 s | 3.55 s | -1.1% | unchanged |
| scheduled_task / `query-today` | 6.39 s | 3.52 s | -44.9% | unchanged |
| scheduled_task / `recurring-action-dst` | 13.14 s | 5.39 s | -59.0% | unchanged |
| scheduled_task / `relative-delay-processing-latency` | 5.23 s | 3.58 s | -31.6% | unchanged |
| scheduled_task / `storage-failure` | 6.68 s | 3.79 s | -43.2% | unchanged |
| scheduled_task / `timed-action-shutoff` | 8.49 s | 5.75 s | -32.4% | unchanged |
| scheduled_task / `update-preserve-fields` | 8.89 s | 5.28 s | -40.5% | unchanged |

## Interpretation and limits

- The remote baseline is the saved November 18 scheduled TV/scheduling suite at [10.0.0.202:3005](http://10.0.0.202:3005/dashboards/evals), pinned before the local retry. Local and remote scenario identifiers, versions, adapter versions, requests and prompt/tool fingerprints were checked before execution.
- This is one fresh attempt per scenario compared with one historical remote attempt. Host, network, Azure resource, request time and caching can affect latency; the measurements do not isolate model or reasoning effort as the cause.
- TV’s Smart STB launch took 10 local model/tool turns versus 4 remotely because the local agent added screenshot navigation and repeated state checks. This preserved fulfillment but increased this scenario’s latency. Fresh Telugu search improved from 66.54 s to 45.95 s.
- The remote visible-results TV trace includes one 0.09-second TLS connection failure before successful completion; local traces have no model errors. All attempts remain included in agent latency.
- The original remote judge (`gpt-6-astra`) results are preserved separately from the common-judge results. These pass/fail handling/reporting grades do not by themselves reward faster execution or penalize every extra successful verification call.
- These repeated controlled fixtures are limited evidence for general quality. No dollar cost is estimated; remote TV token usage is incomplete and unknown counters are not zero.

## Retained artifacts

Machine-local artifacts (not committed to this public repository) are under `service/generated_data/eval-comparisons/2026-11-18-json-model-settings/`:

- `resumed/configuration.json`: current model settings without credentials.
- `resumed/agent-only/`: original local assessments and agent timing, with explicitly deferred grading.
- `resumed/request-settings.json`: captured outbound model and reasoning effort only.
- `resumed/graded/`, `resumed/grading-progress.json`: common-judge regrades, reference checks and source-run lineage.
- `resumed/judge-request-settings.json`: captured judge model and reasoning effort only.
- `resumed/analysis.json`: calculated aggregate and per-scenario paired results.
- `resumed/scripts/`: the evaluation, blinding, analysis and report-generation scripts.
- `remote-summary.json`, `remote-selection.json`, `remote-runs/`, `remote-analysis.json`: pinned remote baseline and original judgments.
- `current/`: excluded authentication-failed attempts from the original morning run.
