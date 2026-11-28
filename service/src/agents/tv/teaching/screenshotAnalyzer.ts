/**
 * Screenshot Analyzer for Teaching Mode
 * Uses vision models to analyze TV screenshots and infer user actions
 */

import { z } from "zod";
import { AI_MODEL_ADVANCED, AI_MODEL_ADVANCED_REASONING_EFFORT } from "../../../config";
import { generateVisionText } from "../../../ai";

const analysisSchema = z.object({
  description: z.string().trim().min(1),
  focusedElement: z.string().trim().nullish(),
  inferredAction: z.string().trim().min(1),
});

/**
 * Previous step context for action inference
 */
export interface PreviousStepContext {
  stepNumber: number;
  description: string;
  focusedElement?: string;
  inferredAction?: string;
}

/**
 * Analyze a screenshot and infer what action the user performed
 * Uses previous step descriptions to understand navigation flow
 */
export async function analyzeScreenshot(
  screenshotBase64: string,
  contentType: string,
  taskName: string,
  previousSteps: PreviousStepContext[] = []
): Promise<{
  description: string;
  focusedElement?: string;
  inferredAction: string;
}> {
  let previousStepsContext = "";
  if (previousSteps.length > 0) {
    previousStepsContext = `
PREVIOUS STEPS IN THIS RECORDING:
${previousSteps
  .map(
    (step) =>
      `Step ${step.stepNumber}: ${step.inferredAction || "Started"} → ${step.description}${
        step.focusedElement ? ` (Focused: ${step.focusedElement})` : ""
      }`
  )
  .join("\n")}

Based on the previous steps, the user is navigating the TV to: "${taskName}"
`;
  } else {
    previousStepsContext = `This is the FIRST screenshot. The user just started the task: "${taskName}"`;
  }

  const stepNumber = previousSteps.length + 1;

  const prompt = `You are analyzing a TV screen recording where a user is teaching navigation steps.

TASK: "${taskName}"
CURRENT STEP: ${stepNumber}

${previousStepsContext}

Analyze this current screenshot and determine:
1. What is shown on the TV screen now
2. What UI element is currently selected/focused (highlighted)
3. What action the user LIKELY performed between the previous step and this step

Common TV remote actions:
- Pressed UP/DOWN/LEFT/RIGHT (directional navigation)
- Pressed SELECT/OK/ENTER (to select focused item)
- Pressed BACK (to go back)
- Pressed HOME (to go to home screen)
- Typed text using on-screen keyboard
- Scrolled through a list
- Opened an app
- Navigated to a menu item

Return JSON:
{
  "description": "Brief description of what's currently shown on screen (1-2 sentences)",
  "focusedElement": "The currently highlighted/selected UI element, or null if none visible",
  "inferredAction": "What the user likely did to get here from the previous step. Be specific like 'Pressed DOWN twice to reach Settings' or 'Selected the Search icon' or 'Typed search query'. For step 1, say 'Started recording - initial screen'"
}

Return ONLY the JSON, no other text.`;

  const responseText = await generateVisionText({
    model: AI_MODEL_ADVANCED,
    reasoningEffort: AI_MODEL_ADVANCED_REASONING_EFFORT,
    prompt,
    imageBase64: screenshotBase64,
    imageContentType: contentType,
    maxTokens: 500,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, "$1"));
  } catch {
    throw new Error("Vision model did not return a valid analysis");
  }
  const analysis = analysisSchema.safeParse(parsed);
  if (!analysis.success) throw new Error("Vision model did not return a valid analysis");
  return { ...analysis.data, focusedElement: analysis.data.focusedElement || undefined };
}
