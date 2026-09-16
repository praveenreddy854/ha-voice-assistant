import test from "node:test";
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { EvalStore } from "../src/evals/store";
import { EvalSupervisor } from "../src/evals/supervisor";
import { EvalRunner } from "../src/evals/runner";
import { RECORDED_IMPORT_VERSION } from "../src/evals/recorded";
import { recordedHistories } from "../src/evals/history";
import { baselineFor, isDue, localDay } from "../src/evals/analytics";
import { discoverRecordedSessions, mergeRecordedSessions, type SessionDiscovery, type SessionTraceMetadata } from "../src/evals/sessions";
import {
  recordedSelection, scheduleConfiguration, scheduledIdentity, simulatedSkippedDays, updateRecordedDailyOutcome,
  type RecordedDailyOutcome,
} from "../src/evals/scheduling";
import { EVAL_AGENT_IDS, type Assessment, type EvalBatch, type EvalRun, type Grade, type RecordedEvalAttempt } from "../src/evals/types";
import type { EvalJob } from "../src/evals/worker";

const START = "2026-09-15T04:30:00.000Z"; // 00:30 in New York
const DUE = "2026-09-15T05:00:00.000Z";
const session = (sessionId: string, startedAt = "2026-09-15T04:45:00Z"): SessionDiscovery["sessions"][number] => ({
  sessionId, agentId: "tv", startedAt, completedAt: startedAt, status: "completed", userPrompt: "Open YouTube", sources: ["telemetry"],
});
const judgment = { verdict: "pass" as const, reason: "Observed", evidenceIds: ["e1"] };
const grade: Grade = {
  task: judgment, handling: judgment, reporting: judgment, recovery: judgment, steps: [], gaps: [],
  context: { task: "open", app: "YouTube", target: "TV", startingState: "home" },
};
const assessment = (sessionId: string): Assessment => ({
  agentId: "tv", mode: "recorded", sourceSessionId: sessionId, request: "Open YouTube", finalResponse: "Done",
  startedAt: START, coverage: "complete", evidence: [{ id: "e1", kind: "final", text: "YouTube visible" }],
});

async function withStore(work: (store: EvalStore) => Promise<void>): Promise<void> {
  const directory = path.resolve(`.recorded-eval-scheduling-${randomUUID()}`);
  await mkdir(directory);
  try { await work(new EvalStore(directory)); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

function harness(store: EvalStore) {
  const state = {
    now: new Date(START), env: {} as NodeJS.ProcessEnv,
    discovery: { sessions: [session("new")], warnings: [] } as SessionDiscovery,
    reads: 0, spawns: [] as Array<{ job: EvalJob; child: ChildProcess }>,
    discover: undefined as (() => Promise<SessionDiscovery>) | undefined,
  };
  const supervisor = new EvalSupervisor(store, job => {
    const child = new ChildProcess();
    child.kill = () => true;
    state.spawns.push({ job: structuredClone(job), child });
    return child;
  }, {
    now: () => state.now, configuration: () => scheduleConfiguration(state.env),
    discover: async () => { state.reads++; return state.discover ? state.discover() : state.discovery; },
  });
  return {
    state, supervisor,
    async tick(at: string) { state.now = new Date(at); await supervisor.tick(); },
    async complete(status: "completed" | "failed" = "completed") {
      const { job, child } = state.spawns.at(-1)!;
      const saved = await store.read<EvalJob>("jobs", job.id);
      const finished: EvalJob = { ...job, ...saved, status, finishedAt: state.now.toISOString(), error: status === "failed" ? "Fake worker failure" : undefined };
      if (status === "failed") await store.failJob(finished, finished.error!);
      else {
        await store.finishRecordedAttempts(finished, "Fake worker completed without grading");
        await store.write("jobs", finished);
        await updateRecordedDailyOutcome(store, finished);
      }
      child.emit("exit", status === "completed" ? 0 : 1);
      await supervisor.busy();
    },
  };
}

async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let index = 0; index < 200; index++) {
    if (await condition()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail("Condition was not reached");
}

test("default flags honor both overrides, and schedule status is a read-only metadata query", () => withStore(async store => {
  assert.deepEqual(scheduleConfiguration({}), { simulated: true, recorded: true });
  assert.deepEqual(scheduleConfiguration({ OFFLINE_EVAL_ENABLED: "false" }), { simulated: false, recorded: false });
  assert.deepEqual(scheduleConfiguration({ OFFLINE_RECORDED_EVAL_ENABLED: "false" }), { simulated: true, recorded: false });
  const { supervisor, state } = harness(store);
  const status = await supervisor.scheduleStatus();
  assert.equal(status.timezone, "America/New_York");
  assert.deepEqual(status.simulated, { enabled: true, hour: 3 });
  assert.deepEqual(status.recorded, { enabled: true, hour: 1, enabledAt: undefined, latest: undefined });
  assert.deepEqual(await readdir(store.directory), []);
  assert.equal(state.reads, 0);
  assert.equal(state.spawns.length, 0);
}));

test("startup persists the cutoff before due time, and restart plus disable/re-enable never reset it", () => withStore(async store => {
  const first = harness(store);
  first.supervisor.start();
  try {
    await waitFor(async () => (await first.supervisor.scheduleStatus()).recorded.enabledAt === START);
    assert.equal(first.state.reads, 0);
    assert.equal(first.state.spawns.length, 0);
  } finally { first.supervisor.stop(); }
  const second = harness(store);
  second.state.env.OFFLINE_RECORDED_EVAL_ENABLED = "false";
  await second.tick("2026-09-16T04:30:00Z");
  assert.equal((await second.supervisor.scheduleStatus()).recorded.enabledAt, START);
  second.state.env.OFFLINE_RECORDED_EVAL_ENABLED = "true";
  second.state.discovery.sessions = [session("since-startup"), session("old", "2026-09-15T04:00:00Z")];
  await second.tick("2026-09-16T05:00:00Z");
  assert.deepEqual(second.state.spawns[0].job.sessionIds, ["since-startup"]);
  assert.equal((await second.supervisor.scheduleStatus()).recorded.enabledAt, START);
  await second.complete();
}));

test("first disabled startup has no cutoff, and both scheduler flags leave explicit manual runs available", () => withStore(async store => {
  const fixture = harness(store);
  fixture.state.env.OFFLINE_EVAL_ENABLED = "false";
  fixture.supervisor.start();
  await fixture.supervisor.busy();
  await fixture.tick(DUE);
  assert.equal((await fixture.supervisor.scheduleStatus()).recorded.enabledAt, undefined);
  await fixture.supervisor.launch({ mode: "recorded", sessionIds: ["historical-session"] });
  assert.equal(fixture.state.spawns[0].job.attempt, "on_demand");
  await fixture.complete();
  delete fixture.state.env.OFFLINE_EVAL_ENABLED;
  fixture.state.env.OFFLINE_RECORDED_EVAL_ENABLED = "false";
  await fixture.tick("2026-09-16T05:00:00Z");
  assert.equal((await fixture.supervisor.scheduleStatus()).recorded.enabledAt, undefined);
  await fixture.supervisor.launch({ mode: "recorded", sessionIds: ["historical-session"] });
  await fixture.complete();
  delete fixture.state.env.OFFLINE_RECORDED_EVAL_ENABLED;
  await fixture.tick("2026-09-17T04:30:00Z");
  assert.equal((await fixture.supervisor.scheduleStatus()).recorded.enabledAt, "2026-09-17T04:30:00.000Z");
  await fixture.tick("2026-09-17T05:00:00Z");
  assert.equal(fixture.state.spawns.length, 2);
  assert.equal((await fixture.supervisor.scheduleStatus()).recorded.latest?.status, "empty");
}));

test("cutoff is initialized at startup even while a prior manual worker occupies admission", () => withStore(async store => {
  const fixture = harness(store);
  await fixture.supervisor.launch({ mode: "recorded", sessionIds: ["manual"] });
  fixture.supervisor.start();
  try {
    await waitFor(async () => (await fixture.supervisor.scheduleStatus()).recorded.enabledAt === START);
    await fixture.tick(DUE);
    assert.equal(fixture.state.reads, 0);
  } finally { fixture.supervisor.stop(); }
  await fixture.complete();
}));

test("eligibility uses existing terminal TV discovery, validates start times, and includes failed real runs", () => {
  const trace = (id: string, overrides: Partial<SessionTraceMetadata> = {}): SessionTraceMetadata => ({
    sessionId: id, agentType: "tv", userPrompt: "Open YouTube", startedAt: START, completedAt: DUE, status: "completed", ...overrides,
  });
  const discovery = mergeRecordedSessions([
    trace("boundary"), trace("older", { startedAt: "2026-09-15T04:29:59.999Z" }),
    trace("future", { startedAt: "2026-09-15T05:00:00.001Z" }),
    trace("invalid", { startedAt: "invalid" }), trace("missing", { startedAt: "" }),
    trace("running", { status: "running" }), trace("unfinished", { completedAt: undefined }),
    trace("other-agent", { agentType: "scheduled_task" }), trace("voice-agent", { agentType: "realtime" }),
    trace("other-invalid", { agentType: "realtime", startedAt: "invalid" }), trace("errored", { status: "error" }),
    trace("current", { startedAt: DUE }),
  ], [{ sessionId: "cosmos-failed", agent: "tv", status: "failed", userPrompt: "Open YouTube", createdAt: START }]);
  const selected = recordedSelection(discovery, new Map(), START, new Date(DUE));
  assert.deepEqual(selected.sessionIds, ["boundary", "cosmos-failed", "errored", "current"]);
  assert.equal(selected.warnings.length, 2);
  assert.ok(selected.warnings.every(warning => warning.includes("automatic eligibility is unknown")));
  assert.throws(() => recordedSelection(discovery, new Map(), "invalid", new Date(DUE)), /timestamp/);
});

test("the 1am scheduler explicitly selects only TV from all-agent discovery", () => withStore(async store => {
  const fixture = harness(store);
  fixture.state.discovery.sessions = [
    ...Array.from({ length: 105 }, (_, index) => ({
      ...session(`other-${index}`, START), agentId: index % 2 ? "scheduled_task" : "realtime",
    })),
    session("tv-after-other-agents"),
  ];
  await fixture.tick(START);
  await fixture.tick(DUE);
  const job = fixture.state.spawns[0].job;
  assert.equal(job.mode, "recorded");
  assert.equal(job.agentId, "tv");
  assert.deepEqual(job.sessionIds, ["tv-after-other-agents"]);
  assert.equal((await fixture.supervisor.scheduleStatus()).recorded.latest?.selectedCount, 1);
  await fixture.complete();
  await fixture.tick("2026-09-16T05:00:00Z");
  assert.equal(fixture.state.spawns.length, 1);
  assert.equal((await fixture.supervisor.scheduleStatus()).recorded.latest?.status, "empty");
}));

test("manual recorded admission supports every registered agent and scopes prior attempts to that agent", () => withStore(async store => {
  const fixture = harness(store);
  await fixture.tick(START);
  for (const agentId of EVAL_AGENT_IDS) {
    const sessionId = agentId === "tv" ? "manual-tv" : "new";
    const job = await fixture.supervisor.launch({ mode: "recorded", agentId, sessionIds: [sessionId] });
    assert.equal(job.agentId, agentId);
    assert.equal(job.attempt, "on_demand");
    await fixture.complete();
  }
  await fixture.tick(DUE);
  assert.deepEqual(fixture.state.spawns[3].job.sessionIds, ["new"]);
  assert.equal(fixture.state.spawns[3].job.agentId, "tv");
  await fixture.complete();
  await assert.rejects(fixture.supervisor.launch({ mode: "recorded", agentId: "unknown", sessionIds: ["new"] }), /not registered/);
}));

test("invalid eligibility timestamps produce an incomplete warning rather than verified empty coverage", () => withStore(async store => {
  const fixture = harness(store);
  fixture.state.discovery.sessions = [session("missing-time", "")];
  await fixture.tick(START);
  await fixture.tick(DUE);
  const latest = (await fixture.supervisor.scheduleStatus()).recorded.latest;
  assert.equal(latest?.status, "incomplete_discovery");
  assert.equal(latest?.selectedCount, 0);
  assert.match(latest?.warnings[0] || "", /invalid or missing start time/);
  assert.equal(fixture.state.spawns.length, 0);
  await fixture.tick("2026-09-15T06:00:00Z");
  assert.equal(fixture.state.reads, 1);
}));

test("discovery crossing midnight defers backlog without accepting an expired daily slot", () => withStore(async store => {
  const fixture = harness(store);
  await fixture.tick(START);
  fixture.state.discover = async () => {
    fixture.state.now = new Date("2026-09-16T04:00:01Z");
    return fixture.state.discovery;
  };
  await fixture.tick("2026-09-16T03:59:59Z");
  assert.equal(fixture.state.spawns.length, 0);
  assert.deepEqual(await store.list("schedule-days"), []);
  assert.deepEqual(await store.list("attempts"), []);
  fixture.state.discover = undefined;
  await fixture.tick("2026-09-16T05:00:00Z");
  assert.equal(fixture.state.spawns[0].job.scheduledDay, "2026-09-16");
  assert.deepEqual(fixture.state.spawns[0].job.sessionIds, ["new"]);
  await fixture.complete();
}));

test("disabling recorded scheduling during discovery prevents a late admission", () => withStore(async store => {
  const fixture = harness(store);
  await fixture.tick(START);
  fixture.state.discover = async () => {
    fixture.state.env.OFFLINE_RECORDED_EVAL_ENABLED = "false";
    return fixture.state.discovery;
  };
  await fixture.tick(DUE);
  assert.equal(fixture.state.spawns.length, 0);
  assert.deepEqual(await store.list("schedule-days"), []);
  fixture.state.discover = undefined;
  delete fixture.state.env.OFFLINE_RECORDED_EVAL_ENABLED;
  await fixture.tick(DUE);
  assert.equal(fixture.state.spawns.length, 1);
  await fixture.complete();
}));

test("a live daily claim awaiting its job write is queued and busy, not falsely interrupted", () => withStore(async store => {
  const fixture = harness(store), observer = harness(store);
  await fixture.tick(START);
  const write = store.write.bind(store);
  let releaseJob: () => void = () => {};
  const jobGate = new Promise<void>(resolve => { releaseJob = resolve; });
  store.write = async (kind, item) => {
    if (kind === "jobs") await jobGate;
    await write(kind, item);
  };
  const pending = fixture.tick(DUE);
  try {
    await waitFor(async () => Boolean(await store.read("schedule-days", "recorded-2026-09-15")));
    assert.equal((await observer.supervisor.scheduleStatus()).recorded.latest?.status, "queued");
    assert.equal(await observer.supervisor.busy(), true);
  } finally {
    releaseJob();
    await pending;
    store.write = write;
  }
  await fixture.complete();
}));

test("every previous attempt status, legacy verdict, and error-only job excludes automatic selection", () => withStore(async store => {
  const fixture = harness(store);
  const statuses: RecordedEvalAttempt["status"][] = ["queued", "running", "evaluated", "eval_error"];
  for (const status of statuses) await store.write<RecordedEvalAttempt>("attempts", {
    id: status, jobId: `old-${status}`, sourceSessionId: status, status, requestedAt: START,
  });
  const legacyRun = (id: string, status: EvalRun["status"], verdict: "pass" | "fail" | "unknown"): EvalRun => ({
    id, batchId: "legacy-batch", mode: "recorded", agentId: "tv", sourceSessionId: id, status, attempt: "on_demand",
    adapterVersion: "1", graderVersion: "1", judgeModel: "judge", assessedAt: START, gradedAt: DUE,
    grade: { ...grade, task: { ...judgment, verdict } },
  });
  for (const verdict of ["pass", "fail", "unknown"] as const) await store.saveRun(legacyRun(`legacy-${verdict}`, "completed", verdict));
  await store.saveRun(legacyRun("legacy-error", "grading_error", "unknown"));
  await store.write<EvalJob>("jobs", { id: "old-error-job", mode: "recorded", sessionIds: ["error-only"], status: "failed", createdAt: START });
  fixture.state.discovery.sessions = [...statuses, "legacy-pass", "legacy-fail", "legacy-unknown", "legacy-error", "error-only", "new"].map(id => session(id));
  await fixture.tick(START);
  await fixture.tick(DUE);
  assert.deepEqual(fixture.state.spawns[0].job.sessionIds, ["new"]);
  assert.equal((await recordedHistories(store)).get("eval_error")?.attempts[0].status, "eval_error");
  await fixture.complete();
}));

test("the oldest 100 available sessions are frozen once; overflow and new arrivals wait for a later day", () => withStore(async store => {
  const fixture = harness(store);
  fixture.state.discovery.sessions = Array.from({ length: 103 }, (_, index) =>
    session(`session-${String(index).padStart(3, "0")}`, new Date(Date.parse(START) + index * 1000).toISOString())).reverse();
  await fixture.tick(START);
  await fixture.tick(DUE);
  const selected = fixture.state.spawns[0].job.sessionIds!;
  assert.equal(selected.length, 100);
  assert.deepEqual([selected[0], selected[99]], ["session-000", "session-099"]);
  fixture.state.discovery.sessions.push(session("new-arrival", "2026-09-15T05:01:00Z"));
  await fixture.complete();
  await fixture.tick("2026-09-15T06:00:00Z");
  assert.equal(fixture.state.spawns.length, 1);
  assert.equal(fixture.state.reads, 1);
  await fixture.tick("2026-09-17T05:00:00Z");
  assert.deepEqual(fixture.state.spawns[1].job.sessionIds, ["session-100", "session-101", "session-102", "new-arrival"]);
  assert.equal(fixture.state.spawns[1].job.scheduledDay, "2026-09-17");
  assert.deepEqual((await store.list<RecordedDailyOutcome>("schedule-days")).map(outcome => outcome.day).sort(), ["2026-09-15", "2026-09-17"]);
  await fixture.complete();
}));

test("empty discovery persists a terminal no-op, including across supervisor instances", () => withStore(async store => {
  const fixture = harness(store);
  fixture.state.discovery.sessions = [];
  await fixture.tick(START);
  await fixture.tick(DUE);
  assert.equal(fixture.state.spawns.length, 0);
  assert.equal((await fixture.supervisor.scheduleStatus()).recorded.latest?.status, "empty");
  fixture.state.discovery.sessions.push(session("later"));
  await fixture.tick("2026-09-15T06:00:00Z");
  const restarted = harness(store);
  await restarted.tick("2026-09-15T06:00:00Z");
  assert.equal(restarted.state.reads, 0);
  assert.equal((await store.list("jobs")).length, 0);
  assert.equal(fixture.state.reads, 1);
}));

test("partial discovery grades available sources and preserves warnings through completion", () => withStore(async store => {
  const fixture = harness(store);
  fixture.state.discover = () => discoverRecordedSessions({
    loadTelemetry: () => [{ sessionId: "available", agentType: "tv", userPrompt: "Open YouTube", startedAt: START, completedAt: DUE, status: "error" }],
    loadCosmos: async () => { throw new Error("Synthetic Cosmos unavailable"); },
  });
  await fixture.tick(START);
  await fixture.tick(DUE);
  assert.deepEqual(fixture.state.spawns[0].job.sessionIds, ["available"]);
  assert.match((await fixture.supervisor.scheduleStatus()).recorded.latest!.warnings.join(" "), /Cosmos source unavailable/);
  await fixture.complete();
  const latest = (await fixture.supervisor.scheduleStatus()).recorded.latest!;
  assert.equal(latest.status, "completed");
  assert.match(latest.warnings.join(" "), /Synthetic Cosmos/);
}));

test("incomplete empty discovery and wholly unavailable discovery have distinct terminal outcomes", () => withStore(async store => {
  const fixture = harness(store);
  fixture.state.discovery = { sessions: [], warnings: ["Cosmos source unavailable: Synthetic failure"] };
  await fixture.tick(START);
  await fixture.tick(DUE);
  assert.equal((await fixture.supervisor.scheduleStatus()).recorded.latest?.status, "incomplete_discovery");
  fixture.state.discover = () => discoverRecordedSessions({
    loadTelemetry: () => { throw new Error("Telemetry unavailable"); }, loadCosmos: async () => null,
  });
  await fixture.tick("2026-09-16T05:00:00Z");
  const latest = (await fixture.supervisor.scheduleStatus()).recorded.latest!;
  assert.equal(latest.status, "failed");
  assert.match(latest.error!, /No retained-session source is available/);
  await fixture.tick("2026-09-16T06:00:00Z");
  assert.equal(fixture.state.reads, 2);
  assert.equal(fixture.state.spawns.length, 0);
}));

test("an unreadable attempt or legacy history store blocks grading rather than resetting evaluation status", async t => {
  for (const kind of ["attempts", "summaries", "jobs", "batches"]) {
    await t.test(kind, () => withStore(async store => {
      const fixture = harness(store);
      await fixture.tick(START);
      await mkdir(path.join(store.directory, kind), { recursive: true });
      await writeFile(path.join(store.directory, kind, "corrupt.json"), "{");
      await fixture.tick(DUE);
      assert.equal(fixture.state.spawns.length, 0);
      const latest = (await fixture.supervisor.scheduleStatus()).recorded.latest!;
      assert.equal(latest.status, "failed");
      assert.ok(latest.error);
      await fixture.tick("2026-09-15T06:00:00Z");
      assert.equal(fixture.state.spawns.length, 0);
    }));
  }
});

test("concurrent polls and independent supervisors share one mode/day claim and one worker", () => withStore(async store => {
  const first = harness(store), second = harness(store);
  await Promise.all([first.tick(START), second.tick(START)]);
  await Promise.all([first.tick(DUE), first.tick(DUE), second.tick(DUE)]);
  assert.equal(first.state.spawns.length + second.state.spawns.length, 1);
  assert.equal((await store.list("jobs")).length, 1);
  assert.equal((await store.list("attempts")).length, 1);
  const winner = first.state.spawns.length ? first : second;
  await winner.complete();
  await Promise.all([first.tick("2026-09-15T06:00:00Z"), second.tick("2026-09-15T06:00:00Z")]);
  assert.equal(first.state.spawns.length + second.state.spawns.length, 1);
}));

test("portal admission cannot race discovery, and completed portal work is excluded on same-day catch-up", () => withStore(async store => {
  const scheduled = harness(store), portal = harness(store);
  await scheduled.tick(START);
  await portal.supervisor.launch({ mode: "recorded", sessionIds: ["new"] });
  await scheduled.tick(DUE);
  assert.equal(scheduled.state.reads, 0);
  assert.equal((await scheduled.supervisor.scheduleStatus()).recorded.latest, undefined);
  await portal.complete();
  scheduled.state.discovery.sessions.push(session("still-new"));
  let resolveDiscovery: ((discovery: SessionDiscovery) => void) | undefined;
  scheduled.state.discover = () => new Promise(resolve => { resolveDiscovery = resolve; });
  const tick = scheduled.tick("2026-09-15T06:00:00Z");
  await waitFor(async () => resolveDiscovery !== undefined);
  await assert.rejects(portal.supervisor.launch({ mode: "recorded", sessionIds: ["still-new"] }), /submission is already in progress/);
  resolveDiscovery!(scheduled.state.discovery);
  await tick;
  assert.deepEqual(scheduled.state.spawns[0].job.sessionIds, ["still-new"]);
  await scheduled.complete();
}));

test("history is refreshed at admission instead of trusting a stale never-evaluated discovery list", () => withStore(async store => {
  const fixture = harness(store);
  await fixture.tick(START);
  fixture.state.discover = async () => {
    await store.write<RecordedEvalAttempt>("attempts", {
      id: "admitted-before-refresh", jobId: "portal", sourceSessionId: "new", status: "eval_error", requestedAt: START,
    });
    return fixture.state.discovery;
  };
  await fixture.tick(DUE);
  assert.equal(fixture.state.spawns.length, 0);
  assert.equal((await fixture.supervisor.scheduleStatus()).recorded.latest?.status, "empty");
}));

test("recorded and simulated schedules coexist during late catch-up without cross-mode day guards", () => withStore(async store => {
  const fixture = harness(store);
  await fixture.tick(START);
  await fixture.tick("2026-09-15T16:00:00Z");
  assert.equal(fixture.state.spawns[0].job.mode, "recorded");
  await fixture.complete();
  for (const [index, agentId] of EVAL_AGENT_IDS.entries()) {
    await fixture.tick("2026-09-15T16:01:00Z");
    assert.equal(fixture.state.spawns.length, index + 2);
    const job = fixture.state.spawns[index + 1].job;
    assert.equal(job.mode, "simulated");
    assert.equal(job.agentId, agentId);
    assert.equal(job.scheduledDay, "2026-09-15");
    await fixture.tick("2026-09-15T16:02:00Z");
    assert.equal(fixture.state.spawns.length, index + 2);
    await fixture.complete(index === 1 ? "failed" : "completed");
  }
  await fixture.tick("2026-09-15T17:00:00Z");
  const restarted = harness(store);
  await restarted.tick("2026-09-15T18:00:00Z");
  assert.equal(restarted.state.spawns.length, 0);
  assert.equal(fixture.state.spawns.length, 4);
  assert.equal(new Set(fixture.state.spawns.map(({ job }) => job.id)).size, 4);
  assert.equal((await store.list("jobs")).length, 4);
  assert.equal((await fixture.supervisor.scheduleStatus()).recorded.latest?.status, "completed");
}));

test("legacy agent-less simulated jobs suppress only TV, never another agent or mode", () => withStore(async store => {
  const fixture = harness(store);
  await fixture.tick(START);
  await store.write<EvalJob>("jobs", {
    id: "scheduled-simulated-2026-09-15", mode: "simulated", scheduledDay: "2026-09-15", status: "failed",
  });
  await fixture.tick("2026-09-15T07:00:00Z");
  assert.equal(fixture.state.spawns[0].job.mode, "recorded");
  await fixture.complete();
  for (const [index, agentId] of ["scheduled_task", "realtime"].entries()) {
    await fixture.tick("2026-09-15T07:01:00Z");
    assert.equal(fixture.state.spawns.length, index + 2);
    assert.equal(fixture.state.spawns[index + 1].job.agentId, agentId);
    assert.equal(fixture.state.spawns[index + 1].job.mode, "simulated");
    await fixture.complete();
  }
  await fixture.tick("2026-09-15T08:00:00Z");
  assert.equal(fixture.state.spawns.length, 3);
  assert.equal((await store.list("jobs")).length, 4);
}));

test("a simulated daily batch does not suppress a recorded catch-up for the same date", () => withStore(async store => {
  const fixture = harness(store);
  await fixture.tick(START);
  await store.write<EvalBatch>("batches", {
    id: "already-simulated", agentId: "tv", mode: "simulated", scheduledDay: "2026-09-15",
    attempt: "scheduled", startedAt: DUE, status: "completed", runIds: [],
  });
  await fixture.tick("2026-09-15T16:00:00Z");
  assert.equal(fixture.state.spawns.length, 1);
  assert.equal(fixture.state.spawns[0].job.mode, "recorded");
  await fixture.complete();
}));

test("the repeated autumn 1am hour uses one New York date and does not repeat an empty batch", () => withStore(async store => {
  const fixture = harness(store);
  fixture.state.discovery.sessions = [];
  await fixture.tick("2026-11-01T04:30:00Z");
  assert.equal(isDue(new Date("2026-11-01T04:59:00Z"), 1), false);
  for (const time of ["2026-11-01T05:00:00Z", "2026-11-01T06:00:00Z"]) {
    assert.equal(isDue(new Date(time), 1), true);
    assert.equal(localDay(new Date(time)), "2026-11-01");
    await fixture.tick(time);
  }
  assert.equal(fixture.state.reads, 1);
  assert.equal((await store.list("schedule-days")).length, 1);
  assert.notEqual(scheduledIdentity("recorded", "2026-11-01"), scheduledIdentity("simulated", "2026-11-01"));
  assert.equal(isDue(new Date("2026-11-01T07:59:00Z")), false);
  assert.equal(isDue(new Date("2026-11-01T08:00:00Z")), true);
}));

test("failed startup or interrupted grading is terminal for its day and requires explicit retry", () => withStore(async store => {
  const fixture = harness(store);
  await fixture.tick(START);
  const broken = new EvalSupervisor(store, () => { throw new Error("Synthetic fork failure"); }, {
    now: () => new Date(DUE), discover: async () => fixture.state.discovery, configuration: () => scheduleConfiguration({}),
  });
  await broken.tick();
  const latest = (await broken.scheduleStatus()).recorded.latest!;
  assert.equal(latest.status, "failed");
  assert.equal(latest.selectedCount, 1);
  assert.match(latest.error!, /Synthetic fork/);
  assert.equal((await recordedHistories(store)).get("new")?.attempts[0].status, "eval_error");
  await fixture.tick("2026-09-15T06:00:00Z");
  await fixture.tick("2026-09-16T05:00:00Z");
  assert.equal(fixture.state.spawns.length, 0);
  await fixture.supervisor.launch({ mode: "recorded", sessionIds: ["new"] });
  assert.equal((await recordedHistories(store)).get("new")?.attempts.length, 2);
  fixture.state.spawns[0].child.emit("exit", 1);
  await fixture.supervisor.busy();
  assert.equal((await recordedHistories(store)).get("new")?.attempts[0].status, "eval_error");
}));

test("a scheduled worker interruption preserves errors and remains terminal across restart", () => withStore(async store => {
  const fixture = harness(store);
  fixture.state.discovery.sessions = [session("started"), session("queued")];
  await fixture.tick(START);
  await fixture.tick(DUE);
  const attempts = await store.list<RecordedEvalAttempt>("attempts");
  const started = attempts.find(attempt => attempt.sourceSessionId === "started")!;
  await store.write("attempts", { ...started, status: "running", startedAt: DUE });
  fixture.state.spawns[0].child.emit("exit", 1);
  await fixture.supervisor.busy();
  const histories = await recordedHistories(store);
  assert.doesNotMatch(histories.get("started")!.attempts[0].error!, /never started/);
  assert.match(histories.get("queued")!.attempts[0].error!, /never started/);
  const restarted = harness(store);
  restarted.state.discovery.sessions = fixture.state.discovery.sessions;
  await restarted.tick("2026-09-15T06:00:00Z");
  assert.equal((await restarted.supervisor.scheduleStatus()).recorded.latest?.status, "failed");
  await restarted.tick("2026-09-16T05:00:00Z");
  assert.equal(restarted.state.spawns.length, 0);
}));

test("an interrupted daily claim without a job is reported read-only and reconciled without retry", () => withStore(async store => {
  const fixture = harness(store);
  await fixture.tick(START);
  const claim: RecordedDailyOutcome = {
    id: scheduledIdentity("recorded", "2026-09-15"), mode: "recorded", day: "2026-09-15", status: "queued",
    selectedCount: 1, sessionIds: ["new"], warnings: ["Cosmos source unavailable"], jobId: "unsaved-job", createdAt: DUE,
  };
  await store.write("schedule-days", claim);
  assert.equal((await fixture.supervisor.scheduleStatus()).recorded.latest?.status, "failed");
  assert.equal((await store.read<RecordedDailyOutcome>("schedule-days", claim.id))?.status, "queued");
  await fixture.tick(DUE);
  const reconciled = await store.read<RecordedDailyOutcome>("schedule-days", claim.id);
  assert.equal(reconciled?.status, "failed");
  assert.equal(fixture.state.reads, 0);
  assert.equal(fixture.state.spawns.length, 0);
}));

test("recorded scheduled provenance reaches the batch, each saved run and summary, including import errors", () => withStore(async store => {
  const fixture = harness(store);
  fixture.state.discovery.sessions = [session("good"), session("missing")];
  await fixture.tick(START);
  await fixture.tick(DUE);
  const job = fixture.state.spawns[0].job;
  assert.equal(job.attempt, "scheduled");
  assert.equal(job.scheduledDay, "2026-09-15");
  let calls = 0;
  const runner = new EvalRunner(store, async () => { calls++; return { grade }; }, "fake-judge", "fake-grader");
  const batch = await runner.recorded("tv", job.sessionIds!.map(sessionId => ({
    sessionId, load: async () => {
      if (sessionId === "missing") throw new Error("Synthetic missing retained evidence");
      return assessment(sessionId);
    },
  })), new AbortController().signal, { jobId: job.id, scheduledDay: job.scheduledDay });
  assert.equal(calls, 1);
  assert.equal(batch.attempt, "scheduled");
  assert.equal(batch.scheduledDay, job.scheduledDay);
  assert.equal(batch.status, "incomplete");
  for (const kind of ["runs", "summaries"]) {
    const runs = await store.list<EvalRun>(kind);
    assert.equal(runs.length, 2);
    assert.ok(runs.every(run => run.mode === "recorded" && run.attempt === "scheduled" && run.scheduledDay === job.scheduledDay));
    assert.ok(runs.every(run => run.adapterVersion === RECORDED_IMPORT_VERSION));
  }
  await fixture.complete("failed");
  assert.equal((await fixture.supervisor.scheduleStatus()).recorded.latest?.status, "failed");
}));

test("recorded adapter overrides retain scheduled provenance and reject cross-agent assessments before judging", () => withStore(async store => {
  let calls = 0;
  const runner = new EvalRunner(store, async () => { calls++; return { grade }; }, "fake-judge", "fake-grader");
  const batch = await runner.recorded("realtime", [
    { sessionId: "valid", load: async () => ({ ...assessment("valid"), agentId: "realtime" }) },
    { sessionId: "wrong-agent", load: async () => assessment("wrong-agent") },
  ], new AbortController().signal, { adapterVersion: "retained-realtime-fixture", scheduledDay: "2026-09-15" });
  assert.equal(calls, 1);
  assert.equal(batch.attempt, "scheduled");
  assert.equal(batch.status, "incomplete");
  const runs = await store.list<EvalRun>("runs");
  assert.ok(runs.every(run => run.agentId === "realtime" && run.adapterVersion === "retained-realtime-fixture" &&
    run.scheduledDay === "2026-09-15" && run.attempt === "scheduled"));
  const rejected = runs.find(run => run.sourceSessionId === "wrong-agent")!;
  assert.equal(rejected.status, "execution_error");
  assert.equal(rejected.assessment, undefined);
  assert.match(rejected.error!, /agent or mode/);
}));

test("simulated runner deduplicates agent, mode and day independently, with per-agent skipped history", () => withStore(async store => {
  const day = "2026-09-15", executions: string[] = [];
  const runner = new EvalRunner(store, async () => ({ grade }), "fake-judge", "fake-grader");
  for (const agentId of EVAL_AGENT_IDS) {
    await store.write<EvalBatch>("batches", {
      id: `${agentId}-recorded`, agentId, mode: "recorded", attempt: "scheduled", scheduledDay: day,
      startedAt: DUE, status: "completed", runIds: [],
    });
    const adapter = {
      id: agentId, version: "1", model: "fake", promptVersion: "fake",
      scenarios: [{ id: "same-scenario", version: "1", request: "Fixture", context: grade.context, expectations: "Fixture", initial: {} }],
      execute: async (): Promise<Assessment> => {
        executions.push(agentId);
        return { ...assessment("sim"), agentId, mode: "simulated" };
      },
    };
    const first = await runner.simulated(adapter, new AbortController().signal, { scheduledDay: day });
    const repeated = await runner.simulated(adapter, new AbortController().signal, { scheduledDay: day });
    assert.equal(first.id, repeated.id);
    assert.equal(first.mode, "simulated");
    assert.equal(first.status, "completed");
  }
  assert.deepEqual(executions, [...EVAL_AGENT_IDS]);
  assert.equal(new Set((await store.list<EvalRun>("runs")).map(run => run.batchId)).size, 3);
  const prior = (agentId: string | undefined, scheduledDay: string): EvalBatch => ({
    id: `${agentId || "legacy"}-${scheduledDay}`, agentId: agentId!, scheduledDay, mode: "simulated",
    attempt: "scheduled", startedAt: START, status: "completed", runIds: [],
  });
  const history = [
    prior(undefined, "2026-09-10"), prior("scheduled_task", "2026-09-12"), prior("realtime", "2026-09-14"),
    ...(await store.list<EvalBatch>("batches")),
  ];
  assert.deepEqual(simulatedSkippedDays(history, day, "tv"), ["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"]);
  assert.deepEqual(simulatedSkippedDays(history, day, "scheduled_task"), ["2026-09-13", "2026-09-14"]);
  assert.deepEqual(simulatedSkippedDays(history, day, "realtime"), []);
}));

test("scheduled recorded batches neither replace simulated execution nor contaminate skipped days and baselines", () => withStore(async store => {
  const batch = (day: string, mode: EvalBatch["mode"]): EvalBatch => ({
    id: `${mode}-${day}`, agentId: "tv", mode, attempt: "scheduled", scheduledDay: day, startedAt: `${day}T12:00:00Z`,
    status: "completed", runIds: [],
  });
  const history = [batch("2026-09-10", "simulated"), batch("2026-09-14", "recorded"), batch("2026-09-15", "recorded")];
  assert.deepEqual(simulatedSkippedDays(history, "2026-09-15"), ["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"]);
  assert.deepEqual(simulatedSkippedDays(history.filter(item => item.mode === "recorded"), "2026-09-15"), []);
  for (const item of history) await store.write("batches", item);
  let executions = 0;
  const runner = new EvalRunner(store, async () => ({ grade }), "fake-judge", "fake-grader");
  const simulated = await runner.simulated({
    id: "tv", version: "1", model: "fake", promptVersion: "fake",
    scenarios: [{ id: "open", version: "1", request: "Open YouTube", context: grade.context, expectations: "Open", initial: {} }],
    execute: async () => { executions++; return { ...assessment("sim"), mode: "simulated" }; },
  }, new AbortController().signal, { scheduledDay: "2026-09-15" });
  assert.equal(simulated.mode, "simulated");
  assert.equal(executions, 1);
  const current = (await store.list<EvalRun>("summaries"))[0];
  const prior = ["2026-09-12", "2026-09-13", "2026-09-14"].map(day => ({
    ...current, id: day, mode: "recorded" as const, scheduledDay: day,
  }));
  assert.equal(baselineFor(current, prior).baselineCount, 0);
}));
