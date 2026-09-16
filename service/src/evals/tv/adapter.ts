import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentAdapter, Assessment, Scenario } from "../types";
import { digest } from "../store";
import { runOfflineAgentLoop } from "../loop";
import { tvScenarios, type TvState } from "./scenarios";
import { TvEnvironment } from "./environment";

async function readSkills(directory: string, prefix = ""): Promise<Record<string, string>> {
  const skills: Record<string, string> = {};
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) Object.assign(skills, await readSkills(path.join(directory, entry.name), `${prefix}${entry.name}/`));
    else if (entry.name.endsWith(".md")) skills[`${prefix}${entry.name.slice(0, -3)}`] = await fs.readFile(path.join(directory, entry.name), "utf8");
  }
  return skills;
}
export async function createTvAdapter(modelOverride?: string): Promise<AgentAdapter> {
  // This module is constructed only inside the worker after its network boundary.
  const [{ createAgentLoop }, { TV_TOOLS }, constants, { AI_MODEL_ADVANCED }, { buildMemoryToolDefinitions }, memory] = await Promise.all([
    import("../../agents/core/agentLoop"), import("../../agents/tv/tools"), import("../../agents/tv/constants"), import("../../config"),
    import("../../agents/core/memoryTools"), import("../../memory"),
  ]);
  const skills = await readSkills(path.join(__dirname, "../../agents/tv/skills"));
  const systemPrompt = `${constants.TV_AGENT_INSTRUCTIONS}\n\n${memory.AGENT_MEMORY_SYSTEM_INSTRUCTIONS}`;
  const tools = [...TV_TOOLS, ...buildMemoryToolDefinitions("tv")].map(({ type, function: contract }) => ({ type, function: contract }));
  const model = modelOverride || AI_MODEL_ADVANCED;
  if (!model) throw new Error("Configure AI_MODEL_ADVANCED before running evals");
  const promptVersion = digest({ systemPrompt, skills, tools: tools.map(t => ({ name: t.function.name, description: t.function.description, schema: t.function.inputSchema?.toJSONSchema() })) });
  return { id: "tv", version: "tv-simulator-1", scenarios: tvScenarios, model, promptVersion,
    async execute(input: Scenario, signal: AbortSignal): Promise<Assessment> {
      const scenario = input as Scenario<TvState>, environment = new TvEnvironment(scenario, skills);
      const started = Date.now();
      const cap = constants.TV_AGENT_MAX_ITERATIONS_CAP;
      const initialMessage = `The user asked: "${scenario.request}"\n\nYou will now be provided with current state of all TVs in home assistant network.\n\nCurrent device states:\n${JSON.stringify(environment.deviceStates(), null, 2)}\n\nAvailable skills:\n${Object.entries(skills).map(([key, content]) => `${key}: ${content.split("\n").find(line => line.startsWith("# ")) || key}`).join("\n")}\n\nBegin by analyzing the goal and planning your approach.`;
      const { finalResponse, usage, stoppedAtIterationLimit: stopped } = await runOfflineAgentLoop({
        createLoop: createAgentLoop, systemPrompt, tools, model, maxIterations: cap, initialMessage, signal,
        oneToolPerTurn: true,
        record: item => environment.record(item),
        async executeTool(name, args) {
          const value = await environment.execute(name, args);
          return { result: { observation: value.observation, toolSuccess: value.toolSuccess },
            imageBase64: value.image?.split(",")[1], imageContentType: "image/png" };
        },
        rejectCompletion(result, steps) {
          if (result.success === true && environment.researchRequired && steps < cap && result.completionToolCallId) {
            return "Completion rejected: command verification failed and required device-command research is pending. Call web_search before completing.";
          }
          return undefined;
        },
      });
      const durationMs = Date.now() - started;
      environment.record({ kind: "final", text: finalResponse });
      environment.record({ kind: "assertion", text: JSON.stringify({ actualFinalState: environment.state, taskSatisfied: environment.taskSatisfied(), virtualDeviceTimeMs: environment.virtualMs, stoppedAtIterationLimit: stopped }) });
      return { agentId: "tv", mode: "simulated", request: scenario.request, finalResponse, startedAt: new Date(started).toISOString(), durationMs,
        model, promptVersion, evidence: environment.evidence, coverage: "complete", context: scenario.context, expectations: scenario.expectations,
        taskAssertion: environment.taskSatisfied(), usage };
    } };
}
