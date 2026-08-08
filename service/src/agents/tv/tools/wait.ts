import { z } from "zod";
import {
  TvToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "./types";
import { delay } from "../../common/utils";
import { TV_DEFAULT_WAIT_MS } from "../../../config";

export const inputSchema = z.object({
  duration_ms: z.number().int().min(250).max(5000).optional().describe(
    "How long to wait in milliseconds. Default is 1500ms if not specified."
  ),
  reason: z.string().describe(
    "Why you're waiting (e.g., 'waiting for search results to load', 'allowing menu animation to complete')."
  ),
});

export type WaitInput = z.infer<typeof inputSchema>;

async function execute(
  args: WaitInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const duration = parsed.duration_ms && parsed.duration_ms > 0 ? parsed.duration_ms : TV_DEFAULT_WAIT_MS;

  await delay(duration, context.abortSignal);

  return {
    observation: `⏱️ Waited ${duration}ms. ${parsed.reason}`,
    needsScreenshot: false,
  };
}

export const definition: TvToolDefinition = {
  name: "wait",
  description:
    "Wait for a specified duration (in milliseconds) to allow UI transitions, loading screens, or animations to complete. Use this before requesting a screenshot if you expect the UI to change.",
  inputSchema,
  execute,
};
