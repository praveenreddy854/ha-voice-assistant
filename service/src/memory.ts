import { randomUUID } from "crypto";
import { Container, CosmosClient, PartitionKeyKind } from "@azure/cosmos";
import { embed } from "ai";
import { azureProvider, generateCompletion } from "./ai";
import {
  AI_MODEL_MINI,
  AZURE_COSMOS_DATABASE,
  AZURE_COSMOS_ENDPOINT,
  AZURE_COSMOS_KEY,
  AZURE_COSMOS_MEMORY_CONTAINER,
  EMBEDDING_MODEL,
  MEMORY_CONSOLIDATION_ENABLED,
  MEMORY_CONSOLIDATION_INTERVAL_MS,
  MEMORY_MIN_SIMILARITY,
  MEMORY_RETRIEVAL_TIMEOUT_MS,
  MEMORY_RETRIEVAL_TOP_K,
} from "./config";

export type MemorySource = "explicit" | "inferred";
export type MemoryStatus = "active" | "deleted";
export type MemoryType = "preference" | "fact" | "guidance";

export interface MemoryScopes {
  global?: boolean;
  roomNames?: string[];
  deviceNames?: string[];
  deviceEntityIds?: string[];
  domains?: string[];
  appNames?: string[];
  people?: string[];
  agentTypes?: string[];
  tags?: string[];
}

export interface AgentMemoryDocument {
  id: string;
  pk: string;
  status: MemoryStatus;
  text: string;
  memoryType: MemoryType;
  source: MemorySource;
  confidence: number;
  scopes: MemoryScopes;
  embedding: number[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  useCount: number;
}

export interface MemoryWriteInput {
  text: string;
  memoryType?: MemoryType;
  source: MemorySource;
  confidence?: number;
  scopes?: MemoryScopes;
}

export interface MemoryRetrievalParams {
  query: string;
  agentType?: string;
  limit?: number;
  minSimilarity?: number;
  preferCache?: boolean;
  useEmbedding?: boolean;
}

export interface MemoryInteraction {
  agentType: string;
  userText: string;
  assistantText?: string;
  createdAt?: string;
}

interface RankedMemory {
  doc: AgentMemoryDocument;
  score: number;
  similarity: number;
  scopeScore: number;
  lexicalScore: number;
}

const MAX_CANDIDATES = 250;
const DUPLICATE_SIMILARITY = 0.87;
const CONSOLIDATION_BATCH_SIZE = 12;
const MAX_PENDING_INTERACTIONS = 100;
const MEMORY_CANDIDATE_CACHE_TTL_MS = 60_000;
const DEVICE_SCOPE_TERMS = [
  "camera",
  "preset",
  "light",
  "switch",
  "vacuum",
  "tv",
  "television",
  "thermostat",
  "fan",
  "door",
  "lock",
  "garage",
  "sensor",
  "speaker",
  "remote",
  "media player",
];
const ROOM_WORDS = [
  "living room",
  "bedroom",
  "kitchen",
  "garage",
  "office",
  "loft",
  "front",
  "back",
  "patio",
  "nursery",
  "laundry",
];

let memoryContainerPromise: Promise<Container | null> | null = null;
let memoryClient: CosmosClient | null = null;
const pendingInteractions: MemoryInteraction[] = [];
let consolidationTimer: NodeJS.Timeout | null = null;
let candidateCacheRefreshTimer: NodeJS.Timeout | null = null;
let consolidationRunning = false;
let partitionRepairStarted = false;
let activeCandidateCache: {
  docs: AgentMemoryDocument[];
  fetchedAt: number;
} = { docs: [], fetchedAt: 0 };
let activeCandidateRefreshPromise: Promise<AgentMemoryDocument[]> | null = null;

export const AGENT_MEMORY_SYSTEM_INSTRUCTIONS = `Persistent agent memory:
- Relevant Persistent agent memory may be provided as compact system context before the current request.
- Apply injected memory when planning or answering. Treat guidance memories as operating constraints unless the user's newest instruction explicitly overrides them or current device state makes them impossible.
- Treat memory as user preference and durable context, not as current device truth.
- Newer user instructions and current Home Assistant state override memory.
- Use retrieve_memory when compact memory is not enough to answer or act.
- Use save_memory for explicit "remember..." requests and durable high-confidence preferences.
- Before saving device-specific memory, identify the target device, room, domain, or app. If the target is unclear, ask a clarification question instead of saving.
- Do not save memory with only agentTypes as scope. Use global=true for global preferences, or a concrete scope for targeted preferences.
- Use update_memory or delete_memory when the user corrects or asks to forget memory.`;

function isMemoryConfigured(): boolean {
  return Boolean(
    AZURE_COSMOS_ENDPOINT &&
      AZURE_COSMOS_KEY &&
      AZURE_COSMOS_DATABASE &&
      AZURE_COSMOS_MEMORY_CONTAINER
  );
}

function getMemoryClient(): CosmosClient {
  if (!memoryClient) {
    memoryClient = new CosmosClient({
      endpoint: AZURE_COSMOS_ENDPOINT!,
      key: AZURE_COSMOS_KEY!,
    });
  }
  return memoryClient;
}

async function initializeMemoryContainer(): Promise<Container> {
  if (!isMemoryConfigured()) {
    throw new Error("Persistent memory Cosmos DB configuration is incomplete");
  }

  const { database } = await getMemoryClient().databases.createIfNotExists({
    id: AZURE_COSMOS_DATABASE!,
  });

  const { container } = await database.containers.createIfNotExists({
    id: AZURE_COSMOS_MEMORY_CONTAINER,
    partitionKey: {
      kind: PartitionKeyKind.Hash,
      paths: ["/pk"],
    },
  });

  return container;
}

async function getMemoryContainer(): Promise<Container | null> {
  if (!isMemoryConfigured()) return null;
  if (!memoryContainerPromise) {
    memoryContainerPromise = initializeMemoryContainer().catch((error) => {
      console.error("[Memory] Failed to initialize Cosmos container", error);
      return null;
    });
  }
  return memoryContainerPromise;
}

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function normalizeList(values: unknown): string[] | undefined {
  if (!Array.isArray(values)) return undefined;
  const normalized = values
    .map((v) => normalizeText(v))
    .filter(Boolean)
    .slice(0, 12);
  return normalized.length ? Array.from(new Set(normalized)) : undefined;
}

function normalizePartitionValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);
}

export function normalizeMemoryScopes(scopes?: MemoryScopes): MemoryScopes {
  if (!scopes) return {};
  return {
    global: scopes.global === true,
    roomNames: normalizeList(scopes.roomNames),
    deviceNames: normalizeList(scopes.deviceNames),
    deviceEntityIds: normalizeList(scopes.deviceEntityIds),
    domains: normalizeList(scopes.domains),
    appNames: normalizeList(scopes.appNames),
    people: normalizeList(scopes.people),
    agentTypes: normalizeList(scopes.agentTypes),
    tags: normalizeList(scopes.tags),
  };
}

function hasPrimaryScope(scopes: MemoryScopes): boolean {
  return Boolean(
    scopes.global ||
      scopes.roomNames?.length ||
      scopes.deviceNames?.length ||
      scopes.deviceEntityIds?.length ||
      scopes.domains?.length ||
      scopes.appNames?.length ||
      scopes.people?.length
  );
}

function textMentionsDeviceScope(text: string): boolean {
  const normalized = text.toLowerCase();
  return DEVICE_SCOPE_TERMS.some((term) => normalized.includes(term));
}

function inferScopedDeviceName(text: string): string | undefined {
  const normalized = text.toLowerCase();
  for (const room of ROOM_WORDS) {
    for (const term of DEVICE_SCOPE_TERMS) {
      const phrase = `${room} ${term}`;
      if (normalized.includes(phrase)) {
        return phrase;
      }
    }
  }
  return undefined;
}

function enrichMemoryScopes(text: string, scopes: MemoryScopes): MemoryScopes {
  if (hasPrimaryScope(scopes)) return scopes;

  const inferredDeviceName = inferScopedDeviceName(text);
  if (inferredDeviceName) {
    return {
      ...scopes,
      deviceNames: [inferredDeviceName],
    };
  }

  if (!textMentionsDeviceScope(text)) {
    return {
      ...scopes,
      global: true,
    };
  }

  return scopes;
}

export interface MemoryWriteValidation {
  ok: boolean;
  clarificationRequired?: boolean;
  message?: string;
}

export function validateMemoryWrite(
  text: string,
  scopes?: MemoryScopes
): MemoryWriteValidation {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return { ok: false, message: "Memory text is required." };
  }

  const normalizedScopes = normalizeMemoryScopes(scopes);
  if (hasPrimaryScope(normalizedScopes)) {
    return { ok: true };
  }

  const inferredDeviceName = inferScopedDeviceName(normalizedText);
  if (inferredDeviceName) {
    return { ok: true };
  }

  if (textMentionsDeviceScope(normalizedText)) {
    return {
      ok: false,
      clarificationRequired: true,
      message:
        "Memory appears device-related, but no target device, room, domain, or app scope was provided. Ask which device this should apply to before saving.",
    };
  }

  return { ok: true };
}

function deriveMemoryPk(scopes: MemoryScopes): string {
  const normalizedScopes = normalizeMemoryScopes(scopes);
  const first = (values?: string[]) => values?.find(Boolean);

  const entityId = first(normalizedScopes.deviceEntityIds);
  if (entityId) return `memory|entity|${normalizePartitionValue(entityId)}`;

  const deviceName = first(normalizedScopes.deviceNames);
  if (deviceName) return `memory|device|${normalizePartitionValue(deviceName)}`;

  const roomName = first(normalizedScopes.roomNames);
  if (roomName) return `memory|room|${normalizePartitionValue(roomName)}`;

  const domain = first(normalizedScopes.domains);
  if (domain) return `memory|domain|${normalizePartitionValue(domain)}`;

  const appName = first(normalizedScopes.appNames);
  if (appName) return `memory|app|${normalizePartitionValue(appName)}`;

  const person = first(normalizedScopes.people);
  if (person) return `memory|person|${normalizePartitionValue(person)}`;

  if (normalizedScopes.global) return "memory|global";

  const tag = first(normalizedScopes.tags);
  if (tag) return `memory|tag|${normalizePartitionValue(tag)}`;

  return "memory|unscoped";
}

function mergeMemoryScopes(a: MemoryScopes, b: MemoryScopes): MemoryScopes {
  const mergeList = (left?: string[], right?: string[]) => {
    const values = [...(left || []), ...(right || [])].filter(Boolean);
    return values.length ? Array.from(new Set(values)).slice(0, 20) : undefined;
  };

  return {
    global: a.global || b.global || undefined,
    roomNames: mergeList(a.roomNames, b.roomNames),
    deviceNames: mergeList(a.deviceNames, b.deviceNames),
    deviceEntityIds: mergeList(a.deviceEntityIds, b.deviceEntityIds),
    domains: mergeList(a.domains, b.domains),
    appNames: mergeList(a.appNames, b.appNames),
    people: mergeList(a.people, b.people),
    agentTypes: mergeList(a.agentTypes, b.agentTypes),
    tags: mergeList(a.tags, b.tags),
  };
}

function clampConfidence(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

function validMemoryType(value: unknown): MemoryType {
  return value === "fact" || value === "guidance" || value === "preference"
    ? value
    : "preference";
}

async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const { embedding } = await embed({
      model: azureProvider.embeddingModel(EMBEDDING_MODEL),
      value: text,
    });
    return embedding;
  } catch (error) {
    console.error("[Memory] Embedding generation failed", error);
    return [];
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function scopeValues(scopes: MemoryScopes): string[] {
  return [
    ...(scopes.roomNames || []),
    ...(scopes.deviceNames || []),
    ...(scopes.deviceEntityIds || []),
    ...(scopes.domains || []),
    ...(scopes.appNames || []),
    ...(scopes.people || []),
    ...(scopes.tags || []),
  ].map((v) => v.toLowerCase());
}

function lexicalScore(query: string, doc: AgentMemoryDocument): number {
  const queryTerms = new Set(
    query
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 3)
  );
  if (queryTerms.size === 0) return doc.scopes.global ? 0.15 : 0;

  const haystack = [
    doc.text,
    ...scopeValues(doc.scopes),
    doc.memoryType,
  ].join(" ").toLowerCase();

  let matches = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) matches++;
  }

  return Math.min(1, matches / Math.max(1, Math.min(queryTerms.size, 8)));
}

function scopeScore(query: string, agentType: string | undefined, doc: AgentMemoryDocument): number {
  const q = query.toLowerCase();
  let score = doc.scopes.global ? 0.25 : 0;

  if (agentType && doc.scopes.agentTypes?.includes(agentType)) {
    score += 0.35;
  }

  for (const value of scopeValues(doc.scopes)) {
    if (value && q.includes(value)) {
      score += 0.25;
    }
  }

  return Math.min(1, score);
}

async function fetchActiveCandidatesLive(): Promise<AgentMemoryDocument[]> {
  const container = await getMemoryContainer();
  if (!container) return [];

  try {
    const { resources } = await container.items
      .query<AgentMemoryDocument>({
        query:
          "SELECT TOP @top * FROM c WHERE c.status = @status ORDER BY c.updatedAt DESC",
        parameters: [
          { name: "@top", value: MAX_CANDIDATES },
          { name: "@status", value: "active" },
        ],
      })
      .fetchAll();
    return resources || [];
  } catch (error) {
    console.error("[Memory] Failed to query memory candidates", error);
    return [];
  }
}

async function refreshActiveCandidateCache(): Promise<AgentMemoryDocument[]> {
  if (activeCandidateRefreshPromise) return activeCandidateRefreshPromise;
  activeCandidateRefreshPromise = fetchActiveCandidatesLive()
    .then((docs) => {
      activeCandidateCache = { docs, fetchedAt: Date.now() };
      return docs;
    })
    .finally(() => {
      activeCandidateRefreshPromise = null;
    });
  return activeCandidateRefreshPromise;
}

async function fetchActiveCandidates(preferCache = false): Promise<AgentMemoryDocument[]> {
  const cachedDocs = activeCandidateCache.docs;
  const cacheAgeMs = Date.now() - activeCandidateCache.fetchedAt;
  const cacheFresh = cachedDocs.length > 0 && cacheAgeMs < MEMORY_CANDIDATE_CACHE_TTL_MS;

  if (preferCache && cachedDocs.length > 0) {
    if (!cacheFresh) void refreshActiveCandidateCache();
    return cachedDocs;
  }

  return refreshActiveCandidateCache();
}

function rankMemories(
  docs: AgentMemoryDocument[],
  query: string,
  queryEmbedding: number[],
  agentType?: string
): RankedMemory[] {
  return docs
    .map((doc) => {
      const similarity = queryEmbedding.length
        ? cosineSimilarity(queryEmbedding, doc.embedding || [])
        : 0;
      const scopes = scopeScore(query, agentType, doc);
      const lexical = lexicalScore(query, doc);
      const score = queryEmbedding.length
        ? similarity * 0.72 + scopes * 0.18 + lexical * 0.1
        : scopes * 0.55 + lexical * 0.45;
      return { doc, score, similarity, scopeScore: scopes, lexicalScore: lexical };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.doc.updatedAt.localeCompare(a.doc.updatedAt);
    });
}

async function findDuplicateMemory(
  text: string,
  embedding: number[]
): Promise<AgentMemoryDocument | null> {
  if (!embedding.length) return null;
  const docs = await fetchActiveCandidates();
  const ranked = rankMemories(docs, text, embedding);
  const best = ranked[0];
  if (!best || best.similarity < DUPLICATE_SIMILARITY) return null;
  return best.doc;
}

export async function saveMemory(
  input: MemoryWriteInput
): Promise<AgentMemoryDocument | null> {
  const container = await getMemoryContainer();
  if (!container) return null;

  const text = normalizeText(input.text);
  if (!text) return null;

  const now = new Date().toISOString();
  const normalizedScopes = normalizeMemoryScopes(input.scopes);
  const validation = validateMemoryWrite(text, normalizedScopes);
  if (!validation.ok) {
    console.warn("[Memory] Refusing to save memory", validation.message);
    return null;
  }
  const scopes = enrichMemoryScopes(text, normalizedScopes);
  const pk = deriveMemoryPk(scopes);
  const embedding = await generateEmbedding(text);
  const duplicate = await findDuplicateMemory(text, embedding);
  const mergedDuplicateScopes = duplicate
    ? mergeMemoryScopes(duplicate.scopes, scopes)
    : scopes;

  const doc: AgentMemoryDocument = duplicate
    ? {
        ...duplicate,
        pk: deriveMemoryPk(mergedDuplicateScopes),
        text,
        memoryType: validMemoryType(input.memoryType ?? duplicate.memoryType),
        source: input.source === "explicit" ? "explicit" : duplicate.source,
        confidence: Math.max(
          duplicate.confidence,
          clampConfidence(input.confidence)
        ),
        scopes: mergedDuplicateScopes,
        embedding: embedding.length ? embedding : duplicate.embedding,
        updatedAt: now,
      }
    : {
        id: randomUUID(),
        pk,
        status: "active",
        text,
        memoryType: validMemoryType(input.memoryType),
        source: input.source,
        confidence: clampConfidence(input.confidence),
        scopes,
        embedding,
        createdAt: now,
        updatedAt: now,
        useCount: 0,
      };

  try {
    const { resource } = await container.items.upsert<AgentMemoryDocument>(doc);
    if (duplicate && duplicate.pk !== doc.pk) {
      await container.item(duplicate.id, duplicate.pk).delete().catch(() => undefined);
    }
    void refreshActiveCandidateCache();
    return (resource as AgentMemoryDocument) ?? doc;
  } catch (error) {
    console.error("[Memory] Failed to save memory", error);
    return null;
  }
}

export async function retrieveMemories(
  params: MemoryRetrievalParams
): Promise<AgentMemoryDocument[]> {
  const query = normalizeText(params.query);
  const limit = Math.max(
    1,
    Math.min(params.limit || MEMORY_RETRIEVAL_TOP_K || 5, 10)
  );
  const minSimilarity =
    typeof params.minSimilarity === "number"
      ? params.minSimilarity
      : MEMORY_MIN_SIMILARITY;

  const docs = await fetchActiveCandidates(params.preferCache === true);
  if (docs.length === 0) return [];

  const queryEmbedding =
    query && params.useEmbedding !== false ? await generateEmbedding(query) : [];
  const ranked = rankMemories(docs, query, queryEmbedding, params.agentType);
  const selected = ranked
    .filter((row) => {
      if (!queryEmbedding.length) {
        if (!query) return row.scopeScore > 0 || row.lexicalScore > 0;
        return row.scopeScore >= 0.5 || row.lexicalScore >= 0.35;
      }
      return row.score >= minSimilarity || row.scopeScore >= 0.5;
    })
    .slice(0, limit)
    .map((row) => row.doc);

  void markMemoriesUsed(selected);
  return selected;
}

async function markMemoriesUsed(memories: AgentMemoryDocument[]): Promise<void> {
  if (memories.length === 0) return;
  const container = await getMemoryContainer();
  if (!container) return;
  const now = new Date().toISOString();
  for (const memory of memories) {
    try {
      const { resource } = await container
        .item(memory.id, memory.pk)
        .read<AgentMemoryDocument>();
      if (!resource) continue;
      await container.items.upsert<AgentMemoryDocument>({
        ...resource,
        lastUsedAt: now,
        useCount: (resource.useCount || 0) + 1,
        updatedAt: resource.updatedAt,
      });
    } catch {
      // Usage counters are best effort.
    }
  }
}

export async function getMemoryById(
  id: string
): Promise<AgentMemoryDocument | null> {
  const container = await getMemoryContainer();
  if (!container) return null;
  try {
    const { resources } = await container.items
      .query<AgentMemoryDocument>({
        query: "SELECT TOP 1 * FROM c WHERE c.id = @id",
        parameters: [{ name: "@id", value: id }],
      })
      .fetchAll();
    return resources?.[0] ?? null;
  } catch {
    return null;
  }
}

export async function updateMemory(params: {
  id?: string;
  query?: string;
  text: string;
  memoryType?: MemoryType;
  scopes?: MemoryScopes;
}): Promise<AgentMemoryDocument | null> {
  const container = await getMemoryContainer();
  if (!container) return null;

  const existing = params.id
    ? await getMemoryById(params.id)
    : (await retrieveMemories({ query: params.query || params.text, limit: 1 }))[0];
  if (!existing || existing.status !== "active") return null;

  const text = normalizeText(params.text);
  if (!text) return null;

  const scopes = enrichMemoryScopes(
    text,
    mergeMemoryScopes(existing.scopes, normalizeMemoryScopes(params.scopes))
  );
  const validation = validateMemoryWrite(text, scopes);
  if (!validation.ok) {
    console.warn("[Memory] Refusing to update memory", validation.message);
    return null;
  }

  const embedding = await generateEmbedding(text);
  const updated: AgentMemoryDocument = {
    ...existing,
    pk: deriveMemoryPk(scopes),
    text,
    memoryType: validMemoryType(params.memoryType ?? existing.memoryType),
    scopes,
    embedding: embedding.length ? embedding : existing.embedding,
    source: "explicit",
    confidence: 1,
    updatedAt: new Date().toISOString(),
  };

  try {
    const { resource } = await container.items.upsert<AgentMemoryDocument>(updated);
    if (existing.pk !== updated.pk) {
      await container.item(existing.id, existing.pk).delete().catch(() => undefined);
    }
    void refreshActiveCandidateCache();
    return (resource as AgentMemoryDocument) ?? updated;
  } catch (error) {
    console.error("[Memory] Failed to update memory", error);
    return null;
  }
}

export async function deleteMemory(params: {
  id?: string;
  query?: string;
  limit?: number;
}): Promise<AgentMemoryDocument[]> {
  const container = await getMemoryContainer();
  if (!container) return [];
  if (!params.id && !normalizeText(params.query)) return [];

  const targets = params.id
    ? [await getMemoryById(params.id)].filter(
        (doc): doc is AgentMemoryDocument => !!doc
      )
    : await retrieveMemories({
        query: params.query || "",
        limit: Math.max(1, Math.min(params.limit || 3, 10)),
      });

  const deleted: AgentMemoryDocument[] = [];
  for (const target of targets) {
    if (target.status !== "active") continue;
    const updated: AgentMemoryDocument = {
      ...target,
      status: "deleted",
      updatedAt: new Date().toISOString(),
    };
    try {
      await container.items.upsert(updated);
      deleted.push(updated);
    } catch (error) {
      console.error(`[Memory] Failed to delete memory ${target.id}`, error);
    }
  }
  if (deleted.length > 0) void refreshActiveCandidateCache();
  return deleted;
}

function formatScopes(scopes: MemoryScopes): string {
  const parts: string[] = [];
  if (scopes.global) parts.push("global");
  if (scopes.roomNames?.length) parts.push(`rooms=${scopes.roomNames.join(",")}`);
  if (scopes.deviceNames?.length) parts.push(`devices=${scopes.deviceNames.join(",")}`);
  if (scopes.deviceEntityIds?.length) {
    parts.push(`entities=${scopes.deviceEntityIds.join(",")}`);
  }
  if (scopes.domains?.length) parts.push(`domains=${scopes.domains.join(",")}`);
  if (scopes.appNames?.length) parts.push(`apps=${scopes.appNames.join(",")}`);
  if (scopes.people?.length) parts.push(`people=${scopes.people.join(",")}`);
  if (scopes.agentTypes?.length) parts.push(`agents=${scopes.agentTypes.join(",")}`);
  return parts.join("; ");
}

export function formatMemoryContext(memories: AgentMemoryDocument[]): string {
  if (memories.length === 0) return "";
  const lines = memories.map((memory, index) => {
    const scopes = formatScopes(memory.scopes);
    const scopePart = scopes ? ` scope: ${scopes};` : "";
    const label =
      memory.memoryType === "guidance"
        ? "GUIDANCE - follow when applicable"
        : memory.memoryType;
    return `${index + 1}. [${memory.id}] ${label};${scopePart} ${memory.text}`;
  });
  return [
    "Relevant Persistent agent memory for this request:",
    ...lines,
    "",
    "Apply guidance memories when they match the request. Current user instructions and current device state override memory.",
  ].join("\n");
}

export async function getPromptMemoryContext(params: {
  query: string;
  agentType: string;
  timeoutMs?: number;
}): Promise<string> {
  const timeoutMs = Math.max(
    100,
    params.timeoutMs ?? MEMORY_RETRIEVAL_TIMEOUT_MS
  );
  const retrieval = retrieveMemories({
    query: params.query,
    agentType: params.agentType,
    limit: MEMORY_RETRIEVAL_TOP_K,
    preferCache: true,
    useEmbedding: false,
  });
  const memories = await withTimeout(retrieval, timeoutMs, []);
  return formatMemoryContext(memories);
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T
): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        console.error("[Memory] Operation failed", error);
        resolve(fallback);
      });
  });
}

export function recordMemoryInteraction(interaction: MemoryInteraction): void {
  const userText = normalizeText(interaction.userText);
  const assistantText = normalizeText(interaction.assistantText);
  if (!userText && !assistantText) return;

  pendingInteractions.push({
    agentType: normalizeText(interaction.agentType) || "unknown",
    userText,
    assistantText,
    createdAt: interaction.createdAt || new Date().toISOString(),
  });

  while (pendingInteractions.length > MAX_PENDING_INTERACTIONS) {
    pendingInteractions.shift();
  }
}

export function startMemoryConsolidation(): void {
  if (!partitionRepairStarted) {
    partitionRepairStarted = true;
    void repairLegacyMemoryPartitions();
  }

  void refreshActiveCandidateCache();
  if (!candidateCacheRefreshTimer) {
    candidateCacheRefreshTimer = setInterval(() => {
      void refreshActiveCandidateCache();
    }, MEMORY_CANDIDATE_CACHE_TTL_MS);
    candidateCacheRefreshTimer.unref?.();
  }

  if (!MEMORY_CONSOLIDATION_ENABLED || consolidationTimer) return;
  consolidationTimer = setInterval(() => {
    void runMemoryConsolidationOnce();
  }, Math.max(10000, MEMORY_CONSOLIDATION_INTERVAL_MS));
  consolidationTimer.unref?.();
}

async function repairLegacyMemoryPartitions(): Promise<void> {
  const container = await getMemoryContainer();
  if (!container) return;

  const docs = await fetchActiveCandidates();
  for (const doc of docs) {
    if (doc.pk !== "memory" && doc.pk !== "memory|unscoped") continue;

    const scopes = enrichMemoryScopes(doc.text, normalizeMemoryScopes(doc.scopes));
    const validation = validateMemoryWrite(doc.text, scopes);
    if (!validation.ok) {
      console.warn(
        `[Memory] Legacy memory ${doc.id} needs clarification before re-keying: ${validation.message}`
      );
      continue;
    }

    const repaired: AgentMemoryDocument = {
      ...doc,
      pk: deriveMemoryPk(scopes),
      scopes,
      updatedAt: new Date().toISOString(),
    };
    if (repaired.pk === doc.pk) continue;

    try {
      await container.items.upsert(repaired);
      await container.item(doc.id, doc.pk).delete().catch(() => undefined);
      console.log(
        `[Memory] Re-keyed legacy memory ${doc.id} from ${doc.pk} to ${repaired.pk}`
      );
    } catch (error) {
      console.error(`[Memory] Failed to re-key legacy memory ${doc.id}`, error);
    }
  }
}

export async function runMemoryConsolidationOnce(): Promise<void> {
  if (consolidationRunning || pendingInteractions.length === 0) return;
  if (!AI_MODEL_MINI || !isMemoryConfigured()) return;

  consolidationRunning = true;
  const batch = pendingInteractions.splice(0, CONSOLIDATION_BATCH_SIZE);
  try {
    const candidates = await extractMemoryCandidates(batch);
    for (const candidate of candidates) {
      if (candidate.confidence < 0.75) continue;
      await saveMemory({
        text: candidate.text,
        memoryType: candidate.memoryType,
        source: "inferred",
        confidence: candidate.confidence,
        scopes: candidate.scopes,
      });
    }
  } catch (error) {
    console.error("[Memory] Consolidation failed", error);
    pendingInteractions.unshift(...batch);
    while (pendingInteractions.length > MAX_PENDING_INTERACTIONS) {
      pendingInteractions.pop();
    }
  } finally {
    consolidationRunning = false;
  }
}

interface ExtractedMemoryCandidate {
  text: string;
  memoryType: MemoryType;
  confidence: number;
  scopes: MemoryScopes;
}

async function extractMemoryCandidates(
  interactions: MemoryInteraction[]
): Promise<ExtractedMemoryCandidate[]> {
  const model = AI_MODEL_MINI;
  if (!model) return [];

  const transcript = interactions
    .map((item, index) => {
      return [
        `Interaction ${index + 1} (${item.agentType}, ${item.createdAt})`,
        `User: ${item.userText}`,
        item.assistantText ? `Assistant: ${item.assistantText}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");

  const prompt = `Extract only durable user preferences, stable facts, or reusable guidance worth remembering for a smart-home voice assistant.

Do not extract transient commands, current device state, tool progress, failed attempts, or one-off requests.
Current user instructions override old memory, so produce corrected replacement facts when the user explicitly changes a preference.
For device-specific memories, include a concrete target in scopes.deviceNames or scopes.deviceEntityIds.
For room-, domain-, app-, or person-specific memories, include the matching scope field.
Use global=true only for preferences that truly apply everywhere.
If the interaction does not identify the target clearly enough, do not extract a memory for it.

Return JSON only, as an array of objects:
[
  {
    "text": "durable memory sentence",
    "memoryType": "preference" | "fact" | "guidance",
    "confidence": 0.0-1.0,
    "scopes": {
      "global": true,
      "roomNames": [],
      "deviceNames": [],
      "deviceEntityIds": [],
      "domains": [],
      "appNames": [],
      "people": [],
      "agentTypes": [],
      "tags": []
    }
  }
]

Return [] if nothing is worth remembering.

Recent interactions:
${transcript}`;

  const raw = await generateCompletion({
    model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 1200,
    temperature: 0,
  });

  const parsed = parseJsonArray(raw);
  return parsed
    .map((item) => {
      const record = item as Record<string, unknown>;
      return {
        text: normalizeText(record.text),
        memoryType: validMemoryType(record.memoryType),
        confidence: clampConfidence(record.confidence),
        scopes: normalizeMemoryScopes(record.scopes as MemoryScopes | undefined),
      };
    })
    .filter((item) => item.text.length > 0);
}

function parseJsonArray(raw: string): unknown[] {
  const trimmed = raw.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = withoutFence.indexOf("[");
  const end = withoutFence.lastIndexOf("]");
  if (start < 0 || end < start) return [];
  try {
    const parsed = JSON.parse(withoutFence.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("[Memory] Failed to parse consolidation JSON", {
      error,
      raw: raw.slice(0, 1000),
    });
    return [];
  }
}
