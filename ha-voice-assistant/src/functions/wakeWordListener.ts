/// <reference types="dom-speech-recognition" />

export type WakeWordStatus = "stopped" | "starting" | "listening" | "reconnecting" | "error";

interface ListenerCallbacks {
  onStatus: (status: WakeWordStatus) => void;
  onTranscript: (text: string) => void;
  onError: (message: string) => void;
}

export function getSpeechRecognitionConstructor(): typeof SpeechRecognition | undefined {
  return window.SpeechRecognition ?? window.webkitSpeechRecognition;
}

/** Own the native lifecycle: transcript clearing must never abort recognition. */
export class WakeWordListener {
  private wanted = false;
  private recognition: SpeechRecognition | null = null;
  private stopping: Promise<void> = Promise.resolve();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private startedAt = 0;
  private lastActivityAt = 0;
  private audioEndedAt: number | undefined;
  private started = false;
  private speechActive = false;
  private failures = 0;

  constructor(
    private readonly callbacks: ListenerCallbacks,
    private readonly createRecognition = (): SpeechRecognition => {
      const Constructor = getSpeechRecognitionConstructor();
      if (!Constructor) throw new Error("Speech recognition is not supported in this browser.");
      return new Constructor();
    },
  ) {}

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.failures = 0;
    this.callbacks.onStatus("starting");
    this.watchdog = setInterval(this.checkHealth, 5000);
    window.addEventListener("online", this.resume);
    window.addEventListener("focus", this.resume);
    window.addEventListener("pageshow", this.resume);
    document.addEventListener("visibilitychange", this.resume);
    void this.begin();
  }

  stop(): Promise<void> {
    this.wanted = false;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    clearInterval(this.watchdog);
    this.watchdog = undefined;
    window.removeEventListener("online", this.resume);
    window.removeEventListener("focus", this.resume);
    window.removeEventListener("pageshow", this.resume);
    document.removeEventListener("visibilitychange", this.resume);
    this.callbacks.onStatus("stopped");
    this.retire();
    return this.stopping;
  }

  private readonly resume = (): void => {
    if (!this.wanted || document.visibilityState === "hidden") return;
    if (!this.recognition) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
      void this.begin();
    } else {
      this.checkHealth();
    }
  };

  private readonly checkHealth = (): void => {
    if (!this.wanted || !this.recognition) return;
    const now = Date.now();
    const startTimedOut = !this.started && now - this.startedAt >= 10000;
    const audioStopped = this.audioEndedAt !== undefined && now - this.audioEndedAt >= 5000;
    // Some engines stall without an end/error event. Renew long idle sessions
    // (including after laptop sleep), avoiding speech that is in progress.
    const idleRenewal = now - this.startedAt >= 5 * 60 * 1000 &&
      now - this.lastActivityAt >= 10000 &&
      (!this.speechActive || now - this.lastActivityAt >= 60000);
    if (startTimedOut || audioStopped || idleRenewal) this.retry(0);
  };

  private retry(delayMs?: number): void {
    if (!this.wanted || this.retryTimer !== undefined) return;
    this.callbacks.onStatus("reconnecting");
    this.retire();
    const backoff = delayMs ?? Math.min(30000, 500 * 2 ** Math.min(this.failures++, 6));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.begin();
    }, backoff);
  }

  private fail(message: string): void {
    void this.stop();
    this.callbacks.onStatus("error");
    this.callbacks.onError(message);
  }

  private async begin(): Promise<void> {
    await this.stopping;
    if (!this.wanted || this.recognition || this.retryTimer !== undefined) return;
    try {
      const recognition = this.createRecognition();
      this.recognition = recognition;
      this.started = false;
      this.speechActive = false;
      this.startedAt = this.lastActivityAt = Date.now();
      this.audioEndedAt = undefined;
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";
      let lastFinalIndex = -1;
      const isCurrent = () => this.wanted && this.recognition === recognition;

      recognition.onstart = () => {
        if (!isCurrent()) return;
        this.started = true;
        this.callbacks.onStatus("listening");
      };
      recognition.onaudiostart = () => {
        if (isCurrent()) this.audioEndedAt = undefined;
      };
      recognition.onaudioend = () => {
        if (isCurrent()) this.audioEndedAt = Date.now();
      };
      recognition.onsoundstart = () => {
        if (isCurrent()) this.lastActivityAt = Date.now();
      };
      recognition.onspeechstart = () => {
        if (!isCurrent()) return;
        this.lastActivityAt = Date.now();
        this.speechActive = true;
      };
      recognition.onspeechend = () => {
        if (!isCurrent()) return;
        this.lastActivityAt = Date.now();
        this.speechActive = false;
      };
      recognition.onresult = (event) => {
        if (!isCurrent()) return;
        this.lastActivityAt = Date.now();
        this.failures = 0;
        const transcripts: string[] = [];
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (result.isFinal && i > lastFinalIndex) {
            lastFinalIndex = i;
            const text = result[0].transcript.trim();
            if (text) transcripts.push(text);
          }
        }
        if (transcripts.length) this.callbacks.onTranscript(transcripts.join(" "));
      };
      recognition.onend = () => {
        if (!isCurrent()) return;
        if (Date.now() - this.startedAt >= 10000) this.failures = 0;
        // It has already ended; do not wait for a second end event.
        this.detach(recognition);
        this.recognition = null;
        this.retry();
      };
      recognition.onerror = (event) => {
        if (!isCurrent()) return;
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          this.fail("Microphone access was blocked. Allow microphone access in your browser, then press Start Voice Assistant.");
        } else if (event.error === "language-not-supported") {
          this.fail(`Speech recognition failed: ${event.error}. Try a browser that supports English speech recognition.`);
        } else {
          // Network, capture, aborted and no-speech failures can recover. Use
          // a new recognizer and bounded backoff instead of a hot restart loop.
          this.retry();
        }
      };
      recognition.start();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError") {
        this.fail("Microphone access was blocked. Allow access, then press Start Voice Assistant.");
      } else if (!getSpeechRecognitionConstructor()) {
        this.fail("Speech recognition is not supported in this browser.");
      } else {
        this.retry();
      }
    }
  }

  private detach(recognition: SpeechRecognition): void {
    recognition.onstart = recognition.onend = recognition.onerror = recognition.onresult = null;
    recognition.onaudiostart = recognition.onaudioend = null;
    recognition.onsoundstart = recognition.onspeechstart = recognition.onspeechend = null;
  }

  private retire(): void {
    const recognition = this.recognition;
    if (!recognition) return;
    this.recognition = null;
    this.detach(recognition);
    this.stopping = new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        recognition.onend = null;
        resolve();
      };
      // A stalled or already-stopped engine may never emit end. Never leave
      // the wake-word → command-mic handoff awaiting that event indefinitely.
      const timer = setTimeout(finish, 1000);
      recognition.onend = finish;
      try { recognition.abort(); } catch { finish(); }
    });
  }
}
