import { randomUUID } from "crypto";
import path from "path";
import { openAIService } from "../aiService";
import { ChatMessage } from "./homeAssistantService";
import { PromptTemplateService } from "./promptTemplateService";
import { SpanKind, addStoryEvent, withSpan } from "../tracing";

export type ReminderCategory =
  | "general"
  | "medication"
  | "meeting"
  | "task"
  | "appointment"
  | "birthday"
  | "bill"
  | "exercise"
  | "meal";

export interface ReminderCreateRequest {
  action: "CREATE";
  title: string;
  description?: string;
  dueDate: string;
  category: ReminderCategory;
  priority: "low" | "medium" | "high" | "urgent";
  isRecurring: boolean;
  recurringPattern?: {
    type: "daily" | "weekly" | "monthly" | "yearly";
    interval: number;
  };
}

export interface ReminderListRequest {
  action: "LIST";
  limit?: number;
  prioritizeOverdue?: boolean;
  categoryBreakdown?: boolean;
  intelligentSuggestion?: string;
}

export interface ReminderQueryRequest {
  action: "QUERY";
  category?: ReminderCategory;
  dateFilter?: string;
  searchTerm?: string;
  intelligentSuggestion?: string;
}

export type ReminderRequest =
  | ReminderCreateRequest
  | ReminderListRequest
  | ReminderQueryRequest;

export interface ReminderEntity extends ReminderCreateRequest {
  id: string;
  status: "active" | "completed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  notificationSent: boolean;
  completedAt?: string;
}

export type ReminderProcessResponse =
  | {
      success: true;
      action: "CREATE";
      reminder: ReminderEntity;
      message: string;
    }
  | {
      success: true;
      action: "LIST";
      reminders: ReminderEntity[];
      message: string;
    }
  | {
      success: true;
      action: "QUERY";
      reminders: ReminderEntity[];
      message: string;
    };

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export class ReminderService {
  private readonly promptService: PromptTemplateService;

  constructor() {
    this.promptService = new PromptTemplateService(
      path.join(__dirname, "..", "prompts")
    );
  }

  public async parseRequest(
    userPrompt: string,
    currentReminders?: unknown[],
    messageHistory?: ChatMessage[]
  ): Promise<ReminderRequest> {
    return withSpan(
      "reminder.parse_request",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "reminder.user_prompt.length": userPrompt.length,
          "reminder.history.count": messageHistory?.length || 0,
          "reminder.current.count": currentReminders?.length || 0,
        },
      },
      async (span) => {
        const template = this.promptService.load("REMINDER.md");
        const remindersContext = currentReminders
          ? JSON.stringify(currentReminders, null, 2)
          : "No current reminders available";

        const prompt = template
          .replace("{{{UserPrompt}}}", userPrompt)
          .replace("{{{CurrentDateTime}}}", new Date().toISOString())
          .replace("{{{CurrentReminders}}}", remindersContext);

        addStoryEvent(span, "reminder.prompt.built", {
          "reminder.prompt.length": prompt.length,
        });

        const messages: ChatMessage[] = [
          ...(messageHistory || []),
          { role: "user", content: prompt },
        ];

        const parsed = await openAIService.createReminderCompletion<ReminderRequest>(
          messages
        );
        addStoryEvent(span, "reminder.request.parsed", {
          "reminder.action": parsed.action,
        });
        return parsed;
      }
    );
  }

  public async processPrompt(
    userPrompt: string,
    currentReminders: unknown[],
    messageHistory?: ChatMessage[]
  ): Promise<ReminderProcessResponse> {
    return withSpan(
      "reminder.process_prompt",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "reminder.user_prompt.length": userPrompt.length,
          "reminder.current.count": currentReminders.length,
        },
      },
      async (span) => {
        const request = await this.parseRequest(
          userPrompt,
          currentReminders,
          messageHistory
        );

        const normalizedReminders = this.normalizeReminders(currentReminders);
        addStoryEvent(span, "reminder.reminders.normalized", {
          "reminder.normalized.count": normalizedReminders.length,
          "reminder.action": request.action,
        });

        if (request.action === "CREATE") {
          const reminder = this.buildReminder(request);
          addStoryEvent(span, "reminder.created", {
            "reminder.created.id": reminder.id,
            "reminder.created.category": reminder.category,
          });
          return {
            success: true,
            action: "CREATE",
            reminder,
            message: `Reminder created: ${reminder.title} at ${new Date(
              reminder.dueDate
            ).toLocaleString()}`,
          };
        }

        if (request.action === "LIST") {
          const reminders = this.listReminders(normalizedReminders, request);
          addStoryEvent(span, "reminder.listed", {
            "reminder.list.count": reminders.length,
          });
          return {
            success: true,
            action: "LIST",
            reminders,
            message: this.formatListMessage(reminders, request),
          };
        }

        const reminders = this.queryReminders(normalizedReminders, request);
        addStoryEvent(span, "reminder.queried", {
          "reminder.query.count": reminders.length,
        });
        return {
          success: true,
          action: "QUERY",
          reminders,
          message: this.formatQueryMessage(reminders, request),
        };
      }
    );
  }

  private buildReminder(request: ReminderCreateRequest): ReminderEntity {
    const now = new Date().toISOString();

    return {
      id: randomUUID(),
      action: "CREATE",
      title: request.title,
      description: request.description,
      dueDate: request.dueDate,
      category: request.category,
      priority: request.priority,
      isRecurring: request.isRecurring,
      recurringPattern: request.recurringPattern,
      status: "active",
      createdAt: now,
      updatedAt: now,
      notificationSent: false,
    };
  }

  private normalizeReminders(reminders: unknown[]): ReminderEntity[] {
    return reminders
      .filter((value): value is Record<string, unknown> => {
        return Boolean(value && typeof value === "object");
      })
      .map((value) => {
        const dueDate =
          typeof value.dueDate === "string"
            ? value.dueDate
            : new Date().toISOString();

        const createdAt =
          typeof value.createdAt === "string"
            ? value.createdAt
            : new Date().toISOString();

        const updatedAt =
          typeof value.updatedAt === "string"
            ? value.updatedAt
            : new Date().toISOString();

        const category =
          typeof value.category === "string"
            ? (value.category as ReminderCategory)
            : "general";

        const priority =
          typeof value.priority === "string" &&
          ["low", "medium", "high", "urgent"].includes(value.priority)
            ? (value.priority as ReminderEntity["priority"])
            : "medium";

        const status =
          typeof value.status === "string" &&
          ["active", "completed", "cancelled"].includes(value.status)
            ? (value.status as ReminderEntity["status"])
            : "active";

        return {
          id:
            typeof value.id === "string" && value.id.trim().length > 0
              ? value.id
              : randomUUID(),
          action: "CREATE",
          title:
            typeof value.title === "string" && value.title.trim().length > 0
              ? value.title
              : "Untitled reminder",
          description:
            typeof value.description === "string" ? value.description : undefined,
          dueDate,
          category,
          priority,
          isRecurring:
            typeof value.isRecurring === "boolean" ? value.isRecurring : false,
          recurringPattern:
            value.recurringPattern && typeof value.recurringPattern === "object"
              ? (value.recurringPattern as ReminderEntity["recurringPattern"])
              : undefined,
          status,
          createdAt,
          updatedAt,
          notificationSent:
            typeof value.notificationSent === "boolean"
              ? value.notificationSent
              : false,
          completedAt:
            typeof value.completedAt === "string" ? value.completedAt : undefined,
        };
      });
  }

  private listReminders(
    reminders: ReminderEntity[],
    request: ReminderListRequest
  ): ReminderEntity[] {
    const now = Date.now();

    const active = reminders.filter((reminder) => reminder.status === "active");

    if (request.prioritizeOverdue) {
      const overdue = active
        .filter((reminder) => this.parseDate(reminder.dueDate) < now)
        .sort((a, b) => this.parseDate(a.dueDate) - this.parseDate(b.dueDate));

      const upcoming = active
        .filter((reminder) => this.parseDate(reminder.dueDate) >= now)
        .sort((a, b) => this.compareByPriorityAndDueDate(a, b));

      const prioritized = [...overdue, ...upcoming];
      return this.applyListLimit(prioritized, request.limit);
    }

    const sorted = [...active].sort((a, b) => this.compareByPriorityAndDueDate(a, b));
    return this.applyListLimit(sorted, request.limit);
  }

  private queryReminders(
    reminders: ReminderEntity[],
    request: ReminderQueryRequest
  ): ReminderEntity[] {
    let filtered = reminders.filter((reminder) => reminder.status === "active");

    if (request.category) {
      filtered = filtered.filter((reminder) => reminder.category === request.category);
    }

    if (request.searchTerm && request.searchTerm.trim().length > 0) {
      const term = request.searchTerm.trim().toLowerCase();
      filtered = filtered.filter((reminder) => {
        const title = reminder.title.toLowerCase();
        const description = (reminder.description || "").toLowerCase();
        return title.includes(term) || description.includes(term);
      });
    }

    if (request.dateFilter) {
      const now = new Date();
      const todayKey = now.toDateString();
      const tomorrow = new Date(now);
      tomorrow.setDate(now.getDate() + 1);
      const tomorrowKey = tomorrow.toDateString();

      const dateFilter = request.dateFilter.trim().toLowerCase();

      if (dateFilter === "today") {
        filtered = filtered.filter(
          (reminder) => new Date(reminder.dueDate).toDateString() === todayKey
        );
      } else if (dateFilter === "tomorrow") {
        filtered = filtered.filter(
          (reminder) => new Date(reminder.dueDate).toDateString() === tomorrowKey
        );
      }
    }

    return filtered.sort((a, b) => this.compareByPriorityAndDueDate(a, b));
  }

  private formatListMessage(
    reminders: ReminderEntity[],
    request: ReminderListRequest
  ): string {
    if (request.intelligentSuggestion && request.intelligentSuggestion.trim()) {
      return this.withReminderItems(request.intelligentSuggestion, reminders);
    }

    if (reminders.length === 0) {
      return "You have no active reminders.";
    }

    const countText = request.limit
      ? `top ${Math.min(request.limit, reminders.length)}`
      : "all";

    return this.withReminderItems(
      `Here are your ${countText} reminders:`,
      reminders,
      false
    );
  }

  private formatQueryMessage(
    reminders: ReminderEntity[],
    request: ReminderQueryRequest
  ): string {
    if (request.intelligentSuggestion && request.intelligentSuggestion.trim()) {
      return this.withReminderItems(request.intelligentSuggestion, reminders);
    }

    if (reminders.length === 0) {
      if (request.category) {
        return `You have no ${request.category} reminders.`;
      }
      if (request.dateFilter) {
        return `You have no reminders for ${request.dateFilter}.`;
      }
      return "No reminders found matching your criteria.";
    }

    if (request.category) {
      return this.withReminderItems(
        `You have ${reminders.length} ${request.category} reminder${
          reminders.length > 1 ? "s" : ""
        }:`,
        reminders,
        false
      );
    }

    return this.withReminderItems(
      `Found ${reminders.length} reminder${reminders.length > 1 ? "s" : ""}:`,
      reminders,
      false
    );
  }

  private withReminderItems(
    prefix: string,
    reminders: ReminderEntity[],
    includeOverdueTag: boolean = true
  ): string {
    if (reminders.length === 0) {
      return prefix;
    }

    const now = Date.now();
    const fragments = reminders.map((reminder, index) => {
      const due = new Date(reminder.dueDate);
      const dueLabel = this.formatDueLabel(due);
      const overdueTag =
        includeOverdueTag && due.getTime() < now ? " (OVERDUE)" : "";
      return `${index + 1}. ${reminder.title} - ${dueLabel}${overdueTag}.`;
    });

    return `${prefix} ${fragments.join(" ")}`.trim();
  }

  private formatDueLabel(dueDate: Date): string {
    return `${dueDate.toLocaleDateString()} at ${dueDate.toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  }

  private compareByPriorityAndDueDate(
    a: ReminderEntity,
    b: ReminderEntity
  ): number {
    const priorityDelta =
      (PRIORITY_ORDER[a.priority] ?? PRIORITY_ORDER.medium) -
      (PRIORITY_ORDER[b.priority] ?? PRIORITY_ORDER.medium);

    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    return this.parseDate(a.dueDate) - this.parseDate(b.dueDate);
  }

  private parseDate(value: string): number {
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
  }

  private applyListLimit(
    reminders: ReminderEntity[],
    limit?: number
  ): ReminderEntity[] {
    if (!limit || limit <= 0) {
      return reminders;
    }

    return reminders.slice(0, limit);
  }
}

export const reminderService = new ReminderService();
