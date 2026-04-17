import { Message } from "../types/chat";

interface SpeechRecognize {
  setRecognizedText: (message: Message) => void;
  setIsListening: React.Dispatch<React.SetStateAction<boolean>>;
  isListeningForWakeWord: React.RefObject<boolean>;
  processRecognizedText: (text: string) => void;
  onSessionStarted?: () => void;
  onSessionStopped?: () => void;
  extendedSilenceTimeout?: boolean;
}

// Active session state
let session: {
  stream: MediaStream;
  audioContext: AudioContext;
  analyser: AnalyserNode;
  recorder: MediaRecorder | null;
  silenceCheckTimer: number | null;
  stopped: boolean;
  props: SpeechRecognize;
  extendedSilenceTimeout: boolean;
} | null = null;

// Silence detection thresholds (RMS-based: silence ~0.01, speech ~0.05+)
const SPEECH_RMS_THRESHOLD = 0.03;
const SILENCE_DURATION_MS = 3000; // 3s of silence after speech to trigger transcription
const EXTENDED_SILENCE_DURATION_MS = 30000; // 30s for teaching mode
const INITIAL_WAIT_MS = 15000; // 15s waiting for first speech before giving up
const EXTENDED_INITIAL_WAIT_MS = 300000; // 5 min for teaching mode

export const startAzureSpeechRecognition = async (props: SpeechRecognize) => {
  const {
    setIsListening,
    setRecognizedText,
    isListeningForWakeWord,
    extendedSilenceTimeout = false,
  } = props;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioContext = new (window.AudioContext ||
      (window as any).webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    session = {
      stream,
      audioContext,
      analyser,
      recorder: null,
      silenceCheckTimer: null,
      stopped: false,
      props,
      extendedSilenceTimeout,
    };

    console.log("MAI Transcribe session started");
    setIsListening(true);
    isListeningForWakeWord.current = false;
    props.onSessionStarted?.();

    // Start first recording cycle
    startRecordingCycle();
  } catch (error) {
    console.error("Error starting MAI transcription:", error);
    setRecognizedText({
      sender: "assistant",
      text: "Unable to access the microphone. Please check microphone permissions and try again.",
    });
  }
};

function startRecordingCycle() {
  if (!session || session.stopped) return;

  const { stream, analyser, extendedSilenceTimeout } = session;

  // Choose best available MIME type
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : "audio/webm";
  const recorder = new MediaRecorder(stream, { mimeType });
  const audioChunks: Blob[] = [];
  session.recorder = recorder;

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) audioChunks.push(event.data);
  };

  recorder.onstop = async () => {
    if (!session || session.stopped) return;

    const audioBlob = new Blob(audioChunks, { type: mimeType });

    // Only transcribe if we have meaningful audio (> ~1KB)
    if (audioBlob.size > 1000) {
      try {
        const base64Audio = await blobToBase64(audioBlob);
        const response = await fetch("http://localhost:3005/api/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ audio: base64Audio, mimeType }),
        });

        const result = await response.json();
        if (result.text && result.text.trim()) {
          const text = result.text.trim().replace(/\.$/, "");
          console.log("MAI Transcribed text:", text);
          session?.props.processRecognizedText(text);
        }
      } catch (error) {
        console.error("Transcription error:", error);
      }
    }

    // Start next recording cycle if session is still active
    if (session && !session.stopped) {
      startRecordingCycle();
    }
  };

  // Collect data every second
  recorder.start(1000);

  // Silence detection via AnalyserNode
  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  let speechDetected = false;
  let silenceStart = 0;
  const silenceDuration = extendedSilenceTimeout
    ? EXTENDED_SILENCE_DURATION_MS
    : SILENCE_DURATION_MS;
  const initialWait = extendedSilenceTimeout
    ? EXTENDED_INITIAL_WAIT_MS
    : INITIAL_WAIT_MS;
  const cycleStart = Date.now();

  session.silenceCheckTimer = window.setInterval(() => {
    if (!session || session.stopped || recorder.state === "inactive") {
      if (session?.silenceCheckTimer) {
        clearInterval(session.silenceCheckTimer);
        session.silenceCheckTimer = null;
      }
      return;
    }

    // Use time-domain data for RMS-based voice activity detection
    analyser.getByteTimeDomainData(dataArray);
    let sumSquares = 0;
    for (let i = 0; i < dataArray.length; i++) {
      const normalized = (dataArray[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / dataArray.length);

    if (rms > SPEECH_RMS_THRESHOLD) {
      speechDetected = true;
      silenceStart = 0;
    } else if (speechDetected) {
      if (!silenceStart) silenceStart = Date.now();
      if (Date.now() - silenceStart > silenceDuration) {
        console.log(
          "Silence detected after speech, stopping recording for transcription"
        );
        if (session?.silenceCheckTimer) {
          clearInterval(session.silenceCheckTimer);
          session.silenceCheckTimer = null;
        }
        if (recorder.state === "recording") recorder.stop();
      }
    }

    // Timeout waiting for initial speech in this cycle
    if (!speechDetected && Date.now() - cycleStart > initialWait) {
      console.log("No speech detected in recording cycle, stopping");
      if (session?.silenceCheckTimer) {
        clearInterval(session.silenceCheckTimer);
        session.silenceCheckTimer = null;
      }
      if (recorder.state === "recording") recorder.stop();
    }
  }, 100);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // Strip the data URL prefix to get raw base64
      const base64 = result.split(",")[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export const stopRecognition = (
  props: SpeechRecognize,
  callback?: () => void
) => {
  const { setIsListening, isListeningForWakeWord, setRecognizedText } = props;

  setRecognizedText({
    sender: "assistant",
    text: "Speech recognition stopped. You can now say 'assistant' to start listening again.",
  });
  setIsListening(false);
  isListeningForWakeWord.current = true;
  props.onSessionStopped?.();

  cleanupSession();
  callback?.();
};

function cleanupSession() {
  if (!session) return;

  session.stopped = true;

  if (session.silenceCheckTimer) {
    clearInterval(session.silenceCheckTimer);
    session.silenceCheckTimer = null;
  }

  if (session.recorder && session.recorder.state !== "inactive") {
    // Prevent the onstop handler from starting a new cycle
    session.recorder.onstop = null;
    session.recorder.stop();
  }

  session.stream.getTracks().forEach((track) => track.stop());
  session.audioContext.close().catch(() => {});
  session = null;
}
