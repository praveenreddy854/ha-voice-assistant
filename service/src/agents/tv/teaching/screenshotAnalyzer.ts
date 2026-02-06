/**
 * Screenshot Analyzer for Teaching Mode
 * Uses vision models to analyze TV screenshots and infer user actions
 */

import { AzureOpenAI } from "openai";
import {
  OPEN_AI_BASE_URL,
  API_KEY,
  OPENAI_RESPONSES_API_VERSION,
  AZURE_AI_AGENT_MODEL,
  AZURE_OPENAI_MODEL_ADVANCED,
} from "../../../config";

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
  previousSteps: PreviousStepContext[] = [],
): Promise<{
  description: string;
  focusedElement?: string;
  inferredAction: string;
}> {
  if (!OPEN_AI_BASE_URL || !API_KEY) {
    return {
      description: "Screenshot captured (analysis unavailable)",
      focusedElement: undefined,
      inferredAction: "Unknown action",
    };
  }

  try {
    const visionModel = AZURE_OPENAI_MODEL_ADVANCED || "gpt-5.1";

    const client = new AzureOpenAI({
      baseURL: OPEN_AI_BASE_URL,
      apiKey: API_KEY,
      apiVersion: OPENAI_RESPONSES_API_VERSION,
    });

    // Build context from previous steps
    let previousStepsContext = "";
    if (previousSteps.length > 0) {
      previousStepsContext = `
PREVIOUS STEPS IN THIS RECORDING:
${previousSteps
  .map(
    (step) =>
      `Step ${step.stepNumber}: ${step.inferredAction || "Started"} → ${step.description}${step.focusedElement ? ` (Focused: ${step.focusedElement})` : ""}`,
  )
  .join("\n")}

Based on the previous steps, the user is navigating the TV to: "${taskName}"
`;
    } else {
      previousStepsContext = `This is the FIRST screenshot. The user just started the task: "${taskName}"`;
    }

    const stepNumber = previousSteps.length + 1;

    const messages = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `You are analyzing a TV screen recording where a user is teaching navigation steps.

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

Return ONLY the JSON, no other text.`,
          },
          {
            type: "input_image",
            image_url: `data:${contentType};base64,${screenshotBase64}`,
          },
        ],
      },
    ];

    let response = await client.responses.create({
      model: visionModel,
      input: JSON.stringify({
        messages,
        max_tokens: 500,
        temperature: 0.2,
      }),
    });

    while (response.status === "queued" || response.status === "in_progress") {
      await new Promise((resolve) => setTimeout(resolve, 100));
      response = await client.responses.retrieve(response.id);
    }

    if (response.status === "failed" || !response.output_text) {
      return {
        description: "Screenshot captured",
        focusedElement: undefined,
        inferredAction:
          stepNumber === 1 ? "Started recording" : "Navigation action",
      };
    }

    try {
      const cleaned = response.output_text
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
      const parsed = JSON.parse(cleaned);
      return {
        description: parsed.description || "Screenshot captured",
        focusedElement: parsed.focusedElement || undefined,
        inferredAction:
          parsed.inferredAction ||
          (stepNumber === 1 ? "Started recording" : "Navigation action"),
      };
    } catch {
      return {
        description: response.output_text.substring(0, 200),
        focusedElement: undefined,
        inferredAction:
          stepNumber === 1 ? "Started recording" : "Navigation action",
      };
    }
  } catch (error) {
    console.error("[Teaching] Error analyzing screenshot:", error);
    return {
      description: "Screenshot captured (analysis error)",
      focusedElement: undefined,
      inferredAction: "Unknown action",
    };
  }
}
