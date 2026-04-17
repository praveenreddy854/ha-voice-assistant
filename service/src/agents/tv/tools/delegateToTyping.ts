import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { runTypingAgent } from "../../typing";
import { getKnownDeviceStates } from "../../../ha";
import { loadSkillsForDevices } from "../skills/skillLoader";
import { loadTypingSkills } from "../skills/typingSkillLoader";

export const inputSchema = z.object({
  text_to_type: z.string().describe(
    "The text to type into the focused input field (e.g., 'Netflix', 'Breaking Bad', 'comedy movies')."
  ),
  remote_entity_id: z.string().describe(
    "Home Assistant entity ID of the remote control to use."
  ),
  media_player_entity_id: z.string().describe(
    "Home Assistant entity ID of the TV/media player."
  ),
  reason: z.string().describe(
    "Why you're delegating this text input task (e.g., 'to search for a movie')."
  ),
});

export type DelegateToTypingInput = z.infer<typeof inputSchema>;

async function execute(
  args: DelegateToTypingInput,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  console.log(`[TV Agent] Delegating to Typing Agent: "${parsed.text_to_type}"`);

  let keyboardHints = "";
  try {
    const deviceStates = await getKnownDeviceStates();
    const skills = loadSkillsForDevices(deviceStates);
    if (skills) {
      keyboardHints = skills;
    }
    // Load typing-specific skills
    const typingSkills = loadTypingSkills(deviceStates);
    if (typingSkills) {
      keyboardHints += "\n\n" + typingSkills;
    }
  } catch (error) {
    console.warn("[TV Agent] Failed to load skills for typing agent:", error);
  }

  try {
    const result = await runTypingAgent({
      userMessage: `Type the text "${parsed.text_to_type}" into the focused input field. ${parsed.reason}`,
      textToType: parsed.text_to_type,
      keyboardHints,
      resumeSessionKey: context.sessionId,
      deviceConfig: {
        remoteEntityId: parsed.remote_entity_id,
        mediaPlayerEntityId: parsed.media_player_entity_id,
      },
      screenshotBase64: context.screenshotBase64,
      screenshotContentType: context.screenshotContentType,
      maxIterations: 15,
    });

    if (!result.success) {
      const typedText = result.sessionState.typedText || "";
      return {
        observation: `❌ Typing Agent failed: ${result.message}\nTarget text: "${parsed.text_to_type}"\nTyped so far: "${typedText}"`,
        needsScreenshot: true,
      };
    }

    return {
      observation:
        `⌨️ Typing Agent completed typing "${parsed.text_to_type}" with background validation.\n` +
        `📸 You may get_latest_screenshot for final confirmation before proceeding.`,
      needsScreenshot: true,
    };
  } catch (error) {
    console.error("[TV Agent] Typing delegation error:", error);
    return {
      observation: `❌ Typing delegation failed: ${
        error instanceof Error ? error.message : "Unknown error"
      }\nTarget text: "${parsed.text_to_type}"`,
      needsScreenshot: false,
    };
  }
}

export const definition: TvToolDefinition = {
  name: "delegate_to_typing",
  description:
    "Delegate text input tasks to a specialized Typing Agent that types word-by-word with screenshot validation. Prerequisites (each in a SEPARATE prior turn): (1) delegate_to_navigation to reach search icon, (2) click_select_button to activate the search field, (3) get_latest_screenshot — then examine the returned screenshot yourself to confirm the keyboard is visible on screen. Only call this tool if you can see the keyboard in the screenshot. If the keyboard is NOT visible, press select again or navigate to the input field. The typing agent types one word at a time and pauses for a screenshot after each word to validate. When this tool returns requesting a screenshot, you MUST: (1) call get_latest_screenshot, (2) call delegate_to_typing again with the SAME text to resume the typing session.",
  inputSchema,
  execute,
};
