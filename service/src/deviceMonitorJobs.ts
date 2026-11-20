import cron from "node-cron";
import { z } from "zod";
import { isValidTimezone, type CronJobScheduler } from "./cronJobs";
import type { HassState } from "./types/ha";

const conditionSchema = z.strictObject({
  field: z.string().regex(/^(state|attributes\.[a-zA-Z0-9_]+)$/),
  operator: z.enum(["equals", "notEquals"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

const jobsSchema = z.array(z.strictObject({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  enabled: z.boolean().default(true),
  cron: z.string().trim().refine(value => cron.validate(value), "Invalid cron expression"),
  timezone: z.string().refine(isValidTimezone, "Invalid timezone").optional(),
  entityId: z.string().regex(/^[a-z_]+\.[a-zA-Z0-9_]+$/),
  conditions: z.array(conditionSchema).min(1),
  minStateDurationSeconds: z.number().int().nonnegative().default(0),
  announcement: z.string().trim().min(1),
  announcementPolicy: z.enum(["oncePerState", "everyMatch"]).default("oncePerState"),
})).superRefine((jobs, context) => {
  const ids = new Set<string>();
  jobs.forEach((job, index) => {
    if (ids.has(job.id)) context.addIssue({ code: "custom", path: [index, "id"], message: "Duplicate job ID" });
    ids.add(job.id);
  });
});

export type DeviceMonitorJob = z.infer<typeof jobsSchema>[number];

export function parseDeviceMonitorJobs(input: unknown): DeviceMonitorJob[] {
  return jobsSchema.parse(input);
}

/** Startup diagnostics identify invalid fields without exposing device/config values. */
export function describeDeviceMonitorConfigError(error: unknown): Record<string, unknown> {
  if (error instanceof z.ZodError) {
    const fields = new Set(["id", "enabled", "cron", "timezone", "entityId", "conditions",
      "field", "operator", "value", "minStateDurationSeconds", "announcement", "announcementPolicy"]);
    return { type: "ZodError", issues: error.issues.slice(0, 20).map(issue => ({
      code: issue.code,
      path: issue.path.map(part => typeof part === "number" ? part : fields.has(String(part)) ? part : "[redacted]"),
    })) };
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "number" && Number.isInteger(code) && code >= 400 && code <= 599) {
    return { type: "Error", statusCode: code };
  }
  return { type: error instanceof Error ? "Error" : "UnknownError" };
}

interface MonitorDependencies {
  readState(entityId: string, signal: AbortSignal): Promise<HassState>;
  announce(message: string): void;
  now?: () => number;
}

export function registerDeviceMonitorJobs(
  jobs: DeviceMonitorJob[],
  scheduler: Pick<CronJobScheduler, "register">,
  dependencies: MonitorDependencies
): void {
  const now = dependencies.now ?? Date.now;
  for (const job of jobs) {
    if (!job.enabled) continue;
    let announcedEpisode: string | undefined;
    scheduler.register({
      id: `device-monitor:${job.id}`,
      expression: job.cron,
      timezone: job.timezone,
      run: async (signal) => {
        const state = await dependencies.readState(job.entityId, AbortSignal.any([
          signal, AbortSignal.timeout(10_000),
        ]));
        if (signal.aborted) return;
        if (state.entity_id !== job.entityId || ["unknown", "unavailable"].includes(state.state)) return;
        const matches = job.conditions.every(condition => {
          const attribute = condition.field.slice("attributes.".length);
          const value: unknown = condition.field === "state"
            ? state.state
            : state.attributes && Object.prototype.hasOwnProperty.call(state.attributes, attribute)
              ? state.attributes[attribute]
              : undefined;
          // Missing attributes never satisfy a condition, including notEquals.
          if (value === undefined || value === null) return false;
          return condition.operator === "equals" ? value === condition.value : value !== condition.value;
        });
        if (!matches) return;
        if (job.minStateDurationSeconds > 0) {
          const changedAt = Date.parse(state.last_changed ?? "");
          if (!Number.isFinite(changedAt) || now() - changedAt < job.minStateDurationSeconds * 1000) return;
        }
        const episode = `${state.state}:${state.last_changed ?? ""}`;
        if (job.announcementPolicy === "oncePerState" && announcedEpisode === episode) return;
        dependencies.announce(job.announcement);
        announcedEpisode = episode;
      },
    });
  }
}
