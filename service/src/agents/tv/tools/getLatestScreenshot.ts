import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";

export const inputSchema = z.object({
  reason: z.string().describe(
    "Why you need a screenshot (e.g., 'to verify search results', 'to locate the next menu item')."
  ),
});

export type GetLatestScreenshotInput = z.infer<typeof inputSchema>;

async function execute(
  args: GetLatestScreenshotInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);

  return {
    observation:
      `📸 Screenshot requested: ${parsed.reason}\n` +
      `➡️ The latest screenshot from the TV camera will be delivered in the next response.`,
    needsScreenshot: true,
  };
}

export const definition: TvToolDefinition = {
  name: "get_latest_screenshot",
  description:
    "Get the latest screenshot from the TV camera to see what's currently displayed. The client continuously captures screenshots in the background. Use this when you need visual feedback to make navigation decisions.",
  inputSchema,
  needsExternalInput: true,
  execute,
};
