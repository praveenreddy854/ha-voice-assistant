// Standalone browser script: keep the IIFE free of runtime CommonJS imports.
(() => {
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
type Record = import("./engine").OnlineRecord;
type Dashboard = {
  enabled: boolean; sampleRate: number; enabledAt?: string; total: number; records: Record[];
  worker: { running: boolean; error?: string }; summary: ReturnType<typeof import("./api").onlineSummary>;
};
type Detail = { record: Record; snapshot?: import("./engine").OnlineSnapshot; result?: import("./engine").OnlineResult };
const uuid = () => typeof window.crypto.randomUUID === "function" ? window.crypto.randomUUID() :
  "10000000-1000-4000-8000-100000000000".replace(/[018]/g, character =>
    (Number(character) ^ window.crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(character) / 4).toString(16));
const escape = (value: unknown) => String(value ?? "—").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const cell = (value: unknown) => `<td>${escape(value)}</td>`;
let selectedId: string | undefined, retryId: string | undefined, loading = false;
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function refresh(): Promise<void> {
  if (loading) return;
  loading = true;
  try {
    const agent = element<HTMLSelectElement>("agent").value;
    const data = await request<Dashboard>(`/api/evals/online${agent ? `?agentId=${encodeURIComponent(agent)}` : ""}`);
    element("error").textContent = "";
    element("health").textContent = `${data.enabled ? "Enabled" : "Disabled"} · Worker ${data.worker.running ? "running" : "unavailable"} · Sampling ${Math.round(data.sampleRate * 100)}%${data.enabledAt ? ` · New runs since ${new Date(data.enabledAt).toLocaleString()}` : ""}${data.worker.error ? ` · ${data.worker.error}` : ""}`;
    const counts = data.summary.states;
    element("metrics").innerHTML = Object.entries({ Completed: counts.completed, Queued: counts.queued, Running: counts.running, "Needs review": data.summary.reviewRequired, "Eval errors": counts.eval_error, Skipped: counts.skipped }).map(([key, value]) => `<div class="metric"><strong>${escape(value)}</strong>${escape(key)}</div>`).join("");
    element("cohorts").innerHTML = data.summary.cohorts.map(row => `<tr><td>${escape(row.agentId)}<br>${escape(row.model)}</td><td><small>${escape(row.promptVersion)}<br>${escape(row.graderVersion)}</small></td>${[row.count, row.taskPass, row.taskFail, row.taskUnknown, row.reportingFail].map(cell).join("")}</tr>`).join("") || '<tr><td colspan="7">No completed evaluations yet.</td></tr>';
    element("records").innerHTML = data.records.map(row => `<tr><td>${escape(row.request)}<br><small>${escape(row.sourceSessionId)}</small></td>${cell(row.model)}${cell(row.status)}${cell(row.verdicts?.task)}${cell(row.verdicts?.handling)}${cell(row.verdicts?.reporting)}${cell(row.reviewRequired ? row.disagreements?.join(", ") : "—")}<td><button data-id="${escape(row.id)}">Details</button></td></tr>`).join("") || '<tr><td colspan="8">No live runs enrolled yet.</td></tr>';
    element("coverage").textContent = `Showing ${data.records.length} of ${data.total} retained attempts. Errors and skipped runs are evaluation coverage gaps, not task failures.`;
  } catch (error) { element("error").textContent = error instanceof Error ? error.message : String(error); }
  finally { loading = false; }
}
element("records").addEventListener("click", async event => {
  const id = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-id]")?.dataset.id;
  if (!id) return;
  try {
    const data = await request<Detail>(`/api/evals/online/${encodeURIComponent(id)}`);
    selectedId = id; retryId = undefined;
    element("evidence").textContent = JSON.stringify(data, null, 2);
    element<HTMLButtonElement>("retry").disabled = !data.snapshot || ["queued", "running"].includes(data.record.status);
    element<HTMLDialogElement>("detail").showModal();
  } catch (error) { element("error").textContent = String(error); }
});
element("retry").addEventListener("click", async () => {
  if (!selectedId) return;
  element<HTMLButtonElement>("retry").disabled = true;
  try {
    retryId ||= uuid();
    await request(`/api/evals/online/${encodeURIComponent(selectedId)}/retry`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ requestId: retryId }) });
    element<HTMLDialogElement>("detail").close(); await refresh();
  } catch (error) { element("evidence").textContent = String(error); element<HTMLButtonElement>("retry").disabled = false; }
});
element("close").addEventListener("click", () => element<HTMLDialogElement>("detail").close());
element("agent").addEventListener("change", refresh);
element("refresh").addEventListener("click", refresh);
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 10_000);
})();
