import type {
  AgentToolExecutionOptions,
  ToolDefinition,
} from "../../core/agentLoop";
import type { AgentPauseGate } from "../../core/types";
import { getActiveSessionId, trackToolResult } from "../../../tracing/agentTraceStore";
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

function pauseGateFrom(
  options?: AgentToolExecutionOptions
): AgentPauseGate | undefined {
  return options?.context.pauseGate;
}

async function waitForRunPermission(
  options?: AgentToolExecutionOptions
): Promise<void> {
  options?.abortSignal?.throwIfAborted();
  await pauseGateFrom(options)?.waitIfPaused();
  options?.abortSignal?.throwIfAborted();
}

export const SCHEDULED_TASK_TOOLS: ToolDefinition[] = ALL_TOOLS.map((mod) => ({
  type: "function" as const,
  function: {
    name: mod.definition.name,
    description: mod.definition.description,
    parameters: {},
    inputSchema: mod.definition.inputSchema,
  },
  execute: async (
    args: Record<string, unknown>,
    options?: AgentToolExecutionOptions
  ) => {
    const result = await executeScheduledTaskTool(mod.definition.name, args, options);
    return result.raw ?? { observation: result.observation, toolSuccess: result.toolSuccess };
  },
}));

export async function executeScheduledTaskTool(
  toolName: string,
  args: Record<string, unknown>,
  options?: AgentToolExecutionOptions
): Promise<{ observation: string; toolSuccess: boolean; raw: unknown }> {
  // Capture attribution before any await. Both SDK and direct execution use
  // this boundary, so each actual attempt produces exactly one result span.
  const sessionId = getActiveSessionId();
  await waitForRunPermission(options);
  const startedAt = Date.now();
  const mod = ALL_TOOLS.find((tool) => tool.definition.name === toolName);
  let traceArgs: Record<string, unknown> = {};
  const record = (result: { observation: string; toolSuccess: boolean }) => {
    if (sessionId) trackToolResult(sessionId, {
      ...result, toolName, toolCallId: options?.toolCallId ?? "",
      durationMs: Math.max(0, Date.now() - startedAt), args: traceArgs,
    });
  };
  let result: { observation: string; toolSuccess: boolean; raw: unknown };
  try {
    if (!mod) throw new Error("Unknown scheduled task tool");
    // Only schema-approved fields enter telemetry; unknown fields and SDK
    // error payloads (which can contain credentials) are never recorded here.
    traceArgs = mod.definition.inputSchema.parse(args);
    const raw = await mod.execute(traceArgs as never);
    result = {
      observation: raw.observation ?? `Tool ${toolName} completed.`,
      toolSuccess: !("toolSuccess" in raw) || raw.toolSuccess !== false,
      raw,
    };
  } catch (err) {
    result = {
      observation: options?.abortSignal?.aborted
        ? `Tool ${toolName} cancelled during execution; its effects may be incomplete.`
        : `Tool ${toolName} failed during execution. Check its arguments and service availability.`,
      toolSuccess: false,
      raw: null,
    };
    record(result);
    if (options?.abortSignal?.aborted) throw err;
    return result;
  }
  // Record the real effect before a post-execution pause/cancellation check:
  // cancelling after a successful write must not hide that persisted write.
  record(result);
  await waitForRunPermission(options);
  return result;
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
