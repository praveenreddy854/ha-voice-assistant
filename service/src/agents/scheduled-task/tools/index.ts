import type { ToolDefinition } from "../../core/agentLoop";
import * as findMatchingEntities from "./findMatchingEntities";
import * as saveScheduledTask from "./saveScheduledTask";
import * as listTasks from "./listTasks";
import * as updateTask from "./updateTask";
import * as deleteTask from "./deleteTask";

const ALL_TOOLS = [
  findMatchingEntities,
  saveScheduledTask,
  listTasks,
  updateTask,
  deleteTask,
] as const;

export const SCHEDULED_TASK_TOOLS: ToolDefinition[] = ALL_TOOLS.map((mod) => ({
  type: "function" as const,
  function: {
    name: mod.definition.name,
    description: mod.definition.description,
    parameters: {},
    inputSchema: mod.definition.inputSchema,
  },
  execute: async (args: Record<string, unknown>) => {
    const result = await mod.execute(args as never);
    return result;
  },
}));

const EXECUTORS: Record<string, (args: unknown) => Promise<unknown>> = {};
for (const mod of ALL_TOOLS) {
  EXECUTORS[mod.definition.name] = mod.execute as (
    args: unknown
  ) => Promise<unknown>;
}

export async function executeScheduledTaskTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<{ observation: string; toolSuccess: boolean; raw: unknown }> {
  const executor = EXECUTORS[toolName];
  if (!executor) {
    return {
      observation: `Unknown tool: ${toolName}`,
      toolSuccess: false,
      raw: null,
    };
  }
  try {
    const raw = (await executor(args)) as { observation?: string };
    return {
      observation: raw.observation ?? `Tool ${toolName} completed.`,
      toolSuccess: true,
      raw,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      observation: `Tool ${toolName} failed: ${message}`,
      toolSuccess: false,
      raw: null,
    };
  }
}

export function getScheduledTaskToolActionSummary(
  toolName: string,
  args: Record<string, unknown>
): string {
  switch (toolName) {
    case "find_matching_entities":
      return `Search HA entities: "${args.query ?? ""}"${
        args.domain ? ` (domain=${args.domain})` : ""
      }`;
    case "save_scheduled_task":
      return `Save scheduled task: "${args.title ?? "(untitled)"}"`;
    case "list_scheduled_tasks":
      return "List active scheduled tasks";
    case "update_scheduled_task":
      return `Update task id=${args.id ?? "?"}`;
    case "delete_scheduled_task":
      return `Delete task scope=${args.scope ?? "?"} id=${args.id ?? "(family)"}`;
    default:
      return toolName;
  }
}
