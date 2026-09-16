import test from "node:test";
import assert from "node:assert/strict";
import type { CosmosClientOptions, FeedOptions } from "@azure/cosmos";
import {
  discoverRecordedSessions, loadCosmosSessionMetadata, mergeRecordedSessions,
  type SessionCosmosClient, type SessionFlowMetadata, type SessionTraceMetadata,
} from "../src/evals/sessions";

const startedAt = "2026-09-14T12:00:00Z";
const completedAt = "2026-09-14T12:01:00Z";
function trace(sessionId: string, overrides: Partial<SessionTraceMetadata> = {}): SessionTraceMetadata {
  return { sessionId, agentType: "tv", userPrompt: "Open YouTube", startedAt, completedAt, status: "completed", ...overrides };
}
function flow(sessionId: string, overrides: Partial<SessionFlowMetadata> = {}): SessionFlowMetadata {
  return { sessionId, agent: "tv", userPrompt: "Open Netflix", createdAt: startedAt, updatedAt: completedAt, status: "completed", ...overrides };
}
const ids = (result: ReturnType<typeof mergeRecordedSessions>) => result.sessions.map(session => session.sessionId);

test("eligible telemetry requires a finished supported-agent lifecycle, including terminal errors", () => {
  const result = mergeRecordedSessions([
    trace("completed"), trace("error", { status: "error" }),
    trace("running", { status: "running" }),
    trace("waiting", { status: "awaiting_external_input" }),
    trace("no-lifecycle", { completedAt: undefined }),
    trace("empty-lifecycle", { completedAt: "" }),
    trace("error-no-lifecycle", { status: "error", completedAt: undefined }),
    trace("wrong-agent", { agentType: "scheduled-task" }),
    trace("unknown-agent", { agentType: "unknown" }),
  ], []);
  assert.deepEqual(ids(result), ["completed", "error"]);
  assert.equal(result.sessions[1].status, "error");
  assert.deepEqual(result.warnings, []);
});

test("Cosmos includes completed, error and legacy failed records, not live or non-TV records", () => {
  const result = mergeRecordedSessions([], [
    flow("completed"), flow("error", { status: "error" }), flow("failed", { status: "failed" }),
    flow("running", { status: "running" }), flow("waiting", { status: "awaiting_screenshot" }),
    flow("wrong-agent", { agent: "home" }),
  ]);
  assert.deepEqual(ids(result), ["completed", "error", "failed"]);
  assert.deepEqual(result.sessions.map(session => session.status), ["completed", "error", "failed"]);
});

test("telemetry conflicts veto matching Cosmos records rather than disappearing during filtering", () => {
  for (const overrides of [
    { status: "running" }, { status: "awaiting_external_input" },
    { completedAt: undefined }, { agentType: "home" }, { agentType: "" },
  ] satisfies Array<Partial<SessionTraceMetadata>>) {
    assert.deepEqual(ids(mergeRecordedSessions([trace("same", overrides)], [flow("same")])), []);
  }
});

test("known nonterminal or wrong-agent Cosmos records veto terminal telemetry", () => {
  for (const overrides of [
    { status: "running" }, { status: "awaiting_screenshot" }, { agent: "home" },
  ] satisfies Array<Partial<SessionFlowMetadata>>) {
    assert.deepEqual(ids(mergeRecordedSessions([trace("same")], [flow("same", overrides)])), []);
  }
});

test("Cosmos dedup chooses newest createdAt, not input order or updatedAt", () => {
  const older = flow("same", { status: "running", updatedAt: "2026-09-15T15:00:00Z" });
  const newer = flow("same", { createdAt: "2026-09-14T13:00:00Z", status: "failed", userPrompt: "Latest prompt" });
  for (const records of [[older, newer], [newer, older]]) {
    const result = mergeRecordedSessions([], records);
    assert.equal(result.sessions.length, 1);
    assert.equal(result.sessions[0].status, "failed");
    assert.equal(result.sessions[0].userPrompt, "Latest prompt");
  }
});

test("newest nonterminal Cosmos record blocks older terminal records and matching telemetry", () => {
  const old = flow("same");
  const latest = flow("same", { createdAt: "2026-09-14T13:00:00Z", status: "running" });
  for (const records of [[old, latest], [latest, old]]) {
    assert.deepEqual(ids(mergeRecordedSessions([], records)), []);
    assert.deepEqual(ids(mergeRecordedSessions([trace("same")], records)), []);
  }
});

test("union uses exact session identity and telemetry metadata, with accurate available sources", () => {
  const result = mergeRecordedSessions([trace("shared"), trace("Trace_Only"), trace("Case")], [
    flow("shared", { createdAt: "2026-09-15T12:00:00Z", status: "error" }), flow("cosmos-only"), flow("case"),
  ]);
  const shared = result.sessions.find(session => session.sessionId === "shared");
  assert.deepEqual(shared, {
    sessionId: "shared", agentId: "tv", userPrompt: "Open YouTube", startedAt, completedAt,
    status: "completed", sources: ["telemetry", "cosmos"],
  });
  assert.deepEqual(result.sessions.find(session => session.sessionId === "Trace_Only")?.sources, ["telemetry"]);
  assert.deepEqual(result.sessions.find(session => session.sessionId === "cosmos-only")?.sources, ["cosmos"]);
  assert.ok(ids(result).includes("Case"));
  assert.ok(ids(result).includes("case"));
  assert.equal(result.sessions.length, 5);
});

test("metadata output is newest first across sources and does not access retained evidence", () => {
  const record = {
    ...trace("old", { startedAt: "2026-09-14T13:30:00+02:00" }),
    get screenshots(): never { throw new Error("Images must not be read"); },
    get llmSteps(): never { throw new Error("LLM evidence must not be read"); },
    get toolResults(): never { throw new Error("Tool evidence must not be read"); },
  };
  const stored = {
    ...flow("new", { createdAt: "2026-09-14T13:00:00Z", updatedAt: undefined }),
    get steps(): never { throw new Error("Steps must not be read"); },
    get embedding(): never { throw new Error("Embeddings must not be read"); },
  };
  const result = mergeRecordedSessions([record, trace("middle")], [stored]);
  assert.deepEqual(ids(result), ["new", "middle", "old"]);
  assert.deepEqual(Object.keys(result.sessions[0]).sort(),
    ["agentId", "completedAt", "sessionId", "sources", "startedAt", "status", "userPrompt"]);
  assert.equal(result.sessions[0].completedAt, stored.createdAt);
  assert.equal("evaluation" in result.sessions[0], false);
});

test("invalid IDs are omitted without normalization and produce source-specific warnings", () => {
  const invalid = ["", " ", "../other", "with/slash", "with.dot", "with space", "line\nbreak", "caf\u00e9"];
  const result = mergeRecordedSessions(
    [...invalid.map(id => trace(id)), trace("Valid_123-id")], invalid.map(id => flow(id)),
  );
  assert.deepEqual(ids(result), ["Valid_123-id"]);
  assert.equal(result.warnings.length, invalid.length * 2);
  assert.ok(result.warnings.every(warning => /invalid session ID.*cannot be scheduled/.test(warning)));
});

test("partial Cosmos outage preserves telemetry and logs the returned warning", async t => {
  const warnings = t.mock.method(console, "warn", () => {});
  const result = await discoverRecordedSessions({
    loadTelemetry: () => [trace("retained")],
    loadCosmos: async () => { throw new Error("Cosmos read failed"); },
  });
  assert.deepEqual(ids(result), ["retained"]);
  assert.deepEqual(result.sessions[0].sources, ["telemetry"]);
  assert.match(result.warnings[0], /Cosmos source unavailable: Cosmos read failed/);
  assert.equal(warnings.mock.calls[0].arguments[0], `[Recorded session discovery] ${result.warnings[0]}`);
});

test("synchronous telemetry failure is isolated from a successful Cosmos read", async t => {
  t.mock.method(console, "warn", () => {});
  const result = await discoverRecordedSessions({
    loadTelemetry: () => { throw new Error("Telemetry unreadable"); },
    loadCosmos: async () => [flow("retained", { status: "error" })],
  });
  assert.deepEqual(ids(result), ["retained"]);
  assert.deepEqual(result.sessions[0].sources, ["cosmos"]);
  assert.match(result.warnings[0], /Telemetry source unavailable: Telemetry unreadable/);
});

test("unconfigured Cosmos is explicitly skipped, not treated as an available source", async t => {
  const warnings = t.mock.method(console, "warn", () => {});
  const result = await discoverRecordedSessions({ loadTelemetry: () => [], loadCosmos: async () => null });
  assert.deepEqual(result.sessions, []);
  assert.match(result.warnings[0], /not configured/);
  assert.equal(warnings.mock.callCount(), 1);
  await assert.rejects(discoverRecordedSessions({
    loadTelemetry: async () => { throw new Error("Telemetry unavailable"); },
    loadCosmos: async () => null,
  }), /No retained-session source is available/);
});

test("both configured source failures reject instead of returning empty success", async t => {
  const warnings = t.mock.method(console, "warn", () => {});
  await assert.rejects(discoverRecordedSessions({
    loadTelemetry: async () => { throw new Error("Telemetry read failed"); },
    loadCosmos: async () => { throw new Error("Cosmos read failed"); },
  }), /No retained-session source is available.*Telemetry read failed.*Cosmos read failed/);
  assert.equal(warnings.mock.callCount(), 2);
});

test("an available empty source remains a successful partial discovery", async t => {
  t.mock.method(console, "warn", () => {});
  const result = await discoverRecordedSessions({
    loadTelemetry: () => [],
    loadCosmos: async () => { throw new Error("Cosmos unavailable"); },
  });
  assert.deepEqual(result.sessions, []);
  assert.equal(result.warnings.length, 1);
});

test("other supported agents are discovered without mixing conflicting TV-flow identities", () => {
  const result = mergeRecordedSessions([
    trace("scheduled", { agentType: "scheduled_task" }),
    trace("voice-error", { agentType: "realtime", status: "error" }),
    trace("conflict", { agentType: "scheduled_task" }),
    trace("unfinished-voice", { agentType: "realtime", status: "running" }),
  ], [flow("conflict")]);
  assert.deepEqual(result.sessions.map(session => [session.sessionId, session.agentId]),
    [["scheduled", "scheduled_task"], ["voice-error", "realtime"]]);
  assert.ok(result.sessions.every(session => session.sources.join() === "telemetry"));
});

test("non-TV discovery never reads Cosmos or mislabels its absence as incomplete coverage", async () => {
  for (const agentId of ["scheduled_task", "realtime"] as const) {
    const result = await discoverRecordedSessions({
      loadTelemetry: () => [trace("selected", { agentType: agentId }), trace("tv-only")],
      loadCosmos: async () => { throw new Error("Cosmos must not be queried for this agent"); },
    }, agentId);
    assert.deepEqual(ids(result), ["selected"]);
    assert.deepEqual(result.warnings, []);
  }
});

test("non-TV telemetry failure is an error, not a successful empty skipped source", async t => {
  t.mock.method(console, "warn", () => {});
  await assert.rejects(discoverRecordedSessions({
    loadTelemetry: () => { throw new Error("Telemetry unavailable"); },
    loadCosmos: async () => { throw new Error("Not a source for this agent"); },
  }, "realtime"), /No retained-session source is available.*Telemetry unavailable/);
});

test("discovery logs and returns invalid-identifier warnings", async t => {
  const warnings = t.mock.method(console, "warn", () => {});
  const result = await discoverRecordedSessions({
    loadTelemetry: () => [trace("invalid/id")], loadCosmos: async () => [flow("valid-id")],
  });
  assert.deepEqual(ids(result), ["valid-id"]);
  assert.equal(warnings.mock.callCount(), 1);
  assert.match(result.warnings[0], /invalid session ID/);
});

test("source loading is concurrent and a hung source is bounded and aborted independently", async t => {
  t.mock.method(console, "warn", () => {});
  let cosmosStarted = false, telemetrySawCosmos = false, aborted = false;
  const result = await discoverRecordedSessions({
    timeoutMs: 20,
    loadTelemetry: async () => {
      await Promise.resolve();
      telemetrySawCosmos = cosmosStarted;
      return [trace("retained")];
    },
    loadCosmos: signal => {
      cosmosStarted = true;
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return new Promise(() => {});
    },
  });
  assert.equal(telemetrySawCosmos, true);
  assert.equal(aborted, true);
  assert.deepEqual(ids(result), ["retained"]);
  assert.match(result.warnings[0], /Cosmos source unavailable: Source read timed out/);
});

const config = { endpoint: "https://unused.invalid", key: "test-only", database: "db", container: "flows" };
function fakeCosmos(pages: SessionFlowMetadata[][], failPage?: number) {
  let page = 0, disposed = 0, query = "";
  let options: CosmosClientOptions | undefined, feedOptions: FeedOptions | undefined;
  const client: SessionCosmosClient = {
    database(id) {
      assert.equal(id, config.database);
      return { container(id) {
        assert.equal(id, config.container);
        return { items: { query(sql, feed) {
          query = sql;
          feedOptions = feed;
          return {
            hasMoreResults: () => page < pages.length,
            async fetchNext() {
              if (page === failPage) throw new Error("Page failed");
              return { resources: pages[page++] };
            },
          };
        } } };
      } };
    },
    dispose() { disposed++; },
  };
  return {
    createClient(input: CosmosClientOptions) { options = input; return client; },
    inspect: () => ({ page, disposed, query, options, feedOptions }),
  };
}

test("Cosmos uses projected metadata only, bounded SDK requests, all pages, and disposes the client", async () => {
  const pages = Array.from({ length: 4 }, (_, page) =>
    Array.from({ length: 100 }, (_, index) => flow(`session-${page * 100 + index}`)));
  pages.splice(1, 0, []);
  const fake = fakeCosmos(pages);
  const signal = new AbortController().signal;
  const result = await loadCosmosSessionMetadata(config, fake.createClient, signal);
  assert.equal(result.length, 400);
  const { page, disposed, query, options, feedOptions } = fake.inspect();
  assert.equal(page, 5);
  assert.equal(disposed, 1);
  assert.equal(query, "SELECT c.sessionId, c.agent, c.userPrompt, c.status, c.createdAt, c.updatedAt FROM c");
  assert.doesNotMatch(query, /\*|TOP|WHERE|embedding|steps|screenshots/i);
  assert.equal(options?.connectionPolicy?.requestTimeout, 10_000);
  assert.equal(options?.connectionPolicy?.enableEndpointDiscovery, false);
  assert.equal(options?.connectionPolicy?.retryOptions?.maxRetryAttemptCount, 2);
  assert.equal(feedOptions?.maxItemCount, 100);
  assert.equal(feedOptions?.maxDegreeOfParallelism, 1);
  assert.equal(feedOptions?.abortSignal, signal);
});

test("a later Cosmos page failure disposes the client and never returns truncated history", async t => {
  t.mock.method(console, "warn", () => {});
  const fake = fakeCosmos([[flow("partial")], [flow("unread")]], 1);
  const result = await discoverRecordedSessions({
    loadTelemetry: () => [trace("retained")],
    loadCosmos: signal => loadCosmosSessionMetadata(config, fake.createClient, signal),
  });
  assert.deepEqual(ids(result), ["retained"]);
  assert.match(result.warnings[0], /Cosmos source unavailable: Page failed/);
  assert.equal(fake.inspect().disposed, 1);
});

test("Cosmos cancellation after client construction still disposes it", async () => {
  const controller = new AbortController(), fake = fakeCosmos([]);
  await assert.rejects(loadCosmosSessionMetadata(config, options => {
    const client = fake.createClient(options);
    controller.abort(new Error("Cancelled"));
    return client;
  }, controller.signal), /Cancelled/);
  assert.equal(fake.inspect().disposed, 1);
});

test("Cosmos query initialization failures still dispose the client", async () => {
  const fake = fakeCosmos([]);
  await assert.rejects(loadCosmosSessionMetadata(config, options => ({
    ...fake.createClient(options),
    database() { throw new Error("Query initialization failed"); },
  })), /Query initialization failed/);
  assert.equal(fake.inspect().disposed, 1);
});
