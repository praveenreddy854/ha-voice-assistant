import cron from "node-cron";
import {
  HOME_ASSISTANT_NOTIFY_SERVICE,
  HOME_CHECKS_CRON,
  HOME_CHECKS_ENABLED,
  LAUNDRY_ALERT_MINUTES,
  LAUNDRY_SWITCH_ENTITY_ID,
  VACUUM_CLEANER_ENTITY_ID,
} from "../config";
import { HassState } from "../types/ha";
import { HomeAssistantService } from "./homeAssistantService";
import { SpanKind, addStoryEvent, withSpan } from "../tracing";

interface HomeCheckIssue {
  type: "vacuum_not_docked" | "laundry_running";
  entityId: string;
  message: string;
  state: string;
}

export interface HomeCheckResult {
  ranAt: string;
  reason: string;
  issues: HomeCheckIssue[];
  notificationSent: boolean;
  notificationMessage?: string;
}

export class HomeChecksService {
  private readonly homeAssistantService: HomeAssistantService;
  private started: boolean;
  private lastResult: HomeCheckResult | null;

  constructor(homeAssistantService: HomeAssistantService) {
    this.homeAssistantService = homeAssistantService;
    this.started = false;
    this.lastResult = null;
  }

  public start(): void {
    if (this.started) {
      return;
    }

    this.started = true;

    if (!HOME_CHECKS_ENABLED) {
      console.info("Home checks scheduler is disabled via HOME_CHECKS_ENABLED=false");
      return;
    }

    cron.schedule(HOME_CHECKS_CRON, () => {
      void this.runChecks("scheduled");
    });

    console.info(`Home checks scheduler started with cron '${HOME_CHECKS_CRON}'`);
  }

  public getStatus(): {
    enabled: boolean;
    started: boolean;
    cron: string;
    notifyService: string;
    lastResult: HomeCheckResult | null;
  } {
    return {
      enabled: HOME_CHECKS_ENABLED,
      started: this.started,
      cron: HOME_CHECKS_CRON,
      notifyService: HOME_ASSISTANT_NOTIFY_SERVICE,
      lastResult: this.lastResult,
    };
  }

  public async runChecks(reason: string = "manual"): Promise<HomeCheckResult> {
    return withSpan(
      "home_checks.run",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "home_checks.reason": reason,
        },
      },
      async (span) => {
        const ranAt = new Date().toISOString();
        const issues: HomeCheckIssue[] = [];

        const vacuumIssue = await this.checkVacuum();
        if (vacuumIssue) {
          issues.push(vacuumIssue);
        }

        const laundryIssue = await this.checkLaundry();
        if (laundryIssue) {
          issues.push(laundryIssue);
        }

        const notificationMessage = issues.map((issue) => issue.message).join(" ");
        let notificationSent = false;

        if (notificationMessage) {
          notificationSent = await this.sendNotification(notificationMessage);
          global.pendingAnnouncement = notificationMessage;
        }

        addStoryEvent(span, "home_checks.evaluated", {
          "home_checks.issue_count": issues.length,
          "home_checks.notification_sent": notificationSent,
        });

        const result: HomeCheckResult = {
          ranAt,
          reason,
          issues,
          notificationSent,
          notificationMessage: notificationMessage || undefined,
        };

        this.lastResult = result;
        return result;
      }
    );
  }

  private async checkVacuum(): Promise<HomeCheckIssue | null> {
    if (!VACUUM_CLEANER_ENTITY_ID) {
      return null;
    }

    try {
      const state = await this.homeAssistantService.fetchEntityState(
        VACUUM_CLEANER_ENTITY_ID
      );

      if (this.isVacuumDocked(state)) {
        return null;
      }

      return {
        type: "vacuum_not_docked",
        entityId: state.entity_id,
        state: state.state,
        message:
          "Daily check: The robot vacuum is not docked. It may be stuck and needs attention.",
      };
    } catch (error) {
      console.error("Failed to run vacuum daily check:", error);
      return null;
    }
  }

  private async checkLaundry(): Promise<HomeCheckIssue | null> {
    if (!LAUNDRY_SWITCH_ENTITY_ID) {
      return null;
    }

    try {
      const state = await this.homeAssistantService.fetchEntityState(
        LAUNDRY_SWITCH_ENTITY_ID
      );

      if (state.state !== "on") {
        return null;
      }

      const runningMinutes = this.getRunningMinutes(state.last_changed);
      if (runningMinutes < LAUNDRY_ALERT_MINUTES) {
        return null;
      }

      return {
        type: "laundry_running",
        entityId: state.entity_id,
        state: state.state,
        message: `Daily check: Laundry has been on for about ${Math.round(
          runningMinutes
        )} minutes. Please check the laundry.`,
      };
    } catch (error) {
      console.error("Failed to run laundry daily check:", error);
      return null;
    }
  }

  private async sendNotification(message: string): Promise<boolean> {
    try {
      await this.homeAssistantService.callService(HOME_ASSISTANT_NOTIFY_SERVICE, {
        title: "Home Assistant Daily Checks",
        message,
      });

      return true;
    } catch (error) {
      console.error("Failed to send Home Assistant notification:", error);
      return false;
    }
  }

  private isVacuumDocked(state: HassState): boolean {
    const rawState = state.state.toLowerCase();
    if (rawState === "docked" || rawState === "charging") {
      return true;
    }

    const statusValue = String(state.attributes?.status || "").toLowerCase();
    return statusValue.includes("charging") || statusValue.includes("dock");
  }

  private getRunningMinutes(lastChanged?: string): number {
    if (!lastChanged) {
      return Number.MAX_SAFE_INTEGER;
    }

    const startedAt = new Date(lastChanged).getTime();
    if (!Number.isFinite(startedAt)) {
      return Number.MAX_SAFE_INTEGER;
    }

    return Math.max(0, (Date.now() - startedAt) / 60_000);
  }
}

export const createHomeChecksService = (
  homeAssistantService: HomeAssistantService
): HomeChecksService => {
  return new HomeChecksService(homeAssistantService);
};
