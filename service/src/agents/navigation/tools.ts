/**
 * Navigation Agent Tools
 * Unified tool definitions with schemas and executors in one place
 */

import { z } from "zod";
import { ToolDefinition } from "../tv/customAgentLoop";
import { executeHACommand } from "../../ha";
import { delay } from "../common/utils";
import { TV_DEFAULT_WAIT_MS } from "../../config";

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

export const GoHomeSchema = z.object({
  command: z
    .string()
    .describe(
      "The home command to send (e.g., 'Go home on loft_tv', 'Press home on appletv'). Must include device name."
    ),
  remote_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv')."
    ),
  reason: z
    .string()
    .describe(
      "Why you're going home (e.g., 'to reset after failed navigation', 'to access main app menu')."
    ),
});

export const GoBackSchema = z.object({
  command: z
    .string()
    .describe(
      "The back command to send (e.g., 'Go back on loft_tv', 'Press back on appletv'). Must include device name."
    ),
  remote_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv')."
    ),
  reason: z
    .string()
    .describe(
      "Why you're pressing back (e.g., 'to exit playing video', 'to return to app home')."
    ),
});

export const NavigateSchema = z.object({
  command: z
    .string()
    .describe(
      "The navigation command (e.g., 'Scroll up on loft_tv', 'Press down 3 times on appletv'). Must include direction, device name, and optionally count."
    ),
  direction: z
    .enum(["up", "down", "left", "right"])
    .describe("Direction to move the selection cursor."),
  count: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe("Number of button presses (1-10). Start small and verify."),
  remote_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv')."
    ),
  reason: z
    .string()
    .describe(
      "Explain your navigation plan (e.g., 'moving up 2 positions to reach top menu bar')."
    ),
});

export const FindSearchSchema = z.object({
  remote_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv')."
    ),
  reason: z
    .string()
    .describe(
      "Why you need to find search (e.g., 'user wants to search for Breaking Bad')."
    ),
});

export const ClickSelectButtonSchema = z.object({
  command: z
    .string()
    .describe(
      "The select command (e.g., 'Select on loft_tv', 'Press OK on appletv'). Must include device name."
    ),
  remote_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the remote control (e.g., 'remote.loft_tv', 'remote.appletv')."
    ),
  reason: z
    .string()
    .describe(
      "What you're selecting and why (e.g., 'selecting search icon to open search')."
    ),
});

export const RequestScreenshotSchema = z.object({
  media_player_entity_id: z
    .string()
    .describe(
      "Home Assistant entity ID of the TV/media player (e.g., 'media_player.loft_tv')."
    ),
  reason: z
    .string()
    .describe(
      "Why you need a screenshot (e.g., 'to verify search field is active')."
    ),
});

export const WaitSchema = z.object({
  duration_ms: z
    .number()
    .int()
    .min(100)
    .max(10000)
    .describe(
      "Wait duration in milliseconds. Recommend: 500-1000 for UI updates, 1500-3000 for loading."
    ),
  reason: z
    .string()
    .describe(
      "Why waiting is needed (e.g., 'app is launching', 'waiting for menu animation')."
    ),
});

// ============================================================================
// Tool Type Definition
// ============================================================================

export interface NavToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  label: string;
  name: string;
  description: string;
  parameters: TSchema;
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

const goHome: NavToolDefinition<typeof GoHomeSchema> = {
  label: "Go Home",
  name: "go_home",
  description: `Press the HOME button to navigate to the main home screen. Use when: (1) you need to reset navigation, (2) starting a new task from a known state, (3) the current screen is unrecognizable.

EXAMPLE COMMANDS:
- "Go home on loft_tv"
- "Press home on appletv"`,
  parameters: GoHomeSchema,
  execute: async (args, context) => {
    const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
      ? Math.max(500, TV_DEFAULT_WAIT_MS)
      : 1500;

    const deviceName = args.remote_entity_id.replace("remote.", "");
    console.log(`[Nav Agent] Executing go_home: ${args.command}`);

    const result = await executeHACommand(args.command);

    if (!result.success) {
      return {
        observation: `❌ Failed to go home: ${result.message}. Try again or use an alternative approach.`,
        needsScreenshot: false,
      };
    }

    await delay(defaultWait);
    return {
      observation: `✅ Successfully pressed HOME button on ${deviceName}.\n📍 Reason: ${args.reason}\n➡️ The TV should now show the home screen.`,
      needsScreenshot: true,
    };
  },
};

const goBack: NavToolDefinition<typeof GoBackSchema> = {
  label: "Go Back",
  name: "go_back",
  description: `Press the BACK button to return to the previous screen. CRITICAL: Use this FIRST when content is playing - you MUST exit the player before navigation will work!

EXAMPLE COMMANDS:
- "Go back on loft_tv"
- "Press back on appletv"`,
  parameters: GoBackSchema,
  execute: async (args, context) => {
    const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
      ? Math.max(500, TV_DEFAULT_WAIT_MS)
      : 1500;

    const deviceName = args.remote_entity_id.replace("remote.", "");
    console.log(`[Nav Agent] Executing go_back: ${args.command}`);

    const result = await executeHACommand(args.command);

    if (!result.success) {
      return {
        observation: `❌ Failed to go back: ${result.message}. Try again or use go_home to reset.`,
        needsScreenshot: false,
      };
    }

    await delay(defaultWait);
    return {
      observation: `✅ Successfully pressed BACK button on ${deviceName}.\n📍 Reason: ${args.reason}\n➡️ The TV should now show the previous screen.`,
      needsScreenshot: true,
    };
  },
};

const navigate: NavToolDefinition<typeof NavigateSchema> = {
  label: "Navigate",
  name: "navigate",
  description: `Move the selection cursor using directional buttons (UP/DOWN/LEFT/RIGHT). Always analyze the screenshot first to understand where you are and where you need to go.

EXAMPLE COMMANDS:
- "Scroll up on loft_tv"
- "Press down on appletv"
- "Scroll left 3 times on samsung_tv"`,
  parameters: NavigateSchema,
  execute: async (args, context) => {
    const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
      ? Math.max(300, TV_DEFAULT_WAIT_MS)
      : 1000;
    const count = Math.min(Math.max(args.count, 1), 10);
    const deviceName = args.remote_entity_id.replace("remote.", "");

    console.log(
      `[Nav Agent] Executing navigate: ${args.direction} x${count} on ${deviceName}`
    );

    let successCount = 0;
    let lastError = "";

    for (let i = 0; i < count; i++) {
      const plainCommand =
        count === 1 ? args.command : `Scroll ${args.direction} on ${deviceName}`;
      const result = await executeHACommand(plainCommand);

      if (result.success) {
        successCount++;
        if (i < count - 1) {
          await delay(200);
        }
      } else {
        lastError = result.message;
        console.warn(
          `[Nav Agent] Navigation press ${i + 1}/${count} failed: ${lastError}`
        );
      }
    }

    await delay(defaultWait);

    if (successCount === 0) {
      return {
        observation: `❌ Failed to navigate ${args.direction}: ${lastError}. The UI may be unresponsive.`,
        needsScreenshot: true,
      };
    }

    if (successCount < count) {
      return {
        observation: `⚠️ Partial: Pressed ${args.direction.toUpperCase()} ${successCount}/${count} times on ${deviceName}.\n📍 Reason: ${args.reason}\n⚠️ Some commands failed.`,
        needsScreenshot: true,
      };
    }

    return {
      observation: `✅ Successfully navigated ${args.direction.toUpperCase()} ${count}x on ${deviceName}.\n📍 Reason: ${args.reason}`,
      needsScreenshot: true,
    };
  },
};

const findSearch: NavToolDefinition<typeof FindSearchSchema> = {
  label: "Find Search",
  name: "find_search",
  description:
    "ADVANCED: Uses AI vision to automatically locate and navigate to the search icon, then activates it. REQUIRES a screenshot. Best for: YouTube, Netflix, Prime Video where search is in top-left area.",
  parameters: FindSearchSchema,
  execute: async (args, context) => {
    const { screenshotBase64, screenshotContentType } = context;

    if (!screenshotBase64) {
      return {
        observation:
          "⚠️ No screenshot available for visual analysis. Use navigate tool to move UP to reach the top menu bar, then verify with a screenshot.\n" +
          "💡 Common pattern: Search icon is typically in the top-left corner.",
        needsScreenshot: true,
      };
    }

    // Import vision analysis dynamically
    try {
      const { AzureOpenAI } = await import("openai");
      const {
        OPEN_AI_BASE_URL,
        API_KEY,
        OPENAI_RESPONSES_API_VERSION,
        AZURE_AI_AGENT_MODEL,
      } = await import("../../config");

      if (!OPEN_AI_BASE_URL || !API_KEY) {
        return {
          observation:
            "⚠️ Vision API not configured. Use manual navigation:\n" +
            "1. Navigate UP to reach the top menu bar\n" +
            "2. Navigate LEFT to reach the search icon\n" +
            "3. Press SELECT when search is highlighted",
          needsScreenshot: false,
        };
      }

      const visionModel = AZURE_AI_AGENT_MODEL || "gpt-4o";
      console.log(`[Nav Agent] Analyzing screenshot using ${visionModel}...`);

      const client = new AzureOpenAI({
        baseURL: OPEN_AI_BASE_URL,
        apiKey: API_KEY,
        apiVersion: OPENAI_RESPONSES_API_VERSION,
      });

      const analysisPrompt = `Analyze this TV screenshot. Find the search icon and provide navigation.

OUTPUT JSON only:
{
  "content_playing": true/false,
  "must_go_back_first": true/false,
  "search_found": true/false,
  "current_position": { "description": "...", "row": "...", "estimated_column": 0 },
  "search_position": { "description": "...", "row": "...", "estimated_column": 0 },
  "navigation_required": { "up": 0, "down": 0, "left": 0, "right": 0, "reasoning": "..." },
  "confidence": "high/medium/low",
  "app_detected": "...",
  "alternative_suggestion": "..."
}`;

      const messages = [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: analysisPrompt },
            {
              type: "image_url" as const,
              image_url: {
                url: `data:${screenshotContentType};base64,${screenshotBase64}`,
                detail: "high" as const,
              },
            },
          ],
        },
      ];

      let response = await client.responses.create({
        model: visionModel,
        input: JSON.stringify({ messages, max_tokens: 500, temperature: 0.1 }),
      });

      let pollCount = 0;
      while (
        (response.status === "queued" || response.status === "in_progress") &&
        pollCount < 60
      ) {
        await delay(100);
        response = await client.responses.retrieve(response.id);
        pollCount++;
      }

      if (response.status === "failed") {
        return {
          observation:
            "❌ Vision analysis failed. Use manual navigation to search.",
          needsScreenshot: false,
        };
      }

      const content = response.output_text;
      if (!content) {
        return {
          observation: "❌ No response from vision analysis.",
          needsScreenshot: false,
        };
      }

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return {
          observation: `Vision analysis: ${content}\n➡️ Use navigate tool manually.`,
          needsScreenshot: false,
        };
      }

      let analysisResult;
      try {
        analysisResult = JSON.parse(jsonMatch[0]);
      } catch {
        return {
          observation: `Could not parse vision analysis. Try manual navigation.`,
          needsScreenshot: false,
        };
      }

      if (analysisResult.content_playing || analysisResult.must_go_back_first) {
        return {
          observation:
            `🎬 Content is playing! Navigation won't work.\n` +
            `🔧 ACTION: Press BACK button first to exit the player.`,
          needsScreenshot: false,
        };
      }

      if (!analysisResult.search_found) {
        const suggestion =
          analysisResult.alternative_suggestion || "Try pressing HOME first.";
        return {
          observation: `❌ Search not found.\n💡 Suggestion: ${suggestion}`,
          needsScreenshot: false,
        };
      }

      // Execute navigation
      const nav = analysisResult.navigation_required || {};
      const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
        ? Math.max(300, TV_DEFAULT_WAIT_MS)
        : 800;
      const deviceName = args.remote_entity_id.replace("remote.", "");
      const navigationSteps: string[] = [];

      const directions: Array<{ dir: string; count: number }> = [
        { dir: "up", count: nav.up || 0 },
        { dir: "down", count: nav.down || 0 },
        { dir: "left", count: nav.left || 0 },
        { dir: "right", count: nav.right || 0 },
      ];

      for (const { dir, count } of directions) {
        if (count > 0) {
          for (let i = 0; i < count; i++) {
            await executeHACommand(`Scroll ${dir} on ${deviceName}`);
            await delay(200);
          }
          navigationSteps.push(`${dir.toUpperCase()} x${count}`);
          await delay(defaultWait);
        }
      }

      const selectResult = await executeHACommand(`Select on ${deviceName}`);
      if (!selectResult.success) {
        return {
          observation:
            `⚠️ Navigation completed but SELECT failed.\n` +
            `🧭 Path: ${navigationSteps.join(" → ") || "none"}\n` +
            `➡️ Try click_select_button manually.`,
          needsScreenshot: true,
        };
      }

      await delay(defaultWait);

      return {
        observation:
          `✅ Navigation to search completed!\n` +
          `🧭 Path: ${navigationSteps.join(" → ") || "direct"} → SELECT\n` +
          `⌨️ Search field should now be active.`,
        needsScreenshot: true,
      };
    } catch (error) {
      return {
        observation: `❌ Error: ${error instanceof Error ? error.message : "Unknown"}\n➡️ Use manual navigation.`,
        needsScreenshot: false,
      };
    }
  },
};

const clickSelectButton: NavToolDefinition<typeof ClickSelectButtonSchema> = {
  label: "Select Button",
  name: "click_select_button",
  description: `Press the SELECT/OK button to activate the currently highlighted item.

EXAMPLE COMMANDS:
- "Select on loft_tv"
- "Press OK on appletv"`,
  parameters: ClickSelectButtonSchema,
  execute: async (args, context) => {
    const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
      ? Math.max(500, TV_DEFAULT_WAIT_MS)
      : 1500;

    const deviceName = args.remote_entity_id.replace("remote.", "");
    console.log(`[Nav Agent] Executing click_select: ${args.command}`);

    const result = await executeHACommand(args.command);

    if (!result.success) {
      return {
        observation: `❌ Failed to click select: ${result.message}. Try again or verify position.`,
        needsScreenshot: true,
      };
    }

    await delay(defaultWait);
    return {
      observation: `✅ Successfully pressed SELECT on ${deviceName}.\n📍 Reason: ${args.reason}`,
      needsScreenshot: true,
    };
  },
};

const requestScreenshot: NavToolDefinition<typeof RequestScreenshotSchema> = {
  label: "Request Screenshot",
  name: "request_screenshot",
  description:
    "Request a fresh screenshot of the TV display. Use when you need to see current state or verify an action worked.",
  parameters: RequestScreenshotSchema,
  execute: async (args, context) => {
    return {
      observation:
        `📸 Screenshot requested for: ${args.reason}\n` +
        `🎯 Media player: ${args.media_player_entity_id}\n` +
        `➡️ Waiting for fresh screenshot.`,
      needsScreenshot: true,
    };
  },
};

const wait: NavToolDefinition<typeof WaitSchema> = {
  label: "Wait",
  name: "wait",
  description:
    "Pause execution for a specified duration. Use when: (1) waiting for UI animations, (2) app is loading, (3) transition between screens.",
  parameters: WaitSchema,
  execute: async (args) => {
    const duration = Math.min(Math.max(args.duration_ms ?? 1000, 100), 10000);

    console.log(`[Nav Agent] Waiting ${duration}ms: ${args.reason}`);
    await delay(duration);

    return {
      observation: `⏱️ Waited ${duration}ms.\n📍 Reason: ${args.reason}`,
      needsScreenshot: false,
    };
  },
};

// ============================================================================
// Export Tool Registry
// ============================================================================

export const NAV_TOOLS_REGISTRY = {
  go_home: goHome,
  go_back: goBack,
  navigate,
  find_search: findSearch,
  click_select_button: clickSelectButton,
  request_screenshot: requestScreenshot,
  wait,
} as const;

export type NavToolName = keyof typeof NAV_TOOLS_REGISTRY;

// ============================================================================
// Convert to Azure/OpenAI Tool Format
// ============================================================================

export function toToolDefinitions(): ToolDefinition[] {
  return Object.values(NAV_TOOLS_REGISTRY).map((tool) => ({
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
  const tool = NAV_TOOLS_REGISTRY[toolName as NavToolName];

  if (!tool) {
    throw new Error(`Unknown navigation tool: ${toolName}`);
  }

  console.log(`[Nav Agent] Executing: ${tool.label} (${tool.name})`, args);

  // Validate and execute - cast to any since Zod validates at runtime
  const validatedArgs = tool.parameters.parse(args);
  return (tool.execute as (args: unknown, ctx: ToolExecutionContext) => Promise<ToolExecutionResult>)(validatedArgs, context);
}
