import http from "http";
import { AsyncLocalStorage } from "node:async_hooks";
import { LiveDelegationController, type VoiceHistoryItem } from "./liveDelegation";
import { runLiveVoiceAgent, type LiveVoiceTool } from "./liveVoiceAgent";
import WebSocket, { WebSocketServer } from "ws";
import {
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_RESOURCE_NAME,
  AI_MODEL_LIVE,
  AI_MODEL_ADVANCED,
  GPT_LIVE_VOICE,
  USER_ADDRESS,
} from "./config";

const HOME_ASSISTANT_DEVICES = (process.env.HOME_ASSISTANT_DEVICES || "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);
import { startTvAgentJob } from "./tvJobManager";
import {
  ActiveRunDomain,
  cancelActiveRun,
  getActiveRun,
  pauseActiveRun,
  resumeActiveRun,
  startActiveRun,
} from "./activeRunManager";
import {
  deleteMemory,
  formatMemoryContext,
  MemoryScopes,
  MemoryType,
  retrieveMemories,
  saveMemory,
  updateMemory,
  validateMemoryWrite,
} from "./memory";
import { executeHACommand } from "./ha";
import { runAgent } from "./agents/core";
import { buildRealtimeInstructions, buildRealtimeTurnInstructions, needsActionConfirmation, REALTIME_TOOLS } from "./realtimeAgent";

type JsonRecord = Record<string, unknown>;

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
// Azure GPT Live Session
// ============================================================================

let azureWs: WebSocket | null = null;
let azureReady = false;
let activeClientWs: WebSocket | null = null;
let fullTranscript = "";
let pendingFollowUp = false;
const voiceHistory: VoiceHistoryItem[] = [];
interface VoiceDelivery {
  client(payload: JsonRecord): void;
  speak(content: string): void;
}
const voiceDelivery = new AsyncLocalStorage<VoiceDelivery>();

function isClientActive(): boolean {
  return activeClientWs?.readyState === WebSocket.OPEN;
}

function sendClient(payload: JsonRecord): void {
  const delivery = voiceDelivery.getStore();
  if (delivery) { delivery.client(payload); return; }
  if (!isClientActive()) return;
  activeClientWs?.send(JSON.stringify(payload));
}

function sendAzure(payload: JsonRecord): void {
  if (!azureWs || azureWs.readyState !== WebSocket.OPEN) return;
  azureWs.send(JSON.stringify(payload));
}

function appendLiveContext(type: string, content: string, delegationId: string | null = null, socket = azureWs): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const sendChunk = (chunk: string) => socket.send(JSON.stringify({ type, delegation_id: delegationId, content: chunk }));
  // A 400-byte chunk stays below the 500-token limit even with byte fallback.
  let chunk = "";
  for (const character of content) {
    if (Buffer.byteLength(chunk + character, "utf8") > 400) {
      sendChunk(chunk);
      chunk = "";
    }
    chunk += character;
  }
  if (chunk) sendChunk(chunk);
}

function requestAssistantSpeech(instructions: string): void {
  const delivery = voiceDelivery.getStore();
  if (delivery) { delivery.speak(instructions); return; }
  if (!azureReady || !isClientActive()) return;
  appendLiveContext("session.commentary.append", instructions);
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

function startRealtimeTvJob(prompt: string) {
  const delivery = voiceDelivery.getStore();
  const notify = (payload: JsonRecord) => delivery ? delivery.client(payload) : sendClient(payload);
  const speak = (content: string) => delivery ? delivery.speak(content) : requestAssistantSpeech(content);
  const started = startTvAgentJob(prompt, {
    onComplete: (message) => {
      notify({ type: "async_job_finished", domain: "tv", status: "completed" });
      speak(completionSpeechInstructions({ prompt, message }));
    },
    onError: (message) => {
      notify({ type: "async_job_finished", domain: "tv", status: "error" });
      speak(failureSpeechInstructions("TV command", message));
    },
  });
  notify({ type: "async_job_started", domain: "tv", jobId: started.jobId });
  return started;
}

function startRealtimeScheduledTaskJob(prompt: string) {
  const delivery = voiceDelivery.getStore();
  const notify = (payload: JsonRecord) => delivery ? delivery.client(payload) : sendClient(payload);
  const speak = (content: string) => delivery ? delivery.speak(content) : requestAssistantSpeech(content);
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
      notify({
        type: "async_job_finished",
        domain: "scheduled_task",
        status: "completed",
        jobId: run.id,
      });
      speak(
        completionSpeechInstructions({ prompt: run.prompt, message })
      );
    },
    onError: (message, run) => {
      notify({
        type: "async_job_finished",
        domain: "scheduled_task",
        status: "error",
        jobId: run.id,
      });
      speak(
        failureSpeechInstructions("scheduled task command", message)
      );
    },
  });
  notify({
    type: "async_job_started",
    domain: "scheduled_task",
    jobId: started.jobId,
  });
  return started;
}

function startRealtimeHomeAssistantJob(command: string) {
  const delivery = voiceDelivery.getStore();
  const notify = (payload: JsonRecord) => delivery ? delivery.client(payload) : sendClient(payload);
  const speak = (content: string) => delivery ? delivery.speak(content) : requestAssistantSpeech(content);
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
      notify({
        type: "async_job_finished",
        domain: "home_assistant",
        status: "completed",
        jobId: run.id,
      });
      speak(
        completionSpeechInstructions({
          prompt: run.prompt,
          message: result.message,
          isAnswer: result.isAnswer,
        })
      );
    },
    onError: (message, run) => {
      notify({
        type: "async_job_finished",
        domain: "home_assistant",
        status: "error",
        jobId: run.id,
      });
      speak(
        failureSpeechInstructions("Home Assistant command", message)
      );
    },
  });
  notify({
    type: "async_job_started",
    domain: "home_assistant",
    jobId: started.jobId,
  });
  return started;
}

function startReplacementRun(
  domain: ActiveRunDomain,
  prompt: string,
  confirmed: boolean,
  replacedDomain: ActiveRunDomain
) {
  if (
    domain === "home_assistant" &&
    needsActionConfirmation(prompt) &&
    !confirmed
  ) {
    return null;
  }
  if (replacedDomain !== domain) {
    cancelActiveRun(replacedDomain);
  }
  if (domain === "tv") return startRealtimeTvJob(prompt);
  if (domain === "scheduled_task") {
    return startRealtimeScheduledTaskJob(prompt);
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
      args.confirmed === true,
      activeRun.domain
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

const REALTIME_INSTRUCTIONS = buildRealtimeInstructions({ devices: HOME_ASSISTANT_DEVICES, address: USER_ADDRESS });

const LIVE_INSTRUCTIONS = `You are a concise English-speaking smart-home voice assistant.
Listen and speak naturally, adapting when the user interrupts. A bare wake phrase means wait silently for the next request.
Delegate device actions, state queries, scheduling, TV control, memory, web searches, and complex reasoning to the backend.
Never claim an action succeeded until its backend result confirms success. Ask for any required clarification or confirmation.
After an accepted command say "On it." once, and after routine success say "Done." Questions and failures need a clear answer.
Interrupting speech does not cancel a running action. Delegate explicit requests to pause, resume, change, or cancel work.
Delegate answers to a pending clarification or confirmation to the application, including short answers such as yes or no.
Only the application can accept commands, confirm actions, or report their outcome. Do not acknowledge acceptance before its result arrives.
User and assistant transcript fragments can overlap; do not interpret each fragment as a completed turn.`;

function connectAzure(onReady: () => void): void {
  const ws = new WebSocket(
    `wss://${AZURE_OPENAI_RESOURCE_NAME}.openai.azure.com/openai/v1/live/sessions`,
    { headers: { "api-key": AZURE_OPENAI_API_KEY! } }
  );
  azureWs = ws;
  azureReady = false;
  let speechTimer: NodeJS.Timeout | undefined;
  let closeTimer: NodeJS.Timeout | undefined;
  let inputMuted = true;
  let closing = false;
  let userDisplayText = "";
  let userTranscriptTimer: NodeJS.Timeout | undefined;
  let latestUsage: unknown;
  let speechActive = false;
  const announcedDelegations = new Set<string>();

  const current = () => azureWs === ws;
  const send = (payload: JsonRecord) => {
    if (current() && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };
  const closeIfIdle = () => {
    if (closeTimer) clearTimeout(closeTimer);
    if (!inputMuted) return;
    closeTimer = setTimeout(() => {
      if (!current()) return;
      if (speechActive || delegations.busy || getActiveRun()?.status === "running") { closeIfIdle(); return; }
      closing = true;
      delegations.dispose();
      send({ type: "session.close" });
    }, 5000);
  };
  const scopes = new Map<string | null, { pending: boolean; speech: string[] }>();
  const append = (content: string, id: string | null, quiet = false) => {
    if (!current() || closing || !isClientActive()) return;
    appendLiveContext(quiet ? "session.thinking.append" : "session.commentary.append", content, id, ws);
  };
  const delegations = new LiveDelegationController({
    history: voiceHistory,
    onIdle: closeIfIdle,
    reply: (content, id, quiet) => {
      append(content, id, quiet);
      if (current()) sendClient({ type: "assistant_work_finished", delegationId: id });
      const scope = scopes.get(id);
      if (scope) {
        scope.pending = false;
        for (const content of scope.speech.splice(0)) append(content, id);
      }
    },
    run: (request) => {
      const scope = { pending: true, speech: [] as string[] };
      scopes.set(request.delegationId, scope);
      const delivery: VoiceDelivery = {
        client: (payload) => {
          if (current() && !closing && activeClientWs?.readyState === WebSocket.OPEN) activeClientWs.send(JSON.stringify(payload));
        },
        speak: (content) => {
          if (scope.pending) scope.speech.push(content);
          else append(content, request.delegationId);
        },
      };
      const activeRun = getActiveRun();
      const runtime = buildRealtimeTurnInstructions({ activeRun });
      return voiceDelivery.run(delivery, () => runLiveVoiceAgent(request, `${REALTIME_INSTRUCTIONS}\n${runtime}`, REALTIME_TOOLS as LiveVoiceTool[], executeRealtimeTool));
    },
  });
  ws.on("user_text", (text: string) => {
    if (closing) return;
    sendClient({ type: "assistant_work_started", delegationId: null });
    appendLiveContext("session.thinking.append", `The user submitted this request to the application: ${text}. The application is handling it; wait for its result.`, null, ws);
    delegations.submitText(text);
  });
  const speechActivity = () => {
    speechActive = true;
    if (closeTimer) clearTimeout(closeTimer);
    if (speechTimer) clearTimeout(speechTimer);
    // GPT Live has no speech-done event. This is a UI grouping heuristic only.
    speechTimer = setTimeout(() => {
      if (!current()) return;
      speechActive = false;
      speechTimer = undefined;
      sendClient({ type: "response_done", fullText: fullTranscript, followupExpected: pendingFollowUp });
      fullTranscript = "";
      closeIfIdle();
    }, 1200);
  };
  ws.on("open", () => send({
    type: "session.start",
    session: {
      model: AI_MODEL_LIVE,
      instructions: LIVE_INSTRUCTIONS,
      audio: { output: { voice: GPT_LIVE_VOICE } },
      delegation: { type: "client" },
    },
  }));
  ws.on("message", async (data) => {
    if (!current()) return;
    try {
      const event = JSON.parse(data.toString());
      switch (event.type) {
        case "session.started":
          azureReady = true;
          onReady();
          break;
        case "session.output_audio.delta":
          sendClient({ type: "audio_delta", audio: event.delta, startMs: event.start_ms, endMs: event.end_ms });
          speechActivity();
          break;
        case "session.output_transcript.delta":
          fullTranscript += event.delta;
          sendClient({ type: "transcript_delta", text: event.delta });
          speechActivity();
          break;
        case "session.input_transcript.delta":
          delegations.appendTranscript(String(event.delta || ""));
          userDisplayText += event.delta;
          if (userTranscriptTimer) clearTimeout(userTranscriptTimer);
          // Display grouping only: fragments never trigger household actions.
          userTranscriptTimer = setTimeout(() => {
            if (current()) sendClient({ type: "user_transcript", text: userDisplayText });
            userDisplayText = "";
          }, 800);
          break;
        case "session.delegation.created":
          if (event.delegation?.target === "client" && typeof event.delegation.id === "string") {
            const id = event.delegation.id;
            if (!announcedDelegations.has(id)) {
              announcedDelegations.add(id);
              sendClient({ type: "assistant_work_started", delegationId: id });
            }
            delegations.delegate(id);
          }
          break;
        case "session.usage.updated":
          latestUsage = event.usage;
          break;
        case "session.closed":
          latestUsage = event.usage;
          console.log("[GPT Live] Session closed", event.reason, latestUsage);
          ws.close();
          break;
        case "error":
          sendClient({ type: "error", message: event.error?.message || "GPT Live API error" });
          break;
      }
    } catch (error) {
      sendClient({ type: "error", message: error instanceof Error ? error.message : "GPT Live event failed" });
    }
  });
  ws.on("error", (error) => {
    if (current()) sendClient({ type: "error", message: `GPT Live connection error: ${error.message}` });
  });
  ws.on("close", () => {
    delegations.dispose();
    if (speechTimer) clearTimeout(speechTimer);
    if (userTranscriptTimer) clearTimeout(userTranscriptTimer);
    if (closeTimer) clearTimeout(closeTimer);
    if (!current()) return;
    azureReady = false;
    azureWs = null;
    sendClient({ type: "session_ended" });
  });
  // The app's command microphone has a bounded listening window.
  ws.on("client_disconnected", () => { closing = true; delegations.dispose(); });
  ws.on("input_end", () => {
    inputMuted = true;
    send({ type: "session.input_audio.mute" });
    closeIfIdle();
  });
  ws.on("input_start", () => {
    inputMuted = false;
    if (closeTimer) clearTimeout(closeTimer);
    send({ type: "session.input_audio.unmute" });
  });
}

export function setupRealtimeChatProxy(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (req.url?.split("?")[0] === "/api/realtime-chat") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    }
  });
  wss.on("connection", (clientWs) => {
    if (activeClientWs && activeClientWs !== clientWs) activeClientWs.close();
    if (azureWs) { azureWs.emit("client_disconnected"); azureWs.close(); }
    activeClientWs = clientWs;
    fullTranscript = "";
    pendingFollowUp = false;
    if (!AI_MODEL_ADVANCED || !AZURE_OPENAI_RESOURCE_NAME || !AZURE_OPENAI_API_KEY) {
      sendClient({ type: "error", message: "Configure AI_MODEL_ADVANCED, AZURE_OPENAI_RESOURCE_NAME, and AZURE_OPENAI_API_KEY for GPT Live." });
      clientWs.close();
      return;
    }
    connectAzure(() => sendClient({ type: "session_ready" }));
    clientWs.on("message", async (data) => {
      if (activeClientWs !== clientWs) return;
      try {
        const msg = JSON.parse(data.toString());
        if (!azureReady || !azureWs) return;
        if (msg.type === "input_audio" && msg.audio) {
          sendAzure({ type: "session.input_audio.append", audio: msg.audio });
        } else if (msg.type === "input_end") {
          azureWs.emit("input_end");
        } else if (msg.type === "input_start" || msg.type === "force_followup") {
          pendingFollowUp = true;
          azureWs.emit("input_start");
        } else if (msg.type === "user_text" && msg.text) {
          azureWs.emit("user_text", String(msg.text));
        } else if (msg.type === "pause_active_agent") {
          const run = pauseActiveRun();
          if (run) {
            sendClient({ type: "agent_run_paused", domain: run.domain, jobId: run.id });
            appendLiveContext("session.thinking.append", `The user paused ${run.domain} job ${run.id}. Wait for their follow-up decision.`);
          }
        }
      } catch (error) {
        sendClient({ type: "error", message: error instanceof Error ? error.message : "Invalid client message" });
      }
    });
    const disconnect = () => {
      if (activeClientWs !== clientWs) return;
      azureWs?.emit("client_disconnected");
      activeClientWs = null;
      sendAzure({ type: "session.close" });
      const closing = azureWs;
      const timer = setTimeout(() => closing?.terminate(), 2000);
      timer.unref();
    };
    clientWs.on("close", disconnect);
    clientWs.on("error", disconnect);
  });
}
