import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { runNavigationAgent } from "../../navigation";
import { getKnownDeviceStates } from "../../../ha";
import { loadSkillsForDevices } from "../skills/skillLoader";

export const inputSchema = z.object({
  task_description: z.string().describe(
    "Clear description of the navigation task to delegate (e.g., 'go to home screen', 'navigate up 3 times', 'find and activate search')."
  ),
  remote_entity_id: z.string().describe(
    "Home Assistant entity ID of the remote control to use."
  ),
  media_player_entity_id: z.string().describe(
    "Home Assistant entity ID of the TV/media player."
  ),
  reason: z.string().describe(
    "Why you're delegating this navigation task (e.g., 'user wants to search for content')."
  ),
});

export type DelegateToNavigationInput = z.infer<typeof inputSchema>;

async function execute(
  args: DelegateToNavigationInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  console.log(`[TV Agent] Delegating to Navigation Agent: ${parsed.task_description}`);
  console.log(`[TV Agent] Screenshot available: ${!!context.screenshotBase64}`);

  // Load app-specific navigation skills so the nav agent knows sidebar layout, etc.
  let skillsContext = "";
  try {
    const deviceStates = await getKnownDeviceStates();
    const skills = loadSkillsForDevices(deviceStates);
    if (skills) {
      skillsContext = `\n\n${skills}`;
    }
  } catch (err) {
    console.warn("[TV Agent] Failed to load skills for navigation agent:", err);
  }

  try {
    const result = await runNavigationAgent({
      userMessage: parsed.task_description + skillsContext,
      deviceConfig: {
        remoteEntityId: parsed.remote_entity_id,
        mediaPlayerEntityId: parsed.media_player_entity_id,
      },
      screenshotBase64: context.screenshotBase64,
      screenshotContentType: context.screenshotContentType,
      maxIterations: 10,
    });

    console.log(`[TV Agent] Navigation Agent result: success=${result.success}, steps=${result.steps.length}`);

    if (!result.success) {
      const stepSummary = result.steps
        .map((s, i) => `  ${i + 1}. ${s.toolName}: ${s.observation?.substring(0, 100)}...`)
        .join("\n");

      return {
        observation:
          `❌ Navigation Agent failed after ${result.steps.length} steps.\n` +
          `📋 Task: ${parsed.task_description}\n` +
          `❗ Error: ${result.message}\n` +
          `📝 Steps attempted:\n${stepSummary}\n` +
          `💡 Suggestion: Try a different approach or request a screenshot to assess the current state.`,
        needsScreenshot: true,
      };
    }

    const stepSummary = result.steps
      .filter(s => s.observation && !s.observation.startsWith("⏱️"))
      .map(s => `• ${s.toolName}: ${s.observation?.split("\n")[0] || "completed"}`)
      .slice(-3)
      .join("\n");

    return {
      observation:
        `✅ Navigation Agent completed successfully!\n` +
        `📋 Task: ${parsed.task_description}\n` +
        `📍 Reason: ${parsed.reason}\n` +
        `🔄 Steps completed: ${result.steps.length}\n` +
        `📝 Recent actions:\n${stepSummary}\n` +
        `🎯 Result: ${result.message}`,
      needsScreenshot: true,
    };
  } catch (error) {
    console.error("[TV Agent] Navigation delegation error:", error);
    return {
      observation:
        `❌ Navigation delegation failed with error.\n` +
        `📋 Task: ${parsed.task_description}\n` +
        `❗ Error: ${error instanceof Error ? error.message : "Unknown error"}\n` +
        `💡 Try using direct navigation tools or request a screenshot first.`,
      needsScreenshot: true,
    };
  }
}

export const definition: TvToolDefinition = {
  name: "delegate_to_navigation",
  description:
    "Delegate navigation-related tasks to a specialized Navigation Agent. Use this when you need to: (1) navigate to home screen, (2) go back to previous screen, (3) perform directional navigation (up/down/left/right), (4) find and activate search functionality using vision AI or (5) to select user profile after launching an app. The Navigation Agent will handle the complete navigation flow and return the result.",
  inputSchema,
  execute,
};
