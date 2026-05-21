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
let pendingFollowUp = false;
let readyCallbacks: Array<() => void> = [];

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
  sendAzure({
    type: "response.create",
    response: {
      modalities: ["text", "audio"],
      instructions,
    },
  });
}

function requestDefaultResponse(): void {
  sendAzure({
    type: "response.create",
    response: {
      modalities: ["text", "audio"],
    },
  });
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

function shortCompletion(message: string): string {
  const trimmed = message.trim();
  if (!trimmed) return "Done";
  const words = trimmed.split(/\s+/).slice(0, 4);
  return words.join(" ").replace(/[.!?]+$/, "");
}

function tvCompletion(prompt: string, resultMessage: string): string {
  const normalizedPrompt = prompt.toLowerCase();
  const normalizedResult = resultMessage.toLowerCase();
  const target = normalizedPrompt.includes("apple tv") ? "Apple TV" : "TV";

  if (/\b(pause|stop)\b/.test(normalizedPrompt)) {
    return `${target} paused`;
  }
  if (/\b(play|resume|continue)\b/.test(normalizedPrompt)) {
    return `${target} playing`;
  }
  if (/\b(unmute)\b/.test(normalizedPrompt)) {
    return `${target} unmuted`;
  }
  if (/\b(mute)\b/.test(normalizedPrompt)) {
    return `${target} muted`;
  }
  if (/\b(wake|turn on|power on)\b/.test(normalizedPrompt)) {
    return `${target} awake`;
  }
  if (/\b(sleep|turn off|power off)\b/.test(normalizedPrompt)) {
    return `${target} off`;
  }

  if (/\b(i attempted|attempted|wake|wakeup|standby)\b/.test(normalizedResult)) {
    return "TV action done";
  }

  return shortCompletion(resultMessage || "TV done");
}

function needsActionConfirmation(command: string): boolean {
  const normalized = command.toLowerCase();
  const protectedOpening =
    /\b(open|unlock)\b/.test(normalized) &&
    /\b(front door|back door|garage door|garage)\b/.test(normalized);
  const bulkDestructive =
    /\b(cancel|delete|remove|clear|turn off|shut off|disable)\b/.test(normalized) &&
    /\b(all|every|everything|entire|whole)\b/.test(normalized);
  return protectedOpening || bulkDestructive;
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

    case "execute_home_assistant_command": {
      const command = typeof args.command === "string" ? args.command : "";
      const confirmed = args.confirmed === true;
      if (!command.trim()) {
        return "Missing command.";
      }
      if (needsActionConfirmation(command) && !confirmed) {
        return "confirmation_required: Ask the user to confirm this protected or bulk destructive action before executing it.";
      }
      const result = await executeHACommand(command);
      return JSON.stringify({
        success: result.success,
        message: result.message,
        data: result.data,
      });
    }

    case "run_scheduled_task_agent": {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      if (!prompt.trim()) {
        return "Missing scheduled task prompt.";
      }
      const result = await runAgent({
        agentType: "scheduled_task",
        userPrompt: prompt,
        maxSteps: 8,
      });
      return JSON.stringify({
        success: result.success,
        status: result.status,
        message: result.message,
      });
    }

    case "start_tv_agent": {
      const prompt = typeof args.prompt === "string" ? args.prompt : "";
      if (!prompt.trim()) {
        return "Missing TV prompt.";
      }
      const started = startTvAgentJob(prompt, {
        onComplete: (message) => {
          sendClient({ type: "async_job_finished", domain: "tv", status: "completed" });
          requestAssistantSpeech(
            `Say only this short completion to the user: "${tvCompletion(prompt, message)}".`
          );
        },
        onError: (message) => {
          sendClient({ type: "async_job_finished", domain: "tv", status: "error" });
          const detail = (message || "TV job failed").replace(/"/g, "'");
          requestAssistantSpeech(
            `The TV job failed. Tell the user in three or four words what went wrong. Do not apologize or add filler. Failure detail: "${detail}".`
          );
        },
      });
      sendClient({ type: "async_job_started", domain: "tv", jobId: started.jobId });
      return JSON.stringify({
        success: true,
        jobId: started.jobId,
        replacedJobId: started.replacedJobId,
        message: "TV job started. Say exactly: working on it.",
      });
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

const REALTIME_TOOLS = [
  {
    type: "function",
    name: "await_user_followup",
    description:
      "Call this BEFORE producing your spoken response whenever that response will be a question or a request for confirmation that the user must answer without saying the wake word again. Examples: asking for a Protected opening or Bulk destructive confirmation, asking a Clarification request, or asking a Specialist agent follow-up. Do NOT call this for routine completions, acknowledgements, or any response that does not require an answer from the user.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "web_search",
    description:
      "Search the web for current information. Use when the user asks about recent events, news, facts, weather, or anything that needs up-to-date data.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "execute_home_assistant_command",
    description:
      "Execute an immediate Home Assistant command or read-only state query. Routine commands do not need confirmation. Set confirmed=true only after the user confirms protected opening or bulk destructive actions.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Plain English smart-home command or state question, scoped exactly to the user's request.",
        },
        confirmed: {
          type: "boolean",
          description:
            "True only after the user confirms a protected opening or bulk destructive action.",
        },
      },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "run_scheduled_task_agent",
    description:
      "Run the ScheduledTaskAgent for creating, listing, querying, updating, or cancelling ScheduledTasks. This is blocking inside the active voice turn.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The user's full scheduled-task request.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: "start_tv_agent",
    description:
      "Start a server-owned async TVAgent job for TV or streaming-app navigation. The assistant should acknowledge with 'working on it' and then stay silent unless user input or completion is needed.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The user's full TV or streaming-app request.",
        },
      },
      required: ["prompt"],
    },
  },
];

const REALTIME_INSTRUCTIONS = `You are the Realtime Voice Agent for a Home Assistant voice assistant.

After the wake word, the user's live audio is streamed to you. Use Realtime turn detection. Keep speech concise.

Language:
- Always speak English. Even if the user's request contains words in another language (song names, artist names, place names, etc.), keep your reply in English.
- Switch languages only if the user explicitly asks you to (e.g. "reply in Telugu", "speak Spanish"). Stay in the requested language until they ask you to switch back.

Capabilities:
- Answer general chat directly.
- Use execute_home_assistant_command for immediate smart-home commands and read-only device state questions.
- Use run_scheduled_task_agent for ScheduledTask creation, list/query, update, cancellation, and clarification.
- Use start_tv_agent for TV or streaming-app tasks that require navigation, screenshots, remote actions, app launching, search, typing, or playback.
- Use web_search when live/current information is needed.

Do not use a fixed priority order. Select the capability by request meaning. If the request is ambiguous, ask a short clarification question before acting.${
  HOME_ASSISTANT_DEVICES.length > 0
    ? `

Known smart-home devices ${HOME_ASSISTANT_DEVICES.join(", ")}.`
    : ""
}

Mic / follow-up policy:
- The mic closes after every response by default and the user must say the wake word again for the next command.
- If your next spoken response will be a question or a request for confirmation that the user must answer without saying the wake word, call await_user_followup BEFORE producing that response. This keeps the mic open for 30 seconds so the user can answer.
- Do NOT call await_user_followup for routine completions, acknowledgements ("working on it", "Done"), or any response that does not require a user answer.

Confirmation policy:
- Routine smart-home actions execute without confirmation.
- Protected opening actions require confirmation: opening or unlocking the front door, back door, or garage door.
- Bulk destructive actions require confirmation.
- If a tool returns confirmation_required, call await_user_followup, then ask the user to confirm.

Specialist behavior:
- Do not narrate tool calls or internal Specialist agent iterations.
- TVAgent runs are async. When start_tv_agent succeeds, say exactly "working on it" and then stay silent.
- ScheduledTaskAgent runs are blocking; speak its final message.
- Completion announcements should usually be three or four words.

Memory:
- Use the recent conversation only as short conversational memory. Current device state and active specialist state are authoritative.${USER_ADDRESS ? ` The user's address is: ${USER_ADDRESS}. Use this for location-based queries like weather.` : ""}`;

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
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 900,
          create_response: true,
          interrupt_response: true,
        },
        tools: REALTIME_TOOLS,
      },
    }));

  });

  ws.on("message", async (data) => {
    try {
      const event = JSON.parse(data.toString());

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

        case "input_audio_buffer.speech_started":
          console.log("[RealtimeChat] Azure speech started");
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
            sendClient({
              type: "user_transcript",
              text: event.transcript,
            });
          }
          break;

        case "response.done": {
          console.log("[RealtimeChat] Azure response done");
          // Skip function-call-only responses — the next response.create that
          // follows the tool result will produce the actual user-facing answer.
          const hasFunctionCall = event.response?.output?.some(
            (o: any) => o.type === "function_call"
          );
          if (hasFunctionCall) {
            break;
          }
          const hasOutput = event.response?.output?.some(
            (o: any) => o.type === "message"
          );
          const followupExpected = pendingFollowUp;
          pendingFollowUp = false;
          sendClient({
            type: "response_done",
            fullText: fullTranscript,
            followupExpected,
            hasOutput: hasOutput || fullTranscript.length > 0,
          });
          fullTranscript = "";
          break;
        }

        case "response.function_call_arguments.done": {
          const callId = event.call_id;
          const fnName = event.name;
          console.log(`[RealtimeChat] Function call: ${fnName}`, event.arguments);

          const toolOutput = await executeRealtimeTool(
            fnName,
            parseArgs(event.arguments)
          );

          ws.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: toolOutput,
            },
          }));

          requestDefaultResponse();
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
            break;
          }
          sendClient({
            type: "error",
            message: errMessage,
          });
          break;
        }
      }
    } catch (err) {
      console.error("[RealtimeChat] Error parsing Azure message:", err);
    }
  });

  ws.on("error", (err) => {
    console.error("[RealtimeChat] Azure WS error:", err.message);
    azureReady = false;
    readyCallbacks = [];
    resetAudioLog();
    sendClient({
      type: "error",
      message: `Azure connection error: ${err.message}`,
    });
  });

  ws.on("close", () => {
    console.log("[RealtimeChat] Azure WS closed");
    azureWs = null;
    azureReady = false;
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
    activeClientWs = clientWs;

    // Discard any stale state left over from a prior client on the same Azure
    // session: a response may still be streaming, and the input buffer may
    // hold unflushed audio. Without this, the new turn inherits the old turn's
    // tail and "responds" before the user even speaks.
    if (azureWs && azureReady) {
      sendAzure({ type: "response.cancel" });
      sendAzure({ type: "input_audio_buffer.clear" });
      fullTranscript = "";
    }

    // Connect to Azure (reuses existing session if alive)
    connectAzure(() => {
      clientWs.send(JSON.stringify({ type: "session_ready" }));
    });

    clientWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === "user_text" && msg.text && azureWs && azureReady) {
          fullTranscript = "";

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
          requestDefaultResponse();
        } else if (msg.type === "input_audio" && msg.audio && azureWs && azureReady) {
          recordAudioAppend(msg.audio);
          azureWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.audio,
          }));
        } else if (msg.type === "commit_audio" && azureWs && azureReady) {
          console.log("[RealtimeChat] Client requested audio commit");
          azureWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          requestDefaultResponse();
        } else if (msg.type === "force_followup") {
          // Client opened the mic for a bare wake-word — keep it open after
          // the next response no matter what the model decides.
          pendingFollowUp = true;
        }
      } catch (err) {
        console.error("[RealtimeChat] Error parsing client message:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("[RealtimeChat] Client disconnected");
      if (activeClientWs === clientWs) {
        activeClientWs = null;
      }
      // Keep Azure session alive for next client connection
    });

    clientWs.on("error", (err) => {
      console.error("[RealtimeChat] Client WS error:", err.message);
      if (activeClientWs === clientWs) {
        activeClientWs = null;
      }
    });
  });

  console.log("[RealtimeChat] WebSocket proxy ready on /api/realtime-chat");
}
