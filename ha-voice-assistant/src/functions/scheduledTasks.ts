import { Response } from "../types/response";
import { messageHistoryManager } from "../utils/sessionManager";

export interface ScheduledTaskEffect {
  kind: "announcement" | "action";
  command?: string;
  entityId?: string;
}

export interface ScheduledTask {
  id: string;
  recurrenceFamilyId: string;
  title: string;
  description?: string;
  effect: ScheduledTaskEffect;
  dueDate: string;
  isRecurring: boolean;
  recurringPattern?: { type: string; interval: number };
  status: "active";
  category: string;
  priority: string;
  createdAt: string;
  updatedAt: string;
}

interface AgentRunResponse {
  success: boolean;
  message: string;
  sessionId: string;
  status: string;
}

const BASE_URL = "http://localhost:3005";

export const runScheduledTaskAgent = async (
  text: string
): Promise<Response<AgentRunResponse>> => {
  try {
    const response = await fetch(`${BASE_URL}/api/agent/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentType: "scheduled_task",
        userPrompt: text,
        messageHistory: messageHistoryManager.getContextualHistory(),
      }),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status}: ${body}`);
    }
    const data = (await response.json()) as AgentRunResponse;
    if (data.message) {
      messageHistoryManager.addMessage("assistant", data.message);
    }
    return { success: true, data, message: data.message };
  } catch (error) {
    console.error("Error running scheduled-task agent:", error);
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};

export const listScheduledTasks = async (): Promise<
  Response<ScheduledTask[]>
> => {
  try {
    const response = await fetch(`${BASE_URL}/api/scheduled-tasks`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { tasks: ScheduledTask[] };
    return { success: true, data: data.tasks };
  } catch (error) {
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};

export const cancelScheduledTask = async (
  id: string,
  recurrenceFamilyId: string
): Promise<Response<boolean>> => {
  try {
    const url = `${BASE_URL}/api/scheduled-tasks/${encodeURIComponent(
      id
    )}?recurrenceFamilyId=${encodeURIComponent(recurrenceFamilyId)}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { success: boolean };
    return { success: true, data: data.success };
  } catch (error) {
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};

export const cancelRecurrenceFamily = async (
  recurrenceFamilyId: string
): Promise<Response<number>> => {
  try {
    const url = `${BASE_URL}/api/scheduled-tasks/family/${encodeURIComponent(
      recurrenceFamilyId
    )}`;
    const response = await fetch(url, { method: "DELETE" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { deleted: number };
    return { success: true, data: data.deleted };
  } catch (error) {
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
};
