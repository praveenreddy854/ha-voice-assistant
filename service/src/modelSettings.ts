import { z } from "zod";

export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

export interface ModelSettings {
  model: string;
  reasoningEffort?: ReasoningEffort;
}

const deploymentName = z.string().trim().min(1).regex(/^[^\s,{}\[\]"']+$/);
const modelSettingsSchema = z.object({
  model: deploymentName,
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
}).strict();

/** A plain deployment name preserves the provider default; JSON configures explicit settings. */
export function parseModelSettings(value: string | undefined, setting = "model"): ModelSettings | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const invalid = () => new Error(`${setting} must be a deployment name or a JSON object with "model" and optional "reasoningEffort" (${REASONING_EFFORTS.join(", ")}); unknown fields and CSV pairs are not supported`);
  if (!text.startsWith("{")) {
    const name = deploymentName.safeParse(text);
    if (!name.success) throw invalid();
    return { model: name.data };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw invalid(); }
  const settings = modelSettingsSchema.safeParse(parsed);
  if (!settings.success) throw invalid();
  return settings.data;
}

/** Eval overrides must resolve to an Azure deployment identifier. */
export function isValidModelOverride(value: string): boolean {
  try {
    const settings = parseModelSettings(value);
    return !!settings && /^[a-zA-Z0-9._-]+$/.test(settings.model);
  } catch { return false; }
}

export function resolveModelSettings(value: string | undefined, reasoningEffort?: ReasoningEffort, setting = "model"): ModelSettings | undefined {
  const settings = parseModelSettings(value, setting);
  if (!settings) return undefined;
  return { model: settings.model, reasoningEffort: reasoningEffort ?? settings.reasoningEffort };
}

export function formatModelSettingsIdentity({ model, reasoningEffort }: ModelSettings): string {
  return reasoningEffort === undefined ? model : JSON.stringify({ model, reasoningEffort });
}

export function modelSettingsIdentity(value: string | undefined, reasoningEffort?: ReasoningEffort, setting = "model"): string | undefined {
  const settings = resolveModelSettings(value, reasoningEffort, setting);
  return settings && formatModelSettingsIdentity(settings);
}

export function reasoningSettings(reasoningEffort?: ReasoningEffort) {
  // Azure deployment aliases may hide the model family from the SDK. An explicit
  // effort must reach the deployment even when its name is not recognized.
  return reasoningEffort === undefined ? {} : {
    providerOptions: { azure: { reasoningEffort, forceReasoning: true } },
  };
}

// Match the installed OpenAI provider's reasoning-family defaults. Chat variants
// keep sampling support; Azure deployment aliases without a known family retain
// their caller-supplied settings.
function isReasoningModel(model: string): boolean {
  const gpt = /^gpt-(\d+)(?:\.\d+)?(?:-(.+))?$/.exec(model);
  const chat = /^gpt-\d+-chat(?:-|$)/.test(model);
  return /^o\d+(?:-|$)/.test(model) || (!!gpt && Number(gpt[1]) >= 5 && !chat);
}

export function samplingSettings(model: string, temperature?: number, reasoningEffort?: ReasoningEffort): { temperature?: number } {
  return temperature != null && !isReasoningModel(model) && reasoningEffort === undefined ? { temperature } : {};
}

export function outputTokenBudget(model: string, visibleTokens: number, reasoningEffort?: ReasoningEffort): number {
  const usesReasoning = reasoningEffort === undefined ? isReasoningModel(model) : reasoningEffort !== "none";
  // Azure counts hidden reasoning against the same cap and recommends 25K of headroom.
  return usesReasoning ? visibleTokens + 25_000 : visibleTokens;
}
