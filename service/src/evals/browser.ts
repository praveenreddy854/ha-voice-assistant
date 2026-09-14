(() => {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const esc = (value: unknown) => String(value ?? "—").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
  type Run = import("./types").EvalRun & { request?: string; verdict: string };
  type Snapshot = { runs: Run[]; batches: import("./types").EvalBatch[]; alerts: import("./types").EvalAlert[];
    baseline: { from: string; to: string }; timezone: string; scheduleEnabled: boolean; fidelityNote: string;
    fidelity: { simulatedId: string; recordedIds: string[]; status: string }[];
    calibrations: { id: string; judgeModel: string; createdAt: string; passed: boolean; results: { id: string; passed: boolean; expected: string[]; actual?: string[]; error?: string }[] }[] };
  let snapshot: Snapshot;
  const badge = (value?: string) => `<span class="badge ${esc(value || "unknown")}">${esc(value || "unknown")}</span>`;
  const date = (value: string) => new Date(value).toLocaleString();
  const duration = (value?: number) => value == null ? "Unknown" : `${(value / 1000).toFixed(1)}s`;
  async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const response = await fetch(url, init), body = await response.json();
    if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`); return body;
  }
  function render() {
    const mode = element<HTMLSelectElement>("mode").value;
    const runs = snapshot.runs.filter(r => mode === "all" || r.mode === mode);
    element("window").textContent = `Baseline ${snapshot.baseline.from} – ${snapshot.baseline.to} · ${snapshot.timezone} · Daily schedule ${snapshot.scheduleEnabled ? "3 a.m." : "disabled"}`;
    element("cards").innerHTML = [["Evaluated runs", runs.length], ["Tasks fulfilled", runs.filter(r => r.grade?.task.verdict === "pass").length], ["Handling passed", runs.filter(r => r.verdict === "pass").length], ["Unknown / incomplete", runs.filter(r => ["unknown", "error"].includes(r.verdict)).length]].map(([label, count]) => `<div class="card"><div class="muted">${label}</div><div class="number">${count}</div></div>`).join("");
    element("alerts").innerHTML = snapshot.alerts.filter(a => !a.resolvedAt).map(a => `<div class="alert">${esc(a.message)} <small>${esc(date(a.createdAt))}</small></div>`).join("") || "No active regression alerts.";
    element("runs").innerHTML = runs.map(r => `<tr><td>${esc(date(r.assessedAt))}<br><small>Graded ${esc(date(r.gradedAt))}</small></td><td>${esc(r.request || r.scenarioId || r.id)}<br><small>${esc(r.assessedModel || "Model unknown")}</small></td><td>${badge(r.mode)}<br><small>${esc(r.attempt)}</small></td><td>${badge(r.grade?.task.verdict)}</td><td>${badge(r.grade?.handling.verdict || (r.status !== "completed" ? "error" : "unknown"))}</td><td>${badge(r.grade?.reporting.verdict)}</td><td>${duration(r.durationMs)}</td><td>${r.comparison ? r.comparison.baselineCount >= 3 ? `${r.comparison.baselineCount} samples<br>Median ${duration(r.comparison.medianMs)}<br>${esc(r.comparison.signal || "No alert threshold crossed")} ${esc(r.comparison.confirmation || "")}` : `Collecting baseline (${r.comparison.baselineCount}/3)` : "On demand"}</td><td><button data-run="${esc(r.id)}">Inspect</button></td></tr>`).join("") || '<tr><td colspan="9">No evals yet. Run a simulation or select completed real sessions above.</td></tr>';
    element("fidelity-note").textContent = snapshot.fidelityNote;
    const pairs = snapshot.fidelity.filter(p => p.recordedIds.length);
    element("fidelity").innerHTML = pairs.map(p => `<p>${esc(snapshot.runs.find(r => r.id === p.simulatedId)?.scenarioId)} · ${p.recordedIds.length} comparable recorded runs <button data-pair="${esc(p.simulatedId)}:${esc(p.recordedIds[0])}">Compare steps</button></p>`).join("") || `No comparison data yet. ${snapshot.fidelity.length} simulated runs currently unmatched.`;
    element("batches").innerHTML = snapshot.batches.map(b => `<p>${esc(b.scheduledDay || date(b.startedAt))} · ${esc(b.mode)} · ${badge(b.status)} · ${b.runIds.length} attempts ${esc(b.error || "")}</p>`).join("") || "No batches recorded.";
    element("calibrations").innerHTML = snapshot.calibrations.map(c => `<details><summary>${esc(c.judgeModel)} · ${badge(c.passed ? "pass" : "fail")} · ${esc(date(c.createdAt))}</summary>${c.results.map(r => `<p>${esc(r.id)} ${badge(r.passed ? "pass" : "fail")} expected ${esc(r.expected.join(" / "))}; actual ${esc(r.actual?.join(" / ") || r.error)}</p>`).join("")}</details>`).join("") || "<p class=muted>The judge has not been validated against the reference cases yet.</p>";
  }
  async function refresh() {
    try { snapshot = await request<Snapshot>(`/api/evals?agentId=${encodeURIComponent(element<HTMLSelectElement>("agent").value)}`); render(); }
    catch (error) { element("status").textContent = String(error); }
  }
  async function launch(body: unknown) {
    try {
      element("status").textContent = "Starting offline eval worker…";
      const job = await request<{ id: string }>("/api/evals/jobs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      element("status").textContent = `Eval job queued: ${job.id}. Results will appear as each run finishes.`; await refresh();
    } catch (error) { element("status").textContent = String(error); }
  }
  function evidenceHtml(run: Run, ids?: string[]) {
    return (run.assessment?.evidence || []).filter(e => !ids || ids.includes(e.id)).map(e => `<details><summary>${esc(e.id)} · ${esc(e.toolName || e.kind)} · ${e.durationMs == null ? "" : duration(e.durationMs)}</summary><pre>${esc(JSON.stringify({ ...e, image: undefined }, null, 2))}</pre>${e.image?.startsWith("data:image/") ? `<img alt="Evidence ${esc(e.id)}" src="${esc(e.image)}">` : ""}</details>`).join("");
  }
  async function inspect(id: string) {
    const run = await request<Run>(`/api/evals/runs/${encodeURIComponent(id)}`);
    element("detail-body").innerHTML = `<h2>${esc(run.assessment?.request || run.id)}</h2><p>${esc(run.assessment?.finalResponse || run.error)}</p><pre>${esc(JSON.stringify({ status: run.status, model: run.assessedModel, promptVersion: run.promptVersion, judge: run.judgeModel, graderVersion: run.graderVersion, usage: run.assessment?.usage, judgeUsage: run.judgeUsage }, null, 2))}</pre><h3>Task and step judgments</h3><pre>${esc(JSON.stringify(run.grade, null, 2))}</pre><h3>Source evidence</h3>${evidenceHtml(run)}`;
    element<HTMLDialogElement>("detail").showModal();
  }
  async function pair(ids: string[]) {
    const [a, b] = await Promise.all(ids.map(id => request<Run>(`/api/evals/runs/${encodeURIComponent(id)}`)));
    const groups = new Set([...(a.grade?.steps || []), ...(b.grade?.steps || [])].map(s => s.groupId));
    element("detail-body").innerHTML = `<h2>Simulated ↔ recorded task comparison</h2><div class="two"><div><h3>Simulated</h3>${esc(a.assessment?.request)}<p>${esc(a.assessment?.finalResponse)}</p>${badge(a.grade?.task.verdict)}</div><div><h3>Recorded</h3>${esc(b.assessment?.request)}<p>${esc(b.assessment?.finalResponse)}</p>${badge(b.grade?.task.verdict)}</div></div>` + [...groups].map(id => {
      const left = a.grade?.steps.find(s => s.groupId === id), right = b.grade?.steps.find(s => s.groupId === id);
      return `<h3>${esc(left?.objective || right?.objective)}</h3><div class="two">${[[a, left], [b, right]].map(([run, step]) => {
        const s = step as import("./types").StepGrade | undefined;
        return `<div>${badge(s?.verdict)} ${s?.alreadySatisfied ? "Already satisfied" : ""}<p>${esc(s?.reason || "No matching step")}</p>${s ? evidenceHtml(run as Run, s.evidenceIds) : ""}</div>`;
      }).join("")}</div>`;
    }).join("");
    element<HTMLDialogElement>("detail").showModal();
  }
  element("simulate").onclick = () => { void launch({ mode: "simulated", ...(element<HTMLInputElement>("model").value.trim() ? { model: element<HTMLInputElement>("model").value.trim() } : {}) }); };
  element("recorded").onclick = () => { void launch({ mode: "recorded", sessionIds: element<HTMLTextAreaElement>("sessions").value.split(/[\s,]+/).filter(Boolean) }); };
  element("calibrate").onclick = () => { void launch({ mode: "calibrate" }); };
  element("refresh").onclick = refresh; element("mode").onchange = render; element("agent").onchange = refresh;
  element("close").onclick = () => element<HTMLDialogElement>("detail").close();
  document.addEventListener("click", event => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-run],button[data-pair]");
    if (button) void (button.dataset.run ? inspect(button.dataset.run) : pair(button.dataset.pair!.split(":"))).catch(error => { element("status").textContent = String(error); });
  });
  void refresh(); setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
})();
