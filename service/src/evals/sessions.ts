import type { CosmosClientOptions, FeedOptions } from "@azure/cosmos";
import type { TvFlowMemoryDocument } from "../agents/tv/flowMemory";
import type { AgentTrace } from "../tracing/agentTraceStore";
import type { EvalAgentId, RecordedSession } from "./types";
import { isEvalAgentId } from "./registry";

export interface SessionDiscovery {
  sessions: Array<Omit<RecordedSession, "evaluation">>;
  warnings: string[];
}

export type SessionTraceMetadata = Pick<
  AgentTrace,
  "sessionId" | "agentType" | "userPrompt" | "startedAt" | "completedAt" | "status"
>;

export type SessionFlowMetadata = Pick<
  TvFlowMemoryDocument,
  "sessionId" | "userPrompt" | "createdAt"
> & {
  agent: string;
  status: TvFlowMemoryDocument["status"] | "failed";
  updatedAt?: string;
};

export interface SessionDiscoveryDependencies {
  /** Return all retained traces, including nonterminal/unsupported conflict records. */
  loadTelemetry(signal: AbortSignal): Promise<readonly SessionTraceMetadata[]> | readonly SessionTraceMetadata[];
  /** Return all projected flow metadata; null means Cosmos is not configured. */
  loadCosmos(signal: AbortSignal): Promise<readonly SessionFlowMetadata[] | null>;
  /** Per-source deadline; an incomplete read fails rather than truncating history. */
  timeoutMs?: number;
}

export interface SessionCosmosConfiguration {
  endpoint: string;
  key: string;
  database: string;
  container: string;
}

/** Minimal read-only SDK surface, injectable without constructing a real client. */
export interface SessionCosmosClient {
  database(id: string): {
    container(id: string): {
      items: {
        query(query: string, options: FeedOptions): {
          hasMoreResults(): boolean;
          fetchNext(): Promise<{ resources: SessionFlowMetadata[] }>;
        };
      };
    };
  };
  dispose(): void;
}

const SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const SOURCE_TIMEOUT_MS = 60_000;
const COSMOS_QUERY = "SELECT c.sessionId, c.agent, c.userPrompt, c.status, c.createdAt, c.updatedAt FROM c";

function terminalTrace(trace: SessionTraceMetadata): trace is SessionTraceMetadata & { status: "completed" | "error" } {
  return isEvalAgentId(trace.agentType) && Boolean(trace.completedAt) &&
    (trace.status === "completed" || trace.status === "error");
}

function terminalFlow(flow: SessionFlowMetadata): flow is SessionFlowMetadata & { status: "completed" | "error" | "failed" } {
  return flow.agent === "tv" && (flow.status === "completed" || flow.status === "error" || flow.status === "failed");
}

/**
 * Pure metadata union by exact sessionId, newest startedAt first. Telemetry wins
 * display metadata; the newest Cosmos createdAt wins before eligibility checks,
 * matching the recorded importer. Warnings are returned, not logged here.
 */
export function mergeRecordedSessions(
  traces: readonly SessionTraceMetadata[],
  flows: readonly SessionFlowMetadata[],
): SessionDiscovery {
  const warnings = new Set<string>();
  function validId(sessionId: string, source: "telemetry" | "cosmos"): boolean {
    if (typeof sessionId === "string" && SESSION_ID.test(sessionId)) return true;
    warnings.add(`Omitting ${source} session with invalid session ID ${JSON.stringify(sessionId)}; it cannot be scheduled.`);
    return false;
  }

  const telemetry = new Map<string, SessionTraceMetadata>();
  for (const trace of traces) {
    if (validId(trace.sessionId, "telemetry")) telemetry.set(trace.sessionId, trace);
  }
  const cosmos = new Map<string, SessionFlowMetadata>();
  for (const flow of flows) {
    if (!validId(flow.sessionId, "cosmos")) continue;
    const previous = cosmos.get(flow.sessionId);
    if (!previous || Date.parse(flow.createdAt) > Date.parse(previous.createdAt)) cosmos.set(flow.sessionId, flow);
  }

  const sessions: SessionDiscovery["sessions"] = [];
  for (const sessionId of new Set([...telemetry.keys(), ...cosmos.keys()])) {
    const trace = telemetry.get(sessionId), flow = cosmos.get(sessionId);
    // Do not filter either source before joining: retained conflicts veto import.
    if (trace && !terminalTrace(trace)) continue;
    if (flow && !terminalFlow(flow)) continue;
    if (trace && flow && trace.agentType !== flow.agent) continue;
    if (trace && terminalTrace(trace)) {
      sessions.push({
        sessionId, agentId: trace.agentType, userPrompt: trace.userPrompt, startedAt: trace.startedAt,
        completedAt: trace.completedAt, status: trace.status,
        sources: flow ? ["telemetry", "cosmos"] : ["telemetry"],
      });
    } else if (flow && terminalFlow(flow)) {
      sessions.push({
        sessionId, agentId: "tv", userPrompt: flow.userPrompt, startedAt: flow.createdAt,
        completedAt: flow.updatedAt || flow.createdAt, status: flow.status, sources: ["cosmos"],
      });
    }
  }
  sessions.sort((left, right) =>
    Date.parse(right.startedAt) - Date.parse(left.startedAt) || left.sessionId.localeCompare(right.sessionId));
  return { sessions, warnings: [...warnings] };
}

/**
 * Read every Cosmos metadata page with bounded requests and no evidence/embedding
 * access. The optional factory and signal support isolated tests and cancellation.
 */
export async function loadCosmosSessionMetadata(
  config: SessionCosmosConfiguration,
  createClient: (options: CosmosClientOptions) => SessionCosmosClient | Promise<SessionCosmosClient> = async options => {
    const { CosmosClient } = await import("@azure/cosmos");
    return new CosmosClient(options);
  },
  signal?: AbortSignal,
): Promise<SessionFlowMetadata[]> {
  signal?.throwIfAborted();
  const client = await createClient({
    endpoint: config.endpoint, key: config.key,
    connectionPolicy: {
      enableEndpointDiscovery: false,
      requestTimeout: 10_000,
      retryOptions: { maxRetryAttemptCount: 2, maxWaitTimeInSeconds: 5 },
    },
  });
  try {
    signal?.throwIfAborted();
    // No terminal/agent filter: otherwise a newer conflicting record is hidden.
    const iterator = client.database(config.database).container(config.container).items.query(COSMOS_QUERY, {
      maxItemCount: 100, maxDegreeOfParallelism: 1, abortSignal: signal,
    });
    const flows: SessionFlowMetadata[] = [];
    while (iterator.hasMoreResults()) {
      signal?.throwIfAborted();
      const { resources } = await iterator.fetchNext();
      flows.push(...resources);
    }
    return flows;
  } finally {
    client.dispose();
  }
}

const defaultDependencies: SessionDiscoveryDependencies = {
  async loadTelemetry(signal) {
    const { getAllTraces } = await import("../tracing/agentTraceStore");
    signal.throwIfAborted();
    // Simulators do not emit production lifecycle telemetry or Cosmos records.
    return getAllTraces().map(({ sessionId, agentType, userPrompt, startedAt, completedAt, status }) =>
      ({ sessionId, agentType, userPrompt, startedAt, completedAt, status }));
  },
  async loadCosmos(signal) {
    const { AZURE_COSMOS_ENDPOINT: endpoint, AZURE_COSMOS_KEY: key, AZURE_COSMOS_DATABASE: database,
      AZURE_COSMOS_TV_FLOW_CONTAINER: container } = await import("../config");
    signal.throwIfAborted();
    if (!endpoint || !key || !database || !container) return null;
    return loadCosmosSessionMetadata({ endpoint, key, database, container }, undefined, signal);
  },
};

async function boundedRead<T>(load: (signal: AbortSignal) => T | Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => load(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Source read timed out after ${timeoutMs} ms; incomplete history was not returned`);
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Load sources independently; callers decorate evaluation status outside this module. */
export async function discoverRecordedSessions(
  dependencies: SessionDiscoveryDependencies = defaultDependencies,
  agentId?: EvalAgentId,
): Promise<SessionDiscovery> {
  const timeoutMs = dependencies.timeoutMs ?? SOURCE_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Session discovery timeoutMs must be positive and finite");
  const usesCosmos = agentId === undefined || agentId === "tv";
  const [telemetry, cosmos] = await Promise.allSettled([
    boundedRead(signal => dependencies.loadTelemetry(signal), timeoutMs),
    usesCosmos ? boundedRead(signal => dependencies.loadCosmos(signal), timeoutMs) : Promise.resolve([]),
  ]);
  const warnings: string[] = [];
  function warn(message: string): void {
    warnings.push(message);
    console.warn(`[Recorded session discovery] ${message}`);
  }
  function unavailable(source: string, error: unknown): void {
    warn(`${source} source unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (telemetry.status === "rejected") unavailable("Telemetry", telemetry.reason);
  if (cosmos.status === "rejected") unavailable("Cosmos", cosmos.reason);
  if (usesCosmos && cosmos.status === "fulfilled" && cosmos.value === null) warn("Cosmos TV-flow storage is not configured; skipping Cosmos discovery.");
  if (telemetry.status === "rejected" && (!usesCosmos || cosmos.status === "rejected" || cosmos.value === null)) {
    throw new Error(`No retained-session source is available. ${warnings.join(" ")}`);
  }
  const merged = mergeRecordedSessions(
    telemetry.status === "fulfilled" ? telemetry.value : [],
    cosmos.status === "fulfilled" ? cosmos.value ?? [] : [],
  );
  merged.warnings.forEach(warn);
  return { sessions: merged.sessions.filter(session => !agentId || session.agentId === agentId), warnings };
}
