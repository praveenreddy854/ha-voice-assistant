/**
 * TV Agent Tools
 * Unified tool definitions with schemas and executors in one place
 */

import { z } from "zod";
import { ToolDefinition } from "./customAgentLoop";
import { getKnownDeviceStates, executeHACommand } from "../../ha";
import { delay } from "../common/utils";
import { TV_DEFAULT_WAIT_MS, TV_AGENT_DEVICES } from "../../config";
import { runNavigationAgent } from "../navigation";
import { runTypingAgent } from "../typing";

// ============================================================================
// Tool Execution Context & Result Types
// ============================================================================

export interface ToolExecutionContext {
  homeAssistantUrl: string;
  homeAssistantToken: string;
  screenshotBase64?: string;
  screenshotContentType?: string;
  sessionId?: string;
  activeAgent?: "tv" | "navigation";
}

export interface ToolExecutionResult {
  observation: string;
  needsScreenshot: boolean;
}

// ============================================================================
// Parameter Schemas
// ============================================================================

export const ClickPowerButtonSchema = z.object({
  command: z
    .string()
    .describe(
      "The power command to send (e.g., 'Turn on loft_tv', 'Turn off appletv'). Must include the device name."
    ),
  remote_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv')."
    ),
  reason: z
    .string()
    .describe(
      "Why you're using power button (e.g., 'to turn on TV for user request')."
    ),
});

export const ClickSelectButtonSchema = z.object({
  command: z
    .string()
    .describe(
      "The select command to send (e.g., 'Select on loft_tv', 'Press OK on appletv'). Must include the device name."
    ),
  remote_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv')."
    ),
  reason: z
    .string()
    .describe(
      "Why you're pressing select (e.g., 'to open selected app', 'to confirm menu selection')."
    ),
});

export const DelegateToTypingSchema = z.object({
  text_to_type: z
    .string()
    .describe(
      "The text to type into the focused input field (e.g., 'Netflix', 'Breaking Bad')."
    ),
  remote_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv')."
    ),
  media_player_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the TV/media player (e.g., 'media_player.loft_tv')."
    ),
  reason: z
    .string()
    .describe(
      "Why you're delegating this text input task (e.g., 'to search for a movie')."
    ),
});

export const RequestScreenshotSchema = z.object({
  reason: z
    .string()
    .describe(
      "Why you need a screenshot (e.g., 'to verify search results', 'to locate the next menu item')."
    ),
  target_agent: z
    .enum(["tv", "navigation", "auto"])
    .optional()
    .describe(
      "Which agent should receive the screenshot. 'auto' (default) routes based on active sessions."
    ),
});

export const GetDeviceStateSchema = z.object({
  device_name: z
    .string()
    .optional()
    .describe(
      "Optional: The device name to get state for (e.g., 'living_room_tv'). If not provided, returns all TV-related device states."
    ),
  reason: z
    .string()
    .describe(
      "Why you need device state (e.g., 'to check if TV is on', 'to verify playback started')."
    ),
});

export const LaunchAppSchema = z.object({
  command: z
    .string()
    .describe(
      "The launch command to send (e.g., 'Launch Netflix on loft_tv'). Must include app and device name."
    ),
  app_name: z
    .string()
    .describe(
      "Name of the app to launch (e.g., 'Netflix', 'YouTube', 'Disney+')."
    ),
  media_player_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the media player (e.g., 'media_player.appletv')."
    ),
  reason: z.string().describe("Why you're launching this app."),
});

export const DelegateToNavigationSchema = z.object({
  task_description: z
    .string()
    .describe(
      "Clear description of the navigation task (e.g., 'go to home screen', 'find and activate search')."
    ),
  remote_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv')."
    ),
  media_player_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the TV/media player (e.g., 'media_player.loft_tv')."
    ),
  reason: z
    .string()
    .describe(
      "Why you're delegating this navigation task (e.g., 'user wants to search for content')."
    ),
});

export const WaitSchema = z.object({
  duration_ms: z
    .number()
    .int()
    .min(250)
    .max(5000)
    .optional()
    .describe("How long to wait in milliseconds. Default is 1500ms."),
  reason: z
    .string()
    .describe(
      "Why you're waiting (e.g., 'waiting for search results to load')."
    ),
});

// ============================================================================
// Tool Type Definition
// ============================================================================

export interface TvToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  /** Human-readable label for the tool */
  label: string;
  /** Tool name used in API calls */
  name: string;
  /** Description of what the tool does */
  description: string;
  /** Zod schema for parameter validation */
  parameters: TSchema;
  /** Execute function */
  execute: (
    args: z.infer<TSchema>,
    context: ToolExecutionContext
  ) => Promise<ToolExecutionResult>;
}

// ============================================================================
// Helper to convert Zod schema to JSON Schema
// ============================================================================

function zodToJsonSchema(schema: z.ZodObject<any>): Record<string, unknown> {
  const shape = schema.shape;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const zodType = value as z.ZodType;
    const description = zodType.description;

    // Unwrap optional types
    let innerType = zodType;
    let isOptional = false;
    if (zodType instanceof z.ZodOptional) {
      innerType = zodType.unwrap();
      isOptional = true;
    }

    let prop: Record<string, unknown> = {};

    if (innerType instanceof z.ZodString) {
      prop = { type: "string" };
    } else if (innerType instanceof z.ZodNumber) {
      prop = { type: "integer" };
      if ((innerType as any)._def.checks) {
        for (const check of (innerType as any)._def.checks) {
          if (check.kind === "min") prop.minimum = check.value;
          if (check.kind === "max") prop.maximum = check.value;
        }
      }
    } else if (innerType instanceof z.ZodEnum) {
      prop = { type: "string", enum: innerType.options };
    } else {
      prop = { type: "string" };
    }

    if (description) {
      prop.description = description;
    }

    properties[key] = prop;

    if (!isOptional) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required,
  };
}

// ============================================================================
// Tool Definitions
// ============================================================================

const clickPowerButton: TvToolDefinition<typeof ClickPowerButtonSchema> = {
  label: "Power Button",
  name: "click_power_button",
  description: `Turn the TV or device on/off using the power button. Use this for device power management. Returns updated device state automatically.

EXAMPLE COMMANDS:
- "Turn on loft_tv"
- "Turn off family_room_tv"
- "Power toggle appletv"`,
  parameters: ClickPowerButtonSchema,
  execute: async (args, context) => {
    const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
      ? Math.max(250, TV_DEFAULT_WAIT_MS)
      : 1500;

    const deviceName = args.remote_entity_id.replace("remote.", "");
    const result = await executeHACommand(args.command);

    if (!result.success) {
      return {
        observation: `Failed to execute "${args.command}": ${result.message}`,
        needsScreenshot: false,
      };
    }

    await delay(defaultWait);

    const deviceStates = (await getKnownDeviceStates()).filter((d) =>
      d.entity_id.includes(deviceName)
    );

    return {
      observation: `Successfully executed "${args.command}". ${args.reason}. Device states: ${JSON.stringify(
        deviceStates.map((s) => ({ entity_id: s.entity_id, state: s.state }))
      )}`,
      needsScreenshot: false,
    };
  },
};

const clickSelectButton: TvToolDefinition<typeof ClickSelectButtonSchema> = {
  label: "Select Button",
  name: "click_select_button",
  description: `Press the select/OK button to confirm selections, enter menus, or activate highlighted items.

EXAMPLE COMMANDS:
- "Select on loft_tv"
- "Press OK on appletv"
- "Enter on samsung_tv"`,
  parameters: ClickSelectButtonSchema,
  execute: async (args, context) => {
    const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
      ? Math.max(250, TV_DEFAULT_WAIT_MS)
      : 1500;

    const result = await executeHACommand(args.command);

    if (!result.success) {
      return {
        observation: `Failed to execute "${args.command}": ${result.message}`,
        needsScreenshot: false,
      };
    }

    await delay(defaultWait);
    return {
      observation: `Successfully executed "${args.command}". ${args.reason}`,
      needsScreenshot: false,
    };
  },
};

const delegateToTyping: TvToolDefinition<typeof DelegateToTypingSchema> = {
  label: "Delegate Typing",
  name: "delegate_to_typing",
  description:
    "Delegate text input tasks to a specialized Typing Agent. IMPORTANT: Only call this AFTER the search input field has been activated and an on-screen keyboard is visible.",
  parameters: DelegateToTypingSchema,
  execute: async (args, context) => {
    console.log(
      `[TV Agent] Delegating to Typing Agent: "${args.text_to_type}"`
    );

    try {
      const result = await runTypingAgent({
        userMessage: `Type the text "${args.text_to_type}" into the focused input field. ${args.reason}`,
        textToType: args.text_to_type,
        deviceConfig: {
          remoteEntityId: args.remote_entity_id,
          mediaPlayerEntityId: args.media_player_entity_id,
        },
        screenshotBase64: context.screenshotBase64,
        screenshotContentType: context.screenshotContentType,
        maxIterations: 15,
      });

      if (!result.success) {
        return {
          observation: `❌ Typing Agent failed: ${result.message}\nTarget text: "${args.text_to_type}"`,
          needsScreenshot: true,
        };
      }

      const lastStep = result.steps[result.steps.length - 1];
      const stepObservation = lastStep?.observation || result.message;

      return {
        observation:
          `⌨️ Typing Agent completed:\n` +
          `📝 Text typed: "${args.text_to_type}"\n` +
          `${stepObservation}\n` +
          `${args.reason}`,
        needsScreenshot: true,
      };
    } catch (error) {
      console.error("[TV Agent] Typing delegation error:", error);
      return {
        observation: `❌ Typing delegation failed: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
        needsScreenshot: false,
      };
    }
  },
};

const requestScreenshot: TvToolDefinition<typeof RequestScreenshotSchema> = {
  label: "Request Screenshot",
  name: "request_screenshot",
  description:
    "Request a fresh screenshot from the TV camera to see what's currently displayed. The screenshot will be included in the next tool response.",
  parameters: RequestScreenshotSchema,
  execute: async (args, context) => {
    let targetAgent: "tv" | "navigation" = "tv";
    let routingReason = "";

    if (args.target_agent === "navigation") {
      targetAgent = "navigation";
      routingReason = " (explicitly routed to navigation agent)";
    } else if (args.target_agent === "tv") {
      targetAgent = "tv";
      routingReason = " (explicitly routed to TV agent)";
    } else if (context.activeAgent === "navigation") {
      targetAgent = "navigation";
      routingReason = " (auto-routed to navigation agent)";
    } else {
      routingReason = " (auto-routed to TV agent)";
    }

    return {
      observation:
        `📸 Screenshot requested: ${args.reason}\n` +
        `🎯 Target Agent: ${targetAgent}${routingReason}\n` +
        `➡️ The screenshot will be delivered in the next tool response.`,
      needsScreenshot: true,
    };
  },
};

const getDeviceState: TvToolDefinition<typeof GetDeviceStateSchema> = {
  label: "Get Device State",
  name: "get_device_state",
  description:
    "Get the current state of specific Home Assistant devices (TV, media players). Use to check power state, playback status, volume, etc.",
  parameters: GetDeviceStateSchema,
  execute: async (args) => {
    const allDeviceStates = await getKnownDeviceStates();
    let deviceStates;
    let observationPrefix;

    if (args.device_name) {
      deviceStates = allDeviceStates.filter((s) => {
        const entityParts = s.entity_id.split(".");
        if (entityParts.length < 2) return false;
        return entityParts[1] === args.device_name;
      });
      observationPrefix = `Device states for ${args.device_name}`;

      if (deviceStates.length === 0) {
        const availableDevices = allDeviceStates
          .filter((s) => TV_AGENT_DEVICES.includes(s.entity_id.split(".")[1]))
          .map((s) => s.entity_id.split(".")[1])
          .filter((name, index, arr) => arr.indexOf(name) === index)
          .join(", ");

        return {
          observation: `Device '${args.device_name}' not found. Available: ${availableDevices}`,
          needsScreenshot: false,
        };
      }
    } else {
      deviceStates = allDeviceStates.filter((s) =>
        TV_AGENT_DEVICES.includes(s.entity_id.split(".")[1])
      );
      observationPrefix = "TV device states";
    }

    return {
      observation: `${observationPrefix}: ${JSON.stringify(
        deviceStates.map((s) => ({
          entity_id: s.entity_id,
          state: s.state,
          attributes: s.attributes,
        })),
        null,
        2
      )}`,
      needsScreenshot: false,
    };
  },
};

const launchApp: TvToolDefinition<typeof LaunchAppSchema> = {
  label: "Launch App",
  name: "launch_app",
  description: `Launch or open a specific app on the TV or media player. Returns updated device state automatically.

EXAMPLE COMMANDS:
- "Launch Netflix on loft_tv"
- "Open YouTube on appletv"
- "Start Disney+ on samsung_tv"`,
  parameters: LaunchAppSchema,
  execute: async (args, context) => {
    const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
      ? Math.max(250, TV_DEFAULT_WAIT_MS)
      : 1500;

    const result = await executeHACommand(args.command);

    if (!result.success) {
      return {
        observation: `Failed to launch ${args.app_name}: ${result.message}`,
        needsScreenshot: false,
      };
    }

    await delay(defaultWait);

    const allDeviceStates = await getKnownDeviceStates();
    const mediaPlayerStates = allDeviceStates.filter(
      (s) => s.entity_id === args.media_player_entity_id
    );

    let appLaunchStatus = "unknown";
    let currentApp = "unknown";
    let deviceState = "unknown";

    if (mediaPlayerStates.length > 0) {
      const mediaPlayer = mediaPlayerStates[0];
      deviceState = mediaPlayer.state;
      const attributes = mediaPlayer.attributes || {};
      currentApp =
        attributes.app_name ||
        attributes.media_title ||
        attributes.source ||
        attributes.app_id ||
        "unknown";

      if (currentApp && typeof currentApp === "string") {
        const normalizedCurrentApp = currentApp.toLowerCase();
        const normalizedRequestedApp = args.app_name.toLowerCase();

        if (
          normalizedCurrentApp.includes(normalizedRequestedApp) ||
          normalizedRequestedApp.includes(normalizedCurrentApp)
        ) {
          appLaunchStatus = "success";
        } else {
          appLaunchStatus = "different_app";
        }
      }
    }

    let observation = `App "${args.app_name}" launch command sent. `;

    if (appLaunchStatus === "success") {
      observation += `✅ SUCCESS: ${args.app_name} is now active.`;
    } else if (appLaunchStatus === "different_app") {
      observation += `⚠️ PARTIAL: Device shows "${currentApp}" instead of "${args.app_name}".`;
    } else {
      observation += `❓ UNKNOWN: Unable to verify. Device state: ${deviceState}.`;
    }

    observation += ` ${args.reason}`;

    return { observation, needsScreenshot: false };
  },
};

const delegateToNavigation: TvToolDefinition<
  typeof DelegateToNavigationSchema
> = {
  label: "Delegate Navigation",
  name: "delegate_to_navigation",
  description:
    "Delegate navigation tasks to a specialized Navigation Agent. Use for: home screen, back navigation, directional movement, search activation, or profile selection.",
  parameters: DelegateToNavigationSchema,
  execute: async (args, context) => {
    console.log(
      `[TV Agent] Delegating to Navigation Agent: ${args.task_description}`
    );

    try {
      const result = await runNavigationAgent({
        userMessage: args.task_description,
        deviceConfig: {
          remoteEntityId: args.remote_entity_id,
          mediaPlayerEntityId: args.media_player_entity_id,
        },
        screenshotBase64: context.screenshotBase64,
        screenshotContentType: context.screenshotContentType,
        maxIterations: 10,
      });

      if (!result.success) {
        const stepSummary = result.steps
          .map(
            (s, i) =>
              `  ${i + 1}. ${s.toolName}: ${s.observation?.substring(0, 100)}...`
          )
          .join("\n");

        return {
          observation:
            `❌ Navigation Agent failed after ${result.steps.length} steps.\n` +
            `📋 Task: ${args.task_description}\n` +
            `❗ Error: ${result.message}\n` +
            `📝 Steps:\n${stepSummary}`,
          needsScreenshot: true,
        };
      }

      const stepSummary = result.steps
        .filter((s) => s.observation && !s.observation.startsWith("⏱️"))
        .map(
          (s) =>
            `• ${s.toolName}: ${s.observation?.split("\n")[0] || "completed"}`
        )
        .slice(-3)
        .join("\n");

      return {
        observation:
          `✅ Navigation Agent completed!\n` +
          `📋 Task: ${args.task_description}\n` +
          `🔄 Steps: ${result.steps.length}\n` +
          `📝 Recent:\n${stepSummary}\n` +
          `🎯 Result: ${result.message}`,
        needsScreenshot: true,
      };
    } catch (error) {
      console.error("[TV Agent] Navigation delegation error:", error);
      return {
        observation:
          `❌ Navigation delegation failed.\n` +
          `📋 Task: ${args.task_description}\n` +
          `❗ Error: ${error instanceof Error ? error.message : "Unknown"}`,
        needsScreenshot: true,
      };
    }
  },
};

const wait: TvToolDefinition<typeof WaitSchema> = {
  label: "Wait",
  name: "wait",
  description:
    "Wait for a specified duration to allow UI transitions, loading screens, or animations to complete.",
  parameters: WaitSchema,
  execute: async (args) => {
    const duration =
      args.duration_ms && args.duration_ms > 0
        ? args.duration_ms
        : TV_DEFAULT_WAIT_MS;

    await delay(duration);

    return {
      observation: `⏱️ Waited ${duration}ms. ${args.reason}`,
      needsScreenshot: false,
    };
  },
};

// ============================================================================
// Export Tool Registry
// ============================================================================

export const TV_TOOLS_REGISTRY = {
  click_power_button: clickPowerButton,
  click_select_button: clickSelectButton,
  delegate_to_typing: delegateToTyping,
  request_screenshot: requestScreenshot,
  get_device_state: getDeviceState,
  launch_app: launchApp,
  delegate_to_navigation: delegateToNavigation,
  wait,
} as const;

export type TvToolName = keyof typeof TV_TOOLS_REGISTRY;

// ============================================================================
// Convert to Azure/OpenAI Tool Format
// ============================================================================

export function toToolDefinitions(): ToolDefinition[] {
  return Object.values(TV_TOOLS_REGISTRY).map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchema(tool.parameters as z.ZodObject<any>),
    },
  }));
}

// ============================================================================
// Execute Tool by Name
// ============================================================================

export async function executeTool(
  toolName: string,
  args: unknown,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const tool = TV_TOOLS_REGISTRY[toolName as TvToolName];

  if (!tool) {
    throw new Error(`Unknown tool: ${toolName}`);
  }

  console.log(`[TV Agent] Executing tool: ${tool.label} (${tool.name})`, args);

  // Validate and execute - cast to any since Zod validates at runtime
  const validatedArgs = tool.parameters.parse(args);
  return (tool.execute as (args: unknown, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>)(validatedArgs, context);
}
