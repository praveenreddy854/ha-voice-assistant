import type { AgentAdapter, Assessment, Scenario } from "../types";
import { digest } from "../store";
import { captureTrial } from "../telemetry";
import { buildRealtimeInstructions, buildRealtimeTurnInstructions, REALTIME_TOOLS } from "../../realtimeAgent";
import { RealtimeEnvironment } from "./environment";
import { executeRealtimeSession, realtimeDeploymentUrl, REALTIME_EVAL_LIMITS } from "./executor";
import type { RealtimeTransport } from "./executor";
import { realtimeScenarios, REALTIME_EVAL_SCOPE } from "./scenarios";
import type { RealtimeState } from "./scenarios";

export interface RealtimeAdapterConfiguration {
  resourceName: string;
  apiVersion: string;
  apiKey: string;
  model: string;
}

/** Explicit injection seam for tests; the default factory is constructed only inside the bounded worker. */
export function createRealtimeAdapterWithTransport(config: RealtimeAdapterConfiguration, transport: RealtimeTransport): AgentAdapter {
  if (!config.model.trim()) throw new Error("Configure AI_MODEL_REALTIME before running Realtime evals");
  if (!config.apiKey) throw new Error("Configure AZURE_OPENAI_API_KEY before running Realtime evals");
  const url = realtimeDeploymentUrl(config.resourceName, config.apiVersion, config.model);
  const promptVersion = digest({
    instructions: realtimeScenarios.map(scenario => buildRealtimeInstructions({
      devices: scenario.initial.devices.map(device => `${device.name} (${device.entityId})`),
      address: scenario.initial.address,
    })),
    runtimeInstructions: buildRealtimeTurnInstructions({
      activeRun: { id: "fixture-run", domain: "tv", status: "paused" },
      memoryContext: "[per-turn isolated fixture memory]", interruptedAssistantText: "[interrupted speech]",
    }),
    tools: REALTIME_TOOLS, limits: REALTIME_EVAL_LIMITS, scope: REALTIME_EVAL_SCOPE,
  });
  return {
    id: "realtime", version: "realtime-simulator-1", scenarios: realtimeScenarios,
    model: config.model, promptVersion,
    async execute(input: Scenario, signal: AbortSignal): Promise<Assessment> {
      const scenario = input as Scenario<RealtimeState>;
      const environment = new RealtimeEnvironment(scenario);
      return captureTrial({
        agentId: "realtime", request: scenario.request, model: config.model, promptVersion,
        evidence: environment.evidence, context: scenario.context, expectations: scenario.expectations,
      }, signal, async telemetry => {
        const result = await executeRealtimeSession({
          transport, url, apiKey: config.apiKey, instructions: environment.instructions,
          turns: environment.state.turns, signal, telemetry,
          beginTurn: index => environment.beginTurn(index),
          executeTool: (name, args, abort) => { abort.throwIfAborted(); return environment.execute(name, args); },
          observeText: text => environment.observeAssistantText(text),
          recordResponse: response => environment.record({ kind: "context", text: JSON.stringify({ nativeRealtimeResponse: response }) }),
          finishTurn: (_index, text) => environment.finishTurn(text),
        });
        environment.record({ kind: "assertion", text: JSON.stringify({
          taskSatisfied: environment.taskSatisfied(), violations: environment.violations,
          acceptedEffects: environment.effects, finalFixtureState: environment.state,
          turnResponses: result.turnResponses, nativeRealtimeResponses: result.responses, scope: REALTIME_EVAL_SCOPE,
        }) });
        return { finalResponse: result.finalResponse, taskAssertion: environment.taskSatisfied() };
      });
    },
  };
}

export async function createRealtimeAdapter(modelOverride?: string): Promise<AgentAdapter> {
  // Import ws after installNetworkBoundary: wss upgrades use its bounded HTTPS transport.
  const [config, { default: WebSocket }] = await Promise.all([import("../../config"), import("ws")]);
  return createRealtimeAdapterWithTransport({
    resourceName: config.AZURE_OPENAI_RESOURCE_NAME ?? "",
    apiVersion: config.AZURE_OPENAI_REALTIME_API_VERSION,
    apiKey: config.AZURE_OPENAI_API_KEY ?? "",
    model: modelOverride || config.AI_MODEL_REALTIME || "",
  }, (url, options) => new WebSocket(url, options));
}
