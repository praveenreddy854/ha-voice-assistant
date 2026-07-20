import { z } from "zod";
import type { ToolDefinition } from "./agentLoop";
import {
  deleteMemory,
  MemoryScopes,
  MemoryType,
  retrieveMemories,
  saveMemory,
  updateMemory,
  validateMemoryWrite,
} from "../../memory";

const scopesSchema = z
  .object({
    global: z.boolean().optional(),
    roomNames: z.array(z.string()).optional(),
    deviceNames: z.array(z.string()).optional(),
    deviceEntityIds: z.array(z.string()).optional(),
    domains: z.array(z.string()).optional(),
    appNames: z.array(z.string()).optional(),
    people: z.array(z.string()).optional(),
    agentTypes: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
  })
  .optional();

const memoryTypeSchema = z.enum(["preference", "fact", "guidance"]);

const retrieveMemorySchema = z.object({
  query: z.string().describe("Question or task to retrieve relevant memory for."),
  limit: z.number().int().positive().max(10).optional(),
});

const saveMemorySchema = z.object({
  text: z
    .string()
    .describe("Durable user preference, stable fact, or reusable guidance to remember."),
  memoryType: memoryTypeSchema.optional(),
  scopes: scopesSchema.describe(
    "Where this memory applies. Use global=true for global preferences. For device-specific memory, provide deviceNames or deviceEntityIds. If the target is ambiguous, ask the user before saving."
  ),
});

const updateMemorySchema = z.object({
  id: z.string().optional(),
  query: z
    .string()
    .optional()
    .describe("Use when the memory id is unknown; updates the best matching memory."),
  text: z.string().describe("Replacement memory text."),
  memoryType: memoryTypeSchema.optional(),
  scopes: scopesSchema,
});

const deleteMemorySchema = z.object({
  id: z.string().optional(),
  query: z
    .string()
    .optional()
    .describe("Use when the memory id is unknown; deletes matching memories."),
  limit: z.number().int().positive().max(10).optional(),
});

function compactMemory(memory: {
  id: string;
  text: string;
  memoryType: string;
  source: string;
  confidence: number;
  scopes: MemoryScopes;
  updatedAt: string;
}): Record<string, unknown> {
  return {
    id: memory.id,
    text: memory.text,
    memoryType: memory.memoryType,
    source: memory.source,
    confidence: memory.confidence,
    scopes: memory.scopes,
    updatedAt: memory.updatedAt,
  };
}

export function buildMemoryToolDefinitions(agentType: string): ToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "retrieve_memory",
        description:
          "Retrieve Persistent agent memory relevant to the current question or task. Use when compact injected memory is not enough.",
        parameters: {},
        inputSchema: retrieveMemorySchema,
      },
      execute: async (args: Record<string, unknown>) => {
        const parsed = retrieveMemorySchema.parse(args);
        const memories = await retrieveMemories({
          query: parsed.query,
          agentType,
          limit: parsed.limit,
        });
        return {
          memories: memories.map(compactMemory),
          observation:
            memories.length > 0
              ? `Retrieved ${memories.length} relevant memories.`
              : "No relevant Persistent agent memory found.",
        };
      },
    },
    {
      type: "function",
      function: {
        name: "save_memory",
        description:
          "Save a durable user preference, stable fact, or reusable guidance item. Use immediately for explicit 'remember...' requests.",
        parameters: {},
        inputSchema: saveMemorySchema,
      },
      execute: async (args: Record<string, unknown>) => {
        const parsed = saveMemorySchema.parse(args);
        const validation = validateMemoryWrite(parsed.text, parsed.scopes);
        if (!validation.ok) {
          return {
            saved: null,
            clarification_required: validation.clarificationRequired === true,
            observation:
              validation.message ||
              "Memory needs a clearer scope before it can be saved.",
          };
        }
        const saved = await saveMemory({
          text: parsed.text,
          memoryType: parsed.memoryType as MemoryType | undefined,
          source: "explicit",
          confidence: 1,
          scopes: {
            ...parsed.scopes,
            agentTypes: Array.from(
              new Set([...(parsed.scopes?.agentTypes || []), agentType])
            ),
          },
        });
        return saved
          ? {
              saved: compactMemory(saved),
              observation: `Saved memory ${saved.id}.`,
            }
          : { saved: null, observation: "Memory was not saved." };
      },
    },
    {
      type: "function",
      function: {
        name: "update_memory",
        description:
          "Correct or replace an existing Persistent agent memory when the user changes a remembered fact or preference.",
        parameters: {},
        inputSchema: updateMemorySchema,
      },
      execute: async (args: Record<string, unknown>) => {
        const parsed = updateMemorySchema.parse(args);
        const updated = await updateMemory({
          id: parsed.id,
          query: parsed.query,
          text: parsed.text,
          memoryType: parsed.memoryType as MemoryType | undefined,
          scopes: parsed.scopes,
        });
        return updated
          ? {
              updated: compactMemory(updated),
              observation: `Updated memory ${updated.id}.`,
            }
          : { updated: null, observation: "No matching memory was updated." };
      },
    },
    {
      type: "function",
      function: {
        name: "delete_memory",
        description:
          "Delete Persistent agent memory when the user asks to forget something.",
        parameters: {},
        inputSchema: deleteMemorySchema,
      },
      execute: async (args: Record<string, unknown>) => {
        const parsed = deleteMemorySchema.parse(args);
        const deleted = await deleteMemory({
          id: parsed.id,
          query: parsed.query,
          limit: parsed.limit,
        });
        return {
          deleted: deleted.map(compactMemory),
          observation:
            deleted.length > 0
              ? `Deleted ${deleted.length} memories.`
              : "No matching memory was deleted.",
        };
      },
    },
  ];
}
