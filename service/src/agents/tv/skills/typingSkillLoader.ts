/**
 * Typing Skill Loader
 *
 * Loads device-specific typing skill files (keyboard layout, word-by-word validation).
 * These are separate from navigation skills and are injected into the typing agent's context.
 */

import fs from "fs";
import path from "path";
import { HassState } from "../../../types/ha";

const SKILLS_DIR = path.join(__dirname);

/**
 * Extract the device folder name from an entity_id.
 * e.g. "media_player.appletv" → "appletv"
 */
function deviceFolderFromEntity(entityId: string): string {
  const parts = entityId.split(".");
  return parts[parts.length - 1];
}

function readSkillFile(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8").trim();
    }
  } catch {
    // Graceful fallback
  }
  return null;
}

/**
 * Load typing-specific skill files for the given device states.
 * Looks for `typing.md` in each device's skill folder.
 */
export function loadTypingSkills(deviceStates: HassState[]): string {
  const sections: string[] = [];
  const seenFolders = new Set<string>();

  for (const state of deviceStates) {
    const folder = deviceFolderFromEntity(state.entity_id);
    if (seenFolders.has(folder)) continue;
    seenFolders.add(folder);

    const typingSkill = readSkillFile(path.join(SKILLS_DIR, folder, "typing.md"));
    if (typingSkill) {
      sections.push(typingSkill);
    }
  }

  if (sections.length === 0) return "";
  return `## Typing Skills\n\n${sections.join("\n\n---\n\n")}`;
}
