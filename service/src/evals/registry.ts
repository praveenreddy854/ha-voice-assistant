import { EVAL_AGENT_IDS, type AgentAdapter, type Assessment, type EvalAgentId, type Scenario } from "./types";

interface EvalAgentRegistration {
  id: EvalAgentId;
  name: string;
  description: string;
  recordedExpectations: string;
  scenarios(): Promise<Scenario[]>;
  createAdapter(modelOverride?: string): Promise<AgentAdapter>;
  loadRecorded(sessionId: string): Promise<Assessment>;
  recordedVersion: string;
}

function recordedLoader(agentId: EvalAgentId) {
  return async (sessionId: string) => (await import("./recorded")).loadRecordedAssessment(sessionId, agentId);
}

export const evalAgents: Record<EvalAgentId, EvalAgentRegistration> = {
  tv: {
    id: "tv",
    name: "TVAgent",
    description: "TV navigation, app readiness, content selection and verified playback with simulated screens.",
    recordedExpectations: "Assess the complete TV request, including target, app, content qualifiers and playback. Command acceptance alone does not establish the observed outcome.",
    scenarios: async () => (await import("./tv/scenarios")).tvScenarios,
    createAdapter: async model => (await import("./tv/adapter")).createTvAdapter(model),
    loadRecorded: recordedLoader("tv"),
    recordedVersion: "recorded-import-2",
  },
  scheduled_task: {
    id: "scheduled_task",
    name: "ScheduledTaskAgent",
    description: "Scheduled announcements and actions, entity resolution, dates, updates and cancellation in isolated storage.",
    recordedExpectations: "Verify the saved effect, entity, absolute due date/timezone, recurrence and cancellation scope. Unrequested fields and other tasks must be preserved. Rejected writes are not successful scheduling. Ambiguous deletion requires clarification, not a guess. Scheduling an action does not mean that future action has fired.",
    scenarios: async () => (await import("./scheduled-task/scenarios")).scheduledTaskScenarios,
    createAdapter: async model => (await import("./scheduled-task/adapter")).createScheduledTaskAdapter(model),
    loadRecorded: recordedLoader("scheduled_task"),
    recordedVersion: "recorded-import-2",
  },
  realtime: {
    id: "realtime",
    name: "Realtime Voice Agent",
    description: "Text/tool decisions on the configured Realtime deployment: routing, confirmations, follow-ups, run control and memory. Audio quality is not assessed.",
    recordedExpectations: "Assess routing and preservation of the user's target and qualifiers, confirmations, follow-up signaling and scoped memory. A protected opening or bulk destructive action needs actual user confirmation. An accepted async job warrants 'On it', not a claim that the device action finished. Do not require a specialist's eventual completion during this voice turn. Missing audio cannot establish speech or microphone quality.",
    scenarios: async () => (await import("./realtime/scenarios")).realtimeScenarios,
    createAdapter: async model => (await import("./realtime/adapter")).createRealtimeAdapter(model),
    loadRecorded: recordedLoader("realtime"),
    recordedVersion: "recorded-import-2",
  },
};

export function isEvalAgentId(id: unknown): id is EvalAgentId {
  return typeof id === "string" && EVAL_AGENT_IDS.some(agentId => agentId === id);
}

export function getEvalAgent(id = "tv"): EvalAgentRegistration {
  if (!isEvalAgentId(id)) throw new Error(`Agent ${id} is not registered for offline evaluations`);
  return evalAgents[id];
}

export async function evalAgentCatalog() {
  return Promise.all(EVAL_AGENT_IDS.map(async id => {
    const agent = evalAgents[id];
    const scenarios = await agent.scenarios();
    return {
      id, name: agent.name, description: agent.description, scenarioCount: scenarios.length,
      scenarios: scenarios.map(scenario => ({ id: scenario.id, request: scenario.request })),
    };
  }));
}
