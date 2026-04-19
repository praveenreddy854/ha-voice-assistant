import { z } from "zod";
import { TvToolDefinition, ToolExecutionContext, ToolExecutionResult } from "./types";
import { loadSkillContent } from "../skills/skillRegistry";

export const inputSchema = z.object({
  skill_key: z.string().describe(
    "The key of the skill to load (e.g., 'common', 'appletv/general', 'appletv/typing', 'appletv/youtube'). Available keys are listed in the initial message."
  ),
  reason: z.string().describe(
    "Why you need this skill (e.g., 'need keyboard layout before typing', 'need YouTube navigation steps')."
  ),
});

export type LoadSkillInput = z.infer<typeof inputSchema>;

async function execute(
  args: LoadSkillInput,
  _context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const parsed = inputSchema.parse(args);
  const content = loadSkillContent(parsed.skill_key);

  if (!content) {
    return {
      observation: `❌ Skill "${parsed.skill_key}" not found. Check the available skill keys listed in the initial message.`,
      needsScreenshot: false,
      toolSuccess: false,
    };
  }

  return {
    observation: `📖 Skill loaded: ${parsed.skill_key}\n\n${content}`,
    needsScreenshot: false,
  };
}

export const definition: TvToolDefinition = {
  name: "load_skill",
  description:
    "Load full instructions for a specific skill. Use this before performing specialized tasks like typing, app-specific navigation, or when you need detailed device-specific guidance. Available skill keys are listed in the initial message.",
  inputSchema,
  execute,
};
