/**
 * ScheduledTaskAgent — definition.
 *
 * Phase 2: handles CREATE flow (parse, resolve entity, save).
 * LIST/QUERY/FIRE arrive in later phases.
 */

import fs from "fs";
import path from "path";
import {
  AgentDefinition,
  AgentRunOptions,
  AgentSession,
  ToolExecutionContext,
  ToolExecutionResult,
} from "../core/types";
import {
  SCHEDULED_TASK_AGENT_DESCRIPTION,
  SCHEDULED_TASK_AGENT_MAX_ITERATIONS,
  SCHEDULED_TASK_AGENT_NAME,
} from "./constants";
import {
  SCHEDULED_TASK_TOOLS,
  executeScheduledTaskTool,
  getScheduledTaskToolActionSummary,
} from "./tools";
import { renderScheduledTaskSystemPrompt } from "./prompt";

const promptCache = new Map<string, string>();

function loadPromptTemplate(): string {
  const cached = promptCache.get("SCHEDULEDTASK");
  if (cached) return cached;
  const text = fs.readFileSync(
    path.join(__dirname, "..", "..", "prompts", "SCHEDULEDTASK.md"),
    "utf8"
  );
  promptCache.set("SCHEDULEDTASK", text);
  return text;
}

function renderSystemPrompt(): string {
  const tz =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return renderScheduledTaskSystemPrompt(loadPromptTemplate(), new Date(), tz);
}

export const scheduledTaskAgentDefinition: AgentDefinition = {
  agentType: "scheduled_task",
  name: SCHEDULED_TASK_AGENT_NAME,
  description: SCHEDULED_TASK_AGENT_DESCRIPTION,
  // The cached AgentLoop resolves this getter on every run/resumption, after
  // any pause, so relative dates never use a clock frozen at service startup.
  get systemPrompt(): string {
    return renderSystemPrompt();
  },
  tools: SCHEDULED_TASK_TOOLS,
  maxIterations: SCHEDULED_TASK_AGENT_MAX_ITERATIONS,

  async buildInitialMessage(
    userPrompt: string,
    _options: AgentRunOptions
  ): Promise<string> {
    return userPrompt;
  },

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    _context: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const result = await executeScheduledTaskTool(toolName, args);
    return {
      observation: result.observation,
      toolSuccess: result.toolSuccess,
      metadata: { raw: result.raw },
    };
  },

  getToolActionSummary(
    toolName: string,
    args: Record<string, unknown>
  ): string {
    return getScheduledTaskToolActionSummary(toolName, args);
  },

  buildToolContext(_session: AgentSession): ToolExecutionContext {
    return {};
  },
};
