(() => {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const esc = (value: unknown) => String(value ?? "—").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  type Run = import("./types").EvalRunSummary & { assessment?: import("./types").Assessment; verdict?: string };
  type Session = import("./types").RecordedSession;
  type Evaluation = import("./types").RecordedSessionEvaluation;
  type History = import("./types").RecordedSessionHistory;
  type RunSummary = import("./types").EvalRunSummary;
  type StatusResponse = { statuses: Record<string, Evaluation>; busy: boolean };
  type Schedules = import("./scheduling").EvalScheduleStatus;
  type CalibrationResult = { id: string; passed: boolean; expected: string[]; actual?: string[]; error?: string;
    expectedScore?: number | null; actualScore?: number | null; expectedProgress?: string; actualProgress?: string;
    expectedSeverities?: string[]; actualSeverities?: string[];
    expectedBlockingComponents?: string[]; actualBlockingComponents?: string[] };
  type Snapshot = { runs: Run[]; batches: import("./types").EvalBatchSummary[]; alerts: import("./types").EvalAlert[]; busy: boolean;
    agents: { id: string; name: string; description: string; scenarioCount: number; referenceCount: number }[];
    baseline: { from: string; to: string }; timezone: string; scheduleEnabled: boolean; schedules?: Schedules; fidelityNote: string;
    fidelity: { simulatedId: string; recordedIds: string[]; status: string }[];
    jobs?: import("./worker").EvalJob[];
    calibrations: { id: string; agentId?: string; judgeModel: string; createdAt: string; passed: boolean; limitation?: string; results: CalibrationResult[] }[] };
  let snapshot: Snapshot | undefined;
  let busy: boolean | undefined;
  let submitting = false;
  let mutationVersion = 0;
  let refreshing: Promise<void> | undefined;
  let refreshAgain = false, reloadSessions = false, retrySources = false;
  let sessionsInitialized = false, metadataKnown = false, statusesKnown = false;
  let metadataError = "", statusError = "";
  let sessions: Session[] = [];
  let availableIds = new Set<string>();
  let statuses: Record<string, Evaluation> = {};
  const sessionCache = new Map<string, Session>();
  let selected = new Set<string>();
  const selectionsByAgent = new Map<string, Set<string>>([["tv", selected]]);
  let agentId = "overview";
  let mode: import("./types").EvalMode = "recorded";
  let evaluator: "llm" | "code" = "llm";
  const currentAgentId = () => agentId;
  const rows = new Map<string, HTMLTableRowElement>();
  let page = 1, reviewSelected = false, deferredRows = false;
  let displayed: Session[] = [];
  let pendingSubmission: { agentId: string; requestId: string; sessionIds: string[] } | undefined;
  let detailVersion = 0, historySession: string | undefined, returnToSelection = false;
  let detailDownloadUrl: string | undefined;
  let historyLoading = false, historyMarkup: string | undefined;
  const selector = element<HTMLDialogElement>("session-selector");
  const detail = element<HTMLDialogElement>("detail");
  const runModes = ["recorded", "simulated"] as const;
  const evaluators = ["llm", "code"] as const;
  const agentIds = ["overview", ...Array.from(document.querySelectorAll<HTMLElement>("#agent-tabs [data-agent-id]"), tab => tab.dataset.agentId!)];
  const PAGE_SIZE = 25, MAX_SELECTION = 100;
  const timezone = "America/New_York";
  const lifecycleLabels: Record<Evaluation["status"], string> = {
    not_evaluated: "Not evaluated", queued: "Queued", running: "Running", evaluated: "Evaluated", eval_error: "Eval error",
  };
  const badge = (value?: string) => `<span class="badge ${esc(value || "unknown")}">${esc(value || "unknown")}</span>`;
  const date = (value: string) => new Date(value).toLocaleString();
  const dayFormatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" });
  const nyDate = (value?: string) => value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("en-US", { timeZone: timezone, timeZoneName: "short" }) : "Unavailable";
  const nyDay = (value: string) => {
    if (!Number.isFinite(Date.parse(value))) return "";
    const parts = dayFormatter.formatToParts(new Date(value));
    return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
  };
  const duration = (value?: number) => value == null ? "Unknown" : `${(value / 1000).toFixed(1)}s`;
  const metricNumber = (value?: number) => value == null || !Number.isFinite(value) || value < 0 ? "Unavailable" : value.toLocaleString("en-US");
  const latency = (value?: number) => value == null || !Number.isFinite(value) || value < 0 ? "Unavailable"
    : value < 1000 ? `${value.toFixed(0)} ms` : `${(value / 1000).toFixed(2)} s`;
  const runMetrics = (run: Run) => run.assessment?.metrics || run.metrics;
  const agentUsage = (run: Run) => run.assessment?.usage || run.usage;
  function metricCells(run: Run) {
    const metrics = runMetrics(run), usage = agentUsage(run);
    return `<td class="trial-turns">${metricNumber(metrics?.assistantTurns)}${metrics ? `<br><small>${metricNumber(metrics.userTurns)} user turns</small>` : ""}</td><td class="trial-tools">${metricNumber(metrics?.toolCalls)}${metrics ? `<br><small>${metricNumber(metrics.toolExecutions)} executed<br>${metricNumber(metrics.toolErrors)} failed / ${metricNumber(metrics.rejectedToolCalls)} rejected</small>` : ""}</td><td class="trial-tokens">${metricNumber(usage?.totalTokens)}${usage ? `<br><small>In ${metricNumber(usage.inputTokens)} / out ${metricNumber(usage.outputTokens)}</small>` : ""}</td>`;
  }
  function batchHtml(batch: import("./types").EvalBatchSummary) {
    const heading = `${esc(batch.scheduledDay || date(batch.startedAt))} · ${esc(batch.mode === "simulated" ? "synthetic" : "recorded")} · ${batch.attempt === "scheduled" ? "Scheduled" : "On demand"} · ${badge(batch.status)} · ${batch.runIds.length} attempts ${esc(batch.error || "")}`;
    if (batch.mode !== "simulated") return `<p>${heading}</p>`;
    const metrics = batch.metricsByAttempt;
    return `<details class="batch-metrics" data-result-id="${esc(batch.id)}"><summary data-focus-key="${esc(batch.id)}">${heading}</summary>${batch.missingRunSummaries ? `<p class="error" role="alert">${metricNumber(batch.missingRunSummaries)} run summaries unavailable. Totals below cover only retained summaries, not the entire batch.</p>` : ""}${metrics?.length ? `<div class="scroll"><table><caption>Retained simulated trial metrics</caption><thead><tr><th>Attempt</th><th>Telemetry coverage</th><th>Assistant turns</th><th>Tool calls / failures</th><th>Agent tokens</th><th>Judge tokens</th><th>Agent latency p50 / p95</th><th>Execution / grading errors</th></tr></thead><tbody>${metrics.map(item => `<tr><td>${esc(item.attempt)}</td><td>${metricNumber(item.measuredRuns)} / ${metricNumber(item.runCount)} trials</td><td>${metricNumber(item.assistantTurns)}</td><td>${metricNumber(item.toolCalls)} / ${metricNumber(item.toolErrors)}</td><td>${metricNumber(item.usage.totalTokens)}</td><td>${metricNumber(item.judgeUsage.totalTokens)}</td><td>${latency(item.p50DurationMs)} / ${latency(item.p95DurationMs)}<br><small>${metricNumber(item.latencySamples)} samples</small></td><td>${metricNumber(item.executionErrors)} / ${metricNumber(item.gradingErrors)}</td></tr>`).join("")}</tbody></table></div><p class="muted">Scheduled, confirmation, and on-demand attempts stay separate. Latencies include unsuccessful attempts; p95 uses the nearest-rank sample. Missing token contributions make the total unavailable.</p>` : '<p class="muted">Trial metrics unavailable for this batch.</p>'}</details>`;
  }
  const modeLabel = () => mode === "recorded" ? "Recorded" : "Synthetic";
  const methodLabel = () => evaluator === "code" ? "Code-based" : "LLM-based";
  const progressLabels: Record<import("./types").TaskScoringAssessment["progress"]["level"], string> = {
    none: "No useful progress", prerequisites: "Prerequisites only", partial: "Partial meaningful progress",
    nearly_complete: "Nearly complete", complete: "Verified full fulfillment", unknown: "Unknown progress",
  };
  function scoreHtml(run: RunSummary) {
    if (run.agentId !== "tv") return '<span class="task-score muted">Task eval score: N/A for this agent</span>';
    if (run.mode !== "recorded") return '<span class="task-score muted">Task eval score: N/A — synthetic evaluation</span>';
    if (run.status !== "completed") return '<span class="task-score muted">No completed task eval score — evaluation did not finish</span>';
    const score = run.grade?.score;
    if (!score) return '<span class="task-score muted">Scoring unavailable for this evaluation</span>';
    return score.status === "scored"
      ? `<span class="task-score"><strong>Task eval score: ${esc(score.value)}/100</strong></span>`
      : `<span class="task-score unknown">Unscored — insufficient evidence</span><br><small>${esc(score.reason)}</small>`;
  }
  function renderSchedules() {
    if (!snapshot) return;
    const schedules = snapshot.schedules;
    const recorded = schedules?.recorded, simulated = schedules?.simulated, latest = recorded?.latest;
    const zone = esc(schedules?.timezone || snapshot.timezone || timezone);
    const outcomeLabels: Record<string, string> = {
      queued: "Batch queued", running: "Batch running", completed: "Batch completed",
      empty: "No eligible sessions", failed: "Scheduling failed",
      incomplete_discovery: "No eligible sessions in available sources — discovery incomplete",
    };
    element("schedules").innerHTML = `<div id="recorded-schedule" class="schedule-card"><h3>Recorded runs · TV only</h3><p>Daily at 1 a.m. · ${zone}<br><strong>${recorded ? recorded.enabled ? "Enabled" : "Disabled" : "Schedule status unavailable"}</strong></p><p class="muted">Automatic recorded grading covers TVAgent only. Other agents remain available for manual recorded evaluation.</p>${recorded?.enabledAt ? `<p>Initial eligibility cutoff: ${esc(nyDate(recorded.enabledAt))}<br><small>Only TV runs started at or after this persisted cutoff are eligible for automatic selection. Older runs remain available manually.</small></p>` : ""}${latest ? `<p>Latest daily outcome: <strong>${esc(outcomeLabels[latest.status] || latest.status.replace(/_/g, " "))}</strong><br>${esc(latest.day)} · ${esc(latest.selectedCount)} sessions selected</p>${latest.warnings.length ? `<div class="session-warning" role="status"><strong>Incomplete recorded-run discovery / scheduling warnings</strong><ul>${latest.warnings.map(warning => `<li>${esc(warning)}</li>`).join("")}</ul></div>` : ""}${latest.error ? `<p class="error" role="alert">${esc(latest.error)}</p>` : ""}` : "<p class=muted>No recorded daily outcome is available.</p>"}</div><div id="simulated-schedule" class="schedule-card"><h3>Simulated suites · All registered agents</h3><p>Daily at 3 a.m. · ${zone}<br><strong>${simulated ? simulated.enabled ? "Enabled" : "Disabled" : typeof snapshot.scheduleEnabled === "boolean" ? snapshot.scheduleEnabled ? "Enabled (legacy schedule status)" : "Disabled (legacy schedule status)" : "Schedule status unavailable"}</strong></p><p>${snapshot.agents.map(agent => esc(agent.name)).join(", ")} run sequentially under the shared worker.</p><p class="muted">Manual launches remain available independently of either schedule when the shared worker is free.</p></div>`;
    element("recorded-schedule").hidden = mode !== "recorded";
    element("simulated-schedule").hidden = mode !== "simulated";
    element("simulated-schedule").querySelector("h3")!.textContent = "Synthetic suites · All registered agents";
  }
  function calibrationHtml(result: CalibrationResult, agentId: string) {
    const verdicts = (values: string[]) => values.map(value => value === "not_checked" ? "Not checked" : value).join(" / ");
    const score = (value: number | null | undefined, absent: string) => value === undefined ? absent
      : value === null ? "Unscored — insufficient evidence" : `${esc(value)}/100`;
    const progress = (value: string | undefined, absent: string) => value === undefined ? absent : esc(value.replace(/_/g, " "));
    const members = (value: string[] | undefined, absent: string) => value === undefined ? absent : esc(value.join(", ") || "None");
    const scoreComparison = agentId !== "tv" ? "<br>Task eval score: N/A for this agent" : result.expectedScore !== undefined || result.actualScore !== undefined
      ? `<br>Task eval score: expected ${score(result.expectedScore, "Not checked")}; actual ${score(result.actualScore, "Unavailable")}` : "";
    const progressComparison = agentId === "tv" && (result.expectedProgress !== undefined || result.actualProgress !== undefined)
      ? `<br>Progress: expected ${progress(result.expectedProgress, "Not checked")}; actual ${progress(result.actualProgress, "Unavailable")}` : "";
    const mistakes = agentId === "tv" && result.expectedSeverities !== undefined
      ? `<br>Mistake severities: expected ${members(result.expectedSeverities, "Not checked")}; actual ${members(result.actualSeverities, "Unavailable")}` : "";
    const gaps = agentId === "tv" && result.expectedBlockingComponents !== undefined
      ? `<br>Blocking components: expected ${members(result.expectedBlockingComponents, "Not checked")}; actual ${members(result.actualBlockingComponents, "Unavailable")}` : "";
    const unchecked = result.expected.includes("not_checked")
      ? "<br><small>Not checked means this reference does not assert that categorical judgment.</small>" : "";
    return `<p>${esc(result.id)} ${badge(result.passed ? "pass" : "fail")} · Task / handling / reporting: expected ${esc(verdicts(result.expected))}; actual ${esc(result.actual ? verdicts(result.actual) : result.error)}${unchecked}${scoreComparison}${progressComparison}${mistakes}${gaps}</p>`;
  }
  class HttpError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  }
  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, { ...init, cache: "no-store", signal: controller.signal });
      const text = await response.text();
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const body: unknown = JSON.parse(text);
          if (body && typeof body === "object" && "error" in body && typeof body.error === "string") message = body.error;
        } catch { /* A proxy can return a non-JSON error page. Keep the HTTP status. */ }
        throw new HttpError(message, response.status);
      }
      return JSON.parse(text) as T;
    } finally { clearTimeout(timeout); }
  }
  type JudgmentKind = "task" | "handling" | "reporting" | "recovery";
  function rate(runs: Run[], kind: JudgmentKind | "assertion") {
    const verdicts = runs.map(run => kind === "assertion"
      ? run.taskAssertion === true ? "pass" : run.taskAssertion === false ? "fail" : "unknown"
      : run.status === "completed" ? run.grade?.[kind].verdict : undefined);
    const passed = verdicts.filter(value => value === "pass").length;
    const failed = verdicts.filter(value => value === "fail").length;
    const known = passed + failed;
    return { passed, failed, known, missing: runs.length - known, value: known ? `${Math.round(passed / known * 100)}%` : "—" };
  }
  const rateNote = (result: ReturnType<typeof rate>) => `${result.passed} passed / ${result.known} known · ${result.missing} excluded`;
  const evalErrors = (runs: Run[]) => runs.filter(run => run.status !== "completed").length;
  const numericScores = (runs: Run[]) => runs.flatMap(run => {
    const score = run.grade?.score;
    return run.agentId === "tv" && run.mode === "recorded" && run.status === "completed" && score?.status === "scored" ? [score.value] : [];
  });
  const meanScore = (scores: number[]) => scores.length ? `${Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length * 10) / 10}` : "—";
  const unscoredCount = (runs: Run[]) => runs.filter(run => run.agentId === "tv" && run.status === "completed" && run.grade?.score?.status === "unscored").length;
  const metric = (label: string, value: string | number, note: string) => `<div class="card"><div class="metric-label">${esc(label)}</div><div class="number">${esc(value)}</div><p class="metric-detail">${esc(note)}</p></div>`;
  function outcomeBar(result: ReturnType<typeof rate>) {
    const total = result.known + result.missing;
    return `<div class="outcome-bar" role="img" aria-label="${result.passed} passed, ${result.failed} failed, ${result.missing} excluded">${total ? `<span class="passed" style="width:${result.passed / total * 100}%"></span><span class="failed" style="width:${result.failed / total * 100}%"></span><span class="missing" style="width:${result.missing / total * 100}%"></span>` : ""}</div>`;
  }
  function renderMetrics(runs: Run[]) {
    const errors = evalErrors(runs);
    if (evaluator === "llm") {
      const kinds: JudgmentKind[] = mode === "recorded" ? ["task", "handling", "reporting"] : ["handling", "reporting", "recovery"];
      const labels = { task: "Task fulfillment", handling: "Handling pass rate", reporting: "Reporting pass rate", recovery: "Recovery pass rate" };
      element("cards").innerHTML = kinds.map(kind => metric(labels[kind], rate(runs, kind).value, rateNote(rate(runs, kind)))).join("")
        + metric("Eval errors", errors, "Evaluation did not finish; not a task verdict.");
    } else if (mode === "simulated") {
      const checks = rate(runs, "assertion");
      element("cards").innerHTML = metric("Assertion pass rate", checks.value, rateNote(checks))
        + metric("Assertions passed", checks.passed, "The final state satisfied the whole request.")
        + metric("Assertions failed", checks.failed, "Outcome not achieved; handling may still pass.")
        + metric("Assertion unavailable", checks.missing, "No saved assertion. Not counted as a failure.");
    } else {
      const scores = numericScores(runs);
      element("cards").innerHTML = metric("Mean TV task score", meanScore(scores), `${scores.length} numeric scores · out of 100 · TV only`)
        + metric("Scored TV runs", scores.length, "Includes zero. Excludes unscored and unavailable.")
        + metric("Unscored TV runs", unscoredCount(runs), "Required evidence missing. Not a zero or eval error.")
        + metric("Eval errors", errors, "No completed score for these attempts.");
    }
    element("sample-note").textContent = `${runs.length} retained ${modeLabel().toLowerCase()} attempts · ${runs.length - errors} completed · ${errors} eval errors. All retained dates; re-evaluations${mode === "simulated" ? ", scheduled, on-demand and confirmation attempts" : ""} count individually. These are not just today's results.`;
  }
  function renderAgentCards() {
    if (!snapshot) return;
    const html = snapshot.agents.map(agent => {
      const runs = snapshot!.runs.filter(run => run.agentId === agent.id && run.mode === mode);
      const errors = evalErrors(runs), primary = rate(runs, evaluator === "code" ? "assertion" : mode === "recorded" ? "task" : "handling");
      const kinds: JudgmentKind[] = mode === "recorded" ? ["task", "handling", "reporting"] : ["handling", "reporting", "recovery"];
      const failed = evaluator === "code" ? primary.failed > 0 : kinds.some(kind => rate(runs, kind).failed > 0);
      const incomplete = evaluator === "code" ? primary.missing > 0
        : runs.some(run => run.status === "completed" && (!run.grade || kinds.some(kind => run.grade?.[kind].verdict === "unknown")));
      let label = evaluator === "code" ? "Independent assertion pass rate" : mode === "recorded" ? "Task fulfillment" : "Handling pass rate";
      let value = primary.value, note = rateNote(primary), bar = outcomeBar(primary);
      let health = !runs.length ? "No evaluations" : errors ? `${errors} eval error${errors === 1 ? "" : "s"}`
        : failed ? "Failures to review" : incomplete ? "Incomplete evidence" : !primary.known ? "No applicable judgments" : "Known checks pass";
      let healthClass = !runs.length ? "" : errors || failed ? "fail" : incomplete || !primary.known ? "unknown" : "pass";
      let facts = evaluator === "llm"
        ? `<div>Reporting<strong>${esc(rate(runs, "reporting").value)}</strong></div><div>${mode === "recorded" ? "Handling" : "Recovery"}<strong>${esc(rate(runs, mode === "recorded" ? "handling" : "recovery").value)}</strong></div>`
        : `<div>Passed / failed<strong>${primary.passed} / ${primary.failed}</strong></div><div>Unavailable<strong>${primary.missing}</strong></div>`;
      const unsupported = evaluator === "code" && mode === "recorded" && agent.id !== "tv";
      if (evaluator === "code" && mode === "recorded") {
        const scores = numericScores(runs), unscored = unscoredCount(runs);
        label = unsupported ? "No numeric rubric" : "Mean task score / 100";
        value = meanScore(scores);
        note = unsupported ? "Recorded code scoring is TV-only. Use LLM-based results for this agent."
          : `${scores.length} scored · ${unscored} unscored · ${runs.length - scores.length - unscored} unavailable / unfinished`;
        bar = "";
        health = unsupported ? "Not applicable" : !runs.length ? "No evaluations" : errors ? `${errors} eval error${errors === 1 ? "" : "s"}`
          : unscored ? "Evidence gaps" : scores.length ? "LLM-informed rubric" : "Scoring unavailable";
        healthClass = unsupported ? "" : errors ? "fail" : unscored ? "unknown" : "";
        facts = `<div>Numeric scores<strong>${scores.length}</strong></div><div>Unscored<strong>${unscored}</strong></div>`;
      }
      return `<article class="agent-card" data-agent-card="${esc(agent.id)}"><span class="health ${healthClass}">${esc(health)}</span><h3>${esc(agent.name)}</h3><div class="metric-label">${esc(label)}</div><div class="number">${esc(value)}</div>${bar}<p class="metric-detail">${esc(note)}</p><div class="agent-facts">${facts}<div>Attempts<strong>${runs.length}</strong></div></div><p class="muted agent-description">${esc(agent.description)}</p><button class="agent-link secondary" data-focus-key="${esc(agent.id)}" data-open-agent="${esc(agent.id)}"${unsupported ? ' data-open-evaluator="llm"' : ""}>${unsupported ? "View LLM-based results" : "View agent results"}</button></article>`;
    }).join("");
    setResultHtml(element("agent-cards"), html);
  }
  function renderExplanation() {
    element("llm-rules").hidden = evaluator !== "llm";
    element("recorded-code-rules").hidden = evaluator !== "code" || mode !== "recorded";
    element("synthetic-code-rules").hidden = evaluator !== "code" || mode !== "simulated";
    const definitions = evaluator === "llm"
      ? [[mode === "recorded" ? "Task fulfillment" : "Handling", mode === "recorded" ? "Was the whole request achieved? Kept separate from good behavior and honest reporting." : "Did the agent act and recover reasonably? Code-based results show the actual scenario outcome."],
        ["Pass rates, not scores", "Passes divided by known passes + failures. Unknown, not applicable and unfinished results are excluded."],
        ["Missing evidence is not failure", "Unknown means evidence cannot settle a judgment. Eval error means execution or grading did not finish."]]
      : mode === "recorded"
        ? [["Code-calculated, LLM-informed", "An LLM assesses progress, mistakes and evidence. Code applies the fixed TV rubric; it does not independently observe the device."],
          ["Outcome first · 0–100", "100 means full fulfillment without deductions. Zero is a real score. Good handling alone does not earn fulfillment credit."],
          ["TV-only, evidence-dependent", "Other agents have LLM judgments, not numeric scores. Unscored means a required evidence component is missing."]]
        : [["Independent final-state check", "Code checks the simulator's actual outcome, not the assistant's success claim or an LLM's opinion."],
          ["Pass / fail, no partial score", "An impossible scenario may fail the outcome check while passing LLM-based handling and truthful reporting."],
          ["Unavailable is not a failure", "Only retained assertions enter the pass rate. A later LLM grading error does not erase a saved code result."]];
    setHtml(element("method-explanation"), `<div class="definition-grid">${definitions.map(([title, explanation]) => `<div><strong>${esc(title)}</strong><p>${esc(explanation)}</p></div>`).join("")}</div>`);
  }
  function provenance(run: Run) {
    if (mode === "simulated" && evaluator === "llm" && run.comparison) {
      const comparison = run.comparison;
      return comparison.baselineCount >= 3
        ? `${comparison.baselineCount} samples<br>Median ${duration(comparison.medianMs)}<br>${esc(comparison.signal || "No alert threshold crossed")} ${esc(comparison.confirmation || "")}`
        : `Collecting baseline (${comparison.baselineCount}/3)`;
    }
    return run.attempt === "scheduled"
      ? `Scheduled${run.scheduledDay ? `<br>${esc(run.scheduledDay)}` : ""}${mode === "recorded" ? "<br><small>Not part of the synthetic baseline</small>" : ""}`
      : run.attempt === "confirmation" ? "Confirmation" : "On demand";
  }
  function renderHistory(runs: Run[]) {
    const code = evaluator === "code";
    const showMetrics = mode === "simulated";
    const columns = code ? mode === "recorded"
      ? ["Task eval score", "Progress", "Deductions", "Reporting ceiling"]
      : ["Independent assertion", "Check scope", "LLM grading", "Duration"]
      : mode === "recorded" ? ["Task fulfillment", "Handling", "Reporting", "Recovery"]
        : ["Handling", "Reporting", "Recovery", "Evidence gaps"];
    const headings = ["Assessed / graded", "Task / scenario", "Attempt", ...columns, "Evaluation status", mode === "simulated" && !code ? "Prior week / provenance" : "Provenance", ...(!code ? ["Duration"] : []), ...(showMetrics ? ["Assistant turns", "Tool calls", "Agent tokens"] : []), "Evidence"];
    element("run-columns").innerHTML = `<tr>${headings.map(label => `<th scope="col">${esc(label)}</th>`).join("")}</tr>`;
    element("trial-metrics-description").hidden = !showMetrics;
    element("history-description").textContent = `${modeLabel()} / ${methodLabel()} only. ${code ? mode === "recorded" ? "TV score calculations use LLM-assessed evidence. Inspect the saved rubric, arithmetic and citations." : "Independent code assertions, including results retained before an LLM grading error. No LLM verdict is substituted for a missing assertion." : mode === "simulated" ? "LLM handling, reporting and recovery judgments. Switch to Code-based for the actual simulator outcome. Timing measures agent wall time, excluding virtual device waits and offline grading; it is not real-device speed." : "Evidence-backed task, handling, reporting and recovery judgments. Switch to Code-based for TV score calculations."}`;
    const html = runs.map(run => {
      const grade = run.status === "completed" ? run.grade : undefined;
      const score = run.agentId === "tv" && run.mode === "recorded" ? grade?.score : undefined;
      const status = run.status === "completed" ? badge("completed") : `${badge("error")}<br><small>${esc(run.error || run.status.replace(/_/g, " "))}</small>`;
      const elapsed = `${duration(run.durationMs)}${showMetrics && runMetrics(run) ? `<br><small>${esc(runMetrics(run)!.stopReason.replace(/_/g, " "))}</small>` : ""}`;
      let cells: string[];
      if (!code) {
        cells = (mode === "recorded" ? ["task", "handling", "reporting", "recovery"] as const : ["handling", "reporting", "recovery"] as const)
          .map(kind => grade ? badge(grade[kind].verdict) : '<span class="muted">Unavailable</span>');
        if (mode === "simulated") cells.push(grade ? esc(grade.gaps.join("; ") || "None reported") : "Unavailable");
      } else if (mode === "recorded") {
        cells = [scoreHtml(run), run.agentId !== "tv" ? "Not applicable" : grade?.scoringAssessment ? esc(progressLabels[grade.scoringAssessment.progress.level]) : "Unavailable",
          score?.status === "scored" ? `${score.totalDeductions} points` : "—",
          score?.status === "scored" ? score.reportingCeiling == null ? "Not applied" : `${score.reportingCeiling}/100` : "—"];
      } else {
        cells = [run.taskAssertion == null ? '<span class="unknown">Assertion unavailable</span><br><small>No assertion retained in this summary. Inspect the saved run.</small>' : badge(run.taskAssertion ? "pass" : "fail"),
          "Whole request / final simulator state", run.status === "grading_error" ? "Grading failed; any saved code result is retained" : run.status === "completed" ? "Completed separately" : "Did not finish", elapsed];
      }
      return `<tr data-run-id="${esc(run.id)}"><td>${esc(date(run.assessedAt))}<br><small>Graded ${esc(date(run.gradedAt))}</small></td><td>${esc(run.request || run.scenarioId || run.id)}<br><small>${esc(run.assessedModel || "Model unknown")}</small></td><td>${esc(run.attempt.replace(/_/g, " "))}</td>${cells.map(cell => `<td>${cell}</td>`).join("")}<td>${status}</td><td>${provenance(run)}</td>${!code ? `<td>${elapsed}</td>` : ""}${showMetrics ? metricCells(run) : ""}<td><button data-focus-key="${esc(run.id)}" data-run="${esc(run.id)}">Inspect</button></td></tr>`;
    }).join("") || `<tr><td colspan="${headings.length}" class="empty-state"><strong>No ${modeLabel().toLowerCase()} evaluations for this agent yet.</strong>${mode === "recorded" ? "Select completed sessions above to evaluate retained evidence." : "Run a synthetic suite above to evaluate controlled scenarios."} Results from the other source stay in their own tab.</td></tr>`;
    setResultHtml(element("runs"), html);
  }
  function renderAlerts() {
    if (!snapshot) return;
    const alerts = snapshot.alerts.filter(alert => !alert.resolvedAt && (agentId === "overview" || (alert.agentId || alert.key.split(":")[0]) === agentId));
    const source = (alert: Snapshot["alerts"][number]) => snapshot!.batches.find(batch => batch.id === alert.batchId)?.mode
      || snapshot!.runs.find(run => alert.runIds.includes(run.id))?.mode
      || snapshot!.jobs?.find(job => job.id === alert.batchId || job.batchId === alert.batchId)?.mode;
    const markup = (alert: Snapshot["alerts"][number]) => `<div class="alert">${esc(alert.message)} <small>${esc(date(alert.createdAt))}</small></div>`;
    const unscoped = alerts.filter(alert => !source(alert));
    const validation = alerts.filter(alert => source(alert) === "calibrate");
    setResultHtml(element("alerts"), (alerts.filter(alert => source(alert) === mode).map(markup).join("") || `No active ${modeLabel().toLowerCase()} alerts.`)
      + (validation.length ? `<h3>Judge validation alerts · Shared across sources</h3>${validation.map(markup).join("")}` : "")
      + (unscoped.length ? `<details data-result-id="unscoped-alerts"><summary data-focus-key="unscoped-alerts">${unscoped.length} additional alerts with unavailable source metadata</summary><p class="muted">These legacy alerts cannot be attributed to Recorded or Synthetic and are not included above.</p>${unscoped.map(markup).join("")}</details>` : ""));
  }
  function render() {
    for (const [prefix, values, selectedValue, panel] of [
      ["source", runModes, mode, "source-panel"], ["evaluator", evaluators, evaluator, "evaluator-panel"], ["agent", agentIds, agentId, "agent-panel"],
    ] as const) {
      for (const value of values) {
        const tab = element<HTMLButtonElement>(`${prefix}-tab-${value}`);
        tab.setAttribute("aria-selected", String(value === selectedValue));
        tab.tabIndex = value === selectedValue ? 0 : -1;
      }
      element(panel).setAttribute("aria-labelledby", `${prefix}-tab-${selectedValue}`);
    }
    const overview = agentId === "overview";
    element("overview").hidden = !overview;
    element("totals-heading").hidden = !overview;
    element("agent-detail").hidden = overview;
    element("simulated-actions").hidden = mode !== "simulated";
    element("recorded-actions").hidden = mode !== "recorded";
    element("judge-section").hidden = evaluator !== "llm";
    element("alerts-section").hidden = evaluator !== "llm";
    element("fidelity-section").hidden = evaluator !== "llm" || mode !== "simulated";
    element("source-description").textContent = mode === "recorded"
      ? "Recorded evaluates completed real sessions from retained evidence. No device actions are replayed. Scores never mix with Synthetic."
      : "Synthetic runs agents in controlled scenarios with simulated tools. No live devices are controlled. Results never mix with Recorded.";
    element("scope-label").textContent = `${modeLabel()} / ${methodLabel()}`;
    renderExplanation();
    if (!snapshot) return;
    const agent = snapshot.agents.find(candidate => candidate.id === agentId);
    element("dashboard-title").textContent = overview ? "Agent overview" : agent?.name || agentId;
    element("dashboard-description").textContent = evaluator === "llm"
      ? mode === "recorded" ? "See task outcomes, action quality and truthful reporting without blending them into one score." : "See how agents handle scenarios, recover and report results. The independent outcome checks live in Code-based."
      : mode === "recorded" ? "TV task scores computed by code from LLM-assessed evidence. Other agents do not have a recorded numeric rubric." : "See which requests reached the expected simulator state, independently of LLM grading.";
    if (agent) {
      element("suite-description").textContent = `Run ${agent.scenarioCount} ${agent.name} scenarios with the current configuration or an alternative deployment. ${agent.description} On-demand results stay outside the daily baseline.`;
      element("judge-description").textContent = `Check ${agent.referenceCount} ${agentId === "tv" ? "reviewed" : "starter"} reference cases for ${agent.name}. ${agentId === "tv" ? "Inspect score, progress, mistake-severity, and evidence-gap agreement alongside categorical labels where available." : "These check categorical judgments; numeric task eval scoring is not applicable for this agent."} Validation is shared across this agent's sources, not a new evaluation of its runs. This is an initial agreement check, not a measured general accuracy claim.`;
      element("recorded-description").textContent = `Select finished ${agent.name} sessions, including assistant errors. ${agentId === "tv" ? "TV runs can supplement retained telemetry with Cosmos evidence. Each evaluation produces LLM judgments and a code-calculated task score when evidence is sufficient." : "This agent uses retained telemetry for manual, categorical evaluation; numeric task eval scoring and the 1 a.m. recorded schedule are TV-only."} Re-evaluations preserve previous attempts.`;
      element("session-selector-title").textContent = `Select recorded ${agent.name} sessions`;
    }
    const agentRuns = snapshot.runs.filter(run => overview || run.agentId === agentId);
    renderMetrics(agentRuns.filter(run => run.mode === mode));
    if (overview) renderAgentCards();
    else renderHistory(agentRuns.filter(run => run.mode === mode));
    element("window").textContent = mode === "simulated" && evaluator === "llm"
      ? `Weekly comparison baseline: ${snapshot.baseline.from} – ${snapshot.baseline.to} · ${snapshot.timezone}. Only comparable scheduled synthetic runs enter that baseline. Dashboard cards include all retained attempts.`
      : `Schedule timezone: ${snapshot.timezone}. Dashboard cards include all retained attempts for this source; they are not a weekly regression baseline.`;
    renderSchedules(); renderAlerts();
    element("fidelity-note").textContent = snapshot.fidelityNote;
    const fidelity = snapshot.fidelity.filter(pair => agentRuns.some(run => run.id === pair.simulatedId));
    const pairs = fidelity.filter(pair => pair.recordedIds.length);
    element("fidelity").innerHTML = pairs.map(pair => `<p>${esc(agentRuns.find(run => run.id === pair.simulatedId)?.scenarioId)} · ${pair.recordedIds.length} comparable recorded runs <button data-pair="${esc(pair.simulatedId)}:${esc(pair.recordedIds[0])}">Compare steps</button></p>`).join("") || `No comparison data yet. ${fidelity.length} synthetic runs currently unmatched.`;
    setResultHtml(element("batches"), snapshot.batches.filter(batch => batch.agentId === agentId && batch.mode === mode).map(batchHtml).join("") || `No ${modeLabel().toLowerCase()} batches for this agent.`);
    setResultHtml(element("calibrations"), snapshot.calibrations.filter(calibration => (calibration.agentId || "tv") === agentId).map(calibration => `<details data-result-id="${esc(calibration.id)}"><summary data-focus-key="${esc(calibration.id)}">${esc(calibration.judgeModel)} · ${badge(calibration.passed ? "pass" : "fail")} · ${esc(date(calibration.createdAt))}</summary>${calibration.results.map(result => calibrationHtml(result, agentId)).join("")}${calibration.limitation ? `<p class="muted">${esc(calibration.limitation)}</p>` : ""}</details>`).join("") || "<p class=muted>The judge has not been validated against the reference cases yet.</p>");
    updateControls();
  }
  function refresh(options: { sessions?: boolean; sources?: boolean } = {}): Promise<void> {
    reloadSessions ||= Boolean(options.sessions);
    retrySources ||= Boolean(options.sources);
    if (refreshing) { refreshAgain = true; return refreshing; }
    element("agent-panel").setAttribute("aria-busy", "true");
    refreshing = (async () => {
      do {
        refreshAgain = false;
        const loadSessions = reloadSessions, forceSources = retrySources, version = mutationVersion;
        reloadSessions = false; retrySources = false;
        try {
          const next = await request<Snapshot>("/api/evals");
          if (version === mutationVersion) {
            snapshot = next;
            if (!sessionsInitialized) busy = next.busy;
            if (element("status").textContent?.startsWith("Dashboard refresh failed:")) element("status").textContent = "";
            render();
          }
        } catch (error) {
          if (version === mutationVersion) {
            element("status").textContent = `Dashboard refresh failed: ${String(error)}. ${snapshot ? "Showing the last loaded results; they may be out of date." : "No evaluation data loaded. Refresh to retry."}`;
            if (!snapshot) element("dashboard-description").textContent = "Evaluation data unavailable. Refresh to retry; missing data is not a zero or a pass.";
            if (!sessionsInitialized) busy = undefined;
          }
        }
        if (sessionsInitialized) {
          if (loadSessions) {
            try {
              const result = await request<import("./types").RecordedSessionsResponse>(`/api/evals/sessions?agentId=${encodeURIComponent(currentAgentId())}${forceSources ? "&refresh=true" : ""}`);
              if (version === mutationVersion) {
                sessions = result.sessions.slice().sort((a, b) => (Date.parse(b.startedAt) - Date.parse(a.startedAt)) || b.sessionId.localeCompare(a.sessionId));
                availableIds = new Set(sessions.map(session => session.sessionId));
                sessions.forEach(session => sessionCache.set(session.sessionId, session));
                metadataKnown = true; metadataError = "";
                element("session-warning").textContent = result.warnings.length ? `Incomplete session list:\n${result.warnings.join("\n")}` : "";
                element("session-warning").hidden = !result.warnings.length;
                element("session-source-retry").hidden = !result.warnings.length;
              }
            } catch (error) {
              if (version === mutationVersion) { metadataKnown = false; metadataError = `Session list unavailable: ${String(error)}. Refresh sessions to retry.`; }
            }
          }
          try {
            const result = await request<StatusResponse>("/api/evals/session-statuses");
            if (!result.statuses || typeof result.statuses !== "object" || typeof result.busy !== "boolean") throw new Error("Invalid evaluation status response");
            if (version === mutationVersion) {
              statuses = result.statuses; statusesKnown = true; statusError = ""; busy = result.busy;
            }
          } catch (error) {
            if (version === mutationVersion) {
              statusesKnown = false; busy = undefined;
              statusError = `Evaluation status unavailable: ${String(error)}. This does not mean these sessions have never been evaluated. Submission is disabled until a successful refresh.`;
            }
          }
          renderSessions(false);
        }
        updateControls();
        if (historySession && detail.open) await loadHistory(historySession, detailVersion, true);
      } while (refreshAgain || reloadSessions || retrySources);
    })().finally(() => { refreshing = undefined; element("agent-panel").setAttribute("aria-busy", "false"); updateControls(); });
    return refreshing;
  }
  async function launch(body: unknown) {
    if (submitting || busy !== false || pendingSubmission) return;
    submitting = true; mutationVersion++; updateControls();
    try {
      element("status").textContent = "Starting offline eval worker…";
      const job = await request<{ id: string }>("/api/evals/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      busy = true;
      element("status").textContent = `Eval job queued: ${job.id}. Results will appear as each run finishes.`;
    } catch (error) { element("status").textContent = `Could not confirm submission: ${String(error)}. Refresh job history before retrying.`; }
    finally { submitting = false; mutationVersion++; await refresh(); }
  }
  function lifecycle(id: string): Evaluation["status"] | undefined {
    if (!statusesKnown) return undefined;
    const evaluation = statuses[id];
    return evaluation?.latestAttempt?.status || evaluation?.status || "not_evaluated";
  }
  function active(id: string) { return ["queued", "running"].includes(lifecycle(id) || ""); }
  function available(id: string) { return availableIds.has(id); }
  function eligible(id: string) { return metadataKnown && statusesKnown && available(id) && sessionCache.get(id)?.agentId === currentAgentId() && !active(id); }
  function setHtml(target: HTMLElement, html: string) { if (target.innerHTML !== html) target.innerHTML = html; }
  function setResultHtml(target: HTMLElement, html: string) {
    const focused = document.activeElement;
    const focusKey = focused instanceof HTMLElement && target.contains(focused) ? focused.dataset.focusKey : undefined;
    const expanded = new Set(Array.from(target.querySelectorAll<HTMLElement>("details[data-result-id][open]"), item => item.dataset.resultId));
    setHtml(target, html);
    target.querySelectorAll<HTMLDetailsElement>("details[data-result-id]").forEach(item => { item.open = expanded.has(item.dataset.resultId); });
    if (focusKey) Array.from(target.querySelectorAll<HTMLElement>("[data-focus-key]")).find(item => item.dataset.focusKey === focusKey)?.focus({ preventScroll: true });
  }
  function judgments(run: RunSummary) {
    if (run.status !== "completed") return `${scoreHtml(run)}<br><span class="muted">LLM judgments unavailable — evaluation did not finish.</span>`;
    return `${scoreHtml(run)}<br>Task ${badge(run.grade?.task.verdict)} · Handling ${badge(run.grade?.handling.verdict)} · Reporting ${badge(run.grade?.reporting.verdict)}`;
  }
  function evaluationHtml(id: string) {
    const evaluation = statuses[id], status = lifecycle(id);
    const attempt = evaluation?.latestAttempt, completed = evaluation?.latestCompleted;
    const previous = !statusesKnown || status !== "evaluated" || Boolean(attempt?.runId && completed && attempt.runId !== completed.id);
    return `<strong>${status ? lifecycleLabels[status] : "Evaluation status unavailable"}</strong>${attempt ? `<br><small>Requested ${esc(nyDate(attempt.requestedAt))}${attempt.startedAt ? `<br>Started ${esc(nyDate(attempt.startedAt))}` : ""}${attempt.finishedAt ? `<br>Finished ${esc(nyDate(attempt.finishedAt))}` : ""}</small>${attempt.error ? `<p class="error">${esc(attempt.error)}</p>` : ""}` : ""}${completed ? `<p>${previous ? `<strong>Previous evaluation${!statusesKnown ? " (last loaded)" : ""}</strong><br>` : ""}${judgments(completed)}<br><small>Graded ${esc(nyDate(completed.gradedAt))}</small></p>` : status === "evaluated" ? "<p>Verdicts unavailable. Inspect attempt history for details.</p>" : ""}`;
  }
  function filterMatches(session: Session) {
    const search = element<HTMLInputElement>("session-search").value.trim().toLocaleLowerCase();
    const from = element<HTMLInputElement>("session-from").value, to = element<HTMLInputElement>("session-to").value;
    const filter = element<HTMLSelectElement>("session-filter").value, day = nyDay(session.startedAt);
    return session.agentId === currentAgentId() && (!search || `${session.userPrompt} ${session.sessionId}`.toLocaleLowerCase().includes(search))
      && (!from || Boolean(day && day >= from)) && (!to || Boolean(day && day <= to))
      && (filter === "all" || lifecycle(session.sessionId) === filter);
  }
  function selectionSummary() {
    const ids = [...selected], hidden = ids.filter(id => !available(id) || !filterMatches(sessionCache.get(id)!)).length;
    element("session-selection-count").textContent = `${ids.length} / ${MAX_SELECTION} selected · ${hidden} hidden by filters or unavailable (selections on other pages are also retained)`;
    if (!statusesKnown) {
      element("session-summary").textContent = `${ids.length} selected. New vs. re-evaluation breakdown unavailable until evaluation status loads.`;
    } else {
      const fresh = ids.filter(id => lifecycle(id) === "not_evaluated" && !(statuses[id]?.attemptCount)).length;
      element("session-summary").textContent = `${ids.length} total selected: ${fresh} new evaluations + ${ids.length - fresh} re-evaluations / retries. All selected sessions, including those hidden by filters or on other pages, are included.`;
    }
  }
  function renderSessions(reconcile = true) {
    if (!sessionsInitialized) return;
    const body = element("session-rows");
    const matches = (reviewSelected ? [...selected].map(id => sessionCache.get(id)!).filter(Boolean) : sessions.filter(filterMatches))
      .sort((a, b) => (Date.parse(b.startedAt) - Date.parse(a.startedAt)) || b.sessionId.localeCompare(a.sessionId));
    const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE));
    page = Math.min(page, pages);
    const next = matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const focusedRow = body.contains(document.activeElement);
    if (reconcile || !focusedRow) {
      displayed = next;
      const visible = new Set(displayed.map(session => session.sessionId));
      for (const [id, row] of rows) if (!visible.has(id)) { row.remove(); rows.delete(id); }
      body.querySelector("[data-empty]")?.remove();
      displayed.forEach((session, index) => {
        let row = rows.get(session.sessionId);
        if (!row) {
          row = document.createElement("tr");
          row.innerHTML = `<td><input type="checkbox" data-select="${esc(session.sessionId)}" aria-label="Select session ${esc(session.sessionId)}"></td><td class="session-request"></td><td></td><td></td><td class="session-evaluation"></td><td><button data-session-history="${esc(session.sessionId)}" aria-label="Evaluation history for ${esc(session.sessionId)}">History</button></td>`;
          rows.set(session.sessionId, row);
        }
        if (body.children[index] !== row) body.insertBefore(row, body.children[index] || null);
      });
      if (!displayed.length) body.innerHTML = `<tr data-empty><td colspan="6">${!metadataKnown ? metadataError ? "Session list could not be loaded. Refresh to retry." : "Loading finished sessions..." : reviewSelected ? "No sessions selected." : "No sessions match these filters."}</td></tr>`;
      deferredRows = false;
    } else deferredRows = true;
    for (const session of displayed) {
      const row = rows.get(session.sessionId);
      if (!row) continue;
      const checkbox = row.querySelector<HTMLInputElement>("input")!;
      checkbox.checked = selected.has(session.sessionId);
      checkbox.disabled = submitting || Boolean(pendingSubmission) || !eligible(session.sessionId) || (!checkbox.checked && selected.size >= MAX_SELECTION);
      checkbox.title = active(session.sessionId) ? "Already queued or running" : !eligible(session.sessionId) ? "Current session state is unavailable" : !checkbox.checked && selected.size >= MAX_SELECTION ? "Maximum 100 selected sessions" : "";
      setHtml(row.cells[1], `${esc(session.userPrompt || "No request recorded")}<small class="session-id">${esc(session.sessionId)}</small>${!available(session.sessionId) ? '<p class="error">Not in the current source list. Refresh sources or remove this selection before running.</p>' : ""}`);
      setHtml(row.cells[2], `${esc(nyDate(session.startedAt))}${session.completedAt ? `<br><small>Finished ${esc(nyDate(session.completedAt))}</small>` : ""}`);
      setHtml(row.cells[3], `${badge(session.status)}<br><small>${esc(session.sources.join(" + ") || "Evidence sources unavailable")}</small>`);
      setHtml(row.cells[4], evaluationHtml(session.sessionId));
    }
    element("session-page-count").textContent = `Page ${page} of ${pages} · ${matches.length} ${reviewSelected ? "selected" : "matching"} sessions · ${PAGE_SIZE} per page`;
    element<HTMLButtonElement>("session-prev").disabled = page <= 1;
    element<HTMLButtonElement>("session-next").disabled = page >= pages;
    const from = element<HTMLInputElement>("session-from").value, to = element<HTMLInputElement>("session-to").value;
    element("session-filter-note").textContent = from && to && from > to ? "Start date must be on or before end date." : reviewSelected ? "Review selected ignores search and filters so you can review every selection. Return to all sessions to apply filters again." : "Select this page affects only the eligible sessions displayed here, not other pages.";
    const errors = [metadataError, statusError].filter(Boolean).join("\n");
    element("session-state-error").textContent = errors;
    element("session-state-error").hidden = !errors;
    selectionSummary(); updateControls();
  }
  function updateControls() {
    const frozen = submitting || Boolean(pendingSubmission);
    for (const id of agentIds) element<HTMLButtonElement>(`agent-tab-${id}`).disabled = frozen;
    document.querySelectorAll<HTMLButtonElement>("[data-open-agent]").forEach(button => { button.disabled = frozen; });
    element<HTMLButtonElement>("simulate").disabled = agentId === "overview" || frozen || busy !== false;
    element<HTMLButtonElement>("calibrate").disabled = agentId === "overview" || frozen || busy !== false;
    element<HTMLButtonElement>("recorded").disabled = agentId === "overview" || submitting;
    element("global-busy").textContent = pendingSubmission
      ? "A recorded submission is uncertain. Agent selection is locked to prevent duplicate paid grading. Open Recorded → Select sessions to confirm the same batch."
      : busy === true ? "An offline eval worker is busy. You can browse results and select sessions; new submissions are disabled until it finishes."
        : busy === undefined ? "Checking worker availability. New submissions are disabled until its state is known." : "";
    const candidates = displayed.filter(session => eligible(session.sessionId));
    const pageSelect = element<HTMLInputElement>("session-page-select");
    const chosen = candidates.filter(session => selected.has(session.sessionId)).length;
    pageSelect.checked = candidates.length > 0 && chosen === candidates.length;
    pageSelect.indeterminate = chosen > 0 && chosen < candidates.length;
    pageSelect.disabled = frozen || !candidates.length || (selected.size >= MAX_SELECTION && chosen === 0);
    element<HTMLButtonElement>("session-clear").disabled = frozen || !selected.size;
    element("session-review").setAttribute("aria-pressed", String(reviewSelected));
    element("session-review").textContent = reviewSelected ? "Back to all sessions" : "Review selected";
    element("session-busy").textContent = busy === true
      ? pendingSubmission ? "The worker is busy. Retry submission only to confirm the same uncertain batch; this will not create a second batch." : "The eval worker is busy. Your selections are preserved; Run will become available when it is free."
      : busy === undefined ? "Worker state is unknown; submission is disabled." : "";
    const blocked = [...selected].some(id => !eligible(id));
    const run = element<HTMLButtonElement>("session-run");
    run.disabled = submitting || !metadataKnown || !statusesKnown || busy === undefined || (!pendingSubmission && (busy || !selected.size || blocked));
    run.textContent = submitting ? "Submitting..." : pendingSubmission ? "Retry submission (same batch)" : "Run selected evaluations";
    if (!pendingSubmission && selected.size && blocked && metadataKnown && statusesKnown) {
      element("session-busy").textContent += " Some selected sessions are queued, running, or no longer in the source list. Review or clear them before submitting.";
    }
  }
  async function submitSelected() {
    if (element<HTMLButtonElement>("session-run").disabled || submitting) return;
    const wasUncertain = Boolean(pendingSubmission);
    submitting = true; renderSessions(false);
    try {
      await refresh();
      if (!metadataKnown || !statusesKnown || busy === undefined) throw new Error("Current state is unavailable. Refresh before submitting.");
      if (!pendingSubmission) {
        if (busy || !selected.size || [...selected].some(id => !eligible(id))) throw new Error("The worker or selected sessions are no longer available. Your selection is preserved.");
        pendingSubmission = { agentId: currentAgentId(), sessionIds: [...selected].sort(), requestId: crypto.randomUUID() };
      }
      mutationVersion++;
      element("session-message").textContent = "Submitting selected sessions...";
      const job = await request<import("./worker").EvalJob>("/api/evals/jobs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "recorded", ...pendingSubmission }),
      });
      if (!job.id) throw new Error("Submission response did not identify the accepted job");
      pendingSubmission.sessionIds.forEach(id => selected.delete(id));
      pendingSubmission = undefined;
      const finished = job.status === "completed" || job.status === "failed";
      busy = finished ? undefined : true; statusesKnown = false;
      const message = job.status === "completed"
        ? `Batch already completed: ${job.id}. No additional batch was started. Open session history to inspect the saved results.`
        : job.status === "failed"
          ? `Batch already failed: ${job.id}.${job.error ? ` ${job.error}` : ""} No additional batch was started. Open session history for completed results and attempt errors; select sessions again for an intentional retry.`
          : `Batch accepted: ${job.id}. Results update as each session finishes. Closing the dialog or page does not cancel the worker.`;
      element("session-message").textContent = message;
      element("status").textContent = message;
    } catch (error) {
      const rejected = error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 408;
      // A later rejection cannot prove that an earlier, uncertain request was not accepted.
      if (rejected && !wasUncertain) pendingSubmission = undefined;
      element("session-message").textContent = pendingSubmission
        ? `Submission outcome is uncertain: ${String(error)}. Selections are locked to avoid accidental duplicate paid grading. Use Retry submission to confirm this exact batch with the same request ID.`
        : `Submission failed: ${String(error)}. Your selection is preserved.`;
    } finally {
      submitting = false; mutationVersion++;
      renderSessions(false); await refresh();
    }
  }
  function evidenceHtml(run: Run, ids?: string[]) {
    return (run.assessment?.evidence || []).filter(e => !ids || ids.includes(e.id)).map(e => `<details${ids ? "" : ` id="evidence-${esc(encodeURIComponent(e.id))}"`}><summary>${esc(e.id)} · ${esc(e.toolName || e.kind)} · ${e.durationMs == null ? "" : duration(e.durationMs)}</summary><pre>${esc(JSON.stringify({ ...e, image: undefined }, null, 2))}</pre>${e.image?.startsWith("data:image/") ? `<img alt="Evidence ${esc(e.id)}" src="${esc(e.image)}">` : ""}</details>`).join("");
  }
  function diagnosticsHtml(run: Run) {
    const metrics = runMetrics(run);
    const counts: Array<[string, number | undefined]> = [
      ["User turns", metrics?.userTurns], ["Assistant turns", metrics?.assistantTurns],
      ["Model requests", metrics?.modelRequests], ["Model errors", metrics?.modelErrors],
      ["Tool calls", metrics?.toolCalls], ["Tool executions", metrics?.toolExecutions],
      ["Tool failures", metrics?.toolErrors], ["Rejected tool calls", metrics?.rejectedToolCalls],
      ["Unexecuted tool calls", metrics?.unexecutedToolCalls], ["Completion signals", metrics?.completionCalls],
    ];
    const timings: Array<[string, number | undefined]> = [
      ["Agent wall time", run.durationMs], ["Model request time", metrics?.modelTimeMs],
      ["Simulated tool time", metrics?.toolTimeMs], ["First complete response", metrics?.timeToFirstResponseMs],
      ["Offline grading time", run.gradingDurationMs], ["Evaluation time", run.evaluationDurationMs],
    ];
    if (metrics?.virtualDeviceTimeMs !== undefined) timings.push(["Virtual device waits", metrics.virtualDeviceTimeMs]);
    const usages: Array<[string, import("./types").Usage | undefined]> = [
      ["Assessed agent", agentUsage(run)], ["Offline judge", run.judgeUsage],
    ];
    return `<section aria-label="Trial diagnostics"><h3>Trial diagnostics</h3>${metrics ? `<p><strong>Stop reason:</strong> ${esc(metrics.stopReason.replace(/_/g, " "))} · Metrics v${esc(metrics.version)}${run.status === "execution_error" ? " · Partial trace retained; execution did not finish." : ""}</p>` : '<p class="unknown">Trial metrics unavailable for this evaluation. Older and recorded evaluations are not backfilled.</p>'}<div class="two"><dl class="score-calculation">${counts.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${metricNumber(value)}</dd>`).join("")}</dl><dl class="score-calculation">${timings.map(([label, value]) => `<dt>${esc(label)}</dt><dd>${latency(value)}</dd>`).join("")}</dl></div><div class="scroll"><table class="token-usage"><caption>Token usage by role</caption><thead><tr><th>Role</th><th>Input</th><th>Output</th><th>Total</th><th>Cache read</th><th>Reasoning</th></tr></thead><tbody>${usages.map(([label, usage]) => `<tr><th scope="row">${esc(label)}</th>${(["inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "reasoningTokens"] as const).map(key => `<td>${metricNumber(usage?.[key])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${metrics ? `<p>Token usage reported for ${metricNumber(metrics.usageReportedResponses)} / ${metricNumber(metrics.assistantTurns)} returned responses. Requests without a reported response also make total usage unavailable.</p>` : ""}<p class="muted">An assistant turn is a model response, not a user message. Tool calls include completion signals and rejected requests; only tool executions reached a simulator. Cache-read and reasoning tokens are subsets of input and output, not additional tokens. Missing usage is unavailable, not zero. Cost is unavailable because deployment pricing is not configured.</p><p class="muted">Agent wall time excludes offline grading. Model time covers provider requests; tool time is simulator wall time, not live device latency. First complete response is not time to first token. Virtual waits are not added to measured wall time. Efficiency metrics do not change task-quality judgments.</p><a id="trial-download" download="${esc(run.id)}.json">Download trial JSON</a></section>`;
  }
  function traceHtml(run: Run) {
    const trace = run.assessment?.trace;
    if (!trace) return '<h3>Model and tool trace</h3><p class="muted">Structured trace unavailable for this evaluation. Inspect the retained source evidence below.</p>';
    return `<section aria-label="Model and tool trace"><h3>Model and tool trace</h3><p class="muted">Requests are ordered within this trial. Offsets start at trial execution; response IDs identify provider calls. Repeated calls remain visible, including rejections and incomplete execution.</p>${trace.modelCalls.map(call => `<details class="model-call"${call.status === "error" ? " open" : ""}><summary>${esc(call.id)} · User turn ${metricNumber(call.userTurn)} · ${esc(call.model || "Model unavailable")} · ${latency(call.durationMs)} · ${badge(call.status)}</summary><p>Started at +${latency(call.offsetMs)}${call.error ? `<br><span class="error">${esc(call.error)}</span>` : ""}</p>${call.responses.map(response => `<details class="model-response"><summary>Assistant turn ${metricNumber(response.turn)} · ${esc(response.responseId || "Response ID unavailable")} · ${esc(response.finishReason || "Finish reason unavailable")} · ${metricNumber(response.usage?.totalTokens)} tokens</summary><pre>${esc(JSON.stringify(response, null, 2))}</pre></details>`).join("") || "<p>No complete model response was retained.</p>"}${call.partialText ? `<p>Partial streamed text:</p><pre>${esc(call.partialText)}</pre>` : ""}${trace.toolCalls.filter(tool => tool.modelCallId === call.id).map(tool => `<details class="tool-call"${tool.status === "error" || tool.status === "rejected" ? " open" : ""}><summary>${esc(tool.name)} · ${esc(tool.toolCallId)} · ${badge(tool.status)} · ${tool.executed ? latency(tool.durationMs) : "Not executed"}</summary><p>Assistant turn ${metricNumber(tool.turn)} · +${latency(tool.offsetMs)}${tool.error ? `<br><span class="error">${esc(tool.error)}</span>` : ""}</p><pre>${esc(JSON.stringify({ arguments: tool.arguments, result: tool.result }, null, 2))}</pre></details>`).join("")}</details>`).join("") || "<p>No model requests started.</p>"}<details class="trial-transcript"><summary>Full retained transcript</summary><pre>${esc(JSON.stringify({ systemMessages: trace.systemMessages, messages: trace.messages }, null, 2))}</pre></details></section>`;
  }
  function citations(ids: string[]) {
    return ids.length ? `<small>Evidence: ${ids.map(id => `<a href="#evidence-${esc(encodeURIComponent(id))}" data-evidence="${esc(id)}">${esc(id)}</a>`).join(", ")}</small>` : "<small>No evidence cited.</small>";
  }
  function scoreDetails(run: Run) {
    if (run.agentId !== "tv") return `<h3>Task eval score calculation</h3><p>${scoreHtml(run)}</p>`;
    const score = run.grade?.score, assessment = run.grade?.scoringAssessment;
    const intro = '<h3>Code-calculated task eval score</h3><p class="muted">Code applies a fixed rubric to LLM-assessed progress, mistakes and evidence. This is not an independent device check. It measures outcome-first task fulfillment, not a probability or confidence estimate. Handling, reporting, elapsed time, and model cost remain separate.</p>';
    if (run.mode !== "recorded" || run.status !== "completed" || !score) return `${intro}<p>${scoreHtml(run)}</p>`;
    const components: import("./types").ScoringComponent[] = ["progress", "execution", "reporting"];
    const assessmentHtml = assessment ? `<h4>Progress assessment</h4><p><strong>${esc(progressLabels[assessment.progress.level])}</strong>: ${esc(assessment.progress.reason)}<br>${citations(assessment.progress.evidenceIds)}</p><h4>Evidence sufficiency</h4><ul>${components.map(component => {
      const evidence = assessment.evidence[component];
      return `<li><strong>${esc(component)}: ${evidence.sufficient ? "Sufficient" : "Blocking gap"}</strong> — ${esc(evidence.reason)}<br>${citations(evidence.evidenceIds)}</li>`;
    }).join("")}</ul>` : "<p>Detailed scoring assessment unavailable for this evaluation.</p>";
    const gaps = run.grade?.gaps.length ? `<h4>Retained evidence gaps</h4><ul>${run.grade.gaps.map(gap => `<li>${esc(gap)}</li>`).join("")}</ul>` : "";
    if (score.status === "unscored") {
      return `${intro}<p>${scoreHtml(run)}</p><p>Rubric version: <code>${esc(score.rubricVersion)}</code></p><p><strong>Blocking components:</strong> ${esc(score.blockingComponents.join(", "))}. No numeric score was assigned.</p>${assessmentHtml}${gaps}`;
    }
    return `${intro}<p>${scoreHtml(run)}</p><p>Rubric version: <code>${esc(score.rubricVersion)}</code></p><dl class="score-calculation"><dt>Starting score</dt><dd>${esc(score.baseScore)}</dd><dt>Mistake deductions</dt><dd>${esc(score.totalDeductions)} points</dd><dt>Before task band</dt><dd>${esc(score.baseScore)} − ${esc(score.totalDeductions)} = ${esc(score.baseScore - score.totalDeductions)}</dd><dt>Task fulfillment band</dt><dd>${esc(score.band.min)}–${esc(score.band.max)}</dd><dt>After band limits</dt><dd>${esc(score.bandAdjustedScore)}</dd><dt>Reporting ceiling</dt><dd>${score.reportingCeiling == null ? "Not applied" : `${esc(score.reportingCeiling)}/100 — final score cannot exceed this ceiling`}</dd><dt>Final task eval score</dt><dd>${esc(score.value)}/100</dd></dl><h4>Distinct mistake episodes</h4>${score.deductions.length ? `<ul>${score.deductions.map(mistake => `<li><strong>${esc(mistake.id)} · ${esc(mistake.severity)} · −${esc(mistake.points)} points</strong><br>${esc(mistake.reason)}<br>${citations(mistake.evidenceIds)}</li>`).join("")}</ul>` : "<p>No assessed mistake deductions.</p>"}${score.reportingCeiling == null ? "" : `<h4>Reporting ceiling reason</h4><p>${esc(run.grade?.reporting.reason)}<br>${citations(run.grade?.reporting.evidenceIds || [])}</p>`}${assessmentHtml}${gaps}`;
  }
  function assertionDetails(run: Run) {
    if (run.mode !== "simulated") return "";
    const assertion = run.assessment?.taskAssertion;
    return `<section aria-label="Independent code assertion"><h3>Independent code assertion</h3><p>Checks the complete request against the simulator's final state. The LLM does not decide this result.</p><p>${assertion == null ? "No independent assertion was retained for this run." : `${badge(assertion ? "pass" : "fail")} ${citations((run.assessment?.evidence || []).filter(item => item.kind === "assertion").map(item => item.id))}`}</p>${run.status === "grading_error" ? "<p>LLM grading failed. Any saved code assertion above is still the independent outcome.</p>" : ""}</section>`;
  }
  function judgmentDetails(run: Run) {
    const grade = run.status === "completed" ? run.grade : undefined;
    if (!grade) return '<section aria-label="LLM-based judgments"><h3>LLM-based judgments</h3><p>No completed LLM judgments are available for this evaluation.</p></section>';
    const labels = { task: run.mode === "simulated" ? "Task outcome (code-constrained)" : "Task fulfillment", handling: "Handling", reporting: "Reporting", recovery: "Recovery" };
    return `<section aria-label="LLM-based judgments"><h3>LLM-based judgments</h3>${run.mode === "simulated" ? '<p class="muted">The simulator assertion fixes task fulfillment when retained; the LLM assesses handling, reporting and recovery.</p>' : ""}<div class="two">${(["task", "handling", "reporting", "recovery"] as const).map(kind => `<div><h4>${labels[kind]} ${badge(grade[kind].verdict)}</h4><p>${esc(grade[kind].reason)}<br>${citations(grade[kind].evidenceIds)}</p></div>`).join("")}</div></section>`;
  }
  function openDetail(title: string) {
    clearDetailDownload();
    detailVersion++;
    historySession = undefined; historyMarkup = undefined;
    element("detail-title").textContent = title;
    element("detail-body").innerHTML = '<p role="status">Loading...</p>';
    if (selector.open) { returnToSelection = true; selector.close(); }
    if (!detail.open) detail.showModal();
    return detailVersion;
  }
  function clearDetailDownload() {
    if (detailDownloadUrl) URL.revokeObjectURL(detailDownloadUrl);
    detailDownloadUrl = undefined;
  }
  function historyLink(id?: string) {
    return id ? `<p><button data-session-history="${esc(id)}">Back to session attempt history</button></p>` : "";
  }
  async function inspect(id: string, sessionId?: string) {
    const version = openDetail("Evaluation details");
    try {
      const run = await request<Run>(`/api/evals/runs/${encodeURIComponent(id)}`);
      if (version !== detailVersion || !detail.open) return;
      const sourceSessionId = sessionId || run.sourceSessionId || run.assessment?.sourceSessionId;
      element("detail-body").innerHTML = `${historyLink(sourceSessionId)}<h3>${esc(run.assessment?.request || run.id)}</h3><p>${esc(run.assessment?.finalResponse || "")}</p><p class="muted">${esc(run.mode === "recorded" ? "Recorded" : "Synthetic")} · ${esc(run.agentId)} · ${esc(run.status.replace(/_/g, " "))}</p>${run.error ? `<p class="error" role="alert">${esc(run.error)}</p>` : ""}${diagnosticsHtml(run)}${assertionDetails(run)}<section aria-label="Task eval score breakdown">${scoreDetails(run)}</section>${judgmentDetails(run)}<details><summary>Run metadata and model usage</summary><pre>${esc(JSON.stringify({ agentId: run.agentId, status: run.status, assessedAt: run.assessedAt, gradedAt: run.gradedAt, durationMs: run.durationMs, sourceSessionId, coverage: run.assessment?.coverage, model: run.assessedModel, promptVersion: run.promptVersion, judge: run.judgeModel, graderVersion: run.graderVersion, usage: run.assessment?.usage, judgeUsage: run.judgeUsage }, null, 2))}</pre></details>${traceHtml(run)}<details><summary>Full judgments and scoring data</summary><pre>${esc(JSON.stringify(run.grade, null, 2))}</pre></details><h3>Source evidence</h3>${evidenceHtml(run)}`;
      detailDownloadUrl = URL.createObjectURL(new Blob([JSON.stringify(run, null, 2)], { type: "application/json" }));
      element<HTMLAnchorElement>("trial-download").href = detailDownloadUrl;
    } catch (error) {
      if (version === detailVersion && detail.open) element("detail-body").innerHTML = `${historyLink(sessionId)}<p class="error" role="alert">Could not load this evaluation: ${esc(String(error))}</p><button data-run="${esc(id)}"${sessionId ? ` data-history-session="${esc(sessionId)}"` : ""}>Retry inspection</button>`;
    }
  }
  async function openHistory(id: string) {
    const version = openDetail("Session evaluation history");
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
      element("detail-body").innerHTML = '<p class="error" role="alert">Invalid or missing session ID in this link. Select a session from the recorded session dialog instead.</p>';
      return;
    }
    historySession = id;
    await loadHistory(id, version);
  }
  async function loadHistory(id: string, version: number, polling = false) {
    if (polling && historyLoading) return;
    historyLoading = true;
    try {
      const result = await request<History>(`/api/evals/sessions/${encodeURIComponent(id)}/history`);
      if (version !== detailVersion || !detail.open || historySession !== id) return;
      const attempts = result.attempts.map((attempt, index) => {
        const runId = attempt.runId || attempt.run?.id;
        const pending = attempt.status === "queued" || attempt.status === "running";
        const noRun = (attempt.agentId || currentAgentId()) === "tv"
          ? pending ? "Verdicts and task eval score are not available yet." : "No completed task eval score. No saved run summary is available for this attempt. This is not a passing evaluation."
          : `Task eval score: N/A for this agent. ${pending ? "Verdicts are not available yet." : "No saved run summary is available for this attempt. This is not a passing evaluation."}`;
        return `<section><h3>${index > 0 && attempt.status === "evaluated" ? "Previous evaluation · " : ""}${esc(lifecycleLabels[attempt.status])}</h3><p>Requested ${esc(nyDate(attempt.requestedAt))}${attempt.startedAt ? `<br>Started ${esc(nyDate(attempt.startedAt))}` : ""}${attempt.finishedAt ? `<br>Finished ${esc(nyDate(attempt.finishedAt))}` : ""}</p><small>Attempt ${esc(attempt.id)} · Job ${esc(attempt.jobId)}</small>${attempt.error ? `<p class="error" role="alert">${esc(attempt.error)}</p>` : ""}${attempt.run ? `<p>${judgments(attempt.run)}<br><small>Graded ${esc(nyDate(attempt.run.gradedAt))} · Judge ${esc(attempt.run.judgeModel)} · Grader ${esc(attempt.run.graderVersion)}</small></p>${attempt.run.error && attempt.run.error !== attempt.error ? `<p class="error">${esc(attempt.run.error)}</p>` : ""}` : `<p class="muted">${noRun}</p>`}${runId ? `<button data-run="${esc(runId)}" data-history-session="${esc(id)}">Inspect</button>` : "<p class=muted>No run was saved for this attempt.</p>"}</section>`;
      }).join("");
      historyMarkup = `<p class="session-id">Session ${esc(id)}</p><p class="muted">Newest attempts first. Re-evaluations preserve earlier results and each run's evidence snapshot. All timestamps use America/New_York.</p><div id="history-refresh-error" role="alert"></div>${attempts || '<p>No evaluation attempts have been recorded for this session.</p>'}<button data-session-history="${esc(id)}">Refresh history</button>`;
      if (!polling || !element("detail-body").contains(document.activeElement)) setHtml(element("detail-body"), historyMarkup);
      else {
        const error = document.getElementById("history-refresh-error");
        if (error) error.textContent = "";
      }
    } catch (error) {
      if (version !== detailVersion || !detail.open || historySession !== id) return;
      const message = `Could not load session history: ${String(error)}. This is not evidence that the session has never been evaluated.`;
      const notice = document.getElementById("history-refresh-error");
      if (notice) notice.textContent = message;
      else element("detail-body").innerHTML = `<p class="session-id">Session ${esc(id)}</p><p class="error" role="alert">${esc(message)}</p><button data-session-history="${esc(id)}">Retry history</button>`;
      historyMarkup = undefined;
    } finally { if (version === detailVersion) historyLoading = false; }
  }
  async function pair(ids: string[]) {
    const version = openDetail("Synthetic and recorded comparison");
    let runs: Run[];
    try { runs = await Promise.all(ids.map(id => request<Run>(`/api/evals/runs/${encodeURIComponent(id)}`))); }
    catch (error) {
      if (version === detailVersion && detail.open) element("detail-body").innerHTML = `<p class="error" role="alert">Could not load comparison: ${esc(String(error))}</p><button data-pair="${esc(ids.join(":"))}">Retry comparison</button>`;
      return;
    }
    if (version !== detailVersion || !detail.open) return;
    const [a, b] = runs;
    const groups = new Set([...(a.grade?.steps || []), ...(b.grade?.steps || [])].map(s => s.groupId));
    element("detail-body").innerHTML = `<h2>Synthetic ↔ recorded task comparison</h2><div class="two"><div><h3>Synthetic</h3>${esc(a.assessment?.request)}<p>${esc(a.assessment?.finalResponse)}</p>${badge(a.grade?.task.verdict)}</div><div><h3>Recorded</h3>${esc(b.assessment?.request)}<p>${esc(b.assessment?.finalResponse)}</p>${badge(b.grade?.task.verdict)}</div></div>` + [...groups].map(id => {
      const left = a.grade?.steps.find(s => s.groupId === id), right = b.grade?.steps.find(s => s.groupId === id);
      return `<h3>${esc(left?.objective || right?.objective)}</h3><div class="two">${[[a, left], [b, right]].map(([run, step]) => {
        const s = step as import("./types").StepGrade | undefined;
        return `<div>${badge(s?.verdict)} ${s?.alreadySatisfied ? "Already satisfied" : ""}<p>${esc(s?.reason || "No matching step")}</p>${s ? evidenceHtml(run as Run, s.evidenceIds) : ""}</div>`;
      }).join("")}</div>`;
    }).join("");
  }
  element("simulate").onclick = () => { void launch({ mode: "simulated", agentId: currentAgentId(), ...(element<HTMLInputElement>("model").value.trim() ? { model: element<HTMLInputElement>("model").value.trim() } : {}) }); };
  element("recorded").onclick = () => {
    sessionsInitialized = true;
    selector.showModal(); renderSessions();
    void refresh({ sessions: true });
  };
  element("calibrate").onclick = () => { void launch({ mode: "calibrate", agentId: currentAgentId() }); };
  element("refresh").onclick = () => { void refresh({ sessions: sessionsInitialized }); };
  function updateLocation() {
    const url = new URL(location.href);
    url.searchParams.set("mode", mode);
    url.searchParams.set("evaluator", evaluator);
    if (agentId === "overview") url.searchParams.delete("agentId");
    else url.searchParams.set("agentId", agentId);
    url.searchParams.delete("sessionId");
    history.replaceState(null, "", url);
  }
  function changeAgent(next: string) {
    if (next === agentId || !agentIds.includes(next) || submitting || pendingSubmission) return;
    mutationVersion++;
    agentId = next;
    selected = selectionsByAgent.get(currentAgentId()) || new Set<string>();
    selectionsByAgent.set(currentAgentId(), selected);
    page = 1; reviewSelected = false; sessions = []; availableIds.clear(); metadataKnown = false; metadataError = "";
    if (next === "overview") sessionsInitialized = false;
    element("session-warning").hidden = true; element("session-source-retry").hidden = true;
    element("session-message").textContent = "";
    updateLocation(); render(); renderSessions();
    void refresh({ sessions: sessionsInitialized });
  }
  function bindTabs<T extends string>(prefix: string, values: readonly T[], onSelect: (value: T) => void) {
    values.forEach(value => {
      const tab = element<HTMLButtonElement>(`${prefix}-tab-${value}`);
      tab.onclick = () => { onSelect(value); };
      tab.onkeydown = event => {
        const tabs = values.map(id => element<HTMLButtonElement>(`${prefix}-tab-${id}`)).filter(button => !button.disabled);
        const index = tabs.indexOf(tab);
        let next: number;
        switch (event.key) {
          case "ArrowRight": next = (index + 1) % tabs.length; break;
          case "ArrowLeft": next = (index + tabs.length - 1) % tabs.length; break;
          case "Home": next = 0; break;
          case "End": next = tabs.length - 1; break;
          default: return;
        }
        event.preventDefault();
        tabs[next]?.focus(); tabs[next]?.click();
      };
    });
  }
  bindTabs("source", runModes, next => { mode = next; updateLocation(); render(); });
  bindTabs("evaluator", evaluators, next => { evaluator = next; updateLocation(); render(); });
  bindTabs("agent", agentIds, changeAgent);
  document.querySelector<HTMLAnchorElement>('.guide-link')!.onclick = () => { element<HTMLDetailsElement>("scoring-guide").open = true; };
  element("close").onclick = () => detail.close();
  detail.addEventListener("close", () => {
    clearDetailDownload();
    detailVersion++; historySession = undefined; historyMarkup = undefined; historyLoading = false;
    if (returnToSelection) { returnToSelection = false; selector.showModal(); renderSessions(); }
  });
  element("session-close").onclick = () => selector.close();
  element("session-refresh").onclick = () => { void refresh({ sessions: true }); };
  element("session-source-retry").onclick = () => { void refresh({ sessions: true, sources: true }); };
  element("session-run").onclick = () => { void submitSelected(); };
  for (const id of ["session-search", "session-from", "session-to", "session-filter"]) {
    element(id).addEventListener(id === "session-search" ? "input" : "change", () => { page = 1; renderSessions(); });
  }
  element("session-prev").onclick = () => { page--; renderSessions(); };
  element("session-next").onclick = () => { page++; renderSessions(); };
  element("session-review").onclick = () => { reviewSelected = !reviewSelected; page = 1; renderSessions(); };
  element("session-clear").onclick = () => {
    if (submitting || pendingSubmission) return;
    selected.clear(); element("session-message").textContent = ""; renderSessions();
  };
  element("session-page-select").onchange = () => {
    if (submitting || pendingSubmission) return;
    const checked = element<HTMLInputElement>("session-page-select").checked;
    const candidates = displayed.filter(session => eligible(session.sessionId));
    let limited = false;
    for (const session of candidates) {
      if (!checked) selected.delete(session.sessionId);
      else if (selected.size < MAX_SELECTION) selected.add(session.sessionId);
      else if (!selected.has(session.sessionId)) limited = true;
    }
    element("session-message").textContent = limited ? "Maximum 100 sessions per batch. Only displayed sessions that fit within the remaining selection capacity were added." : "";
    renderSessions(false);
  };
  element("session-rows").addEventListener("change", event => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.select || submitting || pendingSubmission) return;
    const id = input.dataset.select;
    if (input.checked && eligible(id) && selected.size < MAX_SELECTION) selected.add(id);
    else if (!input.checked) selected.delete(id);
    renderSessions(false);
  });
  element("session-rows").addEventListener("focusout", () => {
    setTimeout(() => { if (deferredRows && !element("session-rows").contains(document.activeElement)) renderSessions(); }, 0);
  });
  element("detail-body").addEventListener("focusout", () => {
    setTimeout(() => {
      if (historySession && historyMarkup && !element("detail-body").contains(document.activeElement)) setHtml(element("detail-body"), historyMarkup);
    }, 0);
  });
  document.addEventListener("click", event => {
    if (!(event.target instanceof Element)) return;
    const agentButton = event.target.closest<HTMLButtonElement>("button[data-open-agent]");
    if (agentButton) {
      if (agentButton.disabled) return;
      if (agentButton.dataset.openEvaluator === "llm") evaluator = "llm";
      changeAgent(agentButton.dataset.openAgent!);
      element("agent-panel").focus();
      return;
    }
    const citation = event.target.closest<HTMLAnchorElement>("a[data-evidence]");
    if (citation) {
      event.preventDefault();
      const evidence = document.getElementById(`evidence-${encodeURIComponent(citation.dataset.evidence!)}`) as HTMLDetailsElement | null;
      if (evidence) {
        evidence.open = true;
        evidence.querySelector("summary")?.focus();
        evidence.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    const button = event.target.closest<HTMLButtonElement>("button[data-run],button[data-pair],button[data-session-history]");
    if (button) void (button.dataset.sessionHistory ? openHistory(button.dataset.sessionHistory)
      : button.dataset.run ? inspect(button.dataset.run, button.dataset.historySession) : pair(button.dataset.pair!.split(":")));
  });
  const params = new URLSearchParams(location.search);
  const requestedAgent = params.get("agentId") || (params.has("sessionId") ? "tv" : undefined);
  if (requestedAgent && agentIds.includes(requestedAgent)) {
    agentId = requestedAgent;
    selected = selectionsByAgent.get(requestedAgent) || new Set<string>();
    selectionsByAgent.set(requestedAgent, selected);
  }
  if (params.get("mode") === "simulated") mode = "simulated";
  if (params.get("evaluator") === "code") evaluator = "code";
  if (params.has("sessionId")) {
    mode = "recorded";
    sessionsInitialized = true;
    void openHistory(params.get("sessionId") || "");
  }
  render(); updateControls(); void refresh();
  setInterval(() => { if (!document.hidden && !refreshing) void refresh(); }, 5_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
})();
