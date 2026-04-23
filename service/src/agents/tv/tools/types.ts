import { z } from "zod";

export interface ToolExecutionContext {
  homeAssistantUrl: string;
  homeAssistantToken: string;
  screenshotBase64?: string;
  screenshotContentType?: string;
  sessionId?: string;
  activeAgent?: "tv" | "navigation";
  /** The user's original request — used by validate_screen and background monitor. */
  userPrompt?: string;
}

export const toolExecutionResultSchema = z.object({
  observation: z.string(),
  needsScreenshot: z.boolean(),
  toolSuccess: z.boolean().optional(),
  appUiContext: z.object({
    appName: z.string().optional(),
    layoutType: z.string().optional(),
    selectionPosition: z.string().optional(),
    navigationLandmarks: z.array(z.string()).optional(),
  }).optional(),
});

export type ToolExecutionResult = z.infer<typeof toolExecutionResultSchema>;

/** Definition shape exported by each tool file. */
export interface TvToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  /** If true, the tool breaks the agent loop for external input (e.g. screenshot). */
  needsExternalInput?: boolean;
  execute: (args: any, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
}
