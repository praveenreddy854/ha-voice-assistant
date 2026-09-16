(() => {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const esc = (value: unknown) => String(value ?? "—").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  type Run = import("./types").EvalRun & { request?: string; verdict: string };
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
  type Snapshot = { runs: Run[]; batches: import("./types").EvalBatch[]; alerts: import("./types").EvalAlert[]; busy: boolean;
    baseline: { from: string; to: string }; timezone: string; scheduleEnabled: boolean; schedules?: Schedules; fidelityNote: string;
    fidelity: { simulatedId: string; recordedIds: string[]; status: string }[];
    calibrations: { id: string; judgeModel: string; createdAt: string; passed: boolean; results: CalibrationResult[] }[] };
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
  const selected = new Set<string>();
  const rows = new Map<string, HTMLTableRowElement>();
  let page = 1, reviewSelected = false, deferredRows = false;
  let displayed: Session[] = [];
  let pendingSubmission: { requestId: string; sessionIds: string[] } | undefined;
  let detailVersion = 0, historySession: string | undefined, returnToSelection = false;
  let historyLoading = false, historyMarkup: string | undefined;
  const selector = element<HTMLDialogElement>("session-selector");
  const detail = element<HTMLDialogElement>("detail");
  const runModes = ["all", "simulated", "recorded"] as const;
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
  function scoreHtml(run: RunSummary) {
    if (run.mode !== "recorded") return '<span class="task-score muted">Task eval score: N/A — simulated evaluation</span>';
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
    element("schedules").innerHTML = `<div id="recorded-schedule" class="schedule-card"><h3>Recorded runs</h3><p>Daily at 1 a.m. · ${zone}<br><strong>${recorded ? recorded.enabled ? "Enabled" : "Disabled" : "Schedule status unavailable"}</strong></p>${recorded?.enabledAt ? `<p>Initial eligibility cutoff: ${esc(nyDate(recorded.enabledAt))}<br><small>Only runs started at or after this persisted cutoff are eligible for automatic selection. Older runs remain available manually.</small></p>` : ""}${latest ? `<p>Latest daily outcome: <strong>${esc(outcomeLabels[latest.status] || latest.status.replace(/_/g, " "))}</strong><br>${esc(latest.day)} · ${esc(latest.selectedCount)} sessions selected</p>${latest.warnings.length ? `<div class="session-warning" role="status"><strong>Incomplete recorded-run discovery / scheduling warnings</strong><ul>${latest.warnings.map(warning => `<li>${esc(warning)}</li>`).join("")}</ul></div>` : ""}${latest.error ? `<p class="error" role="alert">${esc(latest.error)}</p>` : ""}` : "<p class=muted>No recorded daily outcome is available.</p>"}</div><div id="simulated-schedule" class="schedule-card"><h3>Simulated suite</h3><p>Daily at 3 a.m. · ${zone}<br><strong>${simulated ? simulated.enabled ? "Enabled" : "Disabled" : typeof snapshot.scheduleEnabled === "boolean" ? snapshot.scheduleEnabled ? "Enabled (legacy schedule status)" : "Disabled (legacy schedule status)" : "Schedule status unavailable"}</strong></p><p class="muted">Manual launches remain available independently of either schedule when the shared worker is free.</p></div>`;
  }
  function calibrationHtml(result: CalibrationResult) {
    const verdicts = (values: string[]) => values.map(value => value === "not_checked" ? "Not checked" : value).join(" / ");
    const score = (value: number | null | undefined, absent: string) => value === undefined ? absent
      : value === null ? "Unscored — insufficient evidence" : `${esc(value)}/100`;
    const progress = (value: string | undefined, absent: string) => value === undefined ? absent : esc(value.replace(/_/g, " "));
    const members = (value: string[] | undefined, absent: string) => value === undefined ? absent : esc(value.join(", ") || "None");
    const scoreComparison = result.expectedScore !== undefined || result.actualScore !== undefined
      ? `<br>Task eval score: expected ${score(result.expectedScore, "Not checked")}; actual ${score(result.actualScore, "Unavailable")}` : "";
    const progressComparison = result.expectedProgress !== undefined || result.actualProgress !== undefined
      ? `<br>Progress: expected ${progress(result.expectedProgress, "Not checked")}; actual ${progress(result.actualProgress, "Unavailable")}` : "";
    const mistakes = result.expectedSeverities !== undefined
      ? `<br>Mistake severities: expected ${members(result.expectedSeverities, "Not checked")}; actual ${members(result.actualSeverities, "Unavailable")}` : "";
    const gaps = result.expectedBlockingComponents !== undefined
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
  function render() {
    const mode = element<HTMLSelectElement>("mode").value;
    for (const value of runModes) {
      const tab = element<HTMLButtonElement>(`runs-tab-${value}`);
      tab.setAttribute("aria-selected", String(value === mode));
      tab.tabIndex = value === mode ? 0 : -1;
    }
    element("runs-panel").setAttribute("aria-labelledby", `runs-tab-${mode}`);
    if (!snapshot) return;
    const runs = snapshot.runs.filter(r => mode === "all" || r.mode === mode);
    element("window").textContent = `Baseline ${snapshot.baseline.from} – ${snapshot.baseline.to} · ${snapshot.timezone}`;
    renderSchedules();
    element("cards").innerHTML = [["Evaluated runs", runs.length], ["Tasks fulfilled", runs.filter(r => r.grade?.task.verdict === "pass").length], ["Handling passed", runs.filter(r => r.verdict === "pass").length], ["Unknown / incomplete", runs.filter(r => ["unknown", "error"].includes(r.verdict)).length]].map(([label, count]) => `<div class="card"><div class="muted">${label}</div><div class="number">${count}</div></div>`).join("");
    element("alerts").innerHTML = snapshot.alerts.filter(a => !a.resolvedAt).map(a => `<div class="alert">${esc(a.message)} <small>${esc(date(a.createdAt))}</small></div>`).join("") || "No active regression alerts.";
    const emptyRuns = mode === "simulated" ? "No simulated evals yet. Run a simulation above."
      : mode === "recorded" ? "No real evals yet. Select completed real sessions above."
      : "No evals yet. Run a simulation or select completed real sessions above.";
    element("runs").innerHTML = runs.map(r => `<tr><td>${esc(date(r.assessedAt))}<br><small>Graded ${esc(date(r.gradedAt))}</small></td><td>${esc(r.request || r.scenarioId || r.id)}<br><small>${esc(r.assessedModel || "Model unknown")}</small></td><td>${badge(r.mode)}<br><small>${esc(r.attempt)}</small></td><td>${scoreHtml(r)}</td><td>${badge(r.grade?.task.verdict)}</td><td>${badge(r.grade?.handling.verdict || (r.status !== "completed" ? "error" : "unknown"))}</td><td>${badge(r.grade?.reporting.verdict)}</td><td>${duration(r.durationMs)}</td><td>${r.comparison ? r.comparison.baselineCount >= 3 ? `${r.comparison.baselineCount} samples<br>Median ${duration(r.comparison.medianMs)}<br>${esc(r.comparison.signal || "No alert threshold crossed")} ${esc(r.comparison.confirmation || "")}` : `Collecting baseline (${r.comparison.baselineCount}/3)` : r.attempt === "scheduled" ? `Scheduled${r.scheduledDay ? `<br>${esc(r.scheduledDay)}` : ""}${r.mode === "recorded" ? "<br><small>Not part of the simulated baseline</small>" : ""}` : r.attempt === "confirmation" ? "Confirmation" : "On demand"}</td><td><button data-run="${esc(r.id)}">Inspect</button></td></tr>`).join("") || `<tr><td colspan="10">${emptyRuns}</td></tr>`;
    element("fidelity-note").textContent = snapshot.fidelityNote;
    const pairs = snapshot.fidelity.filter(p => p.recordedIds.length);
    element("fidelity").innerHTML = pairs.map(p => `<p>${esc(snapshot!.runs.find(r => r.id === p.simulatedId)?.scenarioId)} · ${p.recordedIds.length} comparable recorded runs <button data-pair="${esc(p.simulatedId)}:${esc(p.recordedIds[0])}">Compare steps</button></p>`).join("") || `No comparison data yet. ${snapshot.fidelity.length} simulated runs currently unmatched.`;
    element("batches").innerHTML = snapshot.batches.map(b => `<p>${esc(b.scheduledDay || date(b.startedAt))} · ${esc(b.mode)} · ${b.attempt === "scheduled" ? "Scheduled" : "On demand"} · ${badge(b.status)} · ${b.runIds.length} attempts ${esc(b.error || "")}</p>`).join("") || "No batches recorded.";
    element("calibrations").innerHTML = snapshot.calibrations.map(c => `<details><summary>${esc(c.judgeModel)} · ${badge(c.passed ? "pass" : "fail")} · ${esc(date(c.createdAt))}</summary>${c.results.map(calibrationHtml).join("")}</details>`).join("") || "<p class=muted>The judge has not been validated against the reference cases yet.</p>";
  }
  function refresh(options: { sessions?: boolean; sources?: boolean } = {}): Promise<void> {
    reloadSessions ||= Boolean(options.sessions);
    retrySources ||= Boolean(options.sources);
    if (refreshing) { refreshAgain = true; return refreshing; }
    refreshing = (async () => {
      do {
        refreshAgain = false;
        const loadSessions = reloadSessions, forceSources = retrySources, version = mutationVersion;
        reloadSessions = false; retrySources = false;
        try {
          const next = await request<Snapshot>(`/api/evals?agentId=${encodeURIComponent(element<HTMLSelectElement>("agent").value)}`);
          if (version === mutationVersion) {
            snapshot = next;
            if (!sessionsInitialized) busy = next.busy;
            render();
          }
        } catch (error) {
          if (version === mutationVersion) {
            element("status").textContent = `Dashboard refresh failed: ${String(error)}`;
            if (!sessionsInitialized) busy = undefined;
          }
        }
        if (sessionsInitialized) {
          if (loadSessions) {
            try {
              const result = await request<import("./types").RecordedSessionsResponse>(`/api/evals/sessions${forceSources ? "?refresh=true" : ""}`);
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
    })().finally(() => { refreshing = undefined; updateControls(); });
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
  function eligible(id: string) { return metadataKnown && statusesKnown && available(id) && !active(id); }
  function setHtml(target: HTMLElement, html: string) { if (target.innerHTML !== html) target.innerHTML = html; }
  function judgments(run: RunSummary) {
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
    return (!search || `${session.userPrompt} ${session.sessionId}`.toLocaleLowerCase().includes(search))
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
      if (!displayed.length) body.innerHTML = `<tr data-empty><td colspan="6">${!metadataKnown ? metadataError ? "Session list could not be loaded. Refresh to retry." : "Loading finished TV sessions..." : reviewSelected ? "No sessions selected." : "No sessions match these filters."}</td></tr>`;
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
    element<HTMLButtonElement>("simulate").disabled = submitting || busy !== false || Boolean(pendingSubmission);
    element<HTMLButtonElement>("calibrate").disabled = submitting || busy !== false || Boolean(pendingSubmission);
    element("global-busy").textContent = busy === true ? "An offline eval worker is busy. New submissions are disabled until it finishes." : busy === undefined ? "Checking worker availability. New submissions are disabled until its state is known." : "";
    const frozen = submitting || Boolean(pendingSubmission);
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
        pendingSubmission = { sessionIds: [...selected].sort(), requestId: crypto.randomUUID() };
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
  function citations(ids: string[]) {
    return ids.length ? `<small>Evidence: ${ids.map(id => `<a href="#evidence-${esc(encodeURIComponent(id))}" data-evidence="${esc(id)}">${esc(id)}</a>`).join(", ")}</small>` : "<small>No evidence cited.</small>";
  }
  function scoreDetails(run: Run) {
    const score = run.grade?.score, assessment = run.grade?.scoringAssessment;
    const intro = '<h3>Task eval score calculation</h3><p class="muted">Outcome-first task fulfillment, not a probability or confidence estimate. Handling, reporting, elapsed time, and model cost remain separate.</p>';
    if (run.mode !== "recorded" || run.status !== "completed" || !score) return `${intro}<p>${scoreHtml(run)}</p>`;
    const levels: Record<import("./types").TaskScoringAssessment["progress"]["level"], string> = {
      none: "No useful progress", prerequisites: "Prerequisites only", partial: "Partial meaningful progress",
      nearly_complete: "Nearly complete", complete: "Verified full fulfillment", unknown: "Unknown progress",
    };
    const components: import("./types").ScoringComponent[] = ["progress", "execution", "reporting"];
    const assessmentHtml = assessment ? `<h4>Progress assessment</h4><p><strong>${esc(levels[assessment.progress.level] || assessment.progress.level)}</strong>: ${esc(assessment.progress.reason)}<br>${citations(assessment.progress.evidenceIds)}</p><h4>Evidence sufficiency</h4><ul>${components.map(component => {
      const evidence = assessment.evidence[component];
      return `<li><strong>${esc(component)}: ${evidence.sufficient ? "Sufficient" : "Blocking gap"}</strong> — ${esc(evidence.reason)}<br>${citations(evidence.evidenceIds)}</li>`;
    }).join("")}</ul>` : "<p>Detailed scoring assessment unavailable for this evaluation.</p>";
    const gaps = run.grade?.gaps.length ? `<h4>Retained evidence gaps</h4><ul>${run.grade.gaps.map(gap => `<li>${esc(gap)}</li>`).join("")}</ul>` : "";
    if (score.status === "unscored") {
      return `${intro}<p>${scoreHtml(run)}</p><p>Rubric version: <code>${esc(score.rubricVersion)}</code></p><p><strong>Blocking components:</strong> ${esc(score.blockingComponents.join(", "))}. No numeric score was assigned.</p>${assessmentHtml}${gaps}`;
    }
    return `${intro}<p>${scoreHtml(run)}</p><p>Rubric version: <code>${esc(score.rubricVersion)}</code></p><dl class="score-calculation"><dt>Starting score</dt><dd>${esc(score.baseScore)}</dd><dt>Mistake deductions</dt><dd>${esc(score.totalDeductions)} points</dd><dt>Before task band</dt><dd>${esc(score.baseScore)} − ${esc(score.totalDeductions)} = ${esc(score.baseScore - score.totalDeductions)}</dd><dt>Task fulfillment band</dt><dd>${esc(score.band.min)}–${esc(score.band.max)}</dd><dt>After band limits</dt><dd>${esc(score.bandAdjustedScore)}</dd><dt>Reporting ceiling</dt><dd>${score.reportingCeiling == null ? "Not applied" : `${esc(score.reportingCeiling)}/100 — final score cannot exceed this ceiling`}</dd><dt>Final task eval score</dt><dd>${esc(score.value)}/100</dd></dl><h4>Distinct mistake episodes</h4>${score.deductions.length ? `<ul>${score.deductions.map(mistake => `<li><strong>${esc(mistake.id)} · ${esc(mistake.severity)} · −${esc(mistake.points)} points</strong><br>${esc(mistake.reason)}<br>${citations(mistake.evidenceIds)}</li>`).join("")}</ul>` : "<p>No assessed mistake deductions.</p>"}${score.reportingCeiling == null ? "" : `<h4>Reporting ceiling reason</h4><p>${esc(run.grade?.reporting.reason)}<br>${citations(run.grade?.reporting.evidenceIds || [])}</p>`}${assessmentHtml}${gaps}`;
  }
  function openDetail(title: string) {
    detailVersion++;
    historySession = undefined; historyMarkup = undefined;
    element("detail-title").textContent = title;
    element("detail-body").innerHTML = '<p role="status">Loading...</p>';
    if (selector.open) { returnToSelection = true; selector.close(); }
    if (!detail.open) detail.showModal();
    return detailVersion;
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
      element("detail-body").innerHTML = `${historyLink(sourceSessionId)}<h3>${esc(run.assessment?.request || run.id)}</h3><p>${esc(run.assessment?.finalResponse || "")}</p>${run.error ? `<p class="error" role="alert">${esc(run.error)}</p>` : ""}<p>${judgments(run)}</p><section aria-label="Task eval score breakdown">${scoreDetails(run)}</section><pre>${esc(JSON.stringify({ status: run.status, assessedAt: run.assessedAt, gradedAt: run.gradedAt, sourceSessionId, coverage: run.assessment?.coverage, model: run.assessedModel, promptVersion: run.promptVersion, judge: run.judgeModel, graderVersion: run.graderVersion, usage: run.assessment?.usage, judgeUsage: run.judgeUsage }, null, 2))}</pre><h3>Task and step judgments</h3><pre>${esc(JSON.stringify(run.grade, null, 2))}</pre><h3>Source evidence</h3>${evidenceHtml(run)}`;
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
        return `<section><h3>${index > 0 && attempt.status === "evaluated" ? "Previous evaluation · " : ""}${esc(lifecycleLabels[attempt.status])}</h3><p>Requested ${esc(nyDate(attempt.requestedAt))}${attempt.startedAt ? `<br>Started ${esc(nyDate(attempt.startedAt))}` : ""}${attempt.finishedAt ? `<br>Finished ${esc(nyDate(attempt.finishedAt))}` : ""}</p><small>Attempt ${esc(attempt.id)} · Job ${esc(attempt.jobId)}</small>${attempt.error ? `<p class="error" role="alert">${esc(attempt.error)}</p>` : ""}${attempt.run ? `<p>${judgments(attempt.run)}<br><small>Graded ${esc(nyDate(attempt.run.gradedAt))} · Judge ${esc(attempt.run.judgeModel)} · Grader ${esc(attempt.run.graderVersion)}</small></p>${attempt.run.error && attempt.run.error !== attempt.error ? `<p class="error">${esc(attempt.run.error)}</p>` : ""}` : `<p class="muted">${attempt.status === "queued" || attempt.status === "running" ? "Verdicts and task eval score are not available yet." : "No completed task eval score. No saved run summary is available for this attempt. This is not a passing evaluation."}</p>`}${runId ? `<button data-run="${esc(runId)}" data-history-session="${esc(id)}">Inspect</button>` : "<p class=muted>No run was saved for this attempt.</p>"}</section>`;
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
    const version = openDetail("Simulated and recorded comparison");
    let runs: Run[];
    try { runs = await Promise.all(ids.map(id => request<Run>(`/api/evals/runs/${encodeURIComponent(id)}`))); }
    catch (error) {
      if (version === detailVersion && detail.open) element("detail-body").innerHTML = `<p class="error" role="alert">Could not load comparison: ${esc(String(error))}</p><button data-pair="${esc(ids.join(":"))}">Retry comparison</button>`;
      return;
    }
    if (version !== detailVersion || !detail.open) return;
    const [a, b] = runs;
    const groups = new Set([...(a.grade?.steps || []), ...(b.grade?.steps || [])].map(s => s.groupId));
    element("detail-body").innerHTML = `<h2>Simulated ↔ recorded task comparison</h2><div class="two"><div><h3>Simulated</h3>${esc(a.assessment?.request)}<p>${esc(a.assessment?.finalResponse)}</p>${badge(a.grade?.task.verdict)}</div><div><h3>Recorded</h3>${esc(b.assessment?.request)}<p>${esc(b.assessment?.finalResponse)}</p>${badge(b.grade?.task.verdict)}</div></div>` + [...groups].map(id => {
      const left = a.grade?.steps.find(s => s.groupId === id), right = b.grade?.steps.find(s => s.groupId === id);
      return `<h3>${esc(left?.objective || right?.objective)}</h3><div class="two">${[[a, left], [b, right]].map(([run, step]) => {
        const s = step as import("./types").StepGrade | undefined;
        return `<div>${badge(s?.verdict)} ${s?.alreadySatisfied ? "Already satisfied" : ""}<p>${esc(s?.reason || "No matching step")}</p>${s ? evidenceHtml(run as Run, s.evidenceIds) : ""}</div>`;
      }).join("")}</div>`;
    }).join("");
  }
  element("simulate").onclick = () => { void launch({ mode: "simulated", ...(element<HTMLInputElement>("model").value.trim() ? { model: element<HTMLInputElement>("model").value.trim() } : {}) }); };
  element("recorded").onclick = () => {
    sessionsInitialized = true;
    selector.showModal(); renderSessions();
    void refresh({ sessions: true });
  };
  element("calibrate").onclick = () => { void launch({ mode: "calibrate" }); };
  element("refresh").onclick = () => { void refresh({ sessions: sessionsInitialized }); };
  element("mode").onchange = render; element("agent").onchange = () => { void refresh(); };
  runModes.forEach((mode, index) => {
    const tab = element<HTMLButtonElement>(`runs-tab-${mode}`);
    tab.onclick = () => { element<HTMLSelectElement>("mode").value = mode; render(); };
    tab.onkeydown = event => {
      let next: number;
      switch (event.key) {
        case "ArrowRight": next = (index + 1) % runModes.length; break;
        case "ArrowLeft": next = (index + runModes.length - 1) % runModes.length; break;
        case "Home": next = 0; break;
        case "End": next = runModes.length - 1; break;
        default: return;
      }
      event.preventDefault();
      const target = element<HTMLButtonElement>(`runs-tab-${runModes[next]}`);
      target.focus(); target.click();
    };
  });
  element("close").onclick = () => detail.close();
  detail.addEventListener("close", () => {
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
  if (params.has("sessionId")) {
    sessionsInitialized = true;
    void openHistory(params.get("sessionId") || "");
  }
  updateControls(); void refresh();
  setInterval(() => { if (!document.hidden && !refreshing) void refresh(); }, 5_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
})();
