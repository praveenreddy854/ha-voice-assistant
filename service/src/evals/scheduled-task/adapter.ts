import { promises as fs } from "node:fs";
import path from "node:path";
import { runOfflineAgentLoop } from "../loop";
import { digest } from "../store";
import { captureTrial } from "../telemetry";
import type { AgentAdapter, Assessment, Scenario } from "../types";
import { assertScheduledTaskToolCoverage, ScheduledTaskEnvironment } from "./environment";
import { scheduledTaskScenarios, type ScheduledTaskState } from "./scenarios";

export async function createScheduledTaskAdapter(modelOverride?: string): Promise<AgentAdapter> {
  // The worker installs its network boundary before these production modules load.
  const [
    { createAgentLoop }, { SCHEDULED_TASK_TOOLS }, constants, { renderScheduledTaskSystemPrompt },
    { AI_MODEL_ADVANCED }, { buildMemoryToolDefinitions }, memory, { dueDateError },
  ] = await Promise.all([
    import("../../agents/core/agentLoop"), import("../../agents/scheduled-task/tools"),
    import("../../agents/scheduled-task/constants"), import("../../agents/scheduled-task/prompt"),
    import("../../config"), import("../../agents/core/memoryTools"), import("../../memory"),
    import("../../agents/scheduled-task/tools/dueDate"),
  ]);
  const template = await fs.readFile(path.join(__dirname, "../../prompts/SCHEDULEDTASK.md"), "utf8");
  const tools = [...SCHEDULED_TASK_TOOLS, ...buildMemoryToolDefinitions("scheduled_task")]
    .map(({ type, function: contract }) => ({ type, function: contract }));
  assertScheduledTaskToolCoverage(tools);
  const model = modelOverride || AI_MODEL_ADVANCED;
  if (!model) throw new Error("Configure AI_MODEL_ADVANCED before running evals");
  const systemPromptFor = (state: ScheduledTaskState) =>
    `${renderScheduledTaskSystemPrompt(template, new Date(state.now), state.timeZone)}\n\n${memory.AGENT_MEMORY_SYSTEM_INSTRUCTIONS}`;
  const fixtureInstructions = "This is an offline scheduling fixture. Use the current date/time and local timezone in the system prompt, not the real wall clock. The fixture clock stays fixed for this entire run, including retries and confirmations.";
  const promptVersion = digest({
    fixtureInstructions, maxIterations: constants.SCHEDULED_TASK_AGENT_MAX_ITERATIONS,
    prompts: scheduledTaskScenarios.map(scenario => ({ id: scenario.id, systemPrompt: systemPromptFor(scenario.initial) })),
    tools: tools.map(tool => ({
      name: tool.function.name, description: tool.function.description, schema: tool.function.inputSchema!.toJSONSchema(),
    })),
  });

  return {
    id: "scheduled_task", version: "scheduled-task-simulator-1", scenarios: scheduledTaskScenarios, model, promptVersion,
    async execute(input: Scenario, signal: AbortSignal): Promise<Assessment> {
      const scenario = input as Scenario<ScheduledTaskState>;
      const environment = new ScheduledTaskEnvironment(scenario, {
        tools, dueDateError, validateMemoryWrite: memory.validateMemoryWrite, normalizeMemoryScopes: memory.normalizeMemoryScopes,
      });
      const fixtureMemory = memory.formatMemoryContext(environment.state.memories.map(item => ({
        ...item, pk: "offline-fixture", status: "active" as const, embedding: [], createdAt: item.updatedAt, useCount: 0,
      })));
      const systemPrompt = [systemPromptFor(environment.state), fixtureMemory].filter(Boolean).join("\n\n");
      const initialMessage = `${fixtureInstructions}\n\n${scenario.request}`;
      environment.record({
        kind: "context",
        text: JSON.stringify({ systemPrompt, initialMessage, memorySource: "isolated fixture only; no live context or completion hooks" }),
      });
      return captureTrial({
        agentId: "scheduled_task", request: scenario.request, model, promptVersion,
        evidence: environment.evidence, context: scenario.context, expectations: scenario.expectations,
      }, signal, async telemetry => {
        const result = await runOfflineAgentLoop({
          createLoop: createAgentLoop, systemPrompt, tools, model, telemetry,
          maxIterations: constants.SCHEDULED_TASK_AGENT_MAX_ITERATIONS, initialMessage, signal, requireInputSchemas: true,
          record: item => environment.record(item),
          async executeTool(name, args) {
            signal.throwIfAborted();
            return { result: await environment.execute(name, args) };
          },
        });
        const assertion = environment.assertion(result.finalResponse);
        const taskAssertion = assertion.taskSatisfied && !result.stoppedAtIterationLimit;
        environment.record({ kind: "final", text: result.finalResponse });
        environment.record({
          kind: "assertion",
          text: JSON.stringify({
            ...assertion, taskSatisfied: taskAssertion, stoppedAtIterationLimit: result.stoppedAtIterationLimit,
            completionSuccess: result.completionSuccess, steps: result.steps,
          }),
        });
        return { finalResponse: result.finalResponse, taskAssertion };
      });
    },
  };
}
