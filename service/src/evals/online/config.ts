import path from "node:path";

export interface OnlineEvalConfig {
  enabled: boolean;
  directory: string;
  sampleRate: number;
  maxPending: number;
  maxEvidenceBytes: number;
  maxTextBytes: number;
  timeoutMs: number;
  pollMs: number;
}

function number(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!raw.trim() || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function onlineEvalConfig(): OnlineEvalConfig {
  return {
    enabled: process.env.ONLINE_EVAL_ENABLED !== "false",
    directory: path.resolve(process.env.ONLINE_EVAL_DIR || path.join(__dirname, "../../../generated_data/online-evals")),
    sampleRate: number("ONLINE_EVAL_SAMPLE_RATE", 1, 0, 1),
    maxPending: Math.floor(number("ONLINE_EVAL_MAX_PENDING", 500, 1, 10_000)),
    maxEvidenceBytes: number("ONLINE_EVAL_MAX_EVIDENCE_BYTES", 16_000_000, 1, 100_000_000),
    maxTextBytes: number("ONLINE_EVAL_MAX_TEXT_BYTES", 350_000, 1, 2_000_000),
    timeoutMs: number("ONLINE_EVAL_TIMEOUT_MS", 180_000, 10, 600_000),
    pollMs: number("ONLINE_EVAL_POLL_MS", 5_000, 50, 60_000),
  };
}
