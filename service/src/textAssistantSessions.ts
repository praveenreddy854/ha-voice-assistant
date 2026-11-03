import { randomUUID } from "crypto";
import { recordMemoryInteraction } from "./memory";
import type {
  TextAssistantHistoryItem,
  TextAssistantRunOptions,
  TextAssistantRunResult,
} from "./textAssistant";

export type TextAssistantSessionStatus =
  | "running"
  | "input_required"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export interface TextAssistantSessionSnapshot {
  conversationId: string;
  status: TextAssistantSessionStatus;
  message: string;
  inputReason?: string;
  createdAt: string;
  expiresAt: string;
  pollAfterMs?: number;
}

export interface TextAssistantSessionService {
  start(scopeId: string, command: string): TextAssistantSessionSnapshot;
  get(
    scopeId: string,
    conversationId: string
  ): TextAssistantSessionSnapshot | undefined;
  submitInput(
    scopeId: string,
    conversationId: string,
    answer: string
  ): TextAssistantSessionSnapshot | undefined;
  cancel(
    scopeId: string,
    conversationId: string
  ): TextAssistantSessionSnapshot | undefined;
}

type TextAssistantExecutor = (
  options: TextAssistantRunOptions
) => Promise<TextAssistantRunResult>;

const defaultTextAssistantExecutor: TextAssistantExecutor = async (options) => {
  const { runTextAssistant } = await import("./textAssistant");
  return runTextAssistant(options);
};

interface PendingInput {
  prompt: string;
  reason: string;
  resolve(answer: string): void;
  reject(error: Error): void;
}

interface ManagedSession {
  id: string;
  scopeId: string;
  command: string;
  status: TextAssistantSessionStatus;
  message: string;
  inputReason?: string;
  createdAt: number;
  expiresAt: number;
  terminalAt?: number;
  abortController: AbortController;
  expiryTimer: NodeJS.Timeout;
  pendingInput?: PendingInput;
  transcript: TextAssistantHistoryItem[];
}

interface TimedHistoryItem extends TextAssistantHistoryItem {
  createdAt: number;
}

export interface TextAssistantSessionManagerOptions {
  executor?: TextAssistantExecutor;
  sessionTtlMs?: number;
  terminalRetentionMs?: number;
  pollAfterMs?: number;
  now?: () => number;
}

const DEFAULT_SESSION_TTL_MS = 2 * 60 * 1000;
const DEFAULT_TERMINAL_RETENTION_MS = 5 * 60 * 1000;
const HISTORY_MAX_ITEMS = 10;
const HISTORY_MAX_AGE_MS = 5 * 60 * 1000;

export class TextAssistantSessionManager
  implements TextAssistantSessionService
{
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly historyByScope = new Map<string, TimedHistoryItem[]>();
  private readonly executor: TextAssistantExecutor;
  private readonly sessionTtlMs: number;
  private readonly terminalRetentionMs: number;
  private readonly pollAfterMs: number;
  private readonly now: () => number;

  constructor(options: TextAssistantSessionManagerOptions = {}) {
    this.executor = options.executor ?? defaultTextAssistantExecutor;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.terminalRetentionMs =
      options.terminalRetentionMs ?? DEFAULT_TERMINAL_RETENTION_MS;
    this.pollAfterMs = options.pollAfterMs ?? 2000;
    this.now = options.now ?? Date.now;
  }

  start(scopeId: string, command: string): TextAssistantSessionSnapshot {
    this.cleanup();
    const createdAt = this.now();
    const id = randomUUID();
    const expiryTimer = setTimeout(
      () => this.expireSession(id),
      this.sessionTtlMs
    );
    expiryTimer.unref?.();
    const session: ManagedSession = {
      id,
      scopeId,
      command,
      status: "running",
      message: "On it.",
      createdAt,
      expiresAt: createdAt + this.sessionTtlMs,
      abortController: new AbortController(),
      expiryTimer,
      transcript: [{ role: "user", content: command }],
    };
    this.sessions.set(session.id, session);

    void this.executeSession(session, this.historyFor(scopeId));
    return this.snapshot(session);
  }

  get(
    scopeId: string,
    conversationId: string
  ): TextAssistantSessionSnapshot | undefined {
    this.cleanup();
    const session = this.ownedSession(scopeId, conversationId);
    return session ? this.snapshot(session) : undefined;
  }

  submitInput(
    scopeId: string,
    conversationId: string,
    answer: string
  ): TextAssistantSessionSnapshot | undefined {
    this.cleanup();
    const session = this.ownedSession(scopeId, conversationId);
    if (!session) return undefined;
    if (session.status !== "input_required" || !session.pendingInput) {
      return this.snapshot(session);
    }

    const pending = session.pendingInput;
    session.pendingInput = undefined;
    session.status = "running";
    session.message = "On it.";
    session.inputReason = undefined;
    session.transcript.push({ role: "user", content: answer });
    pending.resolve(answer);
    return this.snapshot(session);
  }

  cancel(
    scopeId: string,
    conversationId: string
  ): TextAssistantSessionSnapshot | undefined {
    this.cleanup();
    const session = this.ownedSession(scopeId, conversationId);
    if (!session) return undefined;
    if (this.isTerminal(session.status)) return this.snapshot(session);
    this.finish(session, "cancelled", "Cancelled.");
    return this.snapshot(session);
  }

  private async executeSession(
    session: ManagedSession,
    history: TextAssistantHistoryItem[]
  ): Promise<void> {
    try {
      const result = await this.executor({
        command: session.command,
        history,
        abortSignal: session.abortController.signal,
        requestInput: (prompt, reason) =>
          this.requestInput(session, prompt, reason),
      });
      if (this.isTerminal(session.status)) return;
      const status = result.success ? "completed" : "failed";
      this.finish(session, status, result.message);
      this.rememberTranscript(session, result.message);
      if (result.success) {
        recordMemoryInteraction({
          agentType: "text_assistant",
          userText: session.command,
          assistantText: result.message,
        });
      }
    } catch (error) {
      if (this.isTerminal(session.status)) return;
      const message =
        error instanceof Error ? error.message : "The Text Assistant failed.";
      this.finish(session, "failed", message);
      this.rememberTranscript(session, message);
    }
  }

  private requestInput(
    session: ManagedSession,
    prompt: string,
    reason: string
  ): Promise<string> {
    if (this.isTerminal(session.status)) {
      return Promise.reject(new Error("The Shortcut voice turn has ended."));
    }
    if (session.pendingInput) {
      return Promise.reject(
        new Error("The Shortcut voice turn is already waiting for input.")
      );
    }
    return new Promise<string>((resolve, reject) => {
      session.status = "input_required";
      session.message = prompt;
      session.inputReason = reason;
      session.transcript.push({ role: "assistant", content: prompt });
      session.pendingInput = { prompt, reason, resolve, reject };
    });
  }

  private finish(
    session: ManagedSession,
    status: Exclude<TextAssistantSessionStatus, "running" | "input_required">,
    message: string
  ): void {
    session.status = status;
    session.message = message;
    session.inputReason = undefined;
    session.terminalAt = this.now();
    clearTimeout(session.expiryTimer);
    const error = new Error(message);
    session.pendingInput?.reject(error);
    session.pendingInput = undefined;
    if (!session.abortController.signal.aborted) {
      session.abortController.abort(error);
    }
  }

  private expireSession(conversationId: string): void {
    const session = this.sessions.get(conversationId);
    if (!session || this.isTerminal(session.status)) return;
    this.finish(session, "expired", "The request timed out after two minutes.");
  }

  private ownedSession(
    scopeId: string,
    conversationId: string
  ): ManagedSession | undefined {
    const session = this.sessions.get(conversationId);
    return session?.scopeId === scopeId ? session : undefined;
  }

  private historyFor(scopeId: string): TextAssistantHistoryItem[] {
    const now = this.now();
    const history = (this.historyByScope.get(scopeId) ?? []).filter(
      (item) => now - item.createdAt <= HISTORY_MAX_AGE_MS
    );
    const bounded = history.slice(-HISTORY_MAX_ITEMS);
    this.historyByScope.set(scopeId, bounded);
    return bounded.map(({ role, content }) => ({ role, content }));
  }

  private rememberTranscript(
    session: ManagedSession,
    finalMessage: string
  ): void {
    const createdAt = this.now();
    const history = this.historyByScope.get(session.scopeId) ?? [];
    history.push(
      ...session.transcript.map((item) => ({ ...item, createdAt })),
      { role: "assistant", content: finalMessage, createdAt }
    );
    this.historyByScope.set(
      session.scopeId,
      history
        .filter((item) => createdAt - item.createdAt <= HISTORY_MAX_AGE_MS)
        .slice(-HISTORY_MAX_ITEMS)
    );
  }

  private cleanup(): void {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (
        session.terminalAt != null &&
        now - session.terminalAt > this.terminalRetentionMs
      ) {
        clearTimeout(session.expiryTimer);
        this.sessions.delete(id);
      }
    }
    for (const scopeId of this.historyByScope.keys()) {
      this.historyFor(scopeId);
    }
  }

  private snapshot(session: ManagedSession): TextAssistantSessionSnapshot {
    return {
      conversationId: session.id,
      status: session.status,
      message: session.message,
      inputReason: session.inputReason,
      createdAt: new Date(session.createdAt).toISOString(),
      expiresAt: new Date(session.expiresAt).toISOString(),
      pollAfterMs:
        session.status === "running" ? this.pollAfterMs : undefined,
    };
  }

  private isTerminal(status: TextAssistantSessionStatus): boolean {
    return (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "expired"
    );
  }
}
