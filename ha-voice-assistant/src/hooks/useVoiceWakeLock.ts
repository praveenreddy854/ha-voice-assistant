import { useEffect } from "react";

/** Keep an enabled, visible voice-assistant screen awake when supported. */
export function useVoiceWakeLock(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || !navigator.wakeLock) return;
    let disposed = false;
    let pending = false;
    let lock: WakeLockSentinel | undefined;
    const acquire = async () => {
      if (disposed || pending || (lock && !lock.released) || document.visibilityState === "hidden") return;
      pending = true;
      try {
        const acquired = await navigator.wakeLock.request("screen");
        if (disposed) await acquired.release();
        else lock = acquired;
      } catch {
        // The browser/OS may deny wake locks. Recognition recovery still runs.
      } finally {
        pending = false;
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    window.addEventListener("pageshow", acquire);
    window.addEventListener("focus", acquire);
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", acquire);
      window.removeEventListener("pageshow", acquire);
      window.removeEventListener("focus", acquire);
      void lock?.release().catch(() => {});
    };
  }, [enabled]);
}
