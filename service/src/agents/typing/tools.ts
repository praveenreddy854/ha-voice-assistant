/**
 * Typing Agent Tools
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
  activeAgent?: "tv" | "navigation" | "typing";
  targetText?: string;
  typedSoFar?: string;
}

export interface ToolExecutionResult {
  observation: string;
  needsScreenshot: boolean;
}

// ============================================================================
// Parameter Schemas
// ============================================================================

export const TypeTextSchema = z.object({
  commands: z
    .array(z.string())
    .describe(
      "Array of navigation and selection commands to type the complete text (e.g., ['Navigate RIGHT x7 on apple tv', 'Click SELECT on apple tv', ...])."
    ),
  reasoning: z
    .string()
    .describe(
      "Explanation of the typing plan and why these commands will type the desired text."
    ),
});

// ============================================================================
// Tool Type Definition
// ============================================================================

export interface TypingToolDefinition<TSchema extends z.ZodType = z.ZodType> {
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
    } else if (innerType instanceof z.ZodArray) {
      prop = { type: "array", items: { type: "string" } };
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

const typeText: TypingToolDefinition<typeof TypeTextSchema> = {
  label: "Type Text",
  name: "type_text",
  description: `Create a plan for navigating the on-screen keyboard to type the desired text. The keyboard is horizontally laid out with first key as the number option followed by a space and then alphabetically from a-z. The last key is clear key which is used for clearing one character at a time. Provide step by step navigation instructions (left, right) to reach each character from the current cursor position. The initial position will always be 'a'.

Example plan for "hello world":
[
  'Navigate RIGHT x7 on apple tv',        # h
  'Click SELECT on apple tv',        # h
  'Navigate LEFT x3 on apple tv',         # e
  'Click SELECT on apple tv',        # e
  'Navigate RIGHT x7 on apple tv',        # l
  'Click SELECT on apple tv',        # l
  'Navigate RIGHT x3 on apple tv',        # o
  'Click SELECT on apple tv',        # o
  'Navigate LEFT x15 on apple tv',        # space
  'Click SELECT on apple tv',        # space
  ...
]`,
  parameters: TypeTextSchema,
  execute: async (args, context) => {
    const defaultWait = Number.isFinite(TV_DEFAULT_WAIT_MS)
      ? Math.max(250, TV_DEFAULT_WAIT_MS)
      : 800;

    console.log(
      `[Typing Agent] Executing type_text with ${args.commands.length} commands`
    );
    console.log(`[Typing Agent] Reasoning: ${args.reasoning}`);

    const results: string[] = [];
    let successCount = 0;
    let failCount = 0;

    for (const command of args.commands) {
      const result = await executeHACommand(command);

      if (result.success) {
        successCount++;
        results.push(`✅ ${command}`);
      } else {
        failCount++;
        results.push(`❌ ${command}: ${result.message}`);
      }

      await delay(defaultWait);
    }

    const observation =
      failCount === 0
        ? `✅ Successfully executed all ${successCount} commands.\n\n${args.reasoning}\n\nCommands:\n${results.join("\n")}`
        : `⚠️ Executed ${successCount}/${args.commands.length} (${failCount} failed).\n\n${args.reasoning}\n\nResults:\n${results.join("\n")}`;

    return { observation, needsScreenshot: true };
  },
};

// ============================================================================
// Export Tool Registry
// ============================================================================

export const TYPING_TOOLS_REGISTRY = {
  type_text: typeText,
} as const;

export type TypingToolName = keyof typeof TYPING_TOOLS_REGISTRY;

// ============================================================================
// Convert to Azure/OpenAI Tool Format
// ============================================================================

export function toToolDefinitions(): ToolDefinition[] {
  return Object.values(TYPING_TOOLS_REGISTRY).map((tool) => ({
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
  const tool = TYPING_TOOLS_REGISTRY[toolName as TypingToolName];

  if (!tool) {
    throw new Error(`Unknown typing tool: ${toolName}`);
  }

  console.log(`[Typing Agent] Executing: ${tool.label} (${tool.name})`, args);

  const validatedArgs = tool.parameters.parse(args);
  return tool.execute(validatedArgs, context);
}
