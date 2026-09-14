import type { AgentTrace } from "../tracing/agentTraceStore";
import type { TvFlowMemoryDocument } from "../agents/tv/flowMemory";
import type { Assessment, Evidence } from "./types";
import { digest } from "./store";

export function assessmentFromRecord(trace?: AgentTrace, flow?: TvFlowMemoryDocument): Assessment {
  if (!trace && !flow) throw new Error("Completed run not found in telemetry or Cosmos");
  if (trace && !["completed", "error"].includes(trace.status)) throw new Error("Recorded evals require a completed assistant run");
  if (trace && !trace.completedAt) throw new Error("Trace has no terminal session evidence");
  if (flow && !["completed", "error", "failed"].includes(flow.status)) throw new Error("Cosmos flow is not terminal");
  if ((trace?.agentType || flow?.agent) !== "tv") throw new Error("Phase 1 evaluates TVAgent only");
  const evidence: Evidence[] = [];
  const add = (item: Omit<Evidence, "id">) => evidence.push({ id: `e${evidence.length + 1}`, ...item });
  if (trace) {
    // LLM snapshots supply initial state and context that Cosmos steps often omit.
    for (const step of trace.llmSteps) add({ kind: "context", timestamp: step.timestamp, text: JSON.stringify({ messages: step.messages, text: step.text, toolCalls: step.toolCalls }), source: `telemetry:${trace.sessionId}:llm:${step.stepNumber}` });
    for (const [i, result] of trace.toolResults.entries()) add({ kind: "tool", text: JSON.stringify({ observation: result.observation, toolSuccess: result.toolSuccess }), toolName: result.toolName, args: result.args,
      durationMs: result.durationMs, source: `telemetry:${trace.sessionId}:tool:${result.toolCallId || i}` });
    for (const image of trace.screenshots) add({ kind: "image", text: `Screenshot ${image.outcome}`, timestamp: image.timestamp, image: image.dataUrl, source: `telemetry:${trace.sessionId}:screenshot:${image.stepIndex}` });
  }
  if (flow) for (const step of flow.steps) add({ kind: "tool", toolName: step.toolName, args: step.toolArguments,
    text: JSON.stringify({ observation: step.observation, toolSuccess: step.toolSuccess, appUiContext: step.appUiContext }), source: `cosmos:${flow.id}:step:${step.index}` });
  const finalResponse = trace?.finalMessage || flow?.finalMessage || "";
  add({ kind: "final", text: finalResponse || "Final response was not retained" });
  add({ kind: "context", text: "Historical record may be incomplete. Legacy success flags and executionScore are proxies, not verified outcomes. Cosmos steps may omit automatically executed tools. Images, observations, or context absent here are unknown; do not infer that the original agent lacked them." });
  const models = new Set(trace?.llmSteps.map(s => s.requestModel).filter(Boolean));
  const system = trace?.llmSteps.find(s => s.systemMessages?.length)?.systemMessages;
  return { agentId: "tv", mode: "recorded", request: trace?.userPrompt || flow!.userPrompt, finalResponse,
    startedAt: trace?.startedAt || flow!.createdAt, durationMs: trace?.durationMs, model: models.size === 1 ? [...models][0] : undefined,
    // Historical system-only hashes cannot claim equivalence with complete prompt+skill+tool manifests.
    promptVersion: system ? `retained-system-${digest(system)}` : undefined,
    evidence, coverage: "partial", sourceSessionId: trace?.sessionId || flow!.sessionId };
}
export async function loadRecordedAssessment(sessionId: string): Promise<Assessment> {
  const { getTrace } = await import("../tracing/agentTraceStore");
  const trace = getTrace(sessionId);
  let flow: TvFlowMemoryDocument | undefined;
  const { AZURE_COSMOS_ENDPOINT, AZURE_COSMOS_KEY, AZURE_COSMOS_DATABASE, AZURE_COSMOS_TV_FLOW_CONTAINER } = await import("../config");
  if (AZURE_COSMOS_ENDPOINT && AZURE_COSMOS_KEY && AZURE_COSMOS_DATABASE && AZURE_COSMOS_TV_FLOW_CONTAINER) {
    try {
      const { CosmosClient } = await import("@azure/cosmos");
      const client = new CosmosClient({ endpoint: AZURE_COSMOS_ENDPOINT, key: AZURE_COSMOS_KEY, connectionPolicy: { enableEndpointDiscovery: false } });
      const { resources } = await client.database(AZURE_COSMOS_DATABASE).container(AZURE_COSMOS_TV_FLOW_CONTAINER).items.query<TvFlowMemoryDocument>({
        query: "SELECT TOP 1 * FROM c WHERE c.sessionId = @session ORDER BY c.createdAt DESC", parameters: [{ name: "@session", value: sessionId }],
      }).fetchAll();
      flow = resources[0];
      client.dispose();
    } catch (error) {
      if (!trace) throw error;
      const assessment = assessmentFromRecord(trace);
      assessment.evidence.push({ id: `e${assessment.evidence.length + 1}`, kind: "context", text: `Cosmos supplement unavailable: ${error instanceof Error ? error.message : "read failed"}` });
      return assessment;
    }
  }
  return assessmentFromRecord(trace, flow);
}
