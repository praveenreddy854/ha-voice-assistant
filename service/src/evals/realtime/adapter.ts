import type { AgentLoop, AgentLoopConfig } from "../../agents/core/agentLoop";
import { buildLiveVoiceSystemPrompt, liveVoiceToolDefinitions } from "../../liveVoiceContract";
import type { AgentAdapter, Assessment, Scenario } from "../types";
import { digest } from "../store";
import { captureTrial } from "../telemetry";
import { buildRealtimeTurnInstructions, REALTIME_TOOLS } from "../../realtimeAgent";
import { RealtimeEnvironment } from "./environment";
import { executeRealtimeSession, REALTIME_EVAL_LIMITS } from "./executor";
import { realtimeScenarios, REALTIME_EVAL_SCOPE } from "./scenarios";
import type { RealtimeState } from "./scenarios";

/** Injection is a model-loop seam only; every tool remains bound to the fixture. */
export function createRealtimeAdapterWithLoop(model: string, createLoop: (config: AgentLoopConfig) => AgentLoop): AgentAdapter {
  if (!model.trim()) throw new Error("Configure AI_MODEL_ADVANCED before running Realtime reasoning evals");
  const promptVersion = digest({
    prompts: realtimeScenarios.map(scenario => buildLiveVoiceSystemPrompt(new RealtimeEnvironment(scenario).instructions)),
    runtimeInstructions: buildRealtimeTurnInstructions({
      activeRun: { id: "fixture-run", domain: "tv", status: "paused" },
      memoryContext: "[per-turn isolated fixture memory]", interruptedAssistantText: "[interrupted speech]",
    }),
    tools: liveVoiceToolDefinitions(REALTIME_TOOLS), limits: REALTIME_EVAL_LIMITS, scope: REALTIME_EVAL_SCOPE,
  });
  return {
    id: "realtime", version: "realtime-reasoning-simulator-2", scenarios: realtimeScenarios,
    model, promptVersion,
    async execute(input: Scenario, signal: AbortSignal): Promise<Assessment> {
      const scenario = input as Scenario<RealtimeState>;
      const environment = new RealtimeEnvironment(scenario);
      return captureTrial({
        agentId: "realtime", request: scenario.request, model, promptVersion,
        evidence: environment.evidence, context: scenario.context, expectations: scenario.expectations,
      }, signal, async telemetry => {
        const result = await executeRealtimeSession({ createLoop, model, environment, signal, telemetry });
        environment.record({ kind: "assertion", text: JSON.stringify({
          taskSatisfied: environment.taskSatisfied(), violations: environment.violations,
          acceptedEffects: environment.effects, finalFixtureState: environment.state,
          turnResponses: result.turnResponses, scope: REALTIME_EVAL_SCOPE,
        }) });
        return { finalResponse: result.finalResponse, taskAssertion: environment.taskSatisfied() };
      });
    },
  };
}

export async function createRealtimeAdapter(modelOverride?: string): Promise<AgentAdapter> {
  // Load only the model loop after the worker's network boundary. Never import
  // the production voice wrapper: it retrieves and records live memory.
  const [{ AI_MODEL_ADVANCED }, { createAgentLoop }] = await Promise.all([
    import("../../config"), import("../../agents/core/agentLoop"),
  ]);
  return createRealtimeAdapterWithLoop(modelOverride || AI_MODEL_ADVANCED || "", createAgentLoop);
}
