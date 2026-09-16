(() => {
  type Evaluation = import("./types").RecordedSessionEvaluation;
  type Response = { statuses: Record<string, Evaluation>; busy: boolean };
  const labels: Record<Evaluation["status"], string> = {
    not_evaluated: "Not evaluated", queued: "Queued", running: "Running", evaluated: "Evaluated", eval_error: "Eval error",
  };
  let statuses: Record<string, Evaluation> = {};
  let known = false, loading = false, error = "";
  const date = (value: string) => new Date(value).toLocaleString("en-US", { timeZone: "America/New_York", timeZoneName: "short" });
  function scoreText(run: import("./types").EvalRunSummary) {
    if (run.mode !== "recorded") return "task eval score: N/A — simulated evaluation";
    if (run.status !== "completed") return "no completed task eval score — evaluation did not finish";
    const score = run.grade?.score;
    if (!score) return "Scoring unavailable for this evaluation";
    return score.status === "scored" ? `task eval score: ${score.value}/100`
      : `Unscored — insufficient evidence: ${score.reason}`;
  }
  function render() {
    document.querySelectorAll<HTMLElement>("[data-eval-session-id]").forEach(placeholder => {
      if (placeholder.dataset.agentType !== "tv") { placeholder.hidden = true; return; }
      const id = placeholder.dataset.evalSessionId!;
      const evaluation = statuses[id], attempt = evaluation?.latestAttempt;
      const status = attempt?.status || evaluation?.status || "not_evaluated";
      const result = evaluation?.latestCompleted;
      const previous = !known || status !== "evaluated" || Boolean(attempt?.runId && result && attempt.runId !== result.id);
      const text = known ? `Eval: ${labels[status]}` : error ? "Eval: status unavailable" : "Eval: loading status...";
      const verdicts = result
        ? `${previous ? "Previous evaluation" : "Evaluation"}: ${scoreText(result)}; task ${result.grade?.task.verdict || "unknown"}; handling ${result.grade?.handling.verdict || "unknown"}; reporting ${result.grade?.reporting.verdict || "unknown"}; graded ${date(result.gradedAt)}${!known ? " (last loaded)" : ""}`
        : "";
      const title = [text, error, attempt ? `Requested ${date(attempt.requestedAt)}` : "",
        attempt?.startedAt ? `Started ${date(attempt.startedAt)}` : "", attempt?.finishedAt ? `Finished ${date(attempt.finishedAt)}` : "",
        attempt?.error || "", verdicts, "Open session evaluation history"].filter(Boolean).join("\n");
      let link = placeholder.querySelector<HTMLAnchorElement>("a");
      if (!link) {
        link = document.createElement("a");
        link.href = `/dashboards/evals?sessionId=${encodeURIComponent(id)}`;
        link.style.color = "var(--accent)";
        link.style.display = "block";
        link.addEventListener("click", event => event.stopPropagation());
        link.addEventListener("keydown", event => event.stopPropagation());
        placeholder.appendChild(link);
      }
      if (link.textContent !== text) link.textContent = text;
      link.title = title;
      link.setAttribute("aria-label", `${text}. Evaluation history for session ${id}`);
      let summary = placeholder.querySelector<HTMLElement>("small");
      if (!summary) { summary = document.createElement("small"); placeholder.appendChild(summary); }
      if (summary.textContent !== verdicts) summary.textContent = verdicts;
      summary.hidden = !verdicts;
      summary.style.display = verdicts ? "block" : "none";
      let retry = placeholder.querySelector<HTMLButtonElement>("button");
      if (error && !retry) {
        retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Retry eval status";
        retry.addEventListener("click", event => { event.stopPropagation(); void refresh(); });
        placeholder.appendChild(retry);
      }
      if (retry) { retry.hidden = !error; retry.disabled = loading; }
    });
  }
  async function refresh() {
    if (loading) return;
    loading = true; render();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch("/api/evals/session-statuses", { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result: Response = await response.json();
      if (!result.statuses || typeof result.statuses !== "object") throw new Error("Invalid evaluation status response");
      statuses = result.statuses; known = true; error = "";
    } catch (failure) {
      known = false;
      error = `Evaluation status could not be loaded: ${String(failure)}. This does not mean the session has never been evaluated.`;
    } finally { clearTimeout(timeout); loading = false; render(); }
  }
  // The trace viewer explicitly announces list replacement; badge writes never trigger another render.
  document.addEventListener("telemetry:sessions-rendered", render);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  render(); void refresh();
  setInterval(() => { if (!document.hidden) void refresh(); }, 5_000);
})();
