/**
 * Skill Registry
 *
 * Discovers device/app-specific skill files, provides summaries for the
 * initial message, and loads full skill content on demand.
 *
 * This replaces the old pattern of loading ALL skill content upfront.
 * Instead, the agent sees a summary of available skills and can load
 * full content via the `load_skill` tool when it needs detailed guidance.
 */

import fs from "fs";
import path from "path";
import { HassState } from "../../../types/ha";

const SKILLS_DIR = path.join(__dirname);

export interface SkillSummary {
  key: string;
  name: string;
  description: string;
}

/** Known app name mappings: HA attribute value → skill file name (without .md) */
const APP_NAME_MAP: Record<string, string> = {
  youtube: "youtube",
  "com.google.ios.youtube": "youtube",
  "com.google.android.youtube.tv": "youtube",
  netflix: "netflix",
  "com.netflix.netflix": "netflix",
  spotify: "spotify",
  "com.spotify.client": "spotify",
};

function normalizeAppName(raw: string): string | undefined {
  const lower = raw.toLowerCase().trim();
  return APP_NAME_MAP[lower] ?? (lower || undefined);
}

function deviceFolderFromEntity(entityId: string): string {
  return entityId.split(".").pop()!;
}

function detectActiveApp(
  attributes: Record<string, unknown>
): string | undefined {
  const raw =
    (attributes.app_name as string) ??
    (attributes.app_id as string) ??
    (attributes.source as string) ??
    "";
  if (!raw) return undefined;
  return normalizeAppName(String(raw));
}

function readFile(filePath: string): string | null {
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
 * Parse a skill file's `# Title` and collect `##` sub-headings
 * to build a brief description of what the skill covers.
 */
function parseSkillMeta(content: string): { name: string; description: string } {
  const lines = content.split("\n");
  let name = "";
  const sections: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!name && trimmed.startsWith("# ") && !trimmed.startsWith("## ")) {
      name = trimmed.slice(2).trim();
    } else if (trimmed.startsWith("## ") && !trimmed.startsWith("### ")) {
      sections.push(trimmed.slice(3).trim());
    }
  }

  const maxSections = 5;
  const description =
    sections.length > 0
      ? `Covers: ${sections.slice(0, maxSections).join(", ")}${sections.length > maxSections ? ", ..." : ""}`
      : "";

  return { name: name || "Untitled", description };
}

/**
 * Discover available skills for the given device states.
 * Returns summaries (name + description) without loading full content.
 */
export function getAvailableSkills(deviceStates: HassState[]): SkillSummary[] {
  const skills: SkillSummary[] = [];

  // Always-available common skills
  const common = readFile(path.join(SKILLS_DIR, "common.md"));
  if (common) {
    const meta = parseSkillMeta(common);
    skills.push({ key: "common", ...meta });
  }

  // Group entities by device folder
  const deviceGroups = new Map<string, HassState[]>();
  for (const state of deviceStates) {
    const folder = deviceFolderFromEntity(state.entity_id);
    if (!deviceGroups.has(folder)) {
      deviceGroups.set(folder, []);
    }
    deviceGroups.get(folder)!.push(state);
  }

  for (const [folder, states] of deviceGroups) {
    const deviceDir = path.join(SKILLS_DIR, folder);
    if (!fs.existsSync(deviceDir)) continue;

    // Device-general skill
    const general = readFile(path.join(deviceDir, "general.md"));
    if (general) {
      const meta = parseSkillMeta(general);
      skills.push({ key: `${folder}/general`, ...meta });
    }

    // Typing skill
    const typing = readFile(path.join(deviceDir, "typing.md"));
    if (typing) {
      const meta = parseSkillMeta(typing);
      skills.push({ key: `${folder}/typing`, ...meta });
    }

    // App-specific skills
    const loadedApps = new Set<string>();
    for (const state of states) {
      const app = detectActiveApp(state.attributes ?? {});
      if (app && !loadedApps.has(app)) {
        loadedApps.add(app);
        const appSkill = readFile(path.join(deviceDir, `${app}.md`));
        if (appSkill) {
          const meta = parseSkillMeta(appSkill);
          skills.push({ key: `${folder}/${app}`, ...meta });
        }
      }
    }
  }

  return skills;
}

/**
 * Load the full content of a skill by its key.
 * Keys map to file paths: "common" → common.md, "appletv/typing" → appletv/typing.md
 */
export function loadSkillContent(key: string): string | null {
  // Sanitize: only allow alphanumeric, hyphens, underscores, and forward slashes
  if (!/^[\w\-/]+$/.test(key)) return null;
  const filePath = path.join(SKILLS_DIR, `${key}.md`);
  // Ensure resolved path stays within SKILLS_DIR (prevent path traversal)
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(SKILLS_DIR))) return null;
  return readFile(resolved);
}

/**
 * Format skill summaries for injection into the agent's initial message.
 */
export function formatSkillSummaries(skills: SkillSummary[]): string {
  if (skills.length === 0) return "";

  let msg = "## Available Skills\n\n";
  msg +=
    "Load a skill's full instructions using `load_skill` tool when you need detailed guidance.\n\n";

  for (const skill of skills) {
    msg += `- **${skill.name}** (key: \`${skill.key}\`): ${skill.description}\n`;
  }

  return msg;
}
