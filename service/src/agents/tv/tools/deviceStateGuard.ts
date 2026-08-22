import { TV_DEFAULT_WAIT_MS } from "../../../config";
import {
  callHAServiceDirect,
  getKnownDeviceStates,
} from "../../../ha";
import { HassState } from "../../../types/ha";
import { delay } from "../../common/utils";
import { getDeviceIntegration } from "./webSearch";
import { ToolExecutionContext } from "./types";

export interface DeviceStateGuardResult {
  remoteEntityId?: string;
  stateBefore?: string;
  stateAfter?: string;
  poweredOn: boolean;
  ready: boolean;
  observation: string;
}

function normalizeEntityName(entityId: string): string {
  return entityId
    .replace(/^[^.]+\./, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export async function getDeviceEntityState(
  entityId: string,
  context: ToolExecutionContext
): Promise<HassState> {
  await context.waitIfPaused?.();
  context.abortSignal?.throwIfAborted();
  const response = await fetch(
    `${context.homeAssistantUrl}/api/states/${encodeURIComponent(entityId)}`,
    {
      headers: {
        Authorization: `Bearer ${context.homeAssistantToken}`,
        "Content-Type": "application/json",
      },
      signal: context.abortSignal,
    }
  );
  await context.waitIfPaused?.();
  context.abortSignal?.throwIfAborted();

  if (!response.ok) {
    throw new Error(
      `Failed to fetch state for ${entityId}: HTTP ${response.status} ${response.statusText}`
    );
  }
  return (await response.json()) as HassState;
}

async function resolveRemoteEntityId(
  args: Record<string, unknown>
): Promise<string | undefined> {
  if (typeof args.remote_entity_id === "string") {
    return args.remote_entity_id;
  }

  if (typeof args.media_player_entity_id !== "string") {
    return undefined;
  }

  const requestedName = normalizeEntityName(args.media_player_entity_id);
  const states = await getKnownDeviceStates();
  return states.find(
    (state) =>
      state.entity_id.startsWith("remote.") &&
      normalizeEntityName(state.entity_id) === requestedName
  )?.entity_id;
}

/**
 * Re-check the target remote immediately before a non-power action. If it is
 * off, power it on first and then allow the requested command to continue.
 */
export async function ensureDeviceOnBeforeCommand(
  args: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<DeviceStateGuardResult> {
  const remoteEntityId = await resolveRemoteEntityId(args);
  if (!remoteEntityId) {
    return {
      poweredOn: false,
      ready: true,
      observation: "No matching remote entity was available for a state preflight.",
    };
  }

  await context.waitIfPaused?.();
  context.abortSignal?.throwIfAborted();
  const before = await getDeviceEntityState(remoteEntityId, context);
  const stateBefore = before.state.toLowerCase();

  if (stateBefore !== "off") {
    const ready = stateBefore === "on";
    return {
      remoteEntityId,
      stateBefore: before.state,
      stateAfter: before.state,
      poweredOn: false,
      ready,
      observation:
        `Checked ${remoteEntityId}: state is "${before.state}".` +
        `${ready ? "" : " The remote is not ready for commands."}`,
    };
  }

  const integration = getDeviceIntegration(remoteEntityId);
  const powerResult =
    integration === "samsungtv"
      ? await callHAServiceDirect("remote", "turn_on", remoteEntityId)
      : await callHAServiceDirect("remote", "send_command", remoteEntityId, {
          command: "wakeup",
        });

  if (!powerResult.success) {
    throw new Error(
      `State preflight found ${remoteEntityId} off, but power-on failed: ${powerResult.message}`
    );
  }

  const waitMs = Number.isFinite(TV_DEFAULT_WAIT_MS)
    ? Math.max(250, TV_DEFAULT_WAIT_MS)
    : 1500;
  await delay(waitMs, context.abortSignal);
  await context.waitIfPaused?.();
  context.abortSignal?.throwIfAborted();

  let stateAfter = "unknown";
  try {
    stateAfter = (await getDeviceEntityState(remoteEntityId, context)).state;
  } catch {
    // The power-on call succeeded, so a transient verification failure should
    // not suppress the user's requested command.
  }

  return {
    remoteEntityId,
    stateBefore: before.state,
    stateAfter,
    poweredOn: true,
    ready: stateAfter.toLowerCase() === "on",
    observation:
      `Checked ${remoteEntityId}: it was off, so ` +
      `${integration === "samsungtv" ? "remote.turn_on" : "remote.send_command(wakeup)"} ` +
      `was called before the requested command. Current state: "${stateAfter}".` +
      `${stateAfter.toLowerCase() !== "on" ? " The remote did not become ready, so the requested command was not sent." : ""}`,
  };
}
