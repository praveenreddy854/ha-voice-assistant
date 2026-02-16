import {
  SpeechConfig,
  AudioConfig,
  SpeechRecognizer,
  ResultReason,
  PropertyId,
} from "microsoft-cognitiveservices-speech-sdk";
import { getSpeechCredentials } from "../utils/config";
import { Message } from "../types/chat";

interface SpeechRecognize {
  setRecognizedText: (message: Message) => void;
  setIsListening: React.Dispatch<React.SetStateAction<boolean>>;
  isListeningForWakeWord: React.RefObject<boolean>;
  processRecognizedText: (text: string) => void;
  onSessionStarted?: () => void;
  onSessionStopped?: () => void;
  extendedSilenceTimeout?: boolean; // For teaching mode - extend silence timeout
}

let recognizer: SpeechRecognizer | undefined;

export const startAzureSpeechRecognition = async (props: SpeechRecognize) => {
  const {
    setIsListening,
    setRecognizedText,
    isListeningForWakeWord,
    processRecognizedText,
    extendedSilenceTimeout = false,
  } = props;

  const { speechKey, speechRegion } = await getSpeechCredentials();

  if (!speechKey || !speechRegion) {
    setRecognizedText({
      sender: "assistant",
      text: "Speech key or service region not set. Please check your .env file.",
    });
    return;
  }

  const speechConfig = SpeechConfig.fromSubscription(speechKey, speechRegion);
  speechConfig.speechRecognitionLanguage = "en-US";
  
  // Configure silence timeouts
  // For teaching mode, use longer timeouts (5 minutes = 300 seconds)
  // Default is ~15 seconds which is too short
  if (extendedSilenceTimeout) {
    // Set initial silence timeout (time before first speech) - 5 minutes
    speechConfig.setProperty(
      PropertyId.SpeechServiceConnection_InitialSilenceTimeoutMs,
      "300000"
    );
    // Set end silence timeout (time after speech ends to wait for more) - 30 seconds
    speechConfig.setProperty(
      PropertyId.SpeechServiceConnection_EndSilenceTimeoutMs,
      "30000"
    );
  }
  
  const audioConfig = AudioConfig.fromDefaultMicrophoneInput();
  recognizer = new SpeechRecognizer(speechConfig, audioConfig);

  recognizer.sessionStarted = () => {
    console.log("Azure Speech session started");
    setIsListening(true);
    isListeningForWakeWord.current = false;
    props.onSessionStarted?.();
  };

  recognizer.recognized = async (_, e) => {
    try {
      if (e.result.reason === ResultReason.RecognizedSpeech) {
        console.log("Recognized text:", e.result.text);
        const text = e.result.text.trim().replace(/\.$/, "");
        console.log("isListeningForWakeWord:", isListeningForWakeWord.current);
        console.log("Recognized text:", text);

        // Pass the recognized text to the parent component for processing
        processRecognizedText(text);
      }
    } catch (error) {
      console.error("Error recognizing speech:", error);
    }
  };

  recognizer.sessionStopped = () => {
    stopRecognition(props);
  };

  recognizer.startContinuousRecognitionAsync(
    undefined,
    (err) => {
      console.error("Failed to start Azure speech recognition:", err);
      setRecognizedText({
        sender: "assistant",
        text:
          "Unable to access the microphone for Azure speech recognition. Please check microphone permissions and try again.",
      });
      recognizer?.close();
      recognizer = undefined;
      setIsListening(false);
      isListeningForWakeWord.current = true;
      props.onSessionStopped?.();
    }
  );
};

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

  recognizer?.stopContinuousRecognitionAsync(
    () => {
      console.log("Azure Speech recognition stopped successfully");
      recognizer?.close();
      recognizer = undefined;
      callback?.();
    },
    (err) => {
      console.error("Error stopping Azure Speech recognition:", err);
      recognizer?.close();
      recognizer = undefined;
      callback?.();
    }
  );
};
