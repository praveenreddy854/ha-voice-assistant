import type { ReasoningEffort } from "./modelSettings";

export type FoundryRegion = "eus" | "eus2";

const deploymentRegions = {
  "gpt-6.1-terra": "eus",
  "gpt-6.2-sol": "eus",
  "gpt-live-1": "eus2",
  "text-embedding-ada-002": "eus2",
  "text-embedding-3-large": "eus2",
} as const satisfies Record<string, FoundryRegion>;

type Profile = { model: keyof typeof deploymentRegions; reasoningEffort?: ReasoningEffort };

const advanced = { model: "gpt-6.2-sol", reasoningEffort: "high" } as const;
const judge = { model: "gpt-6.2-sol", reasoningEffort: "medium" } as const;

export const MODEL_CATALOG = {
  nano: { model: "gpt-6.1-terra", reasoningEffort: "low" },
  mini: { model: "gpt-6.2-sol", reasoningEffort: "low" },
  advanced,
  homeAssistant: advanced,
  offlineJudge: judge,
  onlineJudge: judge,
  onlineReviewer: judge,
  live: { model: "gpt-live-1" },
  embedding: { model: "text-embedding-ada-002" },
} as const satisfies Record<string, Profile>;

const regions = new Map<string, FoundryRegion>(Object.entries(deploymentRegions));

export function regionForDeployment(model: string): FoundryRegion {
  // Ad-hoc eval candidates not yet in the deployment catalog run in East US.
  return regions.get(model) ?? "eus";
}
