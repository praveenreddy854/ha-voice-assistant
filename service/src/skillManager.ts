import fs from "fs";
import path from "path";
import { HOME_ASSISTANT_SKILL_MATCHERS } from "./config";
import { HassState } from "./types/ha";

export type SkillDoc = {
  id: string;
  content: string;
};

type SkillManagerOptions = {
  cache?: Map<string, string>;
  cacheKey?: string;
};

const defaultSkillMatchers: Record<string, string[]> = {
  apple_tv: ["apple tv", "appletv"],
  samsung_tv: ["samsung"],
  android_tv: ["android tv", "androidtv", "google tv", "chromecast", "shield"],
  roborock: ["roborock"],
};

export class SkillManager {
  private readonly cache: Map<string, string>;
  private readonly cacheKey: string;

  constructor(options?: SkillManagerOptions) {
    this.cache = options?.cache ?? new Map<string, string>();
    this.cacheKey = options?.cacheKey ?? "HOMEASSISTANT_SKILLS_ALL";
  }

  public loadAllSkillDocs(): SkillDoc[] {
    if (this.cache.has(this.cacheKey)) {
      try {
        return JSON.parse(this.cache.get(this.cacheKey) || "[]") as SkillDoc[];
      } catch {
        // Fall through to reload from disk.
      }
    }

    const skillRoot = this.resolveSkillRoot();
    if (!skillRoot) {
      this.cache.set(this.cacheKey, "[]");
      return [];
    }

    const skillDocs: SkillDoc[] = [];
    const entries = fs.readdirSync(skillRoot, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillDir = path.join(skillRoot, entry.name);
      const skillFileCandidates = [
        path.join(skillDir, "skills.md"),
        path.join(skillDir, "SKILL.md"),
      ];

      const skillFile = skillFileCandidates.find((candidate) =>
        fs.existsSync(candidate)
      );
      if (!skillFile) {
        continue;
      }

      const content = fs.readFileSync(skillFile, "utf8").trim();
      if (!content) {
        continue;
      }

      skillDocs.push({ id: entry.name, content });
    }

    this.cache.set(this.cacheKey, JSON.stringify(skillDocs));
    return skillDocs;
  }

  public selectSkillDocs(
    deviceStates: HassState[],
    skillDocs: SkillDoc[] = this.loadAllSkillDocs()
  ): SkillDoc[] {
    if (skillDocs.length === 0) {
      return [];
    }

    const deviceTokens = deviceStates
      .map((state) => {
        const friendlyName = state.attributes?.friendly_name || "";
        return `${state.entity_id} ${friendlyName}`.toLowerCase();
      })
      .join(" ");

    const skillMatchers = HOME_ASSISTANT_SKILL_MATCHERS ?? defaultSkillMatchers;
    const matched = skillDocs.filter((doc) => {
      const keywords = skillMatchers[doc.id];
      if (!keywords || keywords.length === 0) {
        return false;
      }

      return keywords.some((keyword) => deviceTokens.includes(keyword));
    });

    // If no skill matched, include all skills as a fallback.
    return matched.length > 0 ? matched : skillDocs;
  }

  public buildSkillsSection(skills: SkillDoc[]): string {
    if (skills.length === 0) {
      return "";
    }

    return ["### Integration Skills", ...skills.map((skill) => skill.content)].join(
      "\n\n"
    );
  }

  public getSkillsSection(deviceStates: HassState[]): string {
    const skills = this.selectSkillDocs(deviceStates);
    return this.buildSkillsSection(skills);
  }

  private resolveSkillRoot(): string | null {
    const skillRootCandidates = [
      path.join(__dirname, "skills", "homeassistant"),
      path.join(__dirname, "..", "src", "skills", "homeassistant"),
    ];

    for (const candidate of skillRootCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }
}
