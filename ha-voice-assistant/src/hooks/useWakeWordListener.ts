import { useCallback, useEffect, useRef, useState } from "react";
import { WakeWordListener, type WakeWordStatus } from "../functions/wakeWordListener";

export function useWakeWordListener() {
  const [status, setStatus] = useState<WakeWordStatus>("stopped");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listener = useRef<WakeWordListener | null>(null);

  const startListening = useCallback(() => {
    setError(null);
    setFinalTranscript("");
    listener.current ??= new WakeWordListener({
      onStatus: setStatus,
      onTranscript: setFinalTranscript,
      onError: setError,
    });
    listener.current.start();
  }, []);

  const stopListening = useCallback(() => listener.current?.stop() ?? Promise.resolve(), []);
  const resetTranscript = useCallback(() => setFinalTranscript(""), []);

  useEffect(() => () => {
    void listener.current?.stop();
    listener.current = null;
  }, []);

  return { status, error, finalTranscript, resetTranscript, startListening, stopListening };
}
