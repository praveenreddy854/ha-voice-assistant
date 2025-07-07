import {
  SpeechConfig,
  AudioConfig,
  SpeechRecognizer,
  ResultReason,
} from "microsoft-cognitiveservices-speech-sdk";
import { getSpeechCredentials } from "../utils/config";
import { Message } from "../types/chat";

interface SpeechRecognize {
  setRecognizedText: (message: Message) => void;
  setIsListening: React.Dispatch<React.SetStateAction<boolean>>;
  isListeningForWakeWord: React.RefObject<boolean>;
  processRecognizedText: (text: string) => void;
}

let recognizer: SpeechRecognizer | undefined;

export const startAzureSpeechRecognition = async (props: SpeechRecognize) => {
  const {
    setIsListening,
    setRecognizedText,
    isListeningForWakeWord,
    processRecognizedText,
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
  const audioConfig = AudioConfig.fromDefaultMicrophoneInput();
  recognizer = new SpeechRecognizer(speechConfig, audioConfig);

  setIsListening(true);
  isListeningForWakeWord.current = false;

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

  recognizer.startContinuousRecognitionAsync();
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
