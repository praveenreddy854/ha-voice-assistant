import React, { useRef, useState } from "react";
import "./App.css";
import {
  startAzureSpeechRecognition,
  stopRecognition,
} from "./functions/speech";
import Chat from "./Chat";
import { Message } from "./types/chat";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isListening, setIsListening] = useState(false);
  const isListeningForWakeWord = useRef(false);

  const { transcript, resetTranscript } = useSpeechRecognition();

  const startWakeWordListening = () => {
    SpeechRecognition.startListening({
      continuous: true,
      language: "en-US",
    });
    isListeningForWakeWord.current = true;
  };

  React.useEffect(() => {
    // Automatically start listening for the wake word after 1 minute
    // if not already listening for it.
    // This is to ensure the app is ready to respond without user intervention.
    // If the user has already started listening for the wake word, we don't set a timer
    // to avoid interrupting their session.
    if (!isListeningForWakeWord.current) {
      const timer = setTimeout(() => {
        handleRecognizedText({
          sender: "assistant",
          text: "Auto stopping after 1 min of continuous listening",
        });
        resetTranscript();
        stopRecognition();
        startWakeWordListening();
        isListeningForWakeWord.current = true;
      }, 60000); // 1 minute
      return () => clearTimeout(timer);
    }
  }, [isListeningForWakeWord, resetTranscript]);

  React.useEffect(() => {
    if (transcript) {
      if (
        transcript.toLocaleLowerCase() === "assistant" ||
        transcript.toLocaleLowerCase() === "hey assistant"
      ) {
        // If the wake word is detected, reset the transcript and start listening for commands
        resetTranscript();
        handleRecognizedText({ sender: "user", text: transcript });
        isListeningForWakeWord.current = false;
        SpeechRecognition.abortListening();

        startAzureSpeechRecognition({
          setIsListening,
          setRecognizedText: handleRecognizedText,
          isListeningForWakeWord,
        });
      }
    }
  }, [transcript, resetTranscript]);

  const handleRecognizedText = (message: Message) => {
    setMessages((prevMessages) => [...prevMessages, message]);
  };

  const handleOnStartRecognition = () => {
    startWakeWordListening();
  };

  return (
    <div className="App">
      <button
        onClick={handleOnStartRecognition}
        disabled={isListening || isListeningForWakeWord.current}
        style={{ marginBottom: 16 }}
      >
        {isListeningForWakeWord.current
          ? "Listen for wake word"
          : isListening
          ? "Listening..."
          : "Start Speech Recognition"}
      </button>
      <button
        onClick={() => {
          SpeechRecognition.abortListening();
          stopRecognition();
        }}
        disabled={!isListening && !isListeningForWakeWord.current}
        style={{ marginBottom: 16, marginLeft: 16 }}
      >
        Stop Speech Recognition
      </button>
      <Chat messages={messages} />
    </div>
  );
}

export default App;
