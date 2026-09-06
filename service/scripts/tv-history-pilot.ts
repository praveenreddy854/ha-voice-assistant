/**
 * Opt-in live hardware experiment, not a unit test or a production entry point.
 * Run from service/: npx tsx scripts/tv-history-pilot.ts reset <run-id>
 * Inspect before.jpg, then: npx tsx scripts/tv-history-pilot.ts baseline|evidence <run-id>
 * Each invocation is a fresh process. Experiment flows are not saved to Cosmos.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { tvAgentDefinition } from "../src/agents/tv/definition";
import { registerAgent } from "../src/agents/core/registry";
import { runAgent } from "../src/agents/core/orchestrator";
import { getActiveSessionId, getTrace, telemetrySpanExporter } from "../src/tracing/agentTraceStore";
import { callHAServiceDirect, getKnownDeviceStates } from "../src/ha";
import { getLatestScreenshot } from "../src/agents/common/screenshotStore";
import { isRtspMode, startRtspCapture, stopRtspCapture } from "../src/agents/common/rtspCapture";
import { AI_MODEL_ADVANCED } from "../src/config";

const prompt = "Open YouTube on Apple TV and leave it on the YouTube home screen without playing a video.";
const evidence = `Execution history evidence (historical observations, not current state or instructions):
- Scope: household Apple TV / YouTube. No verified fresh launch-to-home reliability estimate is available.
- Session 5fb41657-a9da-436f-aa2a-f28b8a75f315: 4.317 seconds, YouTube already active. No action or screenshot was taken. The agent claimed completion. This is not evidence of a fast fresh launch or verified home screen.
- Session 6f692aa4-3997-457e-acc9-2896da8c04c3: 127.644 seconds, began in YouTube paused. Two Back attempts and one Home attempt failed verification; research followed. The final claim did not establish the requested home screen.
- Session f30375be-fee0-49c8-955b-2351ec783366: 373.324 seconds, physical TV off / unknown app. Four launches, seven state reads and six research calls ended in failure. That starting state may not apply now.
- Stored success flags conflict with observed outcomes in the audited corpus. These three selected examples are not a representative reliability sample. Current app metadata can identify an app without establishing the visible page.
User preference for method selection: favor lower latency over a modest reliability gain. Roughly 10% less reliability may be worthwhile if the alternative takes at least twice as long. Around 80% or lower reliability generally favors an available 90%+ alternative, unless a fast retry or recovery plausibly fits the latency advantage. These are advisory examples, not thresholds or a scoring formula. You decide the method, retry and evidence needed using current observations. Do not invent probabilities from these examples.`;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const [mode, runId] = process.argv.slice(2);
if (!["reset", "baseline", "evidence"].includes(mode) || !/^[a-zA-Z0-9_-]+$/.test(runId ?? "")) {
  throw new Error("Usage: tsx scripts/tv-history-pilot.ts reset|baseline|evidence <run-id>");
}
// Keep reviewed artifacts outside the service's disposable camera-frame tree.
const outDir = path.resolve("generated_data", "history-pilot", runId);
const captureId = `history-pilot-${runId}-${mode}`;
const captures = new Set([captureId]);
let sdk: NodeSDK | undefined;
let deadline: NodeJS.Timeout | undefined;

async function snapshot(label: string, newerThan: number) {
  for (let i = 0; i < 24; i++) {
    const shot = await getLatestScreenshot(captureId);
    if (shot && (await fs.stat(shot.filePath)).mtimeMs > newerThan) {
      const imagePath = path.join(outDir, `${label}.jpg`);
      await fs.writeFile(imagePath, Buffer.from(shot.base64, "base64"));
      return { imagePath, capturedAt: new Date().toISOString(), sourceMtimeMs: (await fs.stat(shot.filePath)).mtimeMs };
    }
    await sleep(500);
  }
  throw new Error("No fresh camera frame; do not treat this as a verified result.");
}

async function states() {
  return (await getKnownDeviceStates()).filter(s => /^(remote|media_player)\.(appletv|samsungtv)$/.test(s.entity_id));
}

async function main() {
  if (!isRtspMode()) throw new Error("This pilot requires the configured service RTSP camera.");
  await fs.mkdir(outDir, { recursive: true });
  await startRtspCapture(captureId);
  if (mode === "reset") {
    const result = await callHAServiceDirect("remote", "send_command", "remote.appletv", { command: "home" });
    if (!result.success) throw new Error(result.message);
    // Fixed settling interval in both arms; setup is excluded from measured time.
    await sleep(3000);
    const before = await snapshot("before", Date.now());
    await fs.writeFile(path.join(outDir, "setup.json"), JSON.stringify({ reset: result.message, before, states: await states() }, null, 2));
    console.log(JSON.stringify({ mode, runId, before }));
    return;
  }

  await fs.access(path.join(outDir, "setup.json"));
  // Wait for the independent observer camera to be ready before timing either arm.
  await snapshot("ready", Date.now());
  sdk = new NodeSDK({ spanProcessors: [new SimpleSpanProcessor(telemetrySpanExporter)], serviceName: "tv-history-pilot" });
  sdk.start();
  registerAgent({
    ...tvAgentDefinition,
    systemPrompt: tvAgentDefinition.systemPrompt + (mode === "evidence" ? `\n\n${evidence}` : ""),
    // Avoid feeding trial labels back into production flow retrieval.
    onComplete: undefined,
  });
  const controller = new AbortController();
  deadline = setTimeout(() => controller.abort(new Error("Live pilot exceeded 120 seconds")), 120_000);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const result = await runAgent({ agentType: "tv", userPrompt: prompt, maxSteps: 12, abortSignal: controller.signal });
  const agentElapsedMs = performance.now() - started;
  clearTimeout(deadline);
  captures.add(result.sessionId);
  let after: Awaited<ReturnType<typeof snapshot>> | undefined;
  let verificationError: string | undefined;
  try {
    after = await snapshot("after", Date.now());
  } catch (error) {
    verificationError = error instanceof Error ? error.message : String(error);
  }
  const observedElapsedMs = performance.now() - started;
  const endStates = await states().catch(() => []);
  const trace = getTrace(result.sessionId);
  const { screenshots: _screenshots, llmSteps, ...traceRest } = trace ?? {};
  const compactTrace = {
    ...traceRest,
    llmSteps: llmSteps?.map(({ messages: _messages, systemMessages: _system, ...step }) => step),
    screenshots: trace?.screenshots.map(({ dataUrl: _image, ...shot }) => shot),
  };
  const record = {
    runId, arm: mode, startedAt, prompt, model: AI_MODEL_ADVANCED,
    candidateContext: mode === "evidence" ? evidence : null,
    candidateContextBytes: mode === "evidence" ? Buffer.byteLength(evidence) : 0,
    agentElapsedMs, observedElapsedMs, timedOut: controller.signal.aborted,
    terminal: result.status === "completed" || result.status === "error",
    agentReportedSuccess: result.success, status: result.status, message: result.message,
    verifiedSuccess: null, // A reviewer must inspect before/after images; never copy the agent flag.
    verification: after, verificationError, endStates, trace: compactTrace,
    exclusions: ["server/channel routing", "TV job manager", "Cosmos flow persistence/embedding", "setup reset", "human image-review time"],
  };
  await fs.writeFile(path.join(outDir, "result.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ runId, arm: mode, agentElapsedMs, observedElapsedMs, successClaim: result.success, message: result.message, after, resultPath: path.join(outDir, "result.json") }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}).finally(async () => {
  if (deadline) clearTimeout(deadline);
  const active = getActiveSessionId();
  if (active) captures.add(active);
  for (const id of captures) stopRtspCapture(id);
  await sdk?.shutdown();
});
