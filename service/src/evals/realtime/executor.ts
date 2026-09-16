import { REALTIME_TOOLS } from "../../realtimeAgent";
import type { Usage } from "../types";
import { validateRealtimeToolArguments } from "./environment";

type Event = Record<string, unknown>;
type Listener = (...args: unknown[]) => void;
export interface RealtimeSocket {
  readyState: number;
  on(event: string, listener: Listener): unknown;
  off(event: string, listener: Listener): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
}
export type RealtimeTransport = (url: string, options: {
  headers: Record<string, string>;
  handshakeTimeout: number;
  followRedirects: false;
  maxPayload: number;
}) => RealtimeSocket;
export interface RealtimeResponseEvidence {
  responseId: string;
  status: string;
  model?: string;
  text: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: Usage;
}
export interface RealtimeExecutionOptions {
  transport: RealtimeTransport;
  url: string;
  apiKey: string;
  instructions: string;
  turns: readonly { text: string }[];
  signal: AbortSignal;
  beginTurn(index: number): string;
  executeTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> | string;
  observeText?(text: string): void;
  recordResponse?(response: RealtimeResponseEvidence): void;
  finishTurn(index: number, text: string): void;
  timeoutMs?: number;
  maxResponses?: number;
  maxToolCalls?: number;
}
export const REALTIME_EVAL_LIMITS = {
  turns: 6, responses: 24, toolCalls: 32, timeoutMs: 90_000,
  outputTokensPerResponse: 1_024, outputCharacters: 65_536, eventBytes: 1_048_576,
} as const;

function object(value: unknown, name: string): Event {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Realtime ${name}`);
  return value as Event;
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
export function realtimeUsage(value: unknown): Usage {
  const usage = value && typeof value === "object" ? value as Event : {};
  return { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens), totalTokens: count(usage.total_tokens) };
}
export function realtimeDeploymentUrl(resourceName: string, apiVersion: string, deployment: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(resourceName)) throw new Error("Configure a valid AZURE_OPENAI_RESOURCE_NAME for Realtime evals");
  if (!apiVersion.trim() || !deployment.trim()) throw new Error("Realtime API version and deployment are required");
  const url = new URL(`wss://${resourceName}.openai.azure.com/openai/realtime`);
  url.searchParams.set("api-version", apiVersion);
  url.searchParams.set("deployment", deployment);
  return url.toString();
}

function bounded(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Realtime limits must be positive integers");
  return Math.min(value, maximum);
}

async function shutdown(socket: RealtimeSocket): Promise<void> {
  if (socket.readyState === 3) return;
  await new Promise<void>(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ignoreError: Listener = () => {};
    const done = () => {
      clearTimeout(timer);
      socket.off("close", done);
      socket.off("error", ignoreError);
      resolve();
    };
    socket.on("error", ignoreError);
    socket.on("close", done);
    timer = setTimeout(() => { try { socket.terminate(); } finally { done(); } }, 250);
    try {
      if (socket.readyState === 0) socket.terminate();
      else socket.close(1000, "Offline evaluation ended");
      if (socket.readyState === 3) done();
    } catch {
      try { socket.terminate(); } finally { done(); }
    }
  });
}

/** A new native Azure Realtime session per attempt; tools never resolve to production handlers. */
export async function executeRealtimeSession(options: RealtimeExecutionOptions): Promise<{
  finalResponse: string;
  turnResponses: string[];
  usage: Usage;
  responses: number;
}> {
  options.signal.throwIfAborted();
  if (!options.apiKey) throw new Error("AZURE_OPENAI_API_KEY is required for Realtime evals");
  const url = new URL(options.url);
  if (url.protocol !== "wss:" || !url.hostname.endsWith(".openai.azure.com") || url.pathname !== "/openai/realtime" ||
    url.username || url.password || (url.port && url.port !== "443")) throw new Error("Expected the configured Azure Realtime wss deployment endpoint");
  if (!options.turns.length || options.turns.length > REALTIME_EVAL_LIMITS.turns || options.turns.some(turn => !turn.text.trim())) {
    throw new Error(`Realtime fixtures require 1-${REALTIME_EVAL_LIMITS.turns} nonempty user turns`);
  }
  const timeoutMs = bounded(options.timeoutMs, REALTIME_EVAL_LIMITS.timeoutMs);
  const maxResponses = bounded(options.maxResponses, REALTIME_EVAL_LIMITS.responses);
  const maxToolCalls = bounded(options.maxToolCalls, REALTIME_EVAL_LIMITS.toolCalls);
  const socket = options.transport(options.url, {
    headers: { "api-key": options.apiKey }, handshakeTimeout: Math.min(timeoutMs, 15_000),
    followRedirects: false, maxPayload: REALTIME_EVAL_LIMITS.eventBytes,
  });
  let settled = false, configured = false, sessionUpdateSent = false, responsePending = false;
  let turnIndex = 0, responses = 0, toolCalls = 0, streamed = "", turnInstructions = "", characters = 0;
  let currentTexts: string[] = [];
  const turnResponses: string[] = [];
  const seenResponses = new Set<string>(), seenCalls = new Set<string>();
  const usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const listeners: Array<[string, Listener]> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: () => void = () => {};
  try {
    return await new Promise((resolve, reject) => {
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      abort = () => fail(options.signal.reason ?? new Error("Realtime evaluation aborted"));
      options.signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => fail(new Error(`Realtime evaluation timed out after ${timeoutMs}ms`)), timeoutMs);
      const send = (event: Event) => {
        options.signal.throwIfAborted();
        if (settled) return;
        if (socket.readyState !== 1) throw new Error("Realtime socket is not open");
        socket.send(JSON.stringify(event));
      };
      const requestResponse = () => {
        if (responses >= maxResponses) throw new Error(`Realtime response limit (${maxResponses}) reached without completing all turns`);
        responsePending = true;
        streamed = "";
        send({ type: "response.create", response: {
          modalities: ["text"], max_output_tokens: REALTIME_EVAL_LIMITS.outputTokensPerResponse,
          ...(turnInstructions ? { instructions: turnInstructions } : {}),
        } });
        // Per-response runtime context follows production: only the first response
        // receives the injected memory/active-run context; tool continuations use the session prompt.
        turnInstructions = "";
      };
      const startTurn = () => {
        turnInstructions = options.beginTurn(turnIndex);
        currentTexts = [];
        send({ type: "conversation.item.create", item: {
          type: "message", role: "user", content: [{ type: "input_text", text: options.turns[turnIndex].text }],
        } });
        requestResponse();
      };
      const observeText = (value: string) => {
        if (!value) return;
        characters += value.length;
        if (characters > REALTIME_EVAL_LIMITS.outputCharacters) throw new Error("Realtime output character limit exceeded");
        options.observeText?.(value);
      };
      const onMessage = async (raw: unknown) => {
        if (settled) return;
        options.signal.throwIfAborted();
        const encoded = typeof raw === "string" ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : String(raw);
        if (Buffer.byteLength(encoded) > REALTIME_EVAL_LIMITS.eventBytes) throw new Error("Realtime event size limit exceeded");
        const event = object(JSON.parse(encoded), "event");
        if (event.type === "error") {
          const error = object(event.error ?? {}, "API error");
          throw new Error(`Realtime API error: ${text(error.message) || text(error.code) || "unknown error"}`);
        }
        if (event.type === "session.updated") {
          if (configured) return;
          if (!sessionUpdateSent) throw new Error("Realtime session configured before it was requested");
          configured = true;
          startTurn();
          return;
        }
        if (event.type === "response.audio.delta" || event.type === "response.output_audio.delta") {
          throw new Error("Realtime eval unexpectedly received audio in text-only mode");
        }
        if (event.type === "response.text.delta") {
          if (!responsePending) throw new Error("Unexpected Realtime text without a requested response");
          const delta = text(event.delta);
          streamed += delta;
          observeText(delta);
          return;
        }
        if (event.type !== "response.done") return;
        const response = object(event.response, "response");
        const id = text(response.id);
        if (!id) throw new Error("Realtime response is missing its ID");
        if (seenResponses.has(id)) return;
        if (!configured || !responsePending) throw new Error("Unexpected Realtime response completion");
        seenResponses.add(id);
        responses++;
        responsePending = false;
        const responseUsage = realtimeUsage(response.usage);
        for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
          usage[key] = usage[key] === undefined || responseUsage[key] === undefined ? undefined : usage[key]! + responseUsage[key]!;
        }
        const output = response.output;
        if (!Array.isArray(output)) throw new Error("Realtime response output is missing");
        const calls: RealtimeResponseEvidence["toolCalls"] = [];
        const messageText: string[] = [];
        for (const rawItem of output) {
          const item = object(rawItem, "output item");
          if (item.type === "function_call") {
            const call = { id: text(item.call_id), name: text(item.name), arguments: text(item.arguments) };
            if (!call.id || !call.name || !call.arguments) throw new Error("Realtime function call is incomplete");
            calls.push(call);
          } else if (item.type === "message") {
            if (!Array.isArray(item.content)) throw new Error("Realtime message content is missing");
            for (const rawContent of item.content) {
              const content = object(rawContent, "message content");
              if (content.type === "text" || content.type === "output_text") messageText.push(text(content.text));
              else throw new Error(`Unexpected Realtime text-only content: ${String(content.type)}`);
            }
          } else throw new Error(`Unsupported Realtime output item: ${String(item.type)}`);
        }
        const finalText = messageText.join("\n") || streamed;
        if (!streamed) observeText(finalText);
        if (finalText) currentTexts.push(finalText);
        options.recordResponse?.({ responseId: id, status: text(response.status), model: text(response.model) || undefined, text: finalText, toolCalls: calls, usage: responseUsage });
        if (response.status !== "completed") throw new Error(`Realtime response ended with ${text(response.status) || "unknown status"}: ${JSON.stringify(response.status_details ?? {})}`);
        if (calls.length) {
          if (responses >= maxResponses) throw new Error(`Realtime response limit (${maxResponses}) reached before tool follow-up`);
          if (toolCalls + calls.length > maxToolCalls) throw new Error(`Realtime tool-call limit (${maxToolCalls}) exceeded`);
          // Validate the entire batch before any isolated effect; replayed call IDs
          // must not repeat a confirmation, memory write or job acceptance.
          const batchIds = new Set<string>();
          const parsed = calls.map(call => {
            if (seenCalls.has(call.id) || batchIds.has(call.id)) throw new Error(`Duplicate Realtime tool call: ${call.id}`);
            batchIds.add(call.id);
            const args = object(JSON.parse(call.arguments), "tool arguments");
            validateRealtimeToolArguments(call.name, args);
            return { ...call, args };
          });
          for (const call of parsed) {
            if (settled) return;
            options.signal.throwIfAborted();
            seenCalls.add(call.id);
            toolCalls++;
            const result = await options.executeTool(call.name, call.args, options.signal);
            if (settled) return;
            send({ type: "conversation.item.create", item: { type: "function_call_output", call_id: call.id, output: result } });
          }
          if (!settled) requestResponse();
          return;
        }
        const answer = currentTexts.join("\n").trim();
        if (!answer) throw new Error("Realtime completed without a text answer");
        turnResponses.push(answer);
        options.finishTurn(turnIndex, answer);
        turnIndex++;
        if (turnIndex < options.turns.length) startTurn();
        else {
          settled = true;
          resolve({ finalResponse: turnResponses[turnResponses.length - 1], turnResponses, usage, responses });
        }
      };
      const listen = (event: string, listener: Listener) => { listeners.push([event, listener]); socket.on(event, listener); };
      // Serialize async tool-result handling; socket error/abort/timeout still fail immediately.
      let chain = Promise.resolve();
      listen("message", raw => { chain = chain.then(() => onMessage(raw)).catch(fail); });
      listen("open", () => {
        if (settled || sessionUpdateSent) return;
        try {
          sessionUpdateSent = true;
          send({ type: "session.update", session: {
            modalities: ["text"], turn_detection: null, input_audio_transcription: null,
            instructions: options.instructions, tools: REALTIME_TOOLS,
            max_response_output_tokens: REALTIME_EVAL_LIMITS.outputTokensPerResponse,
          } });
        } catch (error) { fail(error); }
      });
      listen("error", error => fail(new Error(`Realtime connection failed: ${error instanceof Error ? error.message : String(error)}`)));
      listen("unexpected-response", (_request, response) => fail(new Error(`Realtime WebSocket upgrade rejected: HTTP ${(response as { statusCode?: number })?.statusCode ?? "unknown"}`)));
      listen("close", code => fail(new Error(`Realtime connection closed before completion (code ${String(code)})`)));
      if (options.signal.aborted) abort();
    });
  } finally {
    settled = true;
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
    for (const [event, listener] of listeners) socket.off(event, listener);
    await shutdown(socket);
  }
}
