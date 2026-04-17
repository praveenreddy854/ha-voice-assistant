import { z } from "zod";
import { TvToolDefinition, ToolExecutionResult } from "./types";
import { retrieveSimilarTvFlows } from "../flowMemory";

export const inputSchema = z.object({
  current_goal: z.string().describe(
    "Current user goal in plain language (e.g., 'open YouTube search and type latest songs')."
  ),
  current_context: z.string().optional().describe(
    "Optional current UI/context details (e.g., app shell, highlighted item). Avoid dynamic content titles."
  ),
  limit: z.number().int().min(1).max(5).optional().describe(
    "Maximum number of flows to fetch (defaults to 5)."
  ),
  reason: z.string().describe(
    "Why memory retrieval is needed right now."
  ),
});

export type RetrieveSimilarFlowsInput = z.infer<typeof inputSchema>;

async function execute(args: RetrieveSimilarFlowsInput): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const { flows, usedFallbackPartials } = await retrieveSimilarTvFlows({
    currentGoal: parsed.current_goal,
    currentContext: parsed.current_context,
    limit: parsed.limit,
  });

  if (!flows.length) {
    return {
      observation:
        `📚 No relevant TV flow memory found for current goal.\n` +
        `Goal: ${parsed.current_goal}\n` +
        `Reason: ${parsed.reason}\n` +
        `Proceed with fresh reasoning and request screenshots for verification.`,
      needsScreenshot: false,
      toolSuccess: true,
    };
  }

  const payload = {
    goal: parsed.current_goal,
    reason: parsed.reason,
    totalReturned: flows.length,
    usedFallbackPartials,
    flows,
  };

  return {
    observation: `📚 Retrieved similar TV flows:\n${JSON.stringify(payload, null, 2)}`,
    needsScreenshot: false,
    toolSuccess: true,
  };
}

export const definition: TvToolDefinition = {
  name: "retrieve_similar_flows",
  description:
    "Retrieve up to 5 relevant successful TV-agent flows from memory to guide the current task. Use this when you are uncertain, repeating failed actions, or need proven UI navigation patterns. The tool prioritizes successful flows and backfills with partial flows when needed.",
  inputSchema,
  execute,
};
