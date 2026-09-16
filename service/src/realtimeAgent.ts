export const REALTIME_TOOLS = [
  {
    type: "function",
    name: "await_user_followup",
    description:
      "Call this BEFORE producing your spoken response whenever that response will be a question or a request for confirmation that the user must answer without saying the wake word again. Examples: asking for a Protected opening or Bulk destructive confirmation, asking a Clarification request, or asking a Specialist agent follow-up. Do NOT call this for routine completions, acknowledgements, or any response that does not require an answer from the user.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  {
    type: "function",
    name: "web_search",
    description:
      "Search the web for current information. Use when the user asks about recent events, news, facts, weather, or anything that needs up-to-date data.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "retrieve_memory",
    description:
      "Retrieve Persistent agent memory relevant to the user's question or request. Use for memory inspection and when injected memory is not enough.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The memory question or current user request.",
        },
        limit: {
          type: "number",
          description: "Maximum number of memory items to retrieve.",
        },
      },
      required: ["query"],
    },
  },
  {
    type: "function",
    name: "save_memory",
    description:
      "Save a durable user preference, stable fact, or reusable guidance item. Use immediately when the user says to remember something. For device-specific memory, identify the target device/room/domain/app in scopes; if unclear, ask the user before saving.",
    parameters: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "The durable memory sentence to save.",
        },
        memoryType: {
          type: "string",
          enum: ["preference", "fact", "guidance"],
        },
        scopes: {
          type: "object",
          description:
            "Where this memory applies. Use global=true for global preferences. For device-specific memory, provide deviceNames or deviceEntityIds.",
          properties: {
            global: { type: "boolean" },
            roomNames: { type: "array", items: { type: "string" } },
            deviceNames: { type: "array", items: { type: "string" } },
            deviceEntityIds: { type: "array", items: { type: "string" } },
            domains: { type: "array", items: { type: "string" } },
            appNames: { type: "array", items: { type: "string" } },
            people: { type: "array", items: { type: "string" } },
            agentTypes: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "update_memory",
    description:
      "Correct or replace an existing Persistent agent memory when the user changes a remembered fact or preference.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        query: {
          type: "string",
          description: "Use when the memory id is unknown.",
        },
        text: {
          type: "string",
          description: "Replacement memory text.",
        },
        memoryType: {
          type: "string",
          enum: ["preference", "fact", "guidance"],
        },
        scopes: {
          type: "object",
          properties: {
            global: { type: "boolean" },
            roomNames: { type: "array", items: { type: "string" } },
            deviceNames: { type: "array", items: { type: "string" } },
            deviceEntityIds: { type: "array", items: { type: "string" } },
            domains: { type: "array", items: { type: "string" } },
            appNames: { type: "array", items: { type: "string" } },
            people: { type: "array", items: { type: "string" } },
            agentTypes: { type: "array", items: { type: "string" } },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
      required: ["text"],
    },
  },
  {
    type: "function",
    name: "delete_memory",
    description:
      "Delete Persistent agent memory when the user asks to forget something.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        query: {
          type: "string",
          description: "Use when the memory id is unknown.",
        },
        limit: {
          type: "number",
          description: "Maximum number of matching memory items to delete.",
        },
      },
    },
  },
  {
    type: "function",
    name: "execute_home_assistant_command",
    description:
      "Start a server-owned Home Assistant command or state-query run. It executes asynchronously so long-running or multi-step actions can be paused, resumed, stopped, or changed. Routine commands do not need confirmation. Set confirmed=true only after the user confirms protected opening or bulk destructive actions.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "Plain English smart-home command or state question, scoped exactly to the user's request.",
        },
        confirmed: {
          type: "boolean",
          description:
            "True only after the user confirms a protected opening or bulk destructive action.",
        },
      },
      required: ["command"],
    },
  },
  {
    type: "function",
    name: "run_scheduled_task_agent",
    description:
      "Start a server-owned ScheduledTaskAgent run for creating, listing, querying, updating, or cancelling ScheduledTasks. It runs asynchronously and can be paused, resumed, stopped, or changed.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The user's full scheduled-task request.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: "start_tv_agent",
    description:
      "Start a server-owned async TVAgent job for TV or streaming-app navigation. The assistant should acknowledge with 'On it' and then stay silent unless user input or completion is needed.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "The user's full TV or streaming-app request.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    type: "function",
    name: "control_active_run",
    description:
      "Control the active TV, ScheduledTaskAgent, or Home Assistant run after the wake phrase has paused it. Use continue to resume the exact run, stop to cancel it, or change to cancel it and start a replacement. For change, provide the complete revised instruction and its target domain.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["continue", "stop", "change"],
          description: "How to handle the paused active run.",
        },
        prompt: {
          type: "string",
          description:
            "Required for change: the user's complete revised instruction.",
        },
        domain: {
          type: "string",
          enum: ["tv", "scheduled_task", "home_assistant"],
          description:
            "For change, the capability that should execute the revised request. Omit to keep the current run's domain.",
        },
        confirmed: {
          type: "boolean",
          description:
            "For a changed Home Assistant request, true only after protected or bulk destructive confirmation.",
        },
      },
      required: ["action"],
    },
  },
  {
    type: "function",
    name: "control_tv_agent",
    description:
      "Compatibility tool for controlling an existing TVAgent run. Prefer control_active_run; this preserves the existing TV-only continue, stop, and change flow.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["continue", "stop", "change"],
          description: "How to handle the paused TVAgent run.",
        },
        prompt: {
          type: "string",
          description:
            "Required for change: the user's complete revised TV or streaming-app request.",
        },
      },
      required: ["action"],
    },
  },
];

export function buildRealtimeInstructions(options: {
  devices?: readonly string[];
  address?: string;
} = {}): string {
  const HOME_ASSISTANT_DEVICES = options.devices ?? [];
  const USER_ADDRESS = options.address;
  const REALTIME_INSTRUCTIONS = `You are the Realtime Voice Agent for a Home Assistant voice assistant.

After the wake word, the user's live audio is streamed to you. Use Realtime turn detection. Use terse speech only for routine command acknowledgements and successful completions. Give questions and user-action requests enough detail to be understandable.

Language:
- Always speak English. Even if the user's request contains words in another language (song names, artist names, place names, etc.), keep your reply in English.
- Switch languages only if the user explicitly asks you to (e.g. "reply in Telugu", "speak Spanish"). Stay in the requested language until they ask you to switch back.

Capabilities:
- Answer general chat directly.
- Use execute_home_assistant_command for immediate smart-home commands and read-only device state questions.
- Use run_scheduled_task_agent for ScheduledTask creation, list/query, update, cancellation, and clarification.
- Use start_tv_agent for TV or streaming-app tasks that require navigation, screenshots, remote actions, app launching, search, typing, or playback.
- Use control_active_run to continue, stop, or change any TVAgent, ScheduledTaskAgent, or Home Assistant run that was paused by the wake phrase. control_tv_agent remains available only for compatibility with the existing TV flow.
- Use web_search when live/current information is needed.

Do not use a fixed priority order. Select the capability by request meaning. If the request is ambiguous, ask a short clarification question before acting.${
  HOME_ASSISTANT_DEVICES.length > 0
    ? `

Known smart-home devices ${HOME_ASSISTANT_DEVICES.join(", ")}.`
    : ""
}

Mic / follow-up policy:
- An active voice turn remains open for at most 30 seconds so the user can interrupt or answer a follow-up. After that window closes, the user must say the wake word again.
- If your next spoken response will be a question or a request for confirmation that the user must answer without saying the wake word, call await_user_followup BEFORE producing that response. This keeps the mic open for 30 seconds so the user can answer.
- Do NOT call await_user_followup for routine completions, acknowledgements ("On it", "Done"), or any response that does not require a user answer.
- The user can say the wake phrase while you are speaking to pause your response. A bare wake phrase is not a question: stop and wait silently for the follow-up utterance.
- If the follow-up is "continue speaking", "keep talking", or equivalent, continue the interrupted response from where it stopped without repeating the beginning.
- If the follow-up says stop, remain stopped. If it changes the request, answer the changed request instead.

Confirmation policy:
- Routine smart-home actions execute without confirmation.
- Protected opening actions require confirmation: opening or unlocking the front door, back door, or garage door.
- Bulk destructive actions require confirmation.
- If a tool returns confirmation_required, call await_user_followup, then ask the user to confirm.

Specialist behavior:
- Do not narrate tool calls or internal Specialist agent iterations.
- TVAgent, ScheduledTaskAgent, and Home Assistant runs are server-owned and async. When one starts for a command, say exactly "On it" and then stay silent.
- When control_active_run or control_tv_agent continues or changes a run, say exactly "On it". When it stops a run, say exactly "Done".
- After a routine command succeeds, say exactly "Done". Do not restate the command or result.
- Questions are different: answer them clearly and completely in language the user can understand. Do not shorten an answer to "Done" or impose the command-completion limit.
- Failures, clarifications, confirmations, and any response requiring user action must explain the relevant detail and what the user needs to do. Do not shorten them to a generic acknowledgement or completion.

Pausing and redirecting an active run:
- Saying the wake phrase while a TVAgent, ScheduledTaskAgent, or Home Assistant action is active pauses that exact run; it does not cancel or restart it.
- Interpret the user's follow-up in context of the paused run. For "continue", "resume", or equivalent, call control_active_run with action "continue".
- For "stop", "cancel", "nevermind", or equivalent, call control_active_run with action "stop".
- If the user corrects, redirects, or replaces the action, call control_active_run with action "change", include the complete revised request in prompt, and set domain to the capability that should execute it.
- If the follow-up is unrelated, answer it and leave the active run paused. Do not silently resume it.
- "Continue speaking" or "continue your answer" refers to your interrupted spoken response and must not resume a paused active run. Only resume the run when the user refers to the active action or simply says "continue" in that paused-action context.

Memory:
- Use the recent conversation only as short conversational memory.
- Compact Persistent agent memory may be injected for the current turn. Treat it as durable user preference or context, not current device truth.
- Current device state, active specialist state, and the user's newest instruction are authoritative over memory.
- Use retrieve_memory when the user asks what you remember or when injected memory is not enough.
- Use save_memory for explicit "remember..." requests. Fill concrete scopes: global=true for global preferences, deviceNames/deviceEntityIds for device memory, roomNames for room memory, domains for domain memory, appNames for app memory.
- If a memory request is device-related and the target is unclear, call await_user_followup and ask which device before saving.
- Use update_memory or delete_memory when the user corrects or asks to forget memory.${USER_ADDRESS ? ` The user's address is: ${USER_ADDRESS}. Use this for location-based queries like weather.` : ""}`;
  return REALTIME_INSTRUCTIONS;
}

export type RealtimeRunDomain = "tv" | "scheduled_task" | "home_assistant";

export function buildRealtimeTurnInstructions(options: {
  memoryContext?: string;
  activeRun?: { domain: RealtimeRunDomain; id: string; status: string } | null;
  interruptedAssistantText?: string | null;
}): string {
  const { activeRun, interruptedAssistantText, memoryContext } = options;
  const label = activeRun && {
    tv: "TV agent", scheduled_task: "ScheduledTaskAgent", home_assistant: "Home Assistant action",
  }[activeRun.domain];
  const activeRunContext = activeRun
    ? activeRun.status === "paused"
      ? `Runtime state: ${label} job ${activeRun.id} is PAUSED at the user's wake phrase. Interpret the user's current message as the follow-up decision. Use control_active_run with action "continue" to resume the exact same run, "stop" to cancel it, or "change" with a full replacement prompt when the user changes/corrects the requested action. For an unrelated question, answer it without changing the paused job.`
      : `Runtime state: ${label} job ${activeRun.id} is currently running.`
    : "";
  const interruptedResponseContext = interruptedAssistantText
    ? `Runtime state: The user interrupted your previous spoken response after hearing: "${interruptedAssistantText}". If the user says "continue speaking", "keep talking", or asks you to continue your answer, resume that response from where it stopped without repeating it. If they say stop, end the response. If they give a changed request, follow the new request. An explicit request to continue speaking refers to your interrupted answer, not a paused active run.`
    : "";
  return [memoryContext, activeRunContext, interruptedResponseContext].filter(Boolean).join("\n\n");
}

export function needsActionConfirmation(command: string): boolean {
  const normalized = command.toLowerCase();
  const protectedOpening =
    /\b(open|unlock)\b/.test(normalized) &&
    /\b(front door|back door|garage door|garage)\b/.test(normalized);
  const bulkDestructive =
    /\b(cancel|delete|remove|clear|turn off|shut off|disable)\b/.test(normalized) &&
    /\b(all|every|everything|entire|whole)\b/.test(normalized);
  return protectedOpening || bulkDestructive;
}
