export { ToolExecutionContext, ToolExecutionResult, TvToolDefinition } from "./types";

import { ToolDefinition } from "../../core/agentLoop";
import { TvToolName, TvToolArguments } from "../types";
import { ToolExecutionContext, ToolExecutionResult, TvToolDefinition } from "./types";

import * as clickPowerButton from "./clickPowerButton";
import * as mediaControl from "./mediaControl";
import * as clickSelectButton from "./clickSelectButton";
import * as goBack from "./goBack";
import * as goHome from "./goHome";
import * as navigate from "./navigate";
import * as deterministicTyping from "./deterministicTyping";
import * as deleteTypedText from "./deleteTypedText";
import * as getLatestScreenshot from "./getLatestScreenshot";
import * as getDeviceState from "./getDeviceState";
import * as launchApp from "./launchApp";
import * as retrieveSimilarFlows from "./retrieveSimilarFlows";
import * as webSearch from "./webSearch";
import * as loadSkill from "./loadSkill";
import * as validateScreen from "./validateScreen";
import * as wait from "./wait";
import { ensureDeviceOnBeforeCommand } from "./deviceStateGuard";
import {
  DEVICE_COMPONENT_SOURCE,
  getDeviceCommandResearchRequirement,
  getDeviceIntegration,
  requireDeviceCommandResearch,
} from "./webSearch";

// ============================================================================
// All tool modules in registration order
// ============================================================================

const ALL_TOOLS = [
  clickPowerButton,
  mediaControl,
  clickSelectButton,
  goBack,
  goHome,
  navigate,
  deterministicTyping,
  deleteTypedText,
  getLatestScreenshot,
  getDeviceState,
  launchApp,
  retrieveSimilarFlows,
  webSearch,
  loadSkill,
  validateScreen,
  wait,
] as const;

// ============================================================================
// Build ToolDefinition[] for the agent loop (Zod schemas passed through)
// ============================================================================

export const TV_TOOLS: ToolDefinition[] = ALL_TOOLS.map((mod) => ({
  type: "function" as const,
  function: {
    name: mod.definition.name,
    description: mod.definition.description,
    parameters: {}, // unused when inputSchema is present
    inputSchema: mod.definition.inputSchema,
  },
}));

/** Set of tool names that need external input (break the agent loop). */
export const TOOLS_NEEDING_EXTERNAL_INPUT = new Set<string>(
  ALL_TOOLS
    .filter((mod) => mod.definition.needsExternalInput)
    .map((mod) => mod.definition.name)
);

// ============================================================================
// Tool executor dispatch
// ============================================================================

const EXECUTORS: Record<string, (args: any, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>> = {};
for (const mod of ALL_TOOLS) {
  EXECUTORS[mod.definition.name] = mod.definition.execute;
}

const TOOLS_REQUIRING_DEVICE_ON = new Set<string>([
  "media_control",
  "click_select_button",
  "go_back",
  "go_home",
  "navigate",
  "deterministic_typing",
  "delete_typed_text",
  "launch_app",
]);

const DEVICE_COMMAND_TOOLS = new Set<string>([
  "click_power_button",
  "media_control",
  "click_select_button",
  "go_back",
  "go_home",
  "navigate",
  "deterministic_typing",
  "delete_typed_text",
  "get_device_state",
  "launch_app",
]);

function getToolDeviceIntegration(
  args: Record<string, unknown>
): ReturnType<typeof getDeviceIntegration> {
  for (const field of [
    "remote_entity_id",
    "media_player_entity_id",
    "device_name",
  ] as const) {
    const value = args[field];
    if (typeof value !== "string") continue;
    const integration = getDeviceIntegration(value);
    if (integration) return integration;
  }
  return undefined;
}

function resultRequiresCommandResearch(
  toolName: string,
  result: ToolExecutionResult
): boolean {
  if (result.toolSuccess === false) return true;
  if (toolName !== "launch_app" && toolName !== "click_power_button") {
    return false;
  }
  return /PARTIAL|UNKNOWN|not yet reflected the state change|remains?\s+"?off/i.test(
    result.observation
  );
}

export async function executeTool(
  toolName: TvToolName,
  args: TvToolArguments,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  await context.waitIfPaused?.();
  context.abortSignal?.throwIfAborted();
  console.log(`[TV Tools] Dispatching: ${toolName}`);
  console.log(`[TV Tools]   Args: ${JSON.stringify(args, null, 2)}`);

  const executor = EXECUTORS[toolName];
  if (!executor) {
    console.error(`[TV Tools] No executor found for tool: ${toolName}`);
    throw new Error(`Unsupported tool: ${toolName}`);
  }

  const toolArgs = args as unknown as Record<string, unknown>;
  const integration = DEVICE_COMMAND_TOOLS.has(toolName)
    ? getToolDeviceIntegration(toolArgs)
    : undefined;
  const researchRequirement = integration
    ? getDeviceCommandResearchRequirement(context, integration)
    : undefined;
  if (integration && researchRequirement) {
    return {
      observation:
        `Command research is required before ${toolName}. ` +
        `Previous verification failed: ${researchRequirement.reason}. ` +
        `Call web_search with the Home Assistant Core component URL ` +
        `"${DEVICE_COMPONENT_SOURCE[integration]}" and inspect the result before retrying. ` +
        `No Home Assistant request was sent.`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  const stateGuard = TOOLS_REQUIRING_DEVICE_ON.has(toolName)
    ? await ensureDeviceOnBeforeCommand(
        toolArgs,
        context
      )
    : undefined;

  if (stateGuard && !stateGuard.ready) {
    const reason = stateGuard.observation;
    if (integration) {
      requireDeviceCommandResearch(context, integration, reason);
    }
    return {
      observation:
        `Device state preflight failed: ${reason}` +
        `${integration ? ` Search ${DEVICE_COMPONENT_SOURCE[integration]} before retrying.` : ""}`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  const result = await executor(args, context);
  if (stateGuard) {
    result.observation = `Device state preflight: ${stateGuard.observation}\n\n${result.observation}`;
  }
  if (integration && resultRequiresCommandResearch(toolName, result)) {
    requireDeviceCommandResearch(context, integration, result.observation);
    result.observation +=
      `\n\nCommand verification failed. Before another ${integration} command, ` +
      `call web_search with ${DEVICE_COMPONENT_SOURCE[integration]} and inspect the result.`;
  }
  await context.waitIfPaused?.();
  context.abortSignal?.throwIfAborted();
  console.log(`[TV Tools]   Result success: ${result.toolSuccess ?? true}`);
  console.log(`[TV Tools]   Observation: ${result.observation.substring(0, 300)}`);
  if (result.needsScreenshot) {
    console.log(`[TV Tools]   Needs screenshot: true`);
  }
  return result;
}

// ============================================================================
// Action summary for logging
// ============================================================================

export function getToolActionSummary(
  toolName: string,
  args: Record<string, unknown>
): string {
  switch (toolName) {
    case "click_power_button":
      return "Press power";
    case "media_control":
      return `Media control: ${args.action || "action"}`;
    case "click_select_button":
      return "Press select";
    case "go_back":
      return "Press back";
    case "go_home":
      return "Press home";
    case "navigate":
      return `Navigate ${args.direction || "?"} x${args.count || 1}`;
    case "deterministic_typing":
      return `Type: "${args.text || "text"}"`;
    case "delete_typed_text":
      return "Delete typed text";
    case "get_latest_screenshot":
      return "Get latest screenshot";
    case "get_device_state":
      return "Get device state";
    case "launch_app":
      return `Launch ${args.app_name || "app"}`;
    case "retrieve_similar_flows":
      return `Retrieve similar flows: ${args.current_goal || "goal"}`;
    case "web_search":
      return `Search HA docs: ${args.query || args.url || "query"}`;
    case "load_skill":
      return `Load skill: ${args.skill_key || "skill"}`;
    case "validate_screen":
      return `Validate screen: ${args.expected_state || "check"}`;
    case "wait":
      return `Wait ${args.duration_ms || 1000}ms`;
    default:
      return `Execute ${toolName}`;
  }
}
