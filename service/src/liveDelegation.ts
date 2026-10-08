export interface VoiceHistoryItem {
  role: "user" | "assistant";
  content: string;
  createdAt: number;
}

export interface LiveDelegationRequest {
  command: string;
  history: VoiceHistoryItem[];
  signal: AbortSignal;
  delegationId: string | null;
}

interface DelegationOptions {
  history: VoiceHistoryItem[];
  run(request: LiveDelegationRequest): Promise<string>;
  reply(content: string, delegationId: string | null, quiet?: boolean): void;
  onIdle(): void;
}

/** Assemble requests only when both delegation and a settled transcript exist. */
export class LiveDelegationController {
  private text = "";
  private pending = new Set<string | null>();
  private seen = new Set<string>();
  private settleTimer?: NodeJS.Timeout;
  private emptyTimer?: NodeJS.Timeout;
  private queue = Promise.resolve();
  private queued = 0;
  private abort = new AbortController();
  private settledWithoutDelegation = false;

  constructor(private options: DelegationOptions) {}

  get busy(): boolean { return this.pending.size > 0 || this.queued > 0; }

  appendTranscript(delta: string): void {
    if (this.abort.signal.aborted) return;
    if (this.settledWithoutDelegation && !this.pending.size) this.text = "";
    this.settledWithoutDelegation = false;
    this.text += delta;
    this.schedule();
  }

  delegate(id: string): void {
    if (this.abort.signal.aborted || !id || this.seen.has(id)) return;
    this.seen.add(id);
    this.pending.add(id);
    this.schedule();
    if (!this.emptyTimer) this.emptyTimer = setTimeout(() => {
      this.emptyTimer = undefined;
      if (this.text.trim()) return;
      for (const id of this.pending) {
        this.options.reply(this.queued ? "The application is already handling this request." : "Please repeat the complete request; I did not receive its transcript.", id, this.queued > 0);
      }
      this.pending.clear();
      this.options.onIdle();
    }, 5000);
  }

  /** Browser wake-word text is already an explicitly submitted user request. */
  submitText(text: string): void {
    if (this.abort.signal.aborted) return;
    this.text += `${this.text ? " " : ""}${text}`;
    this.pending.add(null);
    this.schedule();
  }

  private schedule(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => this.flush(), 800);
  }

  private flush(): void {
    this.settleTimer = undefined;
    const command = this.text.trim();
    if (this.abort.signal.aborted) return;
    if (!this.pending.size) { this.settledWithoutDelegation = true; return; }
    if (!command) return;
    this.settledWithoutDelegation = false;
    const ids = [...this.pending];
    this.pending.clear();
    this.text = "";
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.emptyTimer = undefined;
    this.queued++;
    this.queue = this.queue.then(async () => {
      if (this.abort.signal.aborted) return;
      const now = Date.now();
      const history = this.options.history;
      while (history.length && (history.length > 10 || now - history[0].createdAt > 5 * 60_000)) history.shift();
      let message: string;
      try {
        message = await this.options.run({ command, history: [...history], signal: this.abort.signal, delegationId: ids[0] });
      } catch (error) {
        if (this.abort.signal.aborted) return;
        message = `The request failed: ${error instanceof Error ? error.message : "Unknown error"}`;
      }
      if (this.abort.signal.aborted) return;
      history.push({ role: "user", content: command, createdAt: now }, { role: "assistant", content: message, createdAt: Date.now() });
      while (history.length > 10) history.shift();
      // Several IDs for one settled utterance share a result, with one spoken copy.
      ids.forEach((id, index) => this.options.reply(message, id, index > 0));
    }).finally(() => {
      this.queued--;
      if (!this.abort.signal.aborted) this.options.onIdle();
    });
  }

  dispose(): void {
    this.abort.abort(new Error("Voice session closed"));
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.pending.clear();
  }
}
