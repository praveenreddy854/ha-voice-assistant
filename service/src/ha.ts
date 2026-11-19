import { HOME_ASSISTANT_URL, HOME_ASSISTANT_TOKEN, AI_MODEL_HOME_ASSISTANT, AI_MODEL_HOME_ASSISTANT_REASONING_EFFORT } from "./config";
import fs from "fs";
import path from "path";
import { HassServiceCommandBody, HassServiceCommand, HassState, HassTranslationResponse } from "./types/ha";
import { generateCompletion } from "./ai";
import axios from "axios";
import { z } from "zod";
import {
  formatMemoryContext,
  retrieveMemories,
} from "./memory";
import { getTracer } from "./tracing";
import type { AgentPauseGate } from "./agents/core/types";
import { delay } from "./agents/common/utils";
import { createHash, randomUUID } from "node:crypto";
import { addEvent, addLLMStep, completeTrace, createTrace, getActiveSessionId, trackToolResult, withTraceSession } from "./tracing/agentTraceStore";
import { getRequestContext } from "./requestContext";
import { safeErrorDetails } from "./logSanitizer";

function retainHAEvidence(callback: () => void): void {
  try { callback(); } catch { console.error("[HA telemetry] Evidence capture failed"); }
}

const promptCache = new Map<string, string>();
const homeAssistantCacheKey = "HOMEASSISTANT";
const INTERNAL_WAIT_URL_PATH = "internal/wait";
const MAX_PLAN_WAIT_MS = 30000;
const SERVICE_DATA_TARGET_SELECTORS = ["entity_id", "area_id", "device_id", "floor_id", "label_id", "target"];
const haWaitDataSchema = z.object({
  duration_ms: z.number().int().positive().max(MAX_PLAN_WAIT_MS),
  reason: z.string().max(160).optional(),
}).strict();
const haCommandSchema: z.ZodType<HassServiceCommand> = z.object({
  url_path: z.string().trim().min(1).refine(value => {
    const normalized = normalizeHAUrlPath(value);
    const parts = normalized.split("/");
    if (parts.length !== 2 || parts.some(part => !part.trim())) return false;
    // Reject malformed state lookups before an earlier action can execute.
    try {
      return parts[0] !== "states" || Boolean(stateLookupEntityId(normalized));
    } catch {
      return false;
    }
  }),
  entity_id: z.string().trim().min(1),
  service_data: z.record(z.string(), z.unknown()).optional(),
}).passthrough().superRefine((command, context) => {
  if ("error" in command || "clarification" in command) {
    context.addIssue({ code: "custom", message: "A command cannot contain a translation outcome." });
  }
  if (normalizeHAUrlPath(command.url_path) !== INTERNAL_WAIT_URL_PATH) return;
  if (command.entity_id !== "__internal_wait__" || !haWaitDataSchema.safeParse(command.service_data).success) {
    context.addIssue({ code: "custom", message: "Wait steps require __internal_wait__ and an integer duration_ms from 1 to 30000." });
  }
});
const haTranslationSchema: z.ZodType<HassTranslationResponse> = z.union([
  haCommandSchema,
  z.array(haCommandSchema).min(1),
  z.object({ error: z.literal("no_match") }).strict(),
  z.object({ clarification: z.string().trim().min(1).max(1000) }).strict(),
]).superRefine((body, context) => {
  if (!Array.isArray(body) && ("error" in body || "clarification" in body)) return;
  const commands = Array.isArray(body) ? body : [body];
  const totalWaitMs = commands.reduce((total, command) => total +
    (normalizeHAUrlPath(command.url_path) === INTERNAL_WAIT_URL_PATH ? Number(command.service_data?.duration_ms) : 0), 0);
  if (totalWaitMs > MAX_PLAN_WAIT_MS) {
    context.addIssue({ code: "custom", message: "Command plans may wait at most 30000ms in total. Use a scheduled task for longer delays." });
  }
});
const MEDIA_TRANSPORT_SERVICES: Record<string, string> = {
  pause: "media_pause",
  play: "media_play",
  play_pause: "media_play_pause",
  stop: "media_stop",
  next: "media_next_track",
  previous: "media_previous_track",
};

export interface HAExecutionOptions {
  abortSignal?: AbortSignal;
  pauseGate?: AgentPauseGate;
}

async function waitForRunPermission(
  options?: HAExecutionOptions
): Promise<void> {
  options?.abortSignal?.throwIfAborted();
  await options?.pauseGate?.waitIfPaused();
  options?.abortSignal?.throwIfAborted();
}

export async function getHACommandBody(
  command: string,
  messageHistory?: Array<{ role: string; content: string }>,
  options?: HAExecutionOptions,
  memoryContext = ""
): Promise<HassTranslationResponse> {
  await waitForRunPermission(options);
  const deviceStates = await getDeviceStates(undefined, options);
  const prompt = renderHAPrompt(command, deviceStates, memoryContext);

  // Combine message history with current prompt
  const messages = [
    ...(messageHistory || []),
    { role: "user", content: prompt },
  ];

  let stage = "model_request";
  try {
    const started = Date.now();
    const responseText = await generateCompletion({
      model: AI_MODEL_HOME_ASSISTANT || "",
      reasoningEffort: AI_MODEL_HOME_ASSISTANT_REASONING_EFFORT,
      messages,
      abortSignal: options?.abortSignal,
    });
    const sessionId = getActiveSessionId();
    if (sessionId) retainHAEvidence(() => {
      addEvent(sessionId, "ha.translation.configuration", "Home Assistant translation configuration", {
        model: AI_MODEL_HOME_ASSISTANT || "unreported",
        reasoningEffort: AI_MODEL_HOME_ASSISTANT_REASONING_EFFORT,
        promptVersion: createHash("sha256").update(promptCache.get(homeAssistantCacheKey) || "").digest("hex").slice(0, 24),
      });
      addLLMStep(sessionId, {
        stepNumber: 1, timestamp: new Date(started).toISOString(), finishReason: "translation_response",
        requestModel: AI_MODEL_HOME_ASSISTANT, reasoningEffort: AI_MODEL_HOME_ASSISTANT_REASONING_EFFORT,
        text: responseText, toolCalls: [], messages,
        responseTimeMs: Date.now() - started,
      });
    });
    await waitForRunPermission(options);
    stage = "response_parse";
    const body = haTranslationSchema.parse(JSON.parse(responseText));
    stage = "plan_validation";
    if (Array.isArray(body) || !("error" in body || "clarification" in body)) {
      validateHAPlan(body, deviceStates);
      validateHAPlan(normalizeMediaTransportCommands(body).body, deviceStates);
    }
    return body;
  } catch (error) {
    if (options?.abortSignal?.aborted) {
      throw options.abortSignal.reason ?? error;
    }
    const details = { stage, model: AI_MODEL_HOME_ASSISTANT || "unreported", ...safeErrorDetails(error) };
    console.error("Failed to get Home Assistant command:", details);
    const sessionId = getActiveSessionId();
    if (sessionId) retainHAEvidence(() => addEvent(sessionId, "ha.translation.failed", "Home Assistant command translation failed", details));
    throw new Error("Failed to process Home Assistant command (" + stage +
      (details.statusCode ? ", HTTP " + details.statusCode : "") + ")");
  }
}

export async function getHAPrompt(command: string, options?: HAExecutionOptions): Promise<string> {
  return renderHAPrompt(command, await getDeviceStates(undefined, options));
}

function renderHAPrompt(
  command: string,
  deviceStates: Record<string, HassState[]>,
  memoryContext = ""
): string {
  if (!promptCache.has(homeAssistantCacheKey)) {
    const prompt = fs.readFileSync(
      path.join(__dirname, "prompts", "HOMEASSISTANT.md"),
      "utf8"
    );
    promptCache.set(homeAssistantCacheKey, prompt);
  }

  // Cache only the template; current devices and scoped memory are per request.
  const values: Record<string, string> = {
    Devices: JSON.stringify(deviceStates, null, 2),
    Memory: memoryContext || "No relevant persistent memory.",
    UserCommand: command,
  };
  return promptCache.get(homeAssistantCacheKey)!
    .replace(/\{\{\{(Devices|Memory|UserCommand)\}\}\}/g, (_match, key: string) => values[key]);
}

function validateHAPlan(body: HassTranslationResponse, deviceStates: Record<string, HassState[]>): void {
  if (!Array.isArray(body) && ("error" in body || "clarification" in body)) return;
  const states = new Map(Object.values(deviceStates).flat().map(state => [state.entity_id, state]));
  for (const command of Array.isArray(body) ? body : [body]) {
    const urlPath = normalizeHAUrlPath(command.url_path);
    if (urlPath === INTERNAL_WAIT_URL_PATH) continue;
    const state = states.get(command.entity_id);
    if (!state) throw new Error("The command references an entity outside the current configured device list.");
    if (command.service_data && SERVICE_DATA_TARGET_SELECTORS.some(key =>
      Object.prototype.hasOwnProperty.call(command.service_data, key)
    )) throw new Error("Service data must not add or override the command target.");
    if (urlPath.startsWith("states/")) {
      if (stateLookupEntityId(urlPath) !== command.entity_id) throw new Error("State lookup and command entity must match.");
      continue;
    }
    if (!/^[a-z][a-z0-9_]*\/[a-z][a-z0-9_]*$/.test(urlPath)) throw new Error("Invalid Home Assistant service path.");
    if (urlPath === "select/select_option") {
      const option = command.service_data?.option;
      if (typeof option !== "string" || !Array.isArray(state.attributes.options) || !state.attributes.options.includes(option)) {
        throw new Error("The selected option is not available in the current device options.");
      }
    }
  }
}

export async function fetchAllStates(
  options?: HAExecutionOptions
): Promise<HassState[]> {
  await waitForRunPermission(options);
  const response = await axios.get(
    `${HOME_ASSISTANT_URL}/api/states`,
    {
      headers: {
        Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
        "Content-Type": "application/json",
      },
      signal: options?.abortSignal,
    } as any
  );
  await waitForRunPermission(options);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Failed to fetch devices: ${response.statusText}`);
  }

  return response.data as HassState[];
}

/** Fetch one entity directly from Home Assistant's state endpoint. */
export async function getHAEntityState(
  entityId: string,
  options?: HAExecutionOptions
): Promise<HassState> {
  await waitForRunPermission(options);
  const response = await axios.get(
    `${HOME_ASSISTANT_URL}/api/states/${encodeURIComponent(entityId)}`,
    {
      headers: {
        Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
        "Content-Type": "application/json",
      },
      signal: options?.abortSignal,
    } as any
  );
  await waitForRunPermission(options);

  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Failed to fetch state for ${entityId}: ${response.statusText}`
    );
  }

  return response.data as HassState;
}

async function getDeviceStates(
  devicesEntities?: string[],
  options?: HAExecutionOptions
): Promise<Record<string, HassState[]>> {
  const states = await fetchAllStates(options);

  // Create devices object to devices.json
  // const devicesFilePath = path.join(__dirname, "devices.json");
  // if (!fs.existsSync(devicesFilePath)) {
  //   fs.writeFileSync(devicesFilePath, JSON.stringify(states, null, 2));
  // }

  const devices: Record<string, HassState[]> = {};
  const knownDevices = await getKnownDevices();

  // Group devices by domain
  states.forEach((state) => {
    const [_, device = ""] = state.entity_id.split(".");

    if (matchesKnownDevice(device, knownDevices, state.entity_id)) {
      if (!devices[device]) {
        devices[device] = [];
      }
      devices[device].push(state);
    }
  });

  if (devicesEntities) {
    return Object.keys(devices).reduce((acc, device) => {
      acc[device] = devices[device].filter((state) =>
        devicesEntities.includes(state.entity_id)
      );
      return acc;
    }, {} as Record<string, HassState[]>);
  }
  return devices;
}

export const getKnownDevices = async (): Promise<string[]> => {
  const devices = process.env.HOME_ASSISTANT_DEVICES;
  return devices
    ? devices
        .split(",")
        .map((device) => device.trim())
        .filter(Boolean)
    : [];
};

export const matchesKnownDevice = (
  entityFragment: string,
  knownDevices: string[],
  fullEntityId?: string
): boolean => {
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
};

/**
 * Fetches and filters Home Assistant device states based on known devices configuration.
 * Returns only states that match the configured known devices.
 * If no known devices are configured, returns all states.
 *
 * @returns Promise<HassState[]> - Array of filtered device states
 */
export const getKnownDeviceStates = async (): Promise<HassState[]> => {
  const [states, knownDevices] = await Promise.all([
    fetchAllStates(),
    getKnownDevices(),
  ]);

  const shouldFilter = knownDevices.length > 0;

  if (!shouldFilter) {
    return states;
  }

  return states.filter((state) => {
    const [, entity = ""] = state.entity_id.split(".");
    return matchesKnownDevice(entity, knownDevices, state.entity_id);
  });
};

/**
 * Execute a plain English Home Assistant command by converting it to the appropriate API call.
 * This function wraps the logic from /api/postHACommand endpoint for use within the TV agent tools.
 * Supports both single commands and arrays of commands (for multi-step operations like navigate + select).
 *
 * @param command - Plain English command like "Turn on Apple TV" or "Scroll right 3 times on apple tv"
 * @param messageHistory - Optional message history for context
 * @param options - Cooperative pause and cancellation controls for realtime runs
 * @returns Promise with success status and message
 */
export async function executeHACommand(
  command: string,
  messageHistory?: Array<{ role: string; content: string }>,
  options?: HAExecutionOptions
): Promise<{ success: boolean; message: string; data?: any }> {
  const parentSessionId = getActiveSessionId();
  const sessionId = `home-assistant-${randomUUID()}`;
  retainHAEvidence(() => {
    createTrace(sessionId, "home_assistant", command);
    addEvent(sessionId, "ha.execution.started", "Downstream Home Assistant command execution", {
      parentSessionId, model: AI_MODEL_HOME_ASSISTANT || "unreported",
      jobId: getRequestContext()?.jobId, originSessionId: getRequestContext()?.originSessionId,
      evidenceScope: "Command translation, memory augmentations and HTTP results. Transport acceptance does not establish physical completion; no unobserved state is inferred.",
    });
  });
  const jobId = getRequestContext()?.jobId;
  if (jobId) retainHAEvidence(() => addEvent(`job-${jobId}`, "job.child_session.started", "Home Assistant execution trace linked", { sessionId, agentType: "home_assistant" }));
  try {
    const result = await withTraceSession(sessionId, () => executeHACommandInternal(command, messageHistory, options));
    retainHAEvidence(() => completeTrace(sessionId, result.success, result.message, result.success ? "completed" : "error"));
    return result;
  } catch (error) {
    retainHAEvidence(() => completeTrace(sessionId, false, error instanceof Error ? error.message : String(error), "error"));
    throw error;
  }
}

async function executeHACommandInternal(
  command: string,
  messageHistory?: Array<{ role: string; content: string }>,
  options?: HAExecutionOptions
): Promise<{ success: boolean; message: string; data?: any }> {
  const span = getTracer().startSpan("ha.command.execute", {
    attributes: {
      "ha.command.text": command,
      "telemetry.kind": "ha_command",
    },
  });

  try {
    await waitForRunPermission(options);
    const memories = await retrieveMemories({
      query: command, agentType: "realtime", limit: 10,
      preferCache: false, useEmbedding: false,
    });
    const memoryContext = formatMemoryContext(memories);
    await waitForRunPermission(options);
    span.setAttribute("ha.memory.context_present", Boolean(memoryContext));
    span.setAttribute("ha.memory.ids", memories.map((item) => item.id).join(","));

    // Get the HA command body using the existing LLM function
    const generatedHaBody = await getHACommandBody(
      command,
      messageHistory,
      options,
      memoryContext
    );
    if (!Array.isArray(generatedHaBody) && ("error" in generatedHaBody || "clarification" in generatedHaBody)) {
      const message = "error" in generatedHaBody
        ? "Could not match the complete request to available Home Assistant controls. No matching Home Assistant device or supported action was found; no device requests were sent. Specify the device and action, or split the request."
        : `${generatedHaBody.clarification} No device requests were sent.`;
      span.setAttribute("ha.command.generated_body", JSON.stringify(generatedHaBody));
      span.setAttribute("ha.command.success", false);
      span.setAttribute("ha.command.result_message", message);
      const traceId = getActiveSessionId();
      if (traceId) retainHAEvidence(() => addEvent(traceId, "ha.translation.resolved", "Home Assistant command translation outcome", {
        generated: generatedHaBody, plan: generatedHaBody,
        memoryIds: memories.map(item => item.id),
        outcome: "error" in generatedHaBody ? "no_match" : "clarification",
      }));
      return { success: false, message, data: generatedHaBody };
    }
    const {
      body: haBody,
      normalizedCount: mediaTransportNormalizedCount,
    } = normalizeMediaTransportCommands(generatedHaBody);

    span.setAttribute("ha.command.generated_body", JSON.stringify(generatedHaBody));
    span.setAttribute("ha.command.final_body", JSON.stringify(haBody));
    span.setAttribute(
      "ha.command.media_transport_normalized_count",
      mediaTransportNormalizedCount
    );
    const traceId = getActiveSessionId();
    if (traceId) retainHAEvidence(() => addEvent(traceId, "ha.translation.resolved", "Generated and normalized command plan", {
      generated: generatedHaBody, plan: haBody, memoryIds: memories.map(item => item.id),
    }));
    
    // Handle array of commands (multi-step operations)
    if (Array.isArray(haBody)) {
      const result = await executeMultipleHACommands(haBody, command, options);
      span.setAttribute("ha.command.success", result.success);
      span.setAttribute("ha.command.result_message", result.message);
      return result;
    }
    
    // Handle single command
    const result = await executeSingleHACommand(haBody, command, options);
    span.setAttribute("ha.command.success", result.success);
    span.setAttribute("ha.command.result_message", result.message);
    return result;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    if (options?.abortSignal?.aborted) {
      span.setAttribute("ha.command.cancelled", true);
      throw options.abortSignal.reason ?? err;
    }
    console.error("Error executing HA command:", safeErrorDetails(err));
    span.setAttribute("ha.command.success", false);
    span.setAttribute("ha.command.error", err.message);
    return {
      success: false,
      message: `Error executing command: ${err.message}`,
    };
  } finally {
    span.end();
  }
}

/**
 * Execute a single Home Assistant command
 */
function normalizeHAUrlPath(urlPath: string): string {
  let normalized = urlPath.trim().replace(/^\/+|\/+$/g, "");
  if (normalized.startsWith("api/")) {
    normalized = normalized.substring("api/".length);
  }
  if (normalized.startsWith("services/")) {
    normalized = normalized.substring("services/".length);
  }
  return normalized;
}

/**
 * Prefer Home Assistant's media_player transport services over emulating
 * playback buttons through remote.send_command. The LLM prompt includes both
 * APIs because navigation still needs the remote, so enforce this invariant
 * after generation rather than relying on probabilistic model selection.
 */
export function normalizeMediaTransportCommands(
  body: HassServiceCommandBody
): { body: HassServiceCommandBody; normalizedCount: number } {
  let normalizedCount = 0;

  const normalize = (command: HassServiceCommand): HassServiceCommand => {
    if (normalizeHAUrlPath(command.url_path || "") !== "remote/send_command") {
      return command;
    }

    const topLevelCommand = (command as HassServiceCommand & {
      command?: unknown;
    }).command;
    const remoteCommand = command.service_data?.command ?? topLevelCommand;
    if (typeof remoteCommand !== "string") return command;

    const mediaService =
      MEDIA_TRANSPORT_SERVICES[remoteCommand.trim().toLowerCase()];
    if (!mediaService) return command;

    const entityId = command.entity_id.startsWith("remote.")
      ? `media_player.${command.entity_id.substring("remote.".length)}`
      : command.entity_id;
    normalizedCount++;
    return {
      url_path: `media_player/${mediaService}`,
      entity_id: entityId,
    };
  };

  return {
    body: Array.isArray(body) ? body.map(normalize) : normalize(body),
    normalizedCount,
  };
}

function stateLookupEntityId(urlPath: string): string | undefined {
  const parts = urlPath.split("/");
  if (parts.length !== 2 || parts[0] !== "states") {
    return undefined;
  }
  const entityId = decodeURIComponent(parts[1].trim());
  return entityId || undefined;
}

async function executeHAStateLookup(
  entityId: string,
  originalCommand: string,
  options?: HAExecutionOptions
): Promise<{ success: boolean; message: string; data?: any }> {
  const state = await getHAEntityState(entityId, options);
  const friendlyName = state.attributes?.friendly_name || entityId;
  console.log(`HA State retrieved: ${originalCommand}; Response:`, state);

  return {
    success: true,
    message: `${friendlyName} state is "${state.state}"`,
    data: state,
  };
}

async function executeSingleHACommand(
  haBody: HassServiceCommand,
  originalCommand: string,
  options?: HAExecutionOptions
): Promise<{ success: boolean; message: string; data?: any }> {
  const started = Date.now(), traceId = getActiveSessionId();
  const record = (observation: string, success: boolean) => {
    if (traceId) retainHAEvidence(() => trackToolResult(traceId, {
      toolCallId: randomUUID(),
      toolName: normalizeHAUrlPath(haBody.url_path) === INTERNAL_WAIT_URL_PATH ? "wait" : "home_assistant_request",
      args: { ...haBody },
      observation, toolSuccess: success, durationMs: Date.now() - started,
    }));
  };
  try {
    const result = await executeSingleHACommandInternal(haBody, originalCommand, options);
    record(JSON.stringify(result), result.success);
    return result;
  } catch (error) {
    record(safeErrorDetails(error).message, false);
    throw error;
  }
}

async function executeSingleHACommandInternal(
  haBody: HassServiceCommand,
  originalCommand: string,
  options?: HAExecutionOptions
): Promise<{ success: boolean; message: string; data?: any }> {
  await waitForRunPermission(options);
  const urlPath = normalizeHAUrlPath(haBody.url_path || "");
  if (urlPath === INTERNAL_WAIT_URL_PATH) {
    const { duration_ms: durationMs, reason } = haWaitDataSchema.parse(haBody.service_data);
    if (durationMs > 0) {
      await delay(durationMs, options?.abortSignal);
      await waitForRunPermission(options);
    }
    return {
      success: true,
      message: `Waited ${durationMs}ms`,
      data: { durationMs, reason },
    };
  }

  const stateEntityId = stateLookupEntityId(urlPath);
  const entityId = stateEntityId || haBody.entity_id;

  if (!urlPath || (!stateEntityId && urlPath.split("/").length !== 2)) {
    return {
      success: false,
      message:
        "Invalid home assistant path. Command body must contain a valid 'url_path' in the format '<domain>/<service>' or 'states/<entity_id>'",
    };
  }

  if (!entityId) {
    return {
      success: false,
      message: "Missing entity_id. Command body must contain 'entity_id'",
    };
  }

  if (stateEntityId) {
    return executeHAStateLookup(entityId, originalCommand, options);
  }

  // Restored/offline switches and lights may accept POSTs without doing anything.
  // Keep read-only queries above and remote/TV wake paths available.
  if (/^(switch|light|fan)\./.test(entityId)) {
    const state = await getHAEntityState(entityId, options);
    if (state.state === "unavailable" || state.attributes?.restored === true) {
      return {
        success: false,
        message: (state.attributes?.friendly_name || entityId) +
          " is unavailable in Home Assistant. Restore the device connection before retrying.",
        data: state,
      };
    }
  }

  // Prepare the request body
  const requestBody: any = { entity_id: entityId };

  // Add service_data if present (for play_media and other services that need additional data)
  if (haBody.service_data) {
    // For Home Assistant API, merge service_data fields directly at the top level
    Object.assign(requestBody, haBody.service_data);
  }

  const haResponse = await axios.post(
    `${HOME_ASSISTANT_URL}/api/services/${urlPath}`,
    requestBody,
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
      },
      signal: options?.abortSignal,
    } as any
  );
  await waitForRunPermission(options);

  if (haResponse.status < 200 || haResponse.status >= 300) {
    console.error("Home Assistant error response:", haResponse.data);
    return {
      success: false,
      message: `Home Assistant API returned status ${haResponse.status}`,
      data: haResponse.data,
    };
  }

  console.log(`HA Command executed: ${originalCommand}; Response:`, haResponse.data);
  return {
    success: true,
    message: `Command "${originalCommand}" sent successfully`,
    data: haResponse.data,
  };
}

/**
 * Call a Home Assistant service directly without LLM translation.
 * Use this for known, specific commands where domain/service/entity are already determined
 * (e.g., remote.send_command with wakeup/suspend).
 */
export async function callHAServiceDirect(
  domain: string,
  service: string,
  entityId: string,
  serviceData?: Record<string, unknown>,
  options?: HAExecutionOptions
): Promise<{ success: boolean; message: string; data?: any }> {
  await waitForRunPermission(options);
  try {
    const requestBody: Record<string, unknown> = { entity_id: entityId };
    if (serviceData) {
      Object.assign(requestBody, serviceData);
    }

    const response = await axios.post(
      `${HOME_ASSISTANT_URL}/api/services/${domain}/${service}`,
      requestBody,
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${HOME_ASSISTANT_TOKEN}`,
        },
        signal: options?.abortSignal,
        timeout: 30000,
      }
    );
    await waitForRunPermission(options);

    if (response.status < 200 || response.status >= 300) {
      return {
        success: false,
        message: `HA API returned status ${response.status}`,
        data: response.data,
      };
    }

    return {
      success: true,
      message: `${domain}.${service} called on ${entityId}`,
      data: response.data,
    };
  } catch (error) {
    if (options?.abortSignal?.aborted) throw options.abortSignal.reason ?? error;
    const err = error instanceof Error ? error : new Error(String(error));
    return {
      success: false,
      message: `Direct HA service call failed: ${err.message}`,
    };
  }
}

/**
 * Execute multiple Home Assistant commands in sequence
 * Used for multi-step operations like "scroll left 3 times then click select"
 */
async function executeMultipleHACommands(
  commands: HassServiceCommand[],
  originalCommand: string,
  options?: HAExecutionOptions
): Promise<{ success: boolean; message: string; data?: any }> {
  console.log(`Executing ${commands.length} HA commands in sequence for: ${originalCommand}`);
  
  const results: any[] = [];
  
  for (let i = 0; i < commands.length; i++) {
    await waitForRunPermission(options);
    const cmd = commands[i];
    console.log(`Executing command ${i + 1}/${commands.length}:`, cmd);
    
    let result: { success: boolean; message: string; data?: any };
    try {
      result = await executeSingleHACommand(cmd, `Step ${i + 1}: ${cmd.url_path}`, options);
    } catch (error) {
      // Cancellation belongs to the run lifecycle; transport failures belong to
      // this step so callers retain results from the completed part of the plan.
      options?.abortSignal?.throwIfAborted();
      const details = safeErrorDetails(error);
      result = {
        success: false,
        message: `Home Assistant request failed${details.statusCode ? ` (HTTP ${details.statusCode})` : ""}: ${details.message}`,
      };
    }
    results.push(result.data);
    
    if (!result.success) {
      const skipped = commands.length - i - 1;
      return {
        success: false,
        message: `Step ${i + 1} failed: ${result.message}. ${i}/${commands.length} commands succeeded; ${skipped} remaining commands skipped.`,
        data: results,
      };
    }
    
    // Add a small delay between commands to allow the device to process
    if (i < commands.length - 1) {
      await delay(300, options?.abortSignal);
    }
  }
  
  return {
    success: true,
    message: `All ${commands.length} commands executed successfully for "${originalCommand}"`,
    data: results,
  };
}
