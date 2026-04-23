import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { getLatestScreenshot } from "../../common/screenshotStore";
import { isRtspMode, startRtspCapture } from "../../common/rtspCapture";
import { generateVisionText } from "../../../ai";
import { AI_MODEL_MINI } from "../../../config";

export const inputSchema = z.object({
  expected_state: z.string().describe(
    "What you expect to see on screen right now (e.g., 'YouTube search keyboard with cursor on letter a', 'YouTube home feed with first item selected')."
  ),
});

export type ValidateScreenInput = z.infer<typeof inputSchema>;

async function execute(
  args: ValidateScreenInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);

  if (!context.sessionId) {
    return {
      observation: "Cannot validate: no active session for screenshot capture.",
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  if (!AI_MODEL_MINI) {
    return {
      observation: "Cannot validate: vision model not configured.",
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  // Ensure RTSP capture is running so there's a frame to read
  if (isRtspMode()) {
    await startRtspCapture(context.sessionId);
  }

  const screenshot = await getLatestScreenshot(context.sessionId);
  if (!screenshot) {
    return {
      observation: "No screenshot available yet. The camera may not have captured a frame. Wait and retry.",
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  const prompt =
    `You are the user supervising a TV automation agent. You asked: "${context.userPrompt || "unknown"}"\n\n` +
    `The agent expects to see: "${parsed.expected_state}"\n\n` +
    `Look at this TV screenshot and check:\n` +
    `1. Does the screen match what the agent expects?\n` +
    `2. Is the agent making progress toward YOUR goal?\n` +
    `3. If text is visible in a search bar or input field, does it match what should have been typed for your request?\n` +
    `4. Is there any error, popup, or unexpected state?\n\n` +
    `If everything looks correct, respond: PASS — [brief confirmation]\n` +
    `If something is wrong, respond: FAIL — [what's wrong and what the screen should show instead]`;

  const analysis = await generateVisionText({
    model: AI_MODEL_MINI,
    prompt,
    imageBase64: screenshot.base64,
    imageContentType: screenshot.contentType,
    maxTokens: 200,
    temperature: 0,
  });

  const trimmed = analysis.trim();
  const passed = trimmed.toUpperCase().startsWith("PASS");

  if (passed) {
    return {
      observation: `Screen validation PASSED: ${trimmed}`,
      needsScreenshot: false,
      toolSuccess: true,
    };
  }

  return {
    observation:
      `Screen validation FAILED: ${trimmed}\n` +
      `Use get_latest_screenshot to see the actual screen state and adjust your approach.`,
    needsScreenshot: false,
    toolSuccess: false,
  };
}

export const definition: TvToolDefinition = {
  name: "validate_screen",
  description:
    "Quick visual check of the current TV screen against your expectation and the user's goal. " +
    "Captures the latest camera frame and validates it — you do NOT see the image, you get a PASS/FAIL verdict. " +
    "Use for lightweight confirmation without a full screenshot round-trip. If it FAILs, use get_latest_screenshot to see the actual state.",
  inputSchema,
  execute,
};
