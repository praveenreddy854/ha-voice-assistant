import { evalAgents } from "./registry";
import { SCORING_RUBRIC, SCORING_VERSION } from "./scoring";

export const evalPage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent evaluations</title>
<style>
:root{color-scheme:dark;font-family:system-ui,sans-serif;background:#0d1420;color:#e7edf6;--surface:#132133;--muted:#a6b8ce;--line:#25354b;--accent:#a6ceff}
*{box-sizing:border-box}
[hidden]{display:none!important}
body{max-width:1440px;margin:auto;padding:32px}
h1,h2,h3{margin-top:0;font-weight:650}
h2{font-size:20px}h3{font-size:17px}
p{color:var(--muted);line-height:1.65;margin:8px 0 16px}
a{color:var(--accent);text-underline-offset:3px}
button{font:inherit;border:0;border-radius:10px;padding:10px 14px;background:#285f9e;color:#f0f6ff;cursor:pointer;transition:background .15s,color .15s}
button:hover:not(:disabled){background:#3676b8}
button:disabled{opacity:.5;cursor:not-allowed}
button.secondary{background:#1b2e46;color:#dceaff}
input,select,textarea{font:inherit;border:1px solid #3b4b64;border-radius:10px;padding:10px 13px;background:#142236;color:#ecf3ff;max-width:100%}
textarea{width:min(650px,90%);min-height:70px;display:block;margin:12px 0}
input[type=checkbox]{width:18px;height:18px;accent-color:#8cbfff;vertical-align:middle}
label{color:#b9c9df}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.toolbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap}
nav.toolbar{gap:18px;font-size:13px}
nav a{color:#a1b3ca;text-decoration:none}nav a:hover{color:#e7edf6}
.muted,small{color:var(--muted)}.muted{font-size:13px}
.eyebrow{color:#92accb;font-size:10px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;margin:0 0 8px}
.page-heading,.view-heading,.section-heading{display:flex;justify-content:space-between;align-items:center;gap:16px}
.page-heading{margin:30px 0 28px}
.page-heading>div,.view-heading>div{min-width:0}
.page-heading h1{margin:0 0 10px;font-size:36px;line-height:1.15;letter-spacing:-.035em}
.page-heading p{max-width:780px;margin-bottom:0;font-size:14px}
.scope-nav,.tab-container{border:0;border-radius:0;background:transparent;min-width:0}
.tabs{display:flex;gap:4px;flex-wrap:wrap}
.tabs button{background:transparent;color:var(--muted);font-size:14px}
.tabs button[aria-selected=true]{background:#263e59;color:#f3f7ff;font-weight:650}
.tabs button:hover:not(:disabled):not([aria-selected=true]){background:#1b2e46;color:#dceaff}
.source-tabs{display:grid;grid-template-columns:1fr 1fr;gap:6px;padding:6px;background:#132133;border-radius:16px}
.source-tabs button{padding:16px 20px;border-radius:12px;text-align:left}
.source-tabs button[aria-selected=true]{background:#243d5a;box-shadow:0 2px 8px #0002}
.tab-title{display:block;font-size:17px;font-weight:650}
.tab-description{display:block;font-size:12px;margin-top:5px;color:#b0c3db;font-weight:400}
.source-content{padding:14px 0 0}
.scope-copy{margin:0 4px 20px;font-size:12px}
.method-nav{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:12px}
.method-nav p{margin:0;font-size:12px}
#evaluator-tabs{padding:4px;border-radius:12px;background:#132133}
.method-content{padding:0}
.agent-tabs{gap:24px;margin:0;padding:0;border-bottom:1px solid var(--line)}
.agent-tabs button{padding:14px 2px;border-radius:0;border-bottom:2px solid transparent}
.agent-tabs button[aria-selected=true]{background:transparent;color:#bcd9ff;border-bottom-color:#9ac6ff}
.agent-tabs button:hover:not(:disabled):not([aria-selected=true]){background:transparent}
#agent-panel{padding:24px 0 0}
#agent-panel>:last-child{margin-bottom:0}
.source-content:focus-visible,.method-content:focus-visible,#agent-panel:focus-visible{outline-offset:-3px}
.view-heading{margin:0 0 24px;align-items:flex-end}
.view-heading h2{font-size:26px;letter-spacing:-.025em;margin-bottom:8px}
.view-heading p{margin-bottom:0}
.guide-link{white-space:nowrap;font-size:12px}
.section-heading h2{margin:0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#afc1d9}
.section-heading .muted{font-size:12px}
.agent-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin:14px 0 30px}
.agent-card{display:flex;flex-direction:column;min-width:0;border:0;border-radius:18px;background:var(--surface);padding:24px;box-shadow:0 8px 24px #0001}
.agent-card h3{font-size:18px;margin:14px 0 10px}
.number{font-size:32px;font-weight:650;letter-spacing:-.035em;font-variant-numeric:tabular-nums;margin:8px 0}
.agent-card .number{font-size:40px}
.metric-label{color:#b3c6de;font-size:12px}
.metric-detail{color:#aebfd3;font-size:12px;line-height:1.65}
.agent-card .metric-detail{min-height:40px;margin:8px 0 16px}
.agent-facts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:6px 0 18px;color:#a6b8ce;font-size:11px}
.agent-facts strong{display:block;color:#e7edf6;font-size:15px;margin-top:6px}
.agent-card .agent-description{min-height:44px;font-size:13px;margin:0 0 20px}
.agent-card .agent-link{margin-top:auto;width:100%;text-align:left;padding:12px 14px;background:#1d334e;color:#c5dfff;font-size:13px;font-weight:600}
.agent-card .agent-link:hover:not(:disabled){background:#29496e}
.health{align-self:flex-start;border-radius:20px;font-size:10px;font-weight:600;padding:5px 9px;background:#26384e;color:#c4d4e9}
.pass{color:#7fe0b0}.fail,.error{color:#ffb0b0}.unknown{color:#f4cc7c}
.health.pass{background:#193c31;color:#91deb9}.health.fail{background:#412c36;color:#ffb0b0}.health.unknown{background:#3c3425;color:#f4cc7c}
.outcome-bar{height:5px;display:flex;overflow:hidden;border-radius:8px;background:#293b52;margin:10px 0}
.outcome-bar span{height:100%}
.outcome-bar .passed{background:#76d8aa}.outcome-bar .failed{background:#f08f99}.outcome-bar .missing{background:#718198}
#totals-heading{font-size:15px;color:#b8c9de;margin-bottom:2px}
.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;background:#111e2e;border-radius:16px;overflow:hidden;margin:14px 0 0}
.card{padding:20px 24px;min-width:0;border:0;background:transparent}
.card+.card{border-left:1px solid var(--line)}
.card p{margin-bottom:0}
#sample-note{font-size:12px;margin:12px 0 28px;color:#a0b3cc}
section{border:0;border-radius:16px;padding:24px;background:#111e2e;margin:24px 0}
.scoring-panel{background:#132438}
.scoring-panel h2{font-size:16px;margin-bottom:18px}
.scoring-panel p{font-size:13px}
.definition-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}
.definition-grid strong{display:block;font-size:13px;margin-bottom:8px}
.definition-grid p{margin-bottom:0}
.scoring-panel summary{color:#b5d4ff;font-size:13px}
.rubric-table{max-width:650px;margin:12px 0}
.run-actions{padding:24px;border:0;border-radius:16px;background:#132438;margin:24px 0}
.run-actions h2{font-size:17px}
.run-actions .toolbar{justify-content:space-between}
.run-actions p{font-size:13px;max-width:820px}
.history-heading{margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{text-align:left;border-bottom:1px solid var(--line);padding:14px 12px;vertical-align:top}
th{color:#a7bcd6;font-size:11px;text-transform:uppercase;letter-spacing:.07em;font-weight:600}
tbody tr:last-child td{border-bottom:0}
tbody tr:hover{background:#17283d}
.scroll{overflow:auto}
.scroll td button{font-size:13px;padding:8px 12px;background:#1e3855}
#runs td:nth-child(2){min-width:180px;max-width:300px;overflow-wrap:anywhere}
.badge{border-radius:6px;padding:4px 8px;background:#26394f;font-size:12px;white-space:nowrap}
.empty-state{text-align:center;padding:36px 20px!important;color:#b9c9df}
.empty-state strong{display:block;color:#ecf3ff;margin-bottom:8px}
.operational{margin:20px 0}
.operational>summary{padding:14px 0;color:#b9c9df;font-size:14px}
section[aria-labelledby=schedules-title]{background:transparent;padding:8px 0}
#schedules{display:block}
.schedule-card{min-width:0;overflow-wrap:anywhere}
.schedule-card p:last-child{margin-bottom:0}
#window{font-size:12px}
.agent-card p,.card p,.schedule-card p{overflow-wrap:anywhere}
.alert,.session-warning{border-left:3px solid #d5a363;border-radius:0 8px 8px 0;padding:12px;background:#30291f;margin:10px 0}
#global-busy:not(:empty),#status:not(:empty){padding:12px 16px;background:#1b2c43;border-radius:10px;margin:12px 0}
.code-notice{padding:10px 14px;background:#1b304a;border-radius:8px}
details{margin:12px 0}summary{cursor:pointer}
pre{white-space:pre-wrap;word-break:break-word;font-size:12px;color:#bbcae1}
img{max-width:100%;border-radius:10px}
time{white-space:nowrap}
dialog{width:min(1100px,calc(100vw - 32px));max-height:85vh;padding:24px;background:var(--surface);color:#e7edf6;border:0;border-radius:20px;box-shadow:0 24px 72px #0008}
dialog::backdrop{background:#060c16bd}
.close{float:right}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.session-filters{align-items:end}
.session-filters label{display:flex;flex-direction:column;gap:5px}
.session-filters input[type=search]{min-width:240px}
.session-request{min-width:180px;max-width:300px;overflow-wrap:anywhere}
.session-id{display:block;overflow-wrap:anywhere}
.session-evaluation{min-width:200px}
.session-evaluation p{margin:8px 0}
.selection-footer{position:sticky;bottom:-1px;background:var(--surface);border-top:1px solid #435772;padding:12px 0}
.selection-footer p{margin:6px 0}
#session-message,#session-state-error,#session-warning,#session-busy,#global-busy{white-space:pre-wrap}
#session-selector{width:min(1300px,calc(100vw - 24px))}
#session-selector .scroll{max-height:48vh}
.session-pagination{justify-content:space-between;margin:12px 0}
.task-score{display:inline-block;min-width:130px}
.score-calculation{display:grid;grid-template-columns:minmax(120px,1fr) minmax(120px,2fr);gap:8px 16px}
.score-calculation dt{color:var(--muted)}
.score-calculation dd{margin:0;overflow-wrap:anywhere}
#detail-body li{margin:10px 0;overflow-wrap:anywhere}
#detail-body p{overflow-wrap:anywhere}
@media(max-width:1000px){
  .agent-grid{grid-template-columns:1fr}
  .agent-card .agent-description,.agent-card .metric-detail{min-height:0}
  .agent-card .agent-link{align-self:flex-start;width:auto}
  .cards{grid-template-columns:repeat(2,minmax(0,1fr))}
  .card:nth-child(odd){border-left:0}.card:nth-child(n+3){border-top:1px solid var(--line)}
}
@media(max-width:800px){.two{grid-template-columns:1fr}}
@media(max-width:600px){
  body{padding:20px 16px}
  nav.toolbar{gap:14px;font-size:12px}
  .page-heading,.view-heading,.method-nav,.section-heading{align-items:flex-start;flex-direction:column}
  .page-heading{margin:24px 0}
  .page-heading h1{font-size:30px}
  .source-tabs button{padding:14px 12px}
  .tab-title{font-size:16px}.tab-description{font-size:11px;line-height:1.5}
  .method-nav{gap:10px}
  .agent-tabs{gap:16px}.agent-tabs button{font-size:13px;padding:12px 1px}
  #agent-panel{padding-top:20px}
  .view-heading h2{font-size:23px}.guide-link{white-space:normal}
  .section-heading{gap:8px}
  .agent-card{padding:20px}.agent-card .number{font-size:36px}
  .card{padding:16px}.card .number{font-size:28px}
  .definition-grid{grid-template-columns:1fr;gap:18px}
  section,.run-actions{padding:20px}
  .session-filters input[type=search]{min-width:0}
  dialog{padding:16px}
}
@media(max-width:500px){.score-calculation{grid-template-columns:1fr}.score-calculation dd{margin-bottom:8px}}
@media(prefers-reduced-motion:reduce){button{transition:none}}
</style></head><body>
<nav class="toolbar" aria-label="Navigation"><a href="/">Home</a><a href="/dashboards">Telemetry dashboards</a><a href="/telemetry">Trace explorer</a></nav>
<header class="page-heading"><div><p class="eyebrow">Observability / Offline evals</p><h1>Agent evaluations</h1><p>Are your agents getting the job done? Start with an overview, then explore an agent's results and the evidence behind them.</p></div><button id="refresh" class="secondary">Refresh</button></header>
<div id="status" role="status" aria-live="polite"></div><div id="global-busy" role="status"></div>
<main>
<div id="source-container" class="scope-nav">
<div id="source-tabs" class="tabs source-tabs" role="tablist" aria-label="Evaluation source">
<button type="button" id="source-tab-recorded" role="tab" aria-label="Recorded" aria-selected="true" aria-controls="source-panel"><span class="tab-title">Recorded</span><span class="tab-description">Evidence from completed real sessions</span></button>
<button type="button" id="source-tab-simulated" role="tab" aria-label="Synthetic" aria-selected="false" aria-controls="source-panel" tabindex="-1"><span class="tab-title">Synthetic</span><span class="tab-description">Controlled scenarios, no live devices</span></button>
</div>
<div id="source-panel" class="source-content" role="tabpanel" aria-labelledby="source-tab-recorded" tabindex="0">
<p id="source-description" class="muted scope-copy">Recorded evaluations grade retained evidence. They never replay real device actions.</p>
<div id="method-container" class="tab-container">
<div class="method-nav"><p class="muted">How results are evaluated</p><div id="evaluator-tabs" class="tabs" role="tablist" aria-label="Evaluation method">
<button type="button" id="evaluator-tab-llm" role="tab" aria-selected="true" aria-controls="evaluator-panel">LLM-based</button>
<button type="button" id="evaluator-tab-code" role="tab" aria-selected="false" aria-controls="evaluator-panel" tabindex="-1">Code-based</button>
</div></div>
<div id="evaluator-panel" class="method-content" role="tabpanel" aria-labelledby="evaluator-tab-llm" tabindex="0">
<div id="agent-container" class="tab-container">
<div id="agent-tabs" class="tabs agent-tabs" role="tablist" aria-label="Agent">
<button type="button" id="agent-tab-overview" role="tab" aria-selected="true" aria-controls="agent-panel">Overview</button>
${Object.values(evalAgents).map(agent => `<button type="button" id="agent-tab-${agent.id}" role="tab" aria-selected="false" aria-controls="agent-panel" tabindex="-1" data-agent-id="${agent.id}">${agent.name}</button>`).join("")}
</div>
<div id="agent-panel" role="tabpanel" aria-labelledby="agent-tab-overview" tabindex="0" aria-busy="true">
<div class="view-heading"><div><p id="scope-label" class="eyebrow">Recorded / LLM-based</p><h2 id="dashboard-title">Agent overview</h2><p id="dashboard-description" class="muted">Loading agent performance...</p></div><a class="guide-link" href="#scoring-guide">How scoring works</a></div>
<div id="overview"><div class="section-heading"><h2>Agent performance</h2><span class="muted">All retained attempts · Choose an agent to explore</span></div><div id="agent-cards" class="agent-grid"></div></div>
<h2 id="totals-heading">Source totals · All agents</h2>
<div id="cards" class="cards" aria-label="Performance metrics"></div>
<p id="sample-note" class="muted"></p>
<section class="scoring-panel" aria-labelledby="scoring-title"><h2 id="scoring-title">How to read these results</h2><div id="method-explanation"></div>
<details id="scoring-guide"><summary>Scoring rules and limitations</summary>
<div id="llm-rules"><p>Each judgment is <strong>pass</strong>, <strong>fail</strong>, <strong>unknown</strong>, or <strong>not applicable</strong>. Pass rate = passes / (passes + failures). Unknown, not-applicable and unfinished evaluations are excluded from that denominator, not counted as passes.</p><p>Task fulfillment asks whether the whole request was achieved. Handling asks whether the agent acted and recovered reasonably. Reporting asks whether its completion claim is supported. An impossible task can fail fulfillment while passing handling and reporting. For synthetic runs, code fixes the task outcome; the LLM judges handling, reporting and recovery.</p><p>Model judgments are evidence-backed assessments, not guaranteed truth. Inspect reasons and citations, and use judge validation to check reference-case agreement, not to claim general accuracy.</p></div>
<div id="recorded-code-rules" hidden><p><strong>Code calculates the TV score; an LLM assesses the inputs.</strong> This is a deterministic rubric, not an independent check of the real device. The current rubric is <code>${SCORING_VERSION}</code>; each saved result retains its original version.</p>
<div class="scroll"><table class="rubric-table"><caption class="visually-hidden">TV task progress starting scores</caption><thead><tr><th>Evidence-backed progress</th><th>Starting score</th></tr></thead><tbody><tr><td>No useful progress</td><td>${SCORING_RUBRIC.progress.none}</td></tr><tr><td>Prerequisites only</td><td>${SCORING_RUBRIC.progress.prerequisites}</td></tr><tr><td>Partial meaningful progress</td><td>${SCORING_RUBRIC.progress.partial}</td></tr><tr><td>Nearly complete</td><td>${SCORING_RUBRIC.progress.nearly_complete}</td></tr><tr><td>Whole request fulfilled</td><td>${SCORING_RUBRIC.progress.complete}</td></tr></tbody></table></div>
<p>Subtract ${SCORING_RUBRIC.deductions.minor} / ${SCORING_RUBRIC.deductions.moderate} / ${SCORING_RUBRIC.deductions.major} points for each distinct minor / moderate / major avoidable mistake. Clamp to ${SCORING_RUBRIC.completedBand.min}–${SCORING_RUBRIC.completedBand.max} for fulfilled tasks or ${SCORING_RUBRIC.incompleteBand.min}–${SCORING_RUBRIC.incompleteBand.max} for unfulfilled tasks, then cap at ${SCORING_RUBRIC.reportingCeiling} if reporting fails. Reasonable recovery, duration and model cost do not automatically deduct points.</p><p>The mean includes only numeric scores, including zero. Unscored, unavailable, unfinished and non-TV results are excluded. A score is task fulfillment, <strong>not probability or confidence</strong>. Missing required evidence means unscored, not zero.</p></div>
<div id="synthetic-code-rules" hidden><p>An independent assertion checks whether the simulator's final state satisfies the scenario's complete request. <strong>Pass rate = passed assertions / (passed + failed assertions).</strong> There is no partial-credit 0–100 task score for synthetic runs.</p><p>An assertion failure can be expected for an impossible scenario, even when handling and reporting pass. A saved assertion remains valid if later LLM grading fails. Missing assertions are unavailable, never inferred from LLM verdicts; older summaries may not retain them. Inspect an individual run for its full saved evidence.</p></div>
</details></section>
<div id="agent-detail" hidden>
<div class="run-actions">
<div id="simulated-actions" hidden><h2>Run a synthetic suite</h2><p id="suite-description"></p><div class="toolbar"><label>Alternative deployment <input id="model" placeholder="Current backend model"></label><button id="simulate">Run synthetic suite</button></div></div>
<div id="recorded-actions"><h2>Evaluate recorded sessions</h2><p id="recorded-description"></p><button id="recorded" aria-haspopup="dialog" aria-controls="session-selector">Select sessions</button></div>
<p class="muted">Launching an evaluation makes paid model calls. Changing tabs only reads saved results; it does not run or re-run an evaluation.</p>
</div>
<section aria-labelledby="history-title"><div class="history-heading"><h2 id="history-title">Evaluation history</h2><p id="history-description" class="muted"></p></div>
<div id="runs-panel" class="scroll" role="region" aria-label="Evaluation history" tabindex="0"><table><thead id="run-columns"></thead><tbody id="runs"></tbody></table></div></section>
<details id="batch-section" class="operational"><summary>Batch coverage and execution details</summary><p class="muted">Batches produce both code and LLM results. This list is restricted to the selected source and agent.</p><div id="batches"></div></details>
<section id="judge-section" aria-labelledby="judge-title"><h2 id="judge-title">Judge validation</h2><p id="judge-description"></p><button id="calibrate">Validate judge</button><div id="calibrations"></div></section>
<details id="fidelity-section" class="operational"><summary>Compare synthetic and recorded evidence</summary><p id="fidelity-note"></p><div id="fidelity"></div><p class="muted">This is an explicit cross-source comparison, not a combined score. Open a comparable pair to inspect matching objectives and exact tool calls. Unknown or incompatible metadata stays unmatched.</p></details>
</div>
<section id="alerts-section" aria-labelledby="alerts-title"><h2 id="alerts-title">Evaluation alerts</h2><p class="muted">Execution problems and confirmed LLM handling/reporting regressions. These are not numeric-score or code-assertion alerts.</p><div id="alerts"></div></section>
<section aria-labelledby="schedules-title"><h2 id="schedules-title">Daily schedule</h2><div id="schedules"><p class="muted">Schedule status unavailable — loading current configuration.</p></div></section>
<p id="window" class="muted"></p>
</div></div>
</div></div>
</div></div></main>
<dialog id="session-selector" aria-labelledby="session-selector-title" aria-describedby="session-cost">
<button class="close" id="session-close" aria-label="Close session selection">Close</button>
<h2 id="session-selector-title">Select recorded sessions</h2>
<p>Only finished sessions for the selected agent are listed, newest first. Selections are preserved separately for each agent. Assistant status is separate from evaluation lifecycle, the TV-only task eval score, and task, handling, and reporting verdicts. Previous scores belong to their completed evaluation, not a pending or failed re-evaluation.</p>
<div class="toolbar session-filters">
<label>Search request or session ID <input id="session-search" type="search" placeholder="Request or session ID" autofocus></label>
<label>Started from (New York) <input id="session-from" type="date"></label>
<label>Started through (New York) <input id="session-to" type="date"></label>
<label>Evaluation status <select id="session-filter"><option value="all">All statuses</option><option value="not_evaluated">Not evaluated</option><option value="queued">Queued</option><option value="running">Running</option><option value="evaluated">Evaluated</option><option value="eval_error">Eval error</option></select></label>
<button id="session-refresh">Refresh sessions</button>
</div>
<p class="muted">Date boundaries use America/New_York (including daylight saving time). Both dates are inclusive; the filter uses the session start time.</p>
<div id="session-warning" class="session-warning" role="status" hidden></div><button id="session-source-retry" hidden>Retry unavailable sources</button>
<div id="session-state-error" class="session-warning" role="alert" hidden></div>
<div class="toolbar"><label><input id="session-page-select" type="checkbox"> Select this page</label><button id="session-review" aria-pressed="false">Review selected</button><button id="session-clear">Clear selection</button><span id="session-selection-count" role="status"></span></div>
<p id="session-filter-note" class="muted"></p>
<div class="scroll"><table><caption class="visually-hidden">Recorded sessions available for this agent's evaluation</caption><thead><tr><th scope="col">Select</th><th scope="col">Request / session ID</th><th scope="col">Started (New York)</th><th scope="col">Assistant status / sources</th><th scope="col">Evaluation / score / verdicts</th><th scope="col">History</th></tr></thead><tbody id="session-rows"></tbody></table></div>
<div class="toolbar session-pagination"><button id="session-prev">Previous page</button><span id="session-page-count" role="status"></span><button id="session-next">Next page</button></div>
<div class="selection-footer"><p id="session-summary"></p><p id="session-cost">Grading makes paid model calls using currently retained evidence. It never replays device actions. Re-evaluation preserves earlier attempts and their evidence; changed verdicts may reflect changed evidence, not just a different judge.</p><p class="muted">Closing this dialog or page does not cancel an accepted batch. Results update as individual sessions finish.</p><div id="session-busy" role="status"></div><div id="session-message" role="status" aria-live="polite"></div><button id="session-run" disabled>Run selected evaluations</button></div>
</dialog>
<dialog id="detail" aria-labelledby="detail-title"><button class="close" id="close">Close</button><h2 id="detail-title">Evaluation details</h2><div id="detail-body"></div></dialog>
<script src="/dashboards/evals/browser.js" defer></script></body></html>`;
