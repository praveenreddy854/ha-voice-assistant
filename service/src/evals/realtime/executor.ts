import type { AgentLoop, AgentLoopConfig } from "../../agents/core/agentLoop";
import { buildLiveVoiceSystemPrompt, LIVE_VOICE_MAX_ITERATIONS, liveVoiceToolDefinitions } from "../../liveVoiceContract";
import { REALTIME_TOOLS } from "../../realtimeAgent";
import { runOfflineAgentLoop } from "../loop";
import type { TrialTelemetry } from "../telemetry";
import { RealtimeEnvironment, validateRealtimeToolArguments } from "./environment";

export const REALTIME_EVAL_LIMITS = {
  turns: 6, iterationsPerTurn: LIVE_VOICE_MAX_ITERATIONS, toolCalls: 32,
  timeoutMs: 90_000, outputCharacters: 65_536,
} as const;

/** Same AI SDK reasoning contract as production, with fixture-only effects and history. */
export async function executeRealtimeSession(options: {
  createLoop(config: AgentLoopConfig): AgentLoop;
  model: string;
  environment: RealtimeEnvironment;
  signal: AbortSignal;
  telemetry: TrialTelemetry;
  timeoutMs?: number;
}): Promise<{ finalResponse: string; turnResponses: string[] }> {
  const { environment, telemetry } = options;
  const turns = environment.state.turns;
  options.signal.throwIfAborted();
  if (!turns.length || turns.length > REALTIME_EVAL_LIMITS.turns || turns.some(turn => !turn.text.trim())) {
    throw new Error(`Realtime fixtures require 1-${REALTIME_EVAL_LIMITS.turns} nonempty user turns`);
  }
  const timeoutMs = options.timeoutMs ?? REALTIME_EVAL_LIMITS.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > REALTIME_EVAL_LIMITS.timeoutMs) throw new Error("Invalid Realtime eval timeout");
  const timeout = new AbortController();
  const deadline = timeout.signal;
  const timer = setTimeout(() => timeout.abort(new DOMException("Realtime evaluation timed out", "TimeoutError")), timeoutMs);
  const signal = AbortSignal.any([options.signal, deadline]);
  const history: Array<{ role: string; content: string }> = [];
  const turnResponses: string[] = [];
  const seenCalls = new Set<string>();
  let toolCalls = 0, characters = 0;
  try {
    for (const [index, turn] of turns.entries()) {
      signal.throwIfAborted();
      const context = environment.beginTurn(index);
      const systemPrompt = buildLiveVoiceSystemPrompt(`${environment.instructions}\n${context}`);
      const result = await runOfflineAgentLoop({
        createLoop: options.createLoop, model: options.model,
        systemPrompt, tools: liveVoiceToolDefinitions(REALTIME_TOOLS),
        maxIterations: LIVE_VOICE_MAX_ITERATIONS,
        initialMessage: turn.text, history, signal, telemetry, executeToolsInSdk: true,
        systemMessages: environment.turnMemoryContext ? [environment.turnMemoryContext] : [],
        record: item => environment.record(item),
        observeModelOutput(text) {
          characters += text.length;
          if (characters > REALTIME_EVAL_LIMITS.outputCharacters) throw new Error("Realtime output character limit exceeded");
        },
        validateToolBatch(calls) {
          // Validate every call before accepting any effect from this response.
          if (toolCalls + calls.length > REALTIME_EVAL_LIMITS.toolCalls) {
            telemetry.stop("tool_limit");
            throw new Error("Realtime tool-call limit exceeded");
          }
          const batchIds = new Set<string>();
          for (const call of calls) {
            if (seenCalls.has(call.id) || batchIds.has(call.id)) throw new Error(`Duplicate Realtime tool call: ${call.id}`);
            batchIds.add(call.id);
            const args: unknown = JSON.parse(call.function.arguments);
            validateRealtimeToolArguments(call.function.name, args as Record<string, unknown>);
          }
          batchIds.forEach(id => seenCalls.add(id));
          toolCalls += calls.length;
        },
        async executeTool(name, args) {
          signal.throwIfAborted();
          return { result: await environment.execute(name, args) };
        },
      });
      signal.throwIfAborted();
      if (result.stoppedAtIterationLimit) throw new Error("Realtime reasoning iteration limit reached");
      if (!result.finalResponse.trim()) throw new Error("Realtime reasoning completed without a text answer");
      // Only the completed reply is delivered to speech in production.
      environment.observeAssistantText(result.finalResponse);
      environment.finishTurn(result.finalResponse);
      turnResponses.push(result.finalResponse);
      history.push({ role: "user", content: turn.text }, { role: "assistant", content: result.finalResponse });
    }
    return { finalResponse: turnResponses.join("\n"), turnResponses };
  } catch (error) {
    if (deadline.aborted) telemetry.stop("timeout");
    else if (options.signal.aborted) telemetry.stop("aborted");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
