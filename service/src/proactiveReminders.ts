import cron from "node-cron";
import {
  AI_MODEL_MINI,
  PROACTIVE_REMINDERS_CRON,
  PROACTIVE_REMINDERS_ENABLED,
  PROACTIVE_REMINDER_ON_MINUTES,
} from "./config";
import {
  DeviceStateRecord,
  isCosmosConfigured,
  queryRecentDeviceStates,
} from "./cosmos";
import { emitAnnouncement } from "./announcementBus";
import { generateCompletion } from "./ai";

let started = false;

interface Situation {
  entityId: string;
  friendlyName: string;
  type: string;
  onSinceIso: string;
  minutesOn: number;
}

interface ReminderRule {
  type: string;
  matches: (record: DeviceStateRecord) => boolean;
  describe: (situation: Situation) => string;
}

const OPEN_DEVICE_CLASSES = new Set([
  "door",
  "window",
  "garage_door",
  "opening",
]);

const IGNORED_ENTITY_CATEGORIES = new Set(["diagnostic", "config"]);
const IGNORED_DEVICE_CLASSES = new Set([
  "motion",
  "occupancy",
  "presence",
  "connectivity",
  "battery",
  "power",
  "signal_strength",
  "timestamp",
  "update",
]);

const IGNORED_ENTITY_PATTERNS = [
  /\bdo[\s_-]*not[\s_-]*disturb\b/i,
  /\bdnd\b/i,
  /\bdock[\s_-]*status[\s_-]*(?:led|light)\b/i,
  /\bstatus[\s_-]*(?:led|light)\b/i,
  /\b(?:led|light)[\s_-]*status\b/i,
  /\bindicator[\s_-]*(?:led|light)\b/i,
  /\b(?:led|light)[\s_-]*indicator\b/i,
  /\bmotion[\s_-]*sensor\b/i,
  /\bmotion[\s_-]*detection\b/i,
  /\boccupancy[\s_-]*sensor\b/i,
  /\bpresence[\s_-]*sensor\b/i,
];

const RULES: ReminderRule[] = [
  {
    type: "left-on",
    matches: (r) =>
      ["light", "switch", "fan"].includes(r.domain) && r.state === "on",
    describe: (s) =>
      `${s.friendlyName} has been on for ${formatDuration(s.minutesOn)}`,
  },
  {
    type: "left-open",
    matches: (r) =>
      r.domain === "binary_sensor" &&
      r.state === "on" &&
      OPEN_DEVICE_CLASSES.has(String(r.attributes?.device_class ?? "")),
    describe: (s) =>
      `${s.friendlyName} has been open for ${formatDuration(s.minutesOn)}`,
  },
];

const ruleByType = new Map(RULES.map((rule) => [rule.type, rule] as const));

// In-memory record of on-episodes we have already evaluated, so a persistent
// situation is mentioned at most once. The key embeds the on-since timestamp,
// so turning a device off and on again produces a fresh, re-triggerable key.
const handledEpisodes = new Set<string>();

const episodeKey = (s: Situation): string =>
  `${s.entityId}|${s.type}|${s.onSinceIso}`;

function pruneEpisodes(): void {
  if (handledEpisodes.size > 1000) handledEpisodes.clear();
}

function minutesSince(iso: string | undefined, now: number): number {
  if (!iso) return 0;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.floor((now - t) / 60000);
}

function formatDuration(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins} minute${mins === 1 ? "" : "s"}`;
  if (mins === 0) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${hours} hour${hours === 1 ? "" : "s"} ${mins} minute${
    mins === 1 ? "" : "s"
  }`;
}

function normalizedAttribute(record: DeviceStateRecord, name: string): string {
  const value = record.attributes?.[name];
  return typeof value === "string" ? value.toLowerCase() : "";
}

function entitySearchText(record: DeviceStateRecord): string {
  return [
    record.entityId,
    record.friendlyName,
    normalizedAttribute(record, "device_class"),
    normalizedAttribute(record, "entity_category"),
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/[_-]+/g, " ");
}

function isIgnoredForProactiveReminder(record: DeviceStateRecord): boolean {
  const entityCategory = normalizedAttribute(record, "entity_category");
  if (IGNORED_ENTITY_CATEGORIES.has(entityCategory)) {
    return true;
  }

  const deviceClass = normalizedAttribute(record, "device_class");
  if (IGNORED_DEVICE_CLASSES.has(deviceClass)) {
    return true;
  }

  const text = entitySearchText(record);
  if (IGNORED_ENTITY_PATTERNS.some((pattern) => pattern.test(text))) {
    return true;
  }

  if (
    /\bled\b/i.test(text) &&
    !/\b(strip|lamp|bulb|ceiling|table|floor)\b/i.test(text)
  ) {
    return true;
  }

  if (record.domain === "switch" && /\bmotion\b/i.test(text)) {
    return true;
  }

  return false;
}

function latestPerEntity(records: DeviceStateRecord[]): DeviceStateRecord[] {
  const latest = new Map<string, DeviceStateRecord>();
  for (const record of records) {
    const existing = latest.get(record.entityId);
    if (!existing || record.capturedAt > existing.capturedAt) {
      latest.set(record.entityId, record);
    }
  }
  return [...latest.values()];
}

function detectSituations(
  records: DeviceStateRecord[],
  now: number
): Situation[] {
  const situations: Situation[] = [];

  for (const record of latestPerEntity(records)) {
    if (isIgnoredForProactiveReminder(record)) continue;

    const onSinceIso =
      record.lastChanged ?? record.lastUpdated ?? record.capturedAt;
    const minutesOn = minutesSince(onSinceIso, now);
    if (minutesOn < PROACTIVE_REMINDER_ON_MINUTES) continue;

    const rule = RULES.find((r) => r.matches(record));
    if (!rule) continue;

    situations.push({
      entityId: record.entityId,
      friendlyName: record.friendlyName ?? record.entityId,
      type: rule.type,
      onSinceIso,
      minutesOn,
    });
  }

  return situations;
}

async function buildReminderMessage(situations: Situation[]): Promise<string> {
  const lines = situations.map((s) => {
    const rule = ruleByType.get(s.type);
    return rule ? rule.describe(s) : `${s.friendlyName} (${s.type})`;
  });
  const fallback = `Reminder: ${lines.join("; ")}.`;

  if (!AI_MODEL_MINI) return fallback;

  try {
    const text = await generateCompletion({
      model: AI_MODEL_MINI,
      temperature: 0.4,
      maxTokens: 120,
      messages: [
        {
          role: "system",
          content:
            "You write a single short, friendly spoken reminder for a smart-home voice assistant. " +
            "Combine the noted situations into one natural sentence (two at most). Be concise and conversational, " +
            "do not include timestamps or markdown, and only mention what is given. " +
            "Be generous about not bothering the user: ignore status LEDs, indicator lights, motion or occupancy sensors, " +
            "do-not-disturb modes, diagnostic/config entities, and anything that sounds intentionally always on. " +
            "If none of the situations are worth bothering the user about, reply with exactly NONE.",
        },
        {
          role: "user",
          content: `Current situations:\n- ${lines.join("\n- ")}`,
        },
      ],
    });

    const trimmed = text.trim();
    if (!trimmed || trimmed.toUpperCase() === "NONE") return "";
    return trimmed;
  } catch (error) {
    console.error(
      "[ProactiveReminders] AI summary failed, using fallback message",
      error
    );
    return fallback;
  }
}

async function runReminderCheck(): Promise<void> {
  try {
    const now = Date.now();
    const windowMinutes = Math.max(PROACTIVE_REMINDER_ON_MINUTES * 2, 360);
    const sinceIso = new Date(now - windowMinutes * 60000).toISOString();

    const records = await queryRecentDeviceStates(sinceIso);
    if (records.length === 0) return;

    const situations = detectSituations(records, now).filter(
      (s) => !handledEpisodes.has(episodeKey(s))
    );
    if (situations.length === 0) return;

    // Mark each on-episode as handled up front so we evaluate (and bill the AI
    // for) it at most once; a fresh turn-on changes the key and re-triggers.
    for (const s of situations) handledEpisodes.add(episodeKey(s));
    pruneEpisodes();

    const message = await buildReminderMessage(situations);
    if (!message) return;

    emitAnnouncement(message);
    console.info(
      `[ProactiveReminders] Emitted reminder for ${situations.length} situation(s): ${message}`
    );
  } catch (error) {
    console.error("[ProactiveReminders] Reminder check failed", error);
  }
}

export function startProactiveReminders(): void {
  if (started) return;
  started = true;

  if (!PROACTIVE_REMINDERS_ENABLED) {
    console.info(
      "[ProactiveReminders] Disabled via PROACTIVE_REMINDERS_ENABLED; scheduler will remain idle"
    );
    return;
  }

  if (!isCosmosConfigured()) {
    console.warn(
      "[ProactiveReminders] Azure Cosmos DB is not configured; proactive reminders will remain idle"
    );
    return;
  }

  cron.schedule(PROACTIVE_REMINDERS_CRON, () => {
    void runReminderCheck();
  });

  console.info(
    `[ProactiveReminders] Started (cron '${PROACTIVE_REMINDERS_CRON}', threshold ${PROACTIVE_REMINDER_ON_MINUTES}m)`
  );
}
