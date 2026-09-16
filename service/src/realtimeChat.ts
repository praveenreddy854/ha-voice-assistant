import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import {
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_RESOURCE_NAME,
  AZURE_OPENAI_REALTIME_API_VERSION,
  AI_MODEL_REALTIME,
  AI_MODEL_TRANSCRIBE,
  USER_ADDRESS,
} from "./config";

const HOME_ASSISTANT_DEVICES = (process.env.HOME_ASSISTANT_DEVICES || "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);
import { executeHACommand } from "./ha";
import { runAgent } from "./agents/core";
import { startTvAgentJob } from "./tvJobManager";
import {
  ActiveRunDomain,
  cancelActiveRun,
  getActiveRun,
  pauseActiveRun,
  resumeActiveRun,
  startActiveRun,
} from "./activeRunManager";
import { getTracer } from "./tracing";
import {
  buildRealtimeInstructions,
  buildRealtimeTurnInstructions,
  needsActionConfirmation,
  REALTIME_TOOLS,
} from "./realtimeAgent";
import { RealtimeTraceRecorder } from "./tracing/realtimeTrace";
import {
  deleteMemory,
  formatMemoryContext,
  getPromptMemoryContext,
  MemoryScopes,
  MemoryType,
  recordMemoryInteraction,
  retrieveMemories,
  saveMemory,
  updateMemory,
  validateMemoryWrite,
} from "./memory";

type JsonRecord = Record<string, unknown>;

// ============================================================================
// Web Search via DuckDuckGo HTML
// ============================================================================

const MAX_CONTENT_LENGTH = 4000;

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function parseDdgResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const resultBlocks = html.split(/class="result\s/);

  for (const block of resultBlocks.slice(1, 6)) {
    const urlMatch = block.match(/class="result__a"[^>]*href="([^"]+)"/);
    const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
    const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

    if (urlMatch?.[1]) {
      let url = urlMatch[1];
      const uddgMatch = url.match(/uddg=([^&]+)/);
      if (uddgMatch?.[1]) {
        url = decodeURIComponent(uddgMatch[1]);
      }

      results.push({
        title: titleMatch?.[1]?.trim() || url,
        url,
        snippet: snippetMatch?.[1] ? stripHtml(snippetMatch[1]).substring(0, 200) : "",
      });
    }
  }

  return results;
}

async function fetchPageContent(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; HAVoiceAssistant/1.0)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return "";

    const html = await response.text();
    let content = html;
    const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (mainMatch?.[1]) content = mainMatch[1];
    else if (articleMatch?.[1]) content = articleMatch[1];

    return stripHtml(content).substring(0, MAX_CONTENT_LENGTH);
  } catch {
    return "";
  }
}

async function executeWebSearch(query: string): Promise<string> {
  try {
    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const response = await fetch(ddgUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; HAVoiceAssistant/1.0)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) return `Search failed: HTTP ${response.status}`;

    const html = await response.text();
    const results = parseDdgResults(html);

    if (results.length === 0) return `No results found for "${query}".`;

    const resultsList = results
      .map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
      .join("\n\n");

    // Fetch top result content for richer context
    const topContent = await fetchPageContent(results[0].url);
    const topSection = topContent
      ? `\n\n--- Top Result Content (${results[0].title}) ---\n${topContent}`
      : "";

    return `Search results for "${query}":\n\n${resultsList}${topSection}`;
  } catch (error) {
    return `Search error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

// ============================================================================
// Persistent Azure Realtime Session
// ============================================================================

let azureWs: WebSocket | null = null;
let azureReady = false;
let activeClientWs: WebSocket | null = null;
let fullTranscript = "";
let lastUserTranscript = "";
let pendingFollowUp = false;
let responseInFlight = false;
let responseCreatePending = false;
let queuedResponseInstructions: string | null = null;
let queuedResponseTraceId: string | null = null;
let queuedAssistantSpeechInstructions: string[] = [];
let suppressCancelledResponseDone = false;
let interruptedAssistantText: string | null = null;
let readyCallbacks: Array<() => void> = [];
let pendingAudioResponseTimer: NodeJS.Timeout | null = null;
let pendingAudioResponseRequested = false;

// Short conversational memory cap: at most 10 items and 5 minutes.
const MEMORY_MAX_ITEMS = 10;
const MEMORY_MAX_AGE_MS = 5 * 60 * 1000;
const conversationItems: Array<{ id: string; createdAt: number }> = [];

function pruneConversationMemory(): void {
  const now = Date.now();
  while (
    conversationItems.length > 0 &&
    now - conversationItems[0].createdAt > MEMORY_MAX_AGE_MS
  ) {
    const dropped = conversationItems.shift();
    if (dropped) deleteAzureItem(dropped.id);
  }
  while (conversationItems.length > MEMORY_MAX_ITEMS) {
    const dropped = conversationItems.shift();
    if (dropped) deleteAzureItem(dropped.id);
  }
}

function deleteAzureItem(itemId: string): void {
  if (!azureWs || azureWs.readyState !== WebSocket.OPEN) return;
  azureWs.send(
    JSON.stringify({ type: "conversation.item.delete", item_id: itemId })
  );
}
let audioLog = {
  chunkCount: 0,
  approxBytes: 0,
  lastLoggedAt: 0,
};

function parseArgs(raw: string): JsonRecord {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function isClientActive(): boolean {
  return activeClientWs?.readyState === WebSocket.OPEN;
}

function sendClient(payload: JsonRecord): void {
  if (!isClientActive()) return;
  activeClientWs?.send(JSON.stringify(payload));
}

function sendAzure(payload: JsonRecord): void {
  if (!azureWs || azureWs.readyState !== WebSocket.OPEN) return;
  azureWs.send(JSON.stringify(payload));
}

function requestAssistantSpeech(instructions: string): void {
  if (!azureReady || !isClientActive()) return;
  fullTranscript = "";
  if (responseInFlight || responseCreatePending) {
    // Tool-result acknowledgements (for example "On it") must be
    // spoken before a fast async run's completion announcement.
    queuedAssistantSpeechInstructions.push(instructions);
    return;
  }
  requestDefaultResponse(instructions, "queue", null);
}

type BusyResponseBehavior = "queue" | "skip";

function requestDefaultResponse(
  instructions?: string,
  busyBehavior: BusyResponseBehavior = "queue",
  traceTurnId: string | null = realtimeTrace.currentTurnId
): boolean {
  if (responseInFlight || responseCreatePending) {
    if (busyBehavior === "queue") {
      queuedResponseInstructions = instructions ?? "";
      queuedResponseTraceId = traceTurnId;
    }
    return false;
  }

  responseCreatePending = true;
  realtimeTrace.responseRequested(traceTurnId, instructions);
  sendAzure({
    type: "response.create",
    response: {
      modalities: ["text", "audio"],
      ...(instructions ? { instructions } : {}),
    },
  });
  return true;
}

function flushQueuedResponse(): void {
  if (queuedResponseInstructions !== null) {
    const instructions = queuedResponseInstructions;
    const traceTurnId = queuedResponseTraceId;
    queuedResponseInstructions = null;
    queuedResponseTraceId = null;
    requestDefaultResponse(instructions || undefined, "queue", traceTurnId);
    return;
  }
  const assistantSpeech = queuedAssistantSpeechInstructions.shift();
  if (assistantSpeech) {
    requestDefaultResponse(assistantSpeech, "queue", null);
  }
}

async function requestDefaultResponseWithMemory(
  query: string,
  busyBehavior: BusyResponseBehavior = "queue"
): Promise<void> {
  const traceTurnId = realtimeTrace.currentTurnId;
  const span = getTracer().startSpan("realtime.memory.inject", {
    attributes: {
      "telemetry.kind": "realtime_memory",
      "realtime.query": query,
    },
  });
  const memoryContext = await getPromptMemoryContext({
    query,
    agentType: "realtime",
  });
  span.setAttribute("realtime.memory.context_present", Boolean(memoryContext));
  span.setAttribute("realtime.memory.has_guard", /guard/i.test(memoryContext));
  span.end();
  const responseInstructions = buildRealtimeTurnInstructions({
    memoryContext,
    activeRun: getActiveRun(),
    interruptedAssistantText,
  });
  const responseRequested = requestDefaultResponse(
    responseInstructions || undefined,
    busyBehavior,
    traceTurnId
  );
  if (query.trim() && (responseRequested || busyBehavior === "queue")) {
    interruptedAssistantText = null;
  }
}

function resetAudioLog(): void {
  audioLog = {
    chunkCount: 0,
    approxBytes: 0,
    lastLoggedAt: 0,
  };
}

function recordAudioAppend(base64Audio: string): void {
  audioLog.chunkCount += 1;
  audioLog.approxBytes += Math.floor((base64Audio.length * 3) / 4);

  const now = Date.now();
  if (now - audioLog.lastLoggedAt < 1000) return;

  console.log(
    `[RealtimeChat] Forwarding microphone audio chunks=${audioLog.chunkCount} approxBytes=${audioLog.approxBytes}`
  );
  audioLog.chunkCount = 0;
  audioLog.approxBytes = 0;
  audioLog.lastLoggedAt = now;
}

function activeRunLabel(domain: ActiveRunDomain): string {
  switch (domain) {
    case "tv":
      return "TV agent";
    case "scheduled_task":
      return "ScheduledTaskAgent";
    case "home_assistant":
      return "Home Assistant action";
  }
}

function isInformationalRequest(prompt: string): boolean {
  const normalized = prompt.trim().toLowerCase();
  return /^(?:what|when|where|who|why|how|which)\b|^(?:tell me|show me|give me|list|read|check (?:if|whether|the |my )|do i have|are there|is there|any\b|get (?:the )?(?:state|status))|^(?:can|could|would|will) you (?:tell|show|list|check|read)\b/.test(
    normalized
  );
}

function messageNeedsUserAction(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return (
    /\?\s*$/.test(normalized) ||
    /\b(?:please|need you to|you need to|need (?:more|additional) (?:information|details)|must|confirm|choose|select|provide|tell me which|try again|cannot proceed|can't proceed|unable to proceed|failed|error)\b/.test(
      normalized
    )
  );
}

function completionSpeechInstructions(options: {
  prompt: string;
  message: string;
  isAnswer?: boolean;
}): string {
  const detail = JSON.stringify(options.message || "Done");
  if (messageNeedsUserAction(options.message)) {
    return `Explain clearly what happened and exactly what the user needs to do next, using this result: ${detail}. If you ask the user a question, call await_user_followup before speaking. Do not shorten this to a generic completion.`;
  }
  if (options.isAnswer || isInformationalRequest(options.prompt)) {
    return `Answer the user's question clearly and completely in natural language using this result: ${detail}. Keep all details needed for the answer; the short command-completion rule does not apply.`;
  }
  return 'Say exactly "Done."';
}

function failureSpeechInstructions(subject: string, message: string): string {
  const detail = JSON.stringify(message || `${subject} failed`);
  return `Explain clearly that the ${subject} failed, using this detail: ${detail}. Include any action the user needs to take. If you ask a question, call await_user_followup before speaking. Do not impose the short success-completion limit.`;
}

function isHomeAssistantStateResult(data: unknown): boolean {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return typeof record.entity_id === "string" && "state" in record;
}

function matchWakePhrase(
  transcript: string
): { trailingText: string } | null {
  const match = transcript.toLocaleLowerCase().match(
    /^\s*(?:hey[,\s]+|ok[,\s]+)?assistant\b[,.\s]*(.*)$/
  );
  return match ? { trailingText: match[1]?.trim() ?? "" } : null;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return result.length ? result : undefined;
}

function parseMemoryScopes(value: unknown): MemoryScopes | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  return {
    global: raw.global === true,
    roomNames: stringList(raw.roomNames),
    deviceNames: stringList(raw.deviceNames),
    deviceEntityIds: stringList(raw.deviceEntityIds),
    domains: stringList(raw.domains),
    appNames: stringList(raw.appNames),
    people: stringList(raw.people),
    agentTypes: stringList(raw.agentTypes),
    tags: stringList(raw.tags),
  };
}

function parseMemoryType(value: unknown): MemoryType | undefined {
  return value === "fact" || value === "guidance" || value === "preference"
    ? value
    : undefined;
}

function compactMemoryPayload(memory: {
  id: string;
  text: string;
  memoryType: string;
  source: string;
  confidence: number;
  scopes: MemoryScopes;
  updatedAt: string;
}): JsonRecord {
  return {
    id: memory.id,
    text: memory.text,
    memoryType: memory.memoryType,
    source: memory.source,
    confidence: memory.confidence,
    scopes: memory.scopes,
    updatedAt: memory.updatedAt,
  };
}

function clearPendingAudioResponse(): void {
  if (pendingAudioResponseTimer) {
    clearTimeout(pendingAudioResponseTimer);
    pendingAudioResponseTimer = null;
  }
}

function scheduleAudioResponseFallback(): void {
  clearPendingAudioResponse();
  pendingAudioResponseRequested = false;
  pendingAudioResponseTimer = setTimeout(() => {
    void requestAudioResponseWithMemory("");
  }, 1500);
}

async function requestAudioResponseWithMemory(transcript: string): Promise<void> {
  if (pendingAudioResponseRequested) return;
  pendingAudioResponseRequested = true;
  clearPendingAudioResponse();
  await requestDefaultResponseWithMemory(
    transcript,
    suppressCancelledResponseDone ? "queue" : "skip"
  );
}

function startRealtimeTvJob(prompt: string) {
  const started = startTvAgentJob(prompt, {
    onComplete: (message) => {
      sendClient({ type: "async_job_finished", domain: "tv", status: "completed" });
      requestAssistantSpeech(completionSpeechInstructions({ prompt, message }));
    },
    onError: (message) => {
      sendClient({ type: "async_job_finished", domain: "tv", status: "error" });
      requestAssistantSpeech(failureSpeechInstructions("TV command", message));
    },
  });
  sendClient({ type: "async_job_started", domain: "tv", jobId: started.jobId });
  return started;
}

function startRealtimeScheduledTaskJob(prompt: string) {
  const started = startActiveRun({
    domain: "scheduled_task",
    prompt,
    execute: async (run) => {
      const result = await runAgent({
        agentType: "scheduled_task",
        userPrompt: run.prompt,
        maxSteps: 8,
        abortSignal: run.abortSignal,
        pauseGate: run.pauseGate,
      });
      if (result.status !== "completed" || !result.success) {
        throw new Error(result.message || "Scheduled task job failed.");
      }
      return result.message || "Done";
    },
    onComplete: (message, run) => {
      sendClient({
        type: "async_job_finished",
        domain: "scheduled_task",
        status: "completed",
        jobId: run.id,
      });
      requestAssistantSpeech(
        completionSpeechInstructions({ prompt: run.prompt, message })
      );
    },
    onError: (message, run) => {
      sendClient({
        type: "async_job_finished",
        domain: "scheduled_task",
        status: "error",
        jobId: run.id,
      });
      requestAssistantSpeech(
        failureSpeechInstructions("scheduled task command", message)
      );
    },
  });
  sendClient({
    type: "async_job_started",
    domain: "scheduled_task",
    jobId: started.jobId,
  });
  return started;
}

function startRealtimeHomeAssistantJob(command: string) {
  const started = startActiveRun({
    domain: "home_assistant",
    prompt: command,
    execute: async (run) => {
      const result = await executeHACommand(run.prompt, undefined, {
        abortSignal: run.abortSignal,
        pauseGate: run.pauseGate,
      });
      if (!result.success) {
        throw new Error(result.message || "Home Assistant action failed.");
      }
      return {
        message: result.message || "Done",
        isAnswer: isHomeAssistantStateResult(result.data),
      };
    },
    onComplete: (result, run) => {
      sendClient({
        type: "async_job_finished",
        domain: "home_assistant",
        status: "completed",
        jobId: run.id,
      });
      requestAssistantSpeech(
        completionSpeechInstructions({
          prompt: run.prompt,
          message: result.message,
          isAnswer: result.isAnswer,
        })
      );
    },
    onError: (message, run) => {
      sendClient({
        type: "async_job_finished",
        domain: "home_assistant",
        status: "error",
        jobId: run.id,
      });
      requestAssistantSpeech(
        failureSpeechInstructions("Home Assistant command", message)
      );
    },
  });
  sendClient({
    type: "async_job_started",
    domain: "home_assistant",
    jobId: started.jobId,
  });
  return started;
}

function startReplacementRun(
  domain: ActiveRunDomain,
  prompt: string,
  confirmed: boolean
) {
  if (domain === "tv") return startRealtimeTvJob(prompt);
  if (domain === "scheduled_task") {
    return startRealtimeScheduledTaskJob(prompt);
  }
  if (needsActionConfirmation(prompt) && !confirmed) {
    return null;
  }
  return startRealtimeHomeAssistantJob(prompt);
}

function controlActiveRun(
  args: JsonRecord,
  requiredDomain?: ActiveRunDomain
): string {
  const action = typeof args.action === "string" ? args.action : "";
  if (action !== "continue" && action !== "stop" && action !== "change") {
    return JSON.stringify({
      success: false,
      message:
        requiredDomain === "tv"
          ? "Unsupported TV job action."
          : "Unsupported active-run action.",
    });
  }
  const activeRun = getActiveRun(requiredDomain);
  const runDescription = requiredDomain === "tv" ? "TV job" : "active run";

  if (!activeRun) {
    if (requiredDomain === "tv" && action === "change") {
      const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
      if (!prompt) {
        return JSON.stringify({
          success: false,
          message: "A full replacement TV instruction is required.",
        });
      }
      const started = startRealtimeTvJob(prompt);
      return JSON.stringify({
        success: true,
        jobId: started.jobId,
        replacedJobId: started.replacedJobId,
        message: "The prior TV job was replaced. Say exactly: On it.",
      });
    }
    return JSON.stringify({
      success: false,
      message:
        action === "continue"
          ? `There is no paused ${runDescription} to continue.`
          : action === "stop"
            ? `There is no ${runDescription} to stop.`
            : `There is no ${runDescription} to control.`,
    });
  }

  if (action === "continue") {
    const resumed = resumeActiveRun(requiredDomain);
    if (!resumed) {
      return JSON.stringify({
        success: false,
        message: `There is no paused ${runDescription} to continue.`,
      });
    }
    sendClient({
      type: "async_job_started",
      domain: resumed.domain,
      jobId: resumed.id,
    });
    return JSON.stringify({
      success: true,
      jobId: resumed.id,
      domain: resumed.domain,
      message:
        resumed.domain === "tv"
          ? "The same TV job resumed. Say exactly: On it."
          : "The same active run resumed. Say exactly: On it.",
    });
  }

  if (action === "stop") {
    const stopped = cancelActiveRun(requiredDomain);
    if (!stopped) {
      return JSON.stringify({
        success: false,
        message: `There is no ${runDescription} to stop.`,
      });
    }
    sendClient({
      type: "async_job_finished",
      domain: stopped.domain,
      status: "cancelled",
      jobId: stopped.id,
    });
    return JSON.stringify({
      success: true,
      jobId: stopped.id,
      domain: stopped.domain,
      message:
        stopped.domain === "tv"
          ? "The TV job was stopped. Say exactly: Done."
          : "The active run was stopped. Say exactly: Done.",
    });
  }

  if (action === "change") {
    const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
    if (!prompt) {
      return JSON.stringify({
        success: false,
        message:
          requiredDomain === "tv"
            ? "A full replacement TV instruction is required."
            : `A full replacement ${activeRunLabel(activeRun.domain)} instruction is required.`,
      });
    }
    const requestedDomain =
      args.domain === "tv" ||
      args.domain === "scheduled_task" ||
      args.domain === "home_assistant"
        ? args.domain
        : activeRun.domain;
    const replacementDomain = requiredDomain ?? requestedDomain;
    const started = startReplacementRun(
      replacementDomain,
      prompt,
      args.confirmed === true
    );
    if (!started) {
      return "confirmation_required: Ask the user to confirm this protected or bulk destructive replacement before executing it.";
    }
    return JSON.stringify({
      success: true,
      jobId: started.jobId,
      replacedJobId: activeRun.id,
      domain: replacementDomain,
      message:
        replacementDomain === "tv"
          ? "The prior TV job was replaced. Say exactly: On it."
          : "The prior active run was replaced. Say exactly: On it.",
    });
  }

  return JSON.stringify({ success: false, message: "Unsupported active-run action." });
}

async function executeRealtimeTool(
  name: string,
  args: JsonRecord
): Promise<string> {
  switch (name) {
    case "await_user_followup": {
      pendingFollowUp = true;
      return JSON.stringify({ ok: true });
    }

    case "web_search": {
      const query = typeof args.query === "string" ? args.query : "";
      return executeWebSearch(query);
    }

    case "retrieve_memory": {
      const query = typeof args.query === "string" ? args.query : "";
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const memories = await retrieveMemories({
        query,
        agentType: "realtime",
        limit,
      });
      return JSON.stringify({
        memories: memories.map(compactMemoryPayload),
        context: formatMemoryContext(memories),
      });
    }

    case "save_memory": {
      const text = typeof args.text === "string" ? args.text : "";
      if (!text.trim()) return "Missing memory text.";
      const scopes = parseMemoryScopes(args.scopes) || {};
      const validation = validateMemoryWrite(text, scopes);
      if (!validation.ok) {
        return JSON.stringify({
          success: false,
          clarification_required: validation.clarificationRequired === true,
          message:
            validation.message ||
            "Memory needs a clearer scope before it can be saved.",
        });
      }
      const saved = await saveMemory({
        text,
        memoryType: parseMemoryType(args.memoryType),
        source: "explicit",
        confidence: 1,
        scopes: {
          ...scopes,
          agentTypes: Array.from(new Set([...(scopes.agentTypes || []), "realtime"])),
        },
      });
      return JSON.stringify({
        success: !!saved,
        memory: saved ? compactMemoryPayload(saved) : null,
      });
    }

    case "update_memory": {
      const id = typeof args.id === "string" ? args.id : undefined;
      const query = typeof args.query === "string" ? args.query : undefined;
      const text = typeof args.text === "string" ? args.text : "";
      if (!text.trim()) return "Missing replacement memory text.";
      const updated = await updateMemory({
        id,
        query,
        text,
        memoryType: parseMemoryType(args.memoryType),
        scopes: parseMemoryScopes(args.scopes),
      });
      return JSON.stringify({
        success: !!updated,
        memory: updated ? compactMemoryPayload(updated) : null,
      });
    }

    case "delete_memory": {
      const id = typeof args.id === "string" ? args.id : undefined;
      const query = typeof args.query === "string" ? args.query : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const deleted = await deleteMemory({ id, query, limit });
      return JSON.stringify({
        success: deleted.length > 0,
        deleted: deleted.map(compactMemoryPayload),
      });
    }

    case "execute_home_assistant_command": {
      const command = typeof args.command === "string" ? args.command : "";
      const confirmed = args.confirmed === true;
      if (!command.trim()) {
        return "Missing command.";
      }
      if (needsActionConfirmation(command) && !confirmed) {
        return "confirmation_required: Ask the user to confirm this protected or bulk destructive action before executing it.";
      }
      const started = startRealtimeHomeAssistantJob(command);
      return JSON.stringify({
        success: true,
        jobId: started.jobId,
        replacedJobId: started.replacedRun?.id,
        message: "Home Assistant job started. Say exactly: On it.",
      });
    }

    case "run_scheduled_task_agent": {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      if (!prompt.trim()) {
        return "Missing scheduled task prompt.";
      }
      const started = startRealtimeScheduledTaskJob(prompt);
      return JSON.stringify({
        success: true,
        jobId: started.jobId,
        replacedJobId: started.replacedRun?.id,
        message: "Scheduled task job started. Say exactly: On it.",
      });
    }

    case "start_tv_agent": {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      if (!prompt.trim()) {
        return "Missing TV prompt.";
      }
      const started = startRealtimeTvJob(prompt);
      return JSON.stringify({
        success: true,
        jobId: started.jobId,
        replacedJobId: started.replacedJobId,
        message: "TV job started. Say exactly: On it.",
      });
    }

    case "control_tv_agent": {
      return controlActiveRun(args, "tv");
    }

    case "control_active_run": {
      return controlActiveRun(args);
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

const REALTIME_INSTRUCTIONS = buildRealtimeInstructions({
  devices: HOME_ASSISTANT_DEVICES,
  address: USER_ADDRESS,
});
const realtimeTrace = new RealtimeTraceRecorder({
  model: AI_MODEL_REALTIME || "",
  instructions: REALTIME_INSTRUCTIONS,
});

function connectAzure(onReady: () => void): void {
  if (azureWs && azureReady && azureWs.readyState === WebSocket.OPEN) {
    onReady();
    return;
  }

  if (
    azureWs &&
    !azureReady &&
    (azureWs.readyState === WebSocket.OPEN ||
      azureWs.readyState === WebSocket.CONNECTING)
  ) {
    readyCallbacks.push(onReady);
    return;
  }

  // Close stale connection if any
  if (azureWs) {
    realtimeTrace.close("Stale Azure Realtime connection replaced");
    azureWs.removeAllListeners();
    if (azureWs.readyState === WebSocket.OPEN || azureWs.readyState === WebSocket.CONNECTING) {
      azureWs.close();
    }
    azureWs = null;
    azureReady = false;
  }
  readyCallbacks = [onReady];

  const azureUrl =
    `wss://${AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/realtime` +
    `?api-version=${AZURE_OPENAI_REALTIME_API_VERSION}` +
    `&deployment=${AI_MODEL_REALTIME}`;

  const ws = new WebSocket(azureUrl, {
    headers: { "api-key": AZURE_OPENAI_API_KEY! },
  });
  azureWs = ws;

  ws.on("open", () => {
    console.log("[RealtimeChat] Connected to Azure Realtime API");

    // Configure the session as the post-wake-word voice agent.
    ws.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        instructions: REALTIME_INSTRUCTIONS,
        input_audio_format: "pcm16",
        output_audio_format: "pcm16",
        input_audio_transcription: {
          model: AI_MODEL_TRANSCRIBE,
        },
        tools: REALTIME_TOOLS,
      },
    }));

  });

  ws.on("message", async (data) => {
    try {
      const event = JSON.parse(data.toString());
      realtimeTrace.observe(event);

      switch (event.type) {
        case "session.created":
          console.log("[RealtimeChat] Azure session created");
          break;

        case "session.updated":
          console.log("[RealtimeChat] Azure session configured");
          azureReady = true;
          for (const cb of readyCallbacks.splice(0)) {
            cb();
          }
          break;

        case "response.created":
          responseCreatePending = false;
          responseInFlight = true;
          break;

        case "input_audio_buffer.speech_started":
          console.log("[RealtimeChat] Azure speech started");
          if (responseInFlight) {
            realtimeTrace.interrupt("User interrupted the in-flight spoken response");
            console.log("[RealtimeChat] Barge-in: cancelling in-flight response");
            if (fullTranscript.trim()) {
              interruptedAssistantText = fullTranscript.trim();
            }
            queuedAssistantSpeechInstructions = [];
            suppressCancelledResponseDone = true;
            sendAzure({ type: "response.cancel" });
            sendClient({ type: "assistant_interrupted" });
          }
          sendClient({ type: "speech_started" });
          break;

        case "input_audio_buffer.speech_stopped":
          console.log("[RealtimeChat] Azure speech stopped");
          sendClient({ type: "speech_stopped" });
          break;

        case "input_audio_buffer.committed":
          console.log("[RealtimeChat] Azure audio buffer committed");
          resetAudioLog();
          pendingFollowUp = false;
          scheduleAudioResponseFallback();
          break;

        case "conversation.item.created":
          if (event.item?.id) {
            conversationItems.push({
              id: event.item.id,
              createdAt: Date.now(),
            });
            pruneConversationMemory();
          }
          break;

        case "conversation.item.deleted":
          if (event.item_id) {
            const idx = conversationItems.findIndex(
              (i) => i.id === event.item_id
            );
            if (idx >= 0) conversationItems.splice(idx, 1);
          }
          break;

        case "input_audio_buffer.cleared":
          console.log("[RealtimeChat] Azure audio buffer cleared");
          resetAudioLog();
          break;

        case "response.audio.delta":
          sendClient({
            type: "audio_delta",
            audio: event.delta,
          });
          break;

        case "response.audio_transcript.delta":
          fullTranscript += event.delta;
          sendClient({
            type: "transcript_delta",
            text: event.delta,
          });
          break;

        case "response.text.delta":
          fullTranscript += event.delta;
          sendClient({
            type: "transcript_delta",
            text: event.delta,
          });
          break;

        case "conversation.item.input_audio_transcription.completed":
          console.log(
            `[RealtimeChat] Azure transcription completed chars=${String(event.transcript || "").length}`
          );
          if (event.transcript) {
            const transcript = String(event.transcript);
            const activeRun = getActiveRun();
            const wakeMatch = matchWakePhrase(transcript);

            if (wakeMatch) {
              const pausedRun = activeRun ? pauseActiveRun() : undefined;
              console.log(
                pausedRun
                  ? `[RealtimeChat] Wake phrase paused active ${pausedRun.domain} job ${pausedRun.id}`
                  : "[RealtimeChat] Wake phrase paused the active spoken response"
              );
              if (fullTranscript.trim()) {
                interruptedAssistantText = fullTranscript.trim();
              }
              clearPendingAudioResponse();
              queuedAssistantSpeechInstructions = [];
              pendingAudioResponseRequested = true;
              pendingFollowUp = true;
              lastUserTranscript = "";
              fullTranscript = "";
              if (responseInFlight) {
                suppressCancelledResponseDone = true;
                sendAzure({ type: "response.cancel" });
              } else {
                responseCreatePending = false;
              }
              sendClient({
                type: "agent_run_paused",
                domain: pausedRun?.domain ?? "realtime",
                jobId: pausedRun?.id,
              });
              sendClient({ type: "user_transcript", text: transcript });

              if (wakeMatch.trailingText) {
                lastUserTranscript = wakeMatch.trailingText;
                pendingAudioResponseRequested = true;
                void requestDefaultResponseWithMemory(
                  wakeMatch.trailingText,
                  "queue"
                );
              } else {
                realtimeTrace.finishWakePhrase(String(event.item_id || ""));
              }
              break;
            }

            lastUserTranscript = transcript;
            void requestAudioResponseWithMemory(transcript);
            sendClient({
              type: "user_transcript",
              text: transcript,
            });
          }
          break;

        case "response.done": {
          console.log("[RealtimeChat] Azure response done");
          responseInFlight = false;
          responseCreatePending = false;
          if (suppressCancelledResponseDone) {
            suppressCancelledResponseDone = false;
            fullTranscript = "";
            flushQueuedResponse();
            break;
          }
          // Skip function-call-only responses — the next response.create that
          // follows the tool result will produce the actual user-facing answer.
          const hasFunctionCall = event.response?.output?.some(
            (o: any) => o.type === "function_call"
          );
          if (hasFunctionCall) {
            flushQueuedResponse();
            break;
          }
          const hasOutput = event.response?.output?.some(
            (o: any) => o.type === "message"
          );
          const followupExpected = pendingFollowUp;
          pendingFollowUp = false;
          if (hasOutput && fullTranscript.trim() && lastUserTranscript.trim()) {
            recordMemoryInteraction({
              agentType: "realtime",
              userText: lastUserTranscript,
              assistantText: fullTranscript,
            });
            lastUserTranscript = "";
          }
          sendClient({
            type: "response_done",
            fullText: fullTranscript,
            followupExpected,
            hasOutput: hasOutput || fullTranscript.length > 0,
          });
          fullTranscript = "";
          flushQueuedResponse();
          break;
        }

        case "response.function_call_arguments.done": {
          const callId = event.call_id;
          const fnName = event.name;
          console.log(`[RealtimeChat] Function call: ${fnName}`, event.arguments);

          const toolTrace = realtimeTrace.startTool(event);
          let toolOutput: string;
          try {
            toolOutput = await executeRealtimeTool(
              fnName,
              parseArgs(event.arguments)
            );
            realtimeTrace.finishTool(toolTrace, toolOutput);
          } catch (error) {
            realtimeTrace.finishTool(toolTrace, JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
            }), error);
            throw error;
          }

          ws.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: toolOutput,
            },
          }));

          requestDefaultResponse(undefined, "queue", toolTrace?.turnId ?? null);
          break;
        }

        case "error": {
          const errMessage = event.error?.message || "Azure Realtime API error";
          console.error("[RealtimeChat] Azure error:", event.error);
          // Swallow benign errors from our defensive cleanup on reconnect —
          // it's expected that there may be no in-flight response or audio
          // buffer to clear when the session has been idle.
          if (
            /no active response/i.test(errMessage) ||
            /buffer is empty/i.test(errMessage) ||
            /buffer.*empty/i.test(errMessage)
          ) {
            responseCreatePending = false;
            break;
          }
          if (/active response in progress/i.test(errMessage)) {
            responseCreatePending = false;
            responseInFlight = true;
            break;
          }
          responseCreatePending = false;
          sendClient({
            type: "error",
            message: errMessage,
          });
          break;
        }
      }
    } catch (err) {
      realtimeTrace.close(`Realtime event handling failed: ${err instanceof Error ? err.message : String(err)}`);
      console.error("[RealtimeChat] Error parsing Azure message:", err);
    }
  });

  ws.on("error", (err) => {
    realtimeTrace.close(`Azure connection error: ${err.message}`);
    console.error("[RealtimeChat] Azure WS error:", err.message);
    azureReady = false;
    responseCreatePending = false;
    queuedResponseInstructions = null;
    queuedResponseTraceId = null;
    queuedAssistantSpeechInstructions = [];
    readyCallbacks = [];
    resetAudioLog();
    sendClient({
      type: "error",
      message: `Azure connection error: ${err.message}`,
    });
  });

  ws.on("close", () => {
    realtimeTrace.close("Azure Realtime connection closed");
    console.log("[RealtimeChat] Azure WS closed");
    azureWs = null;
    azureReady = false;
    responseCreatePending = false;
    queuedResponseInstructions = null;
    queuedResponseTraceId = null;
    queuedAssistantSpeechInstructions = [];
    readyCallbacks = [];
    resetAudioLog();
    conversationItems.length = 0;
  });
}

// ============================================================================
// Client WebSocket Handler
// ============================================================================

export function setupRealtimeChatProxy(server: http.Server): void {
  if (!AI_MODEL_REALTIME) {
    console.log("[RealtimeChat] AI_MODEL_REALTIME not set, skipping WebSocket setup");
    return;
  }

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/api/realtime-chat")) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    }
  });

  wss.on("connection", (clientWs) => {
    console.log("[RealtimeChat] Client connected");
    if (activeClientWs && activeClientWs !== clientWs) realtimeTrace.close("Realtime client replaced");
    activeClientWs = clientWs;

    // Discard any stale state left over from a prior client on the same Azure
    // session: a response may still be streaming, and the input buffer may
    // hold unflushed audio. Without this, the new turn inherits the old turn's
    // tail and "responds" before the user even speaks.
    if (azureWs && azureReady) {
      sendAzure({ type: "response.cancel" });
      sendAzure({ type: "input_audio_buffer.clear" });
      fullTranscript = "";
      responseInFlight = false;
      responseCreatePending = false;
      queuedResponseInstructions = null;
      queuedResponseTraceId = null;
      queuedAssistantSpeechInstructions = [];
    }

    // Connect to Azure (reuses existing session if alive)
    connectAzure(() => {
      clientWs.send(JSON.stringify({ type: "session_ready" }));
    });

    clientWs.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "user_text" && msg.text && azureWs && azureReady) {
          realtimeTrace.beginText(String(msg.text));
          fullTranscript = "";
          lastUserTranscript = String(msg.text);

          // Send text as a conversation item
          azureWs.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: msg.text }],
            },
          }));

          // Trigger response generation
          await requestDefaultResponseWithMemory(String(msg.text));
        } else if (msg.type === "input_audio" && msg.audio && azureWs && azureReady) {
          recordAudioAppend(msg.audio);
          azureWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.audio,
          }));
        } else if (msg.type === "commit_audio" && azureWs && azureReady) {
          console.log("[RealtimeChat] Client requested audio commit");
          azureWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        } else if (msg.type === "force_followup") {
          // Client opened the mic for a bare wake-word — keep it open after
          // the next response no matter what the model decides.
          pendingFollowUp = true;
        } else if (msg.type === "pause_active_agent") {
          const pausedRun = pauseActiveRun();
          if (pausedRun) {
            console.log(
              `[RealtimeChat] Client wake phrase paused active ${pausedRun.domain} job ${pausedRun.id}`
            );
            clientWs.send(JSON.stringify({
              type: "agent_run_paused",
              domain: pausedRun.domain,
              jobId: pausedRun.id,
            }));
          }
        }
      } catch (err) {
        realtimeTrace.close(`Realtime client message failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error("[RealtimeChat] Error parsing client message:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("[RealtimeChat] Client disconnected");
      if (activeClientWs === clientWs) {
        realtimeTrace.close("Realtime client disconnected before turn completion");
        activeClientWs = null;
      }
      // Keep Azure session alive for next client connection
    });

    clientWs.on("error", (err) => {
      console.error("[RealtimeChat] Client WS error:", err.message);
      if (activeClientWs === clientWs) {
        realtimeTrace.close(`Realtime client error: ${err.message}`);
        activeClientWs = null;
      }
    });
  });

  console.log("[RealtimeChat] WebSocket proxy ready on /api/realtime-chat");
}
