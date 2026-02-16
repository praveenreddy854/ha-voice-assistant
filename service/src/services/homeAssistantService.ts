import axios from "axios";
import path from "path";
import {
  HOME_ASSISTANT_TOKEN,
  HOME_ASSISTANT_URL,
} from "../config";
import { openAIService } from "../aiService";
import { SkillManager } from "../skillManager";
import {
  HassServiceCommand,
  HassServiceCommandBody,
  HassState,
} from "../types/ha";
import { PromptTemplateService } from "./promptTemplateService";
import {
  SpanKind,
  addStoryEvent,
  getTelemetryMetrics,
  recordSpanError,
  withSpan,
} from "../tracing";

export interface ChatMessage {
  role: string;
  content: string;
}

export type CommandExecutionMode = "sequence" | "parallel";

export interface CommandExecutionPlan {
  mode: CommandExecutionMode;
  commands: HassServiceCommand[];
}

export interface CommandExecutionResult {
  success: boolean;
  message: string;
  data?: unknown;
  errors?: string[];
  plan?: CommandExecutionPlan;
}

type RawCommandPlan =
  | HassServiceCommand
  | HassServiceCommand[]
  | {
      mode?: string;
      execution?: string;
      commands?: HassServiceCommand[];
    };

const COMMAND_DELAY_MS = 300;

export class HomeAssistantService {
  private readonly client: ReturnType<typeof axios.create>;
  private readonly promptCache: Map<string, string>;
  private readonly promptService: PromptTemplateService;
  private readonly skillManager: SkillManager;

  constructor() {
    this.client = axios.create({
      baseURL: HOME_ASSISTANT_URL,
      timeout: 30_000,
      headers: {
        "Content-Type": "application/json",
      },
    });

    this.promptCache = new Map<string, string>();
    this.promptService = new PromptTemplateService(
      path.join(__dirname, "..", "prompts"),
      this.promptCache
    );
    this.skillManager = new SkillManager({ cache: this.promptCache });
  }

  public async getHACommandBody(
    command: string,
    messageHistory?: ChatMessage[]
  ): Promise<HassServiceCommandBody> {
    const plan = await this.planCommand(command, messageHistory);
    if (plan.commands.length === 1) {
      return plan.commands[0];
    }
    return plan.commands;
  }

  public async executeNaturalLanguageCommand(
    command: string,
    messageHistory?: ChatMessage[]
  ): Promise<CommandExecutionResult> {
    return withSpan(
      "home_assistant.execute_natural_language_command",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "ha.command.length": command.length,
          "ha.message_history.count": messageHistory?.length || 0,
        },
      },
      async (span) => {
        const metrics = getTelemetryMetrics();
        metrics.workflowRunsTotal.add(1, {
          "workflow.name": "home_assistant_command",
        });

        addStoryEvent(span, "ha.command.received", {
          "ha.command.text": command,
          "ha.message_history.count": messageHistory?.length || 0,
        });

        const plan = await this.planCommand(command, messageHistory);
        addStoryEvent(span, "ha.command.plan_ready", {
          "ha.plan.mode": plan.mode,
          "ha.plan.command_count": plan.commands.length,
        });

        const result = await this.executePlan(plan, command);
        addStoryEvent(span, "ha.command.execution_completed", {
          "ha.execution.success": result.success,
          "ha.execution.error_count": result.errors?.length || 0,
        });
        return { ...result, plan };
      }
    );
  }

  public async planCommand(
    command: string,
    messageHistory?: ChatMessage[]
  ): Promise<CommandExecutionPlan> {
    return withSpan(
      "home_assistant.plan_command",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "ha.command.length": command.length,
          "ha.message_history.count": messageHistory?.length || 0,
        },
      },
      async (span) => {
        const prompt = await this.buildPrompt(command);
        addStoryEvent(span, "ha.plan.prompt_built", {
          "ha.prompt.length": prompt.length,
        });

        const messages: ChatMessage[] = [
          ...(messageHistory || []),
          { role: "user", content: prompt },
        ];

        const rawResponse = await openAIService.createHomeAssistantCompletion(
          messages
        );

        addStoryEvent(span, "ha.plan.llm_response_received", {
          "ha.plan.raw_response.length": rawResponse.length,
        });

        let parsed: RawCommandPlan;
        try {
          parsed = JSON.parse(rawResponse) as RawCommandPlan;
        } catch (error) {
          console.error("Failed to parse Home Assistant LLM JSON response:", {
            rawResponse,
            error,
          });
          recordSpanError(span, error, {
            "ha.plan.raw_response.preview": rawResponse,
          });
          throw new Error("Failed to parse Home Assistant command response");
        }

        const normalizedPlan = this.normalizePlan(parsed);
        addStoryEvent(span, "ha.plan.normalized", {
          "ha.plan.mode": normalizedPlan.mode,
          "ha.plan.command_count": normalizedPlan.commands.length,
        });
        return normalizedPlan;
      }
    );
  }

  public async executePlan(
    plan: CommandExecutionPlan,
    originalCommand: string
  ): Promise<CommandExecutionResult> {
    return withSpan(
      "home_assistant.execute_plan",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "ha.plan.mode": plan.mode,
          "ha.plan.command_count": plan.commands.length,
        },
      },
      async (span) => {
        const metrics = getTelemetryMetrics();
        addStoryEvent(span, "ha.plan.execution_started", {
          "ha.plan.mode": plan.mode,
          "ha.plan.command_count": plan.commands.length,
        });

        if (plan.commands.length === 0) {
          metrics.errorsTotal.add(1, {
            "error.source": "home_assistant.execute_plan",
            "error.type": "no_commands",
          });
          return {
            success: false,
            message: "No commands generated for execution",
          };
        }

        if (plan.mode === "parallel" && plan.commands.length > 1) {
          return this.executeInParallel(plan.commands, originalCommand);
        }

        return this.executeInSequence(plan.commands, originalCommand);
      }
    );
  }

  public async fetchAllStates(): Promise<HassState[]> {
    return withSpan(
      "home_assistant.fetch_all_states",
      {
        kind: SpanKind.CLIENT,
      },
      async (span) => {
        const metrics = getTelemetryMetrics();
        const startedAt = Date.now();
        metrics.externalCallsTotal.add(1, {
          "dependency.name": "home_assistant",
          "dependency.operation": "fetch_all_states",
        });

        this.assertConfigured();
        const response = await this.client.get("/api/states", {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
          },
        });

        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Failed to fetch device states: ${response.statusText}`);
        }

        const durationMs = Date.now() - startedAt;
        metrics.externalCallDurationMs.record(durationMs, {
          "dependency.name": "home_assistant",
          "dependency.operation": "fetch_all_states",
          "dependency.outcome": "success",
        });
        addStoryEvent(span, "ha.fetch_all_states.completed", {
          "ha.fetch_all_states.count": Array.isArray(response.data)
            ? response.data.length
            : 0,
          "ha.fetch_all_states.duration_ms": durationMs,
        });

        return response.data as HassState[];
      }
    );
  }

  public async fetchEntityState(entityId: string): Promise<HassState> {
    return withSpan(
      "home_assistant.fetch_entity_state",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "ha.entity_id": entityId,
        },
      },
      async (span) => {
        const metrics = getTelemetryMetrics();
        const startedAt = Date.now();
        metrics.externalCallsTotal.add(1, {
          "dependency.name": "home_assistant",
          "dependency.operation": "fetch_entity_state",
        });

        this.assertConfigured();
        const response = await this.client.get(`/api/states/${entityId}`, {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
          },
        });

        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Failed to fetch entity state: ${response.statusText}`);
        }

        const durationMs = Date.now() - startedAt;
        metrics.externalCallDurationMs.record(durationMs, {
          "dependency.name": "home_assistant",
          "dependency.operation": "fetch_entity_state",
          "dependency.outcome": "success",
        });
        addStoryEvent(span, "ha.fetch_entity_state.completed", {
          "ha.entity_id": entityId,
          "ha.fetch_entity_state.duration_ms": durationMs,
          "ha.entity_state": (response.data as HassState).state,
        });

        return response.data as HassState;
      }
    );
  }

  public async fetchDomainServices(domain: string): Promise<unknown> {
    return withSpan(
      "home_assistant.fetch_domain_services",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "ha.domain": domain,
        },
      },
      async (span) => {
        const metrics = getTelemetryMetrics();
        const startedAt = Date.now();
        metrics.externalCallsTotal.add(1, {
          "dependency.name": "home_assistant",
          "dependency.operation": "fetch_domain_services",
          "ha.domain": domain,
        });

        this.assertConfigured();
        const response = await this.client.get(`/api/services/${domain}`, {
          headers: {
            Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
          },
        });

        if (response.status < 200 || response.status >= 300) {
          throw new Error(
            `Failed to fetch ${domain} services: ${response.statusText}`
          );
        }

        const durationMs = Date.now() - startedAt;
        metrics.externalCallDurationMs.record(durationMs, {
          "dependency.name": "home_assistant",
          "dependency.operation": "fetch_domain_services",
          "dependency.outcome": "success",
          "ha.domain": domain,
        });
        addStoryEvent(span, "ha.fetch_domain_services.completed", {
          "ha.domain": domain,
          "ha.fetch_domain_services.duration_ms": durationMs,
        });

        return response.data;
      }
    );
  }

  public async callService(
    urlPath: string,
    body: Record<string, unknown>
  ): Promise<unknown> {
    return withSpan(
      "home_assistant.call_service",
      {
        kind: SpanKind.CLIENT,
        attributes: {
          "ha.service_path.requested": urlPath,
        },
      },
      async (span) => {
        const metrics = getTelemetryMetrics();
        const startedAt = Date.now();
        metrics.externalCallsTotal.add(1, {
          "dependency.name": "home_assistant",
          "dependency.operation": "call_service",
        });

        this.assertConfigured();
        const normalizedPath = this.normalizeServicePath(urlPath);
        if (!normalizedPath) {
          throw new Error(
            "Invalid Home Assistant service path. Expected '<domain>/<service>'"
          );
        }

        addStoryEvent(span, "ha.call_service.started", {
          "ha.service_path": normalizedPath,
          "ha.payload.keys": Object.keys(body).join(","),
        });

        const response = await this.client.post(
          `/api/services/${normalizedPath}`,
          body,
          {
            headers: {
              Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
            },
          }
        );

        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Home Assistant API returned status ${response.status}`);
        }

        const durationMs = Date.now() - startedAt;
        metrics.externalCallDurationMs.record(durationMs, {
          "dependency.name": "home_assistant",
          "dependency.operation": "call_service",
          "dependency.outcome": "success",
          "ha.service_path": normalizedPath,
        });
        addStoryEvent(span, "ha.call_service.completed", {
          "ha.service_path": normalizedPath,
          "ha.call_service.duration_ms": durationMs,
          "ha.call_service.status_code": response.status,
        });

        return response.data;
      }
    );
  }

  public async getKnownDeviceStates(): Promise<HassState[]> {
    const [states, knownDevices] = await Promise.all([
      this.fetchAllStates(),
      this.getKnownDevices(),
    ]);

    if (knownDevices.length === 0) {
      return states;
    }

    return states.filter((state) => {
      const [, entity = ""] = state.entity_id.split(".");
      return this.matchesKnownDevice(entity, knownDevices, state.entity_id);
    });
  }

  public async getKnownDevices(): Promise<string[]> {
    const devices = process.env.HOME_ASSISTANT_DEVICES;

    return devices
      ? devices
          .split(",")
          .map((device) => device.trim())
          .filter(Boolean)
      : [];
  }

  public matchesKnownDevice(
    entityFragment: string,
    knownDevices: string[],
    fullEntityId?: string
  ): boolean {
    if (!entityFragment) {
      return false;
    }

    const normalizedFragment = entityFragment.toLowerCase();
    const normalizedFullEntity = (fullEntityId ?? entityFragment).toLowerCase();

    return knownDevices.some((knownDeviceRaw) => {
      const knownDevice = knownDeviceRaw.toLowerCase();
      return (
        normalizedFragment.startsWith(knownDevice) ||
        normalizedFullEntity.startsWith(knownDevice)
      );
    });
  }

  public async getDeviceStatesGrouped(
    devicesEntities?: string[]
  ): Promise<Record<string, HassState[]>> {
    const states = await this.fetchAllStates();
    const knownDevices = await this.getKnownDevices();
    const shouldFilter = knownDevices.length > 0;

    const grouped: Record<string, HassState[]> = {};

    for (const state of states) {
      const [, device = ""] = state.entity_id.split(".");

      if (
        shouldFilter &&
        !this.matchesKnownDevice(device, knownDevices, state.entity_id)
      ) {
        continue;
      }

      if (!grouped[device]) {
        grouped[device] = [];
      }

      grouped[device].push(state);
    }

    if (!devicesEntities) {
      return grouped;
    }

    return Object.keys(grouped).reduce((acc, key) => {
      acc[key] = grouped[key].filter((state) =>
        devicesEntities.includes(state.entity_id)
      );
      return acc;
    }, {} as Record<string, HassState[]>);
  }

  private assertConfigured(): void {
    if (!HOME_ASSISTANT_URL || !HOME_ASSISTANT_TOKEN) {
      throw new Error(
        "Home Assistant is not configured. Set HOME_ASSISTANT_URL and HOME_ASSISTANT_TOKEN."
      );
    }
  }

  private async buildPrompt(userCommand: string): Promise<string> {
    const template = this.promptService.load("HOMEASSISTANT.md");
    const groupedStates = await this.getDeviceStatesGrouped();
    const flatStates = Object.values(groupedStates).flat();
    const skillsSection = this.skillManager.getSkillsSection(flatStates);

    let prompt = template.replace(
      "{{{Devices}}}",
      JSON.stringify(groupedStates, null, 2)
    );

    prompt = this.injectSkills(prompt, skillsSection);
    return prompt.replace("{{{UserCommand}}}", userCommand);
  }

  private injectSkills(prompt: string, skillsSection: string): string {
    if (!skillsSection.trim()) {
      return prompt;
    }

    const marker = "### User";
    const markerIndex = prompt.indexOf(marker);

    if (markerIndex === -1) {
      return `${prompt}\n\n${skillsSection}`;
    }

    return `${prompt.slice(0, markerIndex)}\n\n${skillsSection}\n\n${prompt.slice(
      markerIndex
    )}`;
  }

  private normalizePlan(raw: RawCommandPlan): CommandExecutionPlan {
    if (Array.isArray(raw)) {
      const commands = raw.filter((command) => this.isServiceCommand(command));
      if (commands.length === 0) {
        throw new Error("No valid Home Assistant commands in array response");
      }
      return { mode: "sequence", commands };
    }

    if (
      this.isPlanObject(raw) &&
      Array.isArray(raw.commands) &&
      raw.commands.length > 0
    ) {
      const commands = raw.commands.filter((command) =>
        this.isServiceCommand(command)
      );
      const mode = this.normalizeMode(raw.mode || raw.execution);

      if (commands.length === 0) {
        throw new Error("No valid Home Assistant commands in command plan");
      }

      return { mode, commands };
    }

    if (this.isServiceCommand(raw)) {
      return {
        mode: "sequence",
        commands: [raw],
      };
    }

    throw new Error("Unsupported Home Assistant command format");
  }

  private isServiceCommand(command: unknown): command is HassServiceCommand {
    if (!command || typeof command !== "object") {
      return false;
    }

    const candidate = command as HassServiceCommand;
    return (
      typeof candidate.url_path === "string" &&
      candidate.url_path.trim().length > 0 &&
      typeof candidate.entity_id === "string" &&
      candidate.entity_id.trim().length > 0
    );
  }

  private isPlanObject(value: unknown): value is {
    mode?: string;
    execution?: string;
    commands?: HassServiceCommand[];
  } {
    return Boolean(value && typeof value === "object");
  }

  private normalizeMode(rawMode?: string): CommandExecutionMode {
    if (!rawMode) {
      return "sequence";
    }

    const normalized = rawMode.trim().toLowerCase();
    if (normalized === "parallel") {
      return "parallel";
    }

    return "sequence";
  }

  private async executeInSequence(
    commands: HassServiceCommand[],
    originalCommand: string
  ): Promise<CommandExecutionResult> {
    return withSpan(
      "home_assistant.execute_sequence",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "ha.plan.command_count": commands.length,
        },
      },
      async (span) => {
        const metrics = getTelemetryMetrics();
        const data: unknown[] = [];
        const errors: string[] = [];

        for (let index = 0; index < commands.length; index += 1) {
          const command = commands[index];
          addStoryEvent(span, "ha.command.step_started", {
            "ha.command.step_index": index + 1,
            "ha.command.entity_id": command.entity_id,
            "ha.command.url_path": command.url_path,
          });

          const result = await this.executeSingleCommand(command);
          data.push(result.data);

          metrics.workflowStepsTotal.add(1, {
            "workflow.name": "home_assistant_command",
            "workflow.step.outcome": result.success ? "success" : "error",
          });

          addStoryEvent(span, "ha.command.step_completed", {
            "ha.command.step_index": index + 1,
            "ha.command.step_success": result.success,
            "ha.command.step_message": result.message,
          });

          if (!result.success) {
            errors.push(`Step ${index + 1}: ${result.message}`);
          }

          if (index < commands.length - 1) {
            await this.delay(COMMAND_DELAY_MS);
          }
        }

        if (errors.length > 0) {
          return {
            success: errors.length < commands.length,
            message:
              errors.length === commands.length
                ? `All ${commands.length} commands failed for "${originalCommand}"`
                : `${commands.length - errors.length}/${commands.length} commands succeeded for "${originalCommand}"`,
            data,
            errors,
          };
        }

        return {
          success: true,
          message: `Executed ${commands.length} command(s) for "${originalCommand}"`,
          data,
        };
      }
    );
  }

  private async executeInParallel(
    commands: HassServiceCommand[],
    originalCommand: string
  ): Promise<CommandExecutionResult> {
    return withSpan(
      "home_assistant.execute_parallel",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "ha.plan.command_count": commands.length,
        },
      },
      async (span) => {
        const metrics = getTelemetryMetrics();
        const settled = await Promise.all(
          commands.map((command) => this.executeSingleCommand(command))
        );

        const data = settled.map((result) => result.data);
        const errors = settled
          .map((result, index) => ({ result, index }))
          .filter(({ result }) => !result.success)
          .map(({ result, index }) => `Step ${index + 1}: ${result.message}`);

        settled.forEach((result) => {
          metrics.workflowStepsTotal.add(1, {
            "workflow.name": "home_assistant_command",
            "workflow.step.outcome": result.success ? "success" : "error",
          });
        });

        addStoryEvent(span, "ha.parallel.completed", {
          "ha.parallel.total_steps": commands.length,
          "ha.parallel.error_count": errors.length,
        });

        if (errors.length > 0) {
          return {
            success: errors.length < commands.length,
            message:
              errors.length === commands.length
                ? `All ${commands.length} parallel commands failed for "${originalCommand}"`
                : `${commands.length - errors.length}/${commands.length} parallel commands succeeded for "${originalCommand}"`,
            data,
            errors,
          };
        }

        return {
          success: true,
          message: `Executed ${commands.length} parallel command(s) for "${originalCommand}"`,
          data,
        };
      }
    );
  }

  private async executeSingleCommand(
    command: HassServiceCommand
  ): Promise<{ success: boolean; message: string; data?: unknown }> {
    return withSpan(
      "home_assistant.execute_single_command",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "ha.command.url_path": command.url_path,
          "ha.command.entity_id": command.entity_id,
        },
      },
      async (span) => {
        const normalizedPath = this.normalizeServicePath(command.url_path);

        if (!normalizedPath) {
          return {
            success: false,
            message:
              "Invalid Home Assistant path. Expected '<domain>/<service>' in url_path.",
          };
        }

        if (!command.entity_id || !command.entity_id.trim()) {
          return {
            success: false,
            message: "Missing entity_id in Home Assistant command.",
          };
        }

        const payload: Record<string, unknown> = {
          entity_id: command.entity_id,
        };

        if (command.service_data && typeof command.service_data === "object") {
          Object.assign(payload, command.service_data);
        }

        addStoryEvent(span, "ha.command.call_service", {
          "ha.command.path": normalizedPath,
          "ha.command.payload_keys": Object.keys(payload).join(","),
        });

        try {
          const data = await this.callService(normalizedPath, payload);
          return {
            success: true,
            message: `Executed ${normalizedPath}`,
            data,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("Home Assistant service call failed:", {
            command,
            message,
          });
          recordSpanError(span, error, {
            "ha.command.path": normalizedPath,
            "ha.command.entity_id": command.entity_id,
          });
          return {
            success: false,
            message,
          };
        }
      }
    );
  }

  private normalizeServicePath(urlPath: string): string | null {
    const trimmed = urlPath.trim().replace(/^\/+/, "").replace(/\/+$/, "");

    if (!trimmed) {
      return null;
    }

    const parts = trimmed.split("/").filter(Boolean);
    if (parts.length !== 2) {
      return null;
    }

    return `${parts[0]}/${parts[1]}`;
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const homeAssistantService = new HomeAssistantService();
