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
}

let recognizer: SpeechRecognizer | undefined;

export const startRecognition = async (props: SpeechRecognize) => {
  const { setIsListening, setRecognizedText } = props;

  const { speechKey, speechRegion } = await getSpeechCredentials();

  if (!speechKey || !speechRegion) {
    setRecognizedText({
      sender: "assistant",
      text: "Speech key or service region not set. Please check your .env file.",
    });
    return;
  }

  setIsListening(true);
  const speechConfig = SpeechConfig.fromSubscription(speechKey, speechRegion);
  speechConfig.speechRecognitionLanguage = "en-US";
  const audioConfig = AudioConfig.fromDefaultMicrophoneInput();
  recognizer = new SpeechRecognizer(speechConfig, audioConfig);

  recognizer.recognized = async (s, e) => {
    if (e.result.reason === ResultReason.RecognizedSpeech) {
      setRecognizedText({ sender: "user", text: e.result.text });
    }

    // Check intent of the recognized text
    const intent = await getIntent(e.result.text);

    if (intent === Intent.HACommand) {
      // Handle Home Assistant command
      const result = await postHaCommand(e.result.text);
      setRecognizedText({
        sender: "assistant",
        text: `Command executed: Success: ${result.success}, Message: ${result.message}`,
      });
    } else if (intent === Intent.Chat) {
      // Handle chat intent (if applicable)
      console.log("Chat intent recognized:", e.result.text);
    }
  };

  recognizer.sessionStopped = (s, e) => {
    setIsListening(false);
    recognizer?.close();
  };

  recognizer.startContinuousRecognitionAsync();
};

export const stopRecognition = () => {
  recognizer?.stopContinuousRecognitionAsync();
};
