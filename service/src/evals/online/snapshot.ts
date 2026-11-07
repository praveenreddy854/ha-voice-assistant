import type { AgentTrace } from "../../tracing/agentTraceStore";
import { assessmentFromRecord } from "../recorded";
import { isEvalAgentId } from "../registry";
import { digest } from "../store";
import type { Assessment, EvalAgentId, Evidence } from "../types";

export type OnlineAgentId = EvalAgentId | "home_assistant";
export const isOnlineAgentId = (id: unknown): id is OnlineAgentId => id === "home_assistant" || isEvalAgentId(id);

/** Factor repeated conversation snapshots into shared, citable evidence without dropping messages. */
export function onlineAssessment(trace: AgentTrace): Assessment {
  const isHA = trace.agentType === "home_assistant";
  const assessment = assessmentFromRecord(isHA ? { ...trace, agentType: "realtime" } : trace);
  if (isHA) {
    assessment.agentId = "home_assistant";
    assessment.evaluationScope = "execution";
    const configuration = trace.events.find(event => event.type === "ha.translation.configuration")?.data;
    if (typeof configuration?.promptVersion === "string") assessment.promptVersion = `ha-template-${configuration.promptVersion}`;
    assessment.expectations = "Assess downstream Home Assistant translation and execution, not voice routing. Check exact entities, services, options, user intent and scoped memory, every requested action, all HTTP results, and retained state observations. A successful HTTP call or generic sent-successfully message does not prove physical device completion. Queries must return the requested value. Missing final-state verification makes physical outcomes unknown, not automatically failed. Check stale entity names against the retained current states.";
  }
  const shared = new Map<string, Evidence>();
  const intern = (value: unknown, label: string): string => {
    const id = `shared-${digest(value)}`;
    if (!shared.has(id)) shared.set(id, { id, kind: "context", text: `${label}: ${JSON.stringify(value)}`, source: "deduplicated_conversation_snapshot" });
    return id;
  };
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") {
      const item = value as Record<string, unknown>;
      if (item.type === "image" && typeof item.image === "string") {
        const id = `image-${digest(item.image)}`;
        if (!shared.has(id)) shared.set(id, { id, kind: "image", text: "Image retained in the agent's conversation", image: item.image.startsWith("data:") ? item.image : `data:${item.mediaType || "image/jpeg"};base64,${item.image}` });
        return { type: "image", evidenceId: id };
      }
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, normalize(entry)]));
    }
    return value;
  };
  assessment.evidence = assessment.evidence.map(evidence => {
    if (evidence.kind !== "context" || !evidence.source?.includes(":llm:")) return evidence;
    const step = JSON.parse(evidence.text);
    if (Array.isArray(step.messages)) {
      step.messageEvidenceIds = step.messages.map((entry: unknown) => intern(normalize(entry), "Conversation message"));
      delete step.messages;
    }
    if (step.systemMessages) { step.systemEvidenceId = intern(step.systemMessages, "System context"); delete step.systemMessages; }
    return { ...evidence, text: JSON.stringify(step) };
  });
  assessment.evidence.push(...shared.values());
  assessment.evidence.push({ id: "snapshot-format", kind: "context", text: "Repeated conversation messages and system context are stored once as shared-* evidence. messageEvidenceIds and systemEvidenceId resolve to those exact retained values. References are repeated views, not extra actions. image-* evidence retains conversation images. No chronological or missing state is invented." });
  return assessment;
}
