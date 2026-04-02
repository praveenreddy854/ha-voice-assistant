import { Container, CosmosClient, PartitionKeyKind } from "@azure/cosmos";
import { embed } from "ai";
import { azureProvider } from "../../ai";
import {
  AZURE_COSMOS_DATABASE,
  AZURE_COSMOS_ENDPOINT,
  AZURE_COSMOS_KEY,
  AZURE_COSMOS_TV_FLOW_CONTAINER,
  EMBEDDING_MODEL,
  TV_FLOW_MEMORY_MIN_SIMILARITY,
  TV_FLOW_MEMORY_TOP_K,
} from "../../config";
import { TvAgentStep, TvAgenticFlowStatus } from "./types";
const MAX_CANDIDATES = 250;

let tvFlowContainerPromise: Promise<Container | null> | null = null;

export interface TvFlowStepMemory {
  index: number;
  toolName?: string;
  actionSummary: string;
  reasoning: string;
  observation: string;
  toolArguments: Record<string, unknown>;
  toolSuccess: boolean;
  awaitedScreenshot: boolean;
  screenshotOutcome: "none" | "pending" | "captured" | "error";
  appUiContext?: {
    appName?: string;
    layoutType?: string;
    selectionPosition?: string;
    navigationLandmarks?: string[];
  };
}

export interface TvFlowMemoryDocument {
  id: string;
  pk: string;
  agent: "tv";
  sessionId: string;
  userPrompt: string;
  normalizedTaskText: string;
  status: TvAgenticFlowStatus;
  success: boolean;
  finalMessage?: string;
  iterations: number;
  maxSteps: number;
  executionScore: number;
  embedding: number[];
  steps: TvFlowStepMemory[];
  appUiContext: {
    appNames: string[];
    layoutTypes: string[];
    selectionPositions: string[];
    navigationLandmarks: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface SaveTvFlowMemoryParams {
  sessionId: string;
  userPrompt: string;
  status: TvAgenticFlowStatus;
  success: boolean;
  finalMessage?: string;
  iterations: number;
  maxSteps: number;
  steps: TvAgentStep[];
}

export interface RetrieveSimilarFlowsParams {
  currentGoal: string;
  currentContext?: string;
  limit?: number;
  minSimilarity?: number;
}

interface RankedFlow {
  similarity: number;
  doc: TvFlowMemoryDocument;
}

export interface RetrievedFlowSummary {
  id: string;
  sessionId: string;
  similarity: number;
  status: TvAgenticFlowStatus;
  success: boolean;
  executionScore: number;
  createdAt: string;
  userPrompt: string;
  finalMessage?: string;
  toolSequence: string[];
  uiStructureCues: {
    appNames: string[];
    layoutTypes: string[];
    selectionPositions: string[];
    navigationLandmarks: string[];
  };
  whatWorked: string[];
  whatFailed: string[];
}

const isTvFlowMemoryConfigured = (): boolean => {
  return Boolean(
    AZURE_COSMOS_ENDPOINT &&
      AZURE_COSMOS_KEY &&
      AZURE_COSMOS_DATABASE &&
      AZURE_COSMOS_TV_FLOW_CONTAINER
  );
};

async function getTvFlowContainer(): Promise<Container | null> {
  if (!isTvFlowMemoryConfigured()) {
    return null;
  }

  if (!tvFlowContainerPromise) {
    tvFlowContainerPromise = initializeTvFlowContainer().catch((error) => {
      console.error("[TV Flow Memory] Failed to initialize container", error);
      return null;
    });
  }

  return tvFlowContainerPromise;
}

async function initializeTvFlowContainer(): Promise<Container> {
  if (!isTvFlowMemoryConfigured()) {
    throw new Error("TV flow memory Cosmos DB configuration is incomplete");
  }

  const client = new CosmosClient({
    endpoint: AZURE_COSMOS_ENDPOINT!,
    key: AZURE_COSMOS_KEY!,
  });

  const { database } = await client.databases.createIfNotExists({
    id: AZURE_COSMOS_DATABASE!,
  });

  const { container } = await database.containers.createIfNotExists({
    id: AZURE_COSMOS_TV_FLOW_CONTAINER!,
    partitionKey: {
      kind: PartitionKeyKind.Hash,
      paths: ["/pk"],
    },
  });

  return container;
}

function normalizeTaskText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractDeviceIdFromEntity(entityId: unknown): string | null {
  if (typeof entityId !== "string") return null;
  const parts = entityId.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  return parts[1].toLowerCase();
}

function getPrimaryDeviceId(steps: TvAgentStep[]): string {
  for (const step of steps) {
    const args = (step.toolArguments || {}) as unknown as Record<
      string,
      unknown
    >;

    const remoteId = extractDeviceIdFromEntity(args.remote_entity_id);
    if (remoteId) return remoteId;

    const mediaId = extractDeviceIdFromEntity(args.media_player_entity_id);
    if (mediaId) return mediaId;

    const directName = typeof args.device_name === "string" ? args.device_name : null;
    if (directName && directName.trim()) {
      return directName.trim().toLowerCase();
    }
  }

  return "unknown";
}

async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const { embedding } = await embed({
      model: azureProvider.embeddingModel(EMBEDDING_MODEL),
      value: text,
    });
    return embedding;
  } catch (error) {
    console.error("[TV Flow Memory] Embedding generation failed", error);
    return [];
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function computeExecutionScore(
  status: TvAgenticFlowStatus,
  success: boolean,
  steps: TvAgentStep[],
  maxSteps: number
): number {
  if (status === "completed" && success) {
    return 1;
  }

  const safeMax = Math.max(1, maxSteps || 1);
  const progressRatio = clampScore(steps.length / safeMax);

  const successfulSteps = steps.filter((s) => s.toolSuccess).length;
  const stepSuccessRatio = steps.length > 0 ? successfulSteps / steps.length : 0;

  const screenshotRequested = steps.filter((s) => s.awaitedScreenshot).length;
  const screenshotResolved = steps.filter(
    (s) => s.screenshotOutcome === "captured"
  ).length;
  const screenshotResolutionRatio =
    screenshotRequested > 0 ? screenshotResolved / screenshotRequested : 1;

  const score =
    stepSuccessRatio * 0.5 + progressRatio * 0.3 + screenshotResolutionRatio * 0.2;

  return clampScore(score);
}

function toMemoryStep(step: TvAgentStep): TvFlowStepMemory {
  return {
    index: step.index,
    toolName: step.toolName,
    actionSummary: step.actionSummary,
    reasoning: step.reasoning,
    observation: step.observation,
    toolArguments: (step.toolArguments || {}) as unknown as Record<
      string,
      unknown
    >,
    toolSuccess: step.toolSuccess ?? false,
    awaitedScreenshot: step.awaitedScreenshot ?? false,
    screenshotOutcome: step.screenshotOutcome ?? "none",
    appUiContext: step.appUiContext,
  };
}

function aggregateUiContext(steps: TvAgentStep[]): TvFlowMemoryDocument["appUiContext"] {
  const appNames = new Set<string>();
  const layoutTypes = new Set<string>();
  const selectionPositions = new Set<string>();
  const navigationLandmarks = new Set<string>();

  for (const step of steps) {
    if (!step.appUiContext) continue;

    if (step.appUiContext.appName) {
      appNames.add(step.appUiContext.appName);
    }
    if (step.appUiContext.layoutType) {
      layoutTypes.add(step.appUiContext.layoutType);
    }
    if (step.appUiContext.selectionPosition) {
      selectionPositions.add(step.appUiContext.selectionPosition);
    }
    for (const landmark of step.appUiContext.navigationLandmarks || []) {
      if (landmark) {
        navigationLandmarks.add(landmark);
      }
    }
  }

  return {
    appNames: Array.from(appNames),
    layoutTypes: Array.from(layoutTypes),
    selectionPositions: Array.from(selectionPositions),
    navigationLandmarks: Array.from(navigationLandmarks),
  };
}

function buildEmbeddingText(userPrompt: string, steps: TvAgentStep[]): string {
  const pieces: string[] = [userPrompt.trim()];

  for (const step of steps) {
    const parts = [step.actionSummary, step.reasoning, step.observation]
      .filter((p) => typeof p === "string" && p.trim().length > 0)
      .join(" | ");
    if (parts) {
      pieces.push(parts);
    }

    if (step.appUiContext) {
      pieces.push(
        `app:${step.appUiContext.appName || "unknown"};layout:${
          step.appUiContext.layoutType || "unknown"
        };selection:${step.appUiContext.selectionPosition || "unknown"}`
      );
    }
  }

  return pieces.join("\n").slice(0, 12000);
}

function toFlowSummary(flow: RankedFlow): RetrievedFlowSummary {
  const toolSequence = flow.doc.steps
    .map((s) => s.toolName)
    .filter((name): name is string => !!name)
    .slice(0, 12);

  const whatWorked = flow.doc.steps
    .filter((s) => s.toolSuccess)
    .map((s) => `${s.toolName || "unknown_tool"}: ${s.actionSummary}`)
    .slice(0, 5);

  const whatFailed = flow.doc.steps
    .filter((s) => !s.toolSuccess)
    .map((s) => `${s.toolName || "unknown_tool"}: ${s.observation}`)
    .slice(0, 5);

  return {
    id: flow.doc.id,
    sessionId: flow.doc.sessionId,
    similarity: flow.similarity,
    status: flow.doc.status,
    success: flow.doc.success,
    executionScore: flow.doc.executionScore,
    createdAt: flow.doc.createdAt,
    userPrompt: flow.doc.userPrompt,
    finalMessage: flow.doc.finalMessage,
    toolSequence,
    uiStructureCues: flow.doc.appUiContext,
    whatWorked,
    whatFailed,
  };
}

export async function saveTvFlowMemory(
  params: SaveTvFlowMemoryParams
): Promise<void> {
  const container = await getTvFlowContainer();
  if (!container) {
    console.warn(
      "[TV Flow Memory] Cosmos container unavailable; skipping flow-memory persistence"
    );
    return;
  }

  const now = new Date().toISOString();
  const normalizedTaskText = normalizeTaskText(params.userPrompt);
  const primaryDeviceId = getPrimaryDeviceId(params.steps);
  const embeddingText = buildEmbeddingText(params.userPrompt, params.steps);
  const embedding = await generateEmbedding(embeddingText);
  const executionScore = computeExecutionScore(
    params.status,
    params.success,
    params.steps,
    params.maxSteps
  );

  const doc: TvFlowMemoryDocument = {
    id: `${params.sessionId}-${Date.now()}`,
    pk: `tvflow|${primaryDeviceId}`,
    agent: "tv",
    sessionId: params.sessionId,
    userPrompt: params.userPrompt,
    normalizedTaskText,
    status: params.status,
    success: params.success,
    finalMessage: params.finalMessage,
    iterations: params.iterations,
    maxSteps: params.maxSteps,
    executionScore,
    embedding,
    steps: params.steps.map(toMemoryStep),
    appUiContext: aggregateUiContext(params.steps),
    createdAt: now,
    updatedAt: now,
  };

  try {
    await container.items.upsert(doc);
  } catch (error) {
    console.error("[TV Flow Memory] Failed to upsert flow document", error);
  }
}

function rankAndSelectFlows(
  docs: TvFlowMemoryDocument[],
  queryEmbedding: number[],
  limit: number,
  minSimilarity: number
): RetrievedFlowSummary[] {
  const ranked: RankedFlow[] = docs
    .filter((doc) => doc.embedding && doc.embedding.length > 0)
    .map((doc) => ({
      doc,
      similarity: cosineSimilarity(queryEmbedding, doc.embedding),
    }))
    .filter((row) => row.similarity >= minSimilarity)
    .sort((a, b) => {
      if (b.similarity !== a.similarity) return b.similarity - a.similarity;
      const aSuccess = a.doc.success && a.doc.status === "completed" ? 1 : 0;
      const bSuccess = b.doc.success && b.doc.status === "completed" ? 1 : 0;
      if (bSuccess !== aSuccess) return bSuccess - aSuccess;
      if (b.doc.executionScore !== a.doc.executionScore) {
        return b.doc.executionScore - a.doc.executionScore;
      }
      return b.doc.createdAt.localeCompare(a.doc.createdAt);
    });

  const successful = ranked.filter(
    (row) => row.doc.success && row.doc.status === "completed"
  );
  const partial = ranked.filter(
    (row) => !(row.doc.success && row.doc.status === "completed")
  );

  const output: RankedFlow[] = [];

  for (const flow of successful) {
    if (output.length >= limit) break;
    output.push(flow);
  }

  for (const flow of partial) {
    if (output.length >= limit) break;
    output.push(flow);
  }

  return output.map(toFlowSummary);
}

export async function retrieveSimilarTvFlows(
  params: RetrieveSimilarFlowsParams
): Promise<{ flows: RetrievedFlowSummary[]; usedFallbackPartials: boolean }> {
  const container = await getTvFlowContainer();
  if (!container) {
    return { flows: [], usedFallbackPartials: false };
  }

  const normalizedLimit = Math.max(
    1,
    Math.min(params.limit || TV_FLOW_MEMORY_TOP_K || 5, 5)
  );
  const normalizedMinSimilarity =
    typeof params.minSimilarity === "number"
      ? params.minSimilarity
      : Number.isFinite(TV_FLOW_MEMORY_MIN_SIMILARITY)
      ? TV_FLOW_MEMORY_MIN_SIMILARITY
      : 0.65;

  const queryText = [params.currentGoal, params.currentContext]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .join("\n")
    .trim();

  if (!queryText) {
    return { flows: [], usedFallbackPartials: false };
  }

  const queryEmbedding = await generateEmbedding(queryText);
  if (!queryEmbedding.length) {
    return { flows: [], usedFallbackPartials: false };
  }

  const querySpec = {
    query: "SELECT TOP @top * FROM c WHERE c.agent = @agent ORDER BY c.createdAt DESC",
    parameters: [
      { name: "@top", value: MAX_CANDIDATES },
      { name: "@agent", value: "tv" },
    ],
  };

  let docs: TvFlowMemoryDocument[] = [];
  try {
    const { resources } = await container.items
      .query<TvFlowMemoryDocument>(querySpec, { maxItemCount: MAX_CANDIDATES })
      .fetchAll();
    docs = resources || [];
  } catch (error) {
    console.error("[TV Flow Memory] Query failed", error);
    return { flows: [], usedFallbackPartials: false };
  }

  const flows = rankAndSelectFlows(
    docs,
    queryEmbedding,
    normalizedLimit,
    normalizedMinSimilarity
  );

  const successfulCount = flows.filter(
    (f) => f.success && f.status === "completed"
  ).length;

  return {
    flows,
    usedFallbackPartials: flows.length > successfulCount,
  };
}
