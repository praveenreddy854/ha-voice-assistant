/**
 * Skill Loader
 *
 * Loads device-specific and app-specific navigation skill files
 * based on the current Home Assistant device states.
 *
 * Directory layout:
 *   skills/
 *   ├── common.md                 ← always loaded
 *   ├── appletv/
 *   │   ├── general.md            ← loaded when an Apple TV entity is present
 *   │   └── youtube.md            ← loaded when YouTube is the active app
 *   └── samsung_tv/
 *       ├── general.md
 *       └── youtube.md
 */

import fs from "fs";
import path from "path";
import { HassState } from "../../../types/ha";

const SKILLS_DIR = path.join(__dirname);

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

function readSkillFile(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf-8").trim();
    }
  } catch {
    // Graceful fallback — missing files are not errors
  }
  return null;
}

/**
 * Extract the device folder name from an entity_id.
 * e.g. "media_player.appletv" → "appletv"
 *      "remote.samsung_tv"    → "samsung_tv"
 */
function deviceFolderFromEntity(entityId: string): string {
  const parts = entityId.split(".");
  return parts[parts.length - 1];
}

/**
 * Detect the active app from a device's attributes.
 * Checks common attribute keys that different HA integrations use.
 */
function detectActiveApp(attributes: Record<string, any>): string | undefined {
  const raw =
    attributes.app_name ??
    attributes.app_id ??
    attributes.source ??
    "";
  if (!raw) return undefined;
  return normalizeAppName(String(raw));
}

/**
 * Load all relevant navigation skills for the given device states.
 * Returns a single string ready to inject into the agent's initial message,
 * or an empty string if no skills matched.
 */
export function loadSkillsForDevices(deviceStates: HassState[]): string {
  const sections: string[] = [];

  // 1. Always load common tips
  const common = readSkillFile(path.join(SKILLS_DIR, "common.md"));
  if (common) {
    sections.push(common);
  }

  // Group entities by device folder so we check ALL entities for active apps,
  // not just the first one (e.g., remote.appletv has no app_name, but
  // media_player.appletv does — we must check both).
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

    // 2. Load device-general skills
    const general = readSkillFile(path.join(deviceDir, "general.md"));
    if (general) {
      sections.push(general);
    }

    // 3. Load app-specific skills — check ALL entities for this device
    //    (media_player has app_name/app_id; remote/binary_sensor do not)
    const loadedApps = new Set<string>();
    for (const state of states) {
      const app = detectActiveApp(state.attributes ?? {});
      if (app && !loadedApps.has(app)) {
        loadedApps.add(app);
        const appSkill = readSkillFile(path.join(deviceDir, `${app}.md`));
        if (appSkill) {
          sections.push(appSkill);
        }
      }
    }
  }

  if (sections.length === 0) return "";

  return `## Navigation Skills & Tips\n\n${sections.join("\n\n---\n\n")}`;
}
