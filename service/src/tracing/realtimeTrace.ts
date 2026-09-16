import { randomUUID } from "node:crypto";
import { trace } from "@opentelemetry/api";
import {
  addEvent, addLLMStep, completeTrace, createTrace, getSessionTraceContext, trackToolResult,
} from "./agentTraceStore";
import type { TraceLLMStep, TraceToolCall, TraceToolResult } from "./agentTraceStore";

type RecordValue = Record<string, unknown>;
export interface RealtimeTraceSink {
  create(sessionId: string, agentType: string, request: string): void;
  request(sessionId: string, request: string): void;
  event(sessionId: string, type: string, message: string, data?: RecordValue): void;
  step(sessionId: string, step: TraceLLMStep): void;
  tool(sessionId: string, result: TraceToolResult): void;
  complete(sessionId: string, success: boolean, text: string, status: "completed" | "error"): void;
}
const productionSink: RealtimeTraceSink = {
  create: createTrace,
  request(sessionId, request) {
    // Audio transcription may arrive after response.done. Update the existing
    // lifecycle span instead of creating a second trace with a fabricated start.
    const context = getSessionTraceContext(sessionId);
    if (context) trace.getSpan(context)?.setAttribute("agent.user_prompt", request);
  },
  event: addEvent, step: addLLMStep, tool: trackToolResult, complete: completeTrace,
};
interface ResponseState {
  id: string;
  turn: Turn;
  startedAt?: number;
  instructions?: string;
  audioText: string;
  text: string;
  calls: Map<string, TraceToolCall>;
  done: boolean;
}
interface Turn {
  id: string;
  itemId?: string;
  request: string;
  awaitingTranscript: boolean;
  responses: Set<string>;
  pendingTools: Set<string>;
  spoken: string[];
  steps: number;
  terminal?: { status: "completed" | "error"; reason: string };
  deadline: ReturnType<typeof setTimeout>;
  grace?: ReturnType<typeof setTimeout>;
}
export interface RealtimeToolTrace {
  turnId: string;
  responseId: string;
  callId: string;
  name: string;
  args: RecordValue;
  startedAt: number;
}
export interface RealtimeTraceOptions {
  model: string;
  instructions: string;
  sink?: RealtimeTraceSink;
  now?: () => number;
  makeId?: () => string;
  turnTimeoutMs?: number;
  terminalGraceMs?: number;
}
const record = (value: unknown): RecordValue => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
function args(raw: string): RecordValue {
  try { return record(JSON.parse(raw)); } catch { return {}; }
}
function responseText(output: unknown): string {
  if (!Array.isArray(output)) return "";
  return output.flatMap(item => {
    const message = record(item);
    if (message.type !== "message" || !Array.isArray(message.content)) return [];
    const content = message.content.map(record);
    const transcript = content.map(part => string(part.transcript)).filter(Boolean).join("");
    return [transcript || content.map(part => string(part.text)).filter(Boolean).join("")];
  }).filter(Boolean).join("\n");
}

/** Observes only text, tool metadata and usage. Never records audio or entire API/session events. */
export class RealtimeTraceRecorder {
  private readonly sink: RealtimeTraceSink;
  private readonly now: () => number;
  private readonly turns = new Map<string, Turn>();
  private readonly items = new Map<string, string>();
  private readonly responses = new Map<string, ResponseState>();
  private readonly retiredResponses = new Set<string>();
  private readonly requested: Array<{ turnId: string | null; instructions?: string }> = [];
  private readonly pendingText: string[] = [];
  private current: string | null = null;
  private lastResponse?: string;

  constructor(private readonly options: RealtimeTraceOptions) {
    this.sink = options.sink ?? productionSink;
    this.now = options.now ?? Date.now;
  }

  get currentTurnId(): string | null {
    const turn = this.current && this.turns.get(this.current);
    return turn && !turn.terminal ? turn.id : null;
  }

  private safe(callback: () => void): void {
    try { callback(); } catch {
      // Observability must never alter voice delivery or production tool execution.
      console.error("[Realtime trace] Evidence capture failed; retained turn history may be incomplete.");
    }
  }

  private event(turn: Turn, type: string, message: string, data?: RecordValue): void {
    this.safe(() => this.sink.event(turn.id, type, message, { observedAt: new Date(this.now()).toISOString(), ...data }));
  }

  private begin(request: string, awaitingTranscript: boolean, itemId?: string): Turn {
    const id = `realtime-${(this.options.makeId ?? randomUUID)()}`;
    const turn: Turn = {
      id, itemId, request, awaitingTranscript, responses: new Set(), pendingTools: new Set(), spoken: [], steps: 0,
      deadline: setTimeout(() => this.forceFinish(id, "Realtime turn timed out without a complete retained lifecycle"), this.options.turnTimeoutMs ?? 120_000),
    };
    turn.deadline.unref?.();
    this.turns.set(id, turn);
    if (itemId) this.items.set(itemId, id);
    this.current = id;
    this.safe(() => this.sink.create(id, "realtime", request));
    this.event(turn, "realtime.turn.started", "Retaining a new Realtime user turn", {
      inputKind: awaitingTranscript ? "audio_transcript_pending" : "text",
      itemId, instructions: this.options.instructions,
      evidenceScope: "Retained text/tool/usage evidence only. No raw audio. Async job acceptance is not device completion. Prior unretained conversation and audio delivery are not reconstructed.",
    });
    return turn;
  }

  beginText(text: string): string {
    const turn = this.begin(text, false);
    this.pendingText.push(turn.id);
    return turn.id;
  }

  responseRequested(turnId: string | null, instructions?: string): void {
    this.requested.push({ turnId, instructions });
  }

  private retireResponse(id: string): void {
    this.retiredResponses.add(id);
    if (this.retiredResponses.size > 256) this.retiredResponses.delete(this.retiredResponses.values().next().value!);
  }

  private bindResponse(id: string, created = true): ResponseState | undefined {
    if (!id || this.retiredResponses.has(id)) return undefined;
    const existing = this.responses.get(id);
    if (existing) return existing;
    const request = this.requested.shift();
    const turnId = request ? request.turnId : this.currentTurnId;
    const turn = turnId && this.turns.get(turnId);
    if (!turn || turn.terminal) { this.retireResponse(id); return undefined; }
    const response: ResponseState = {
      id, turn, startedAt: created ? this.now() : undefined, instructions: request?.instructions,
      audioText: "", text: "", calls: new Map(), done: false,
    };
    this.responses.set(id, response);
    turn.responses.add(id);
    this.lastResponse = id;
    if (!created) this.event(turn, "realtime.evidence.gap", "response.created was not retained; response start time is unknown", { responseId: id });
    return response;
  }

  private responseFor(event: RecordValue): ResponseState | undefined {
    const id = string(event.response_id) || this.lastResponse;
    return id ? this.responses.get(id) : undefined;
  }

  observe(event: RecordValue): void {
    this.safe(() => this.observeUnsafe(event));
  }

  private observeUnsafe(event: RecordValue): void {
    const type = string(event.type);
    if (type === "input_audio_buffer.committed") {
      const itemId = string(event.item_id);
      if (itemId && !this.items.has(itemId)) this.begin("[Audio transcription pending]", true, itemId);
    } else if (type === "conversation.item.created") {
      const item = record(event.item);
      if (item.role !== "user" || !item.id || !Array.isArray(item.content)) return;
      const text = item.content.map(record).map(part => string(part.text)).join("");
      if (!text) return;
      const index = this.pendingText.findIndex(id => this.turns.get(id)?.request === text);
      if (index < 0) return;
      const [id] = this.pendingText.splice(index, 1);
      const turn = this.turns.get(id)!;
      turn.itemId = string(item.id);
      this.items.set(turn.itemId, id);
    } else if (type === "conversation.item.input_audio_transcription.completed" || type === "conversation.item.input_audio_transcription.failed") {
      const id = this.items.get(string(event.item_id));
      const turn = id && this.turns.get(id);
      if (!turn) return;
      const text = string(event.transcript);
      turn.request = text || "[Audio transcription unavailable]";
      turn.awaitingTranscript = false;
      this.safe(() => this.sink.request(turn.id, turn.request));
      this.event(turn, text ? "realtime.user.transcript" : "realtime.evidence.gap",
        text ? "User transcription received" : "The user audio transcript was not retained",
        text ? { itemId: event.item_id, transcript: text } : { itemId: event.item_id });
      this.maybeFinish(turn);
    } else if (type === "response.created") {
      this.bindResponse(string(record(event.response).id));
    } else if (type === "response.audio_transcript.delta" || type === "response.text.delta") {
      const response = this.responseFor(event);
      if (!response || response.done) return;
      if (type === "response.audio_transcript.delta") response.audioText += string(event.delta);
      else response.text += string(event.delta);
    } else if (type === "response.done") {
      const data = record(event.response);
      const response = this.responses.get(string(data.id)) ?? this.bindResponse(string(data.id), false);
      if (!response || response.done) return;
      this.recordResponse(response, data);
      const hasCalls = Array.isArray(data.output) && data.output.some(item => record(item).type === "function_call");
      if (data.status !== "completed") {
        response.turn.terminal = { status: "error", reason: `Realtime response ${string(data.status) || "status unknown"}` };
        this.event(response.turn, "realtime.response.error", response.turn.terminal.reason, { responseId: response.id, statusDetails: data.status_details });
      } else if (!hasCalls && !response.turn.terminal) {
        response.turn.terminal = (responseText(data.output) || response.audioText || response.text).trim()
          ? { status: "completed", reason: "Final user-facing response completed" }
          : { status: "error", reason: "Realtime response ended without retained spoken text" };
      }
      this.maybeFinish(response.turn);
    } else if (type === "error") {
      const message = string(record(event.error).message) || "Azure Realtime API error";
      if (/no active response|buffer.*empty|active response in progress/i.test(message)) {
        this.requested.length = 0;
        return;
      }
      this.close(`Azure Realtime API error: ${message}`);
    }
  }

  private recordResponse(response: ResponseState, data: RecordValue, terminalReason?: string): void {
    response.done = true;
    const turn = response.turn;
    const text = responseText(data.output) || response.audioText || response.text;
    if (text) turn.spoken.push(text);
    if (Array.isArray(data.output)) for (const item of data.output.map(record)) {
      if (item.type !== "function_call") continue;
      const raw = string(item.arguments);
      const toolCallId = string(item.call_id);
      if (toolCallId) response.calls.set(toolCallId, {
        toolCallId, toolName: string(item.name), args: args(raw), actionSummary: string(item.name),
      });
      this.event(turn, "realtime.tool.arguments", "Exact Realtime function-call arguments", {
        responseId: response.id, toolCallId, toolName: item.name, rawArguments: raw,
      });
    }
    const usage = record(data.usage);
    const inputDetails = record(usage.input_token_details);
    const duration = response.startedAt === undefined ? undefined : Math.max(0, this.now() - response.startedAt);
    this.safe(() => this.sink.step(turn.id, {
      stepNumber: ++turn.steps, timestamp: new Date(response.startedAt ?? this.now()).toISOString(),
      finishReason: terminalReason || (response.calls.size ? "tool_calls" : string(data.status) || "unknown"),
      requestModel: this.options.model, responseModel: string(data.model) || undefined,
      responseId: response.id, provider: "azure",
      inputTokens: number(usage.input_tokens), outputTokens: number(usage.output_tokens), totalTokens: number(usage.total_tokens),
      cacheReadTokens: number(inputDetails.cached_tokens), responseTimeMs: duration, stepTimeMs: duration,
      text, toolCalls: [...response.calls.values()],
      systemMessages: [this.options.instructions, ...(response.instructions ? [response.instructions] : [])],
      messages: [{ role: "user", content: turn.request }],
    }));
  }

  startTool(event: RecordValue): RealtimeToolTrace | undefined {
    const response = this.responseFor(event);
    if (!response || !this.turns.has(response.turn.id)) return undefined;
    const callId = string(event.call_id), name = string(event.name), raw = string(event.arguments);
    if (!callId || !name) return undefined;
    const token: RealtimeToolTrace = { turnId: response.turn.id, responseId: response.id, callId, name, args: args(raw), startedAt: this.now() };
    response.turn.pendingTools.add(callId);
    response.calls.set(callId, { toolName: name, toolCallId: callId, args: token.args, actionSummary: name });
    this.event(response.turn, "realtime.tool.started", "Realtime tool execution started", { responseId: response.id, toolCallId: callId, toolName: name, rawArguments: raw });
    return token;
  }

  finishTool(token: RealtimeToolTrace | undefined, output: string, error?: unknown): void {
    if (!token) return;
    const turn = this.turns.get(token.turnId);
    if (!turn || !turn.pendingTools.delete(token.callId)) return;
    let result: RecordValue = {};
    try { result = record(JSON.parse(output)); } catch { /* Text search and confirmation outputs are not JSON. */ }
    const failed = error !== undefined || result.success === false || result.ok === false || /^(?:confirmation_required|Missing |Search (?:error|failed)|Unknown tool:)/i.test(output);
    this.safe(() => this.sink.tool(turn.id, {
      toolCallId: token.callId, toolName: token.name, args: token.args, observation: output,
      durationMs: Math.max(0, this.now() - token.startedAt), toolSuccess: !failed,
    }));
    if (error !== undefined) {
      turn.terminal = { status: "error", reason: error instanceof Error ? error.message : String(error) };
      this.event(turn, "realtime.tool.error", turn.terminal.reason, { toolCallId: token.callId });
    }
    this.maybeFinish(turn);
  }

  interrupt(reason: string): void {
    const response = this.lastResponse && this.responses.get(this.lastResponse);
    const turn = response && !response.done ? response.turn : undefined;
    if (!turn) return;
    turn.terminal = { status: "error", reason };
    this.event(turn, "realtime.turn.interrupted", reason);
    this.maybeFinish(turn);
  }

  finishWakePhrase(itemId: string): void {
    const id = this.items.get(itemId);
    const turn = id && this.turns.get(id);
    if (!turn) return;
    turn.terminal = { status: "completed", reason: "Bare wake phrase paused the interaction; no spoken answer requested" };
    this.maybeFinish(turn);
  }

  close(reason: string): void {
    for (const turn of this.turns.values()) {
      turn.terminal ??= { status: "error", reason };
      this.event(turn, "realtime.connection.ended", reason);
      for (const id of turn.responses) {
        const response = this.responses.get(id);
        if (response && !response.done) this.recordResponse(response, {}, "connection_closed");
      }
      this.missingTranscript(turn);
      this.maybeFinish(turn);
    }
    this.current = null;
    this.requested.length = 0;
  }

  private missingTranscript(turn: Turn): void {
    if (!turn.awaitingTranscript) return;
    turn.awaitingTranscript = false;
    turn.request = "[Audio transcription unavailable]";
    this.safe(() => this.sink.request(turn.id, turn.request));
    this.event(turn, "realtime.evidence.gap", "Turn ended before user transcription was available");
  }

  private forceFinish(id: string, reason: string): void {
    const turn = this.turns.get(id);
    if (!turn) return;
    turn.terminal ??= { status: "error", reason };
    this.event(turn, "realtime.evidence.gap", reason, { pendingToolCallIds: [...turn.pendingTools] });
    this.missingTranscript(turn);
    for (const responseId of turn.responses) {
      const response = this.responses.get(responseId);
      if (response && !response.done) this.recordResponse(response, {}, "retention_timeout");
    }
    turn.pendingTools.clear();
    this.maybeFinish(turn);
  }

  private maybeFinish(turn: Turn): void {
    if (!turn.terminal || !this.turns.has(turn.id)) return;
    const unfinished = [...turn.responses].some(id => !this.responses.get(id)?.done);
    if (turn.awaitingTranscript || turn.pendingTools.size || unfinished) {
      if (!turn.grace) {
        turn.grace = setTimeout(() => this.forceFinish(turn.id, "Timed out waiting for terminal Realtime evidence"), this.options.terminalGraceMs ?? 10_000);
        turn.grace.unref?.();
      }
      return;
    }
    clearTimeout(turn.deadline);
    clearTimeout(turn.grace);
    this.event(turn, "realtime.turn.ended", turn.terminal.reason, { spokenText: turn.spoken.join("\n"), lifecycleOnly: true });
    this.safe(() => this.sink.complete(turn.id, turn.terminal!.status === "completed", turn.spoken.join("\n"), turn.terminal!.status));
    this.turns.delete(turn.id);
    if (turn.itemId) this.items.delete(turn.itemId);
    for (const id of turn.responses) { this.responses.delete(id); this.retireResponse(id); }
    const pendingIndex = this.pendingText.indexOf(turn.id);
    if (pendingIndex >= 0) this.pendingText.splice(pendingIndex, 1);
    if (this.current === turn.id) this.current = null;
  }
}
