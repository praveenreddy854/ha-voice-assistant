import {
  SpeechConfig,
  AudioConfig,
  SpeechRecognizer,
  ResultReason,
} from "microsoft-cognitiveservices-speech-sdk";
import { getSpeechCredentials } from "../utils/config";
import { getIntent, Intent } from "./intent";
import { postHaCommand } from "./ha";
import { Message } from "../types/chat";

interface SpeechRecognize {
  setRecognizedText: (message: Message) => void;
  setIsListening: React.Dispatch<React.SetStateAction<boolean>>;
  isListeningForWakeWord: React.RefObject<boolean>;
}

let recognizer: SpeechRecognizer | undefined;

export const startAzureSpeechRecognition = async (props: SpeechRecognize) => {
  const { setIsListening, setRecognizedText, isListeningForWakeWord } = props;

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
  isListeningForWakeWord.current = true;

  recognizer.recognized = async (s, e) => {
    try {
      if (e.result.reason === ResultReason.RecognizedSpeech) {
        console.log("Recognized text:", e.result.text);
        const text = e.result.text.trim().replace(/\.$/, "");
        console.log("isListeningForWakeWord:", isListeningForWakeWord.current);
        console.log("Recognized text:", text);

        if (text.toLowerCase() === "stop" || text.toLowerCase() === "stop it") {
          isListeningForWakeWord.current = true;
          setRecognizedText({ sender: "user", text: "Stop" });
          return;
        }

        setRecognizedText({ sender: "user", text });
        // Check intent of the recognized text
        const intent = await getIntent(text);

        if (intent === Intent.HACommand) {
          // Handle Home Assistant command
          const result = await postHaCommand(text);
          setRecognizedText({
            sender: "assistant",
            text: `Command executed: Success: ${result.success}, Message: ${result.message}`,
          });
        } else if (intent === Intent.Chat) {
          // Handle chat intent (if applicable)
          console.log("Chat intent recognized:", e.result.text);
        }
      }
    } catch (error) {
      console.error("Error recognizing speech:", error);
    }
  };

  recognizer.sessionStopped = (s, e) => {
    stopRecognition(props);
  };

  recognizer.startContinuousRecognitionAsync();
};

export const stopRecognition = (props: SpeechRecognize) => {
  const { setIsListening, isListeningForWakeWord, setRecognizedText } = props;
  setRecognizedText({
    sender: "assistant",
    text: "Speech recognition stopped. You can now say 'assistant' to start listening again.",
  });
  setIsListening(false);
  isListeningForWakeWord.current = true;
  recognizer?.stopContinuousRecognitionAsync();
  recognizer?.close();
};
