import React, { useRef, useState, useCallback } from "react";
import "./App.css";
import {
  startAzureSpeechRecognition,
  stopRecognition,
} from "./functions/speechToText";
import Chat from "./Chat";
import { Message } from "./types/chat";
import SpeechRecognition, {
  useSpeechRecognition,
} from "react-speech-recognition";
import { synthesizeTextToBuffer } from "./functions/textToSpeech";

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isWakeWordMode, setIsWakeWordMode] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const isListeningForWakeWord = useRef(false);

  const { transcript, resetTranscript } = useSpeechRecognition();

  const startWakeWordListening = useCallback(() => {
    console.log("Starting wake word listening...");
    resetTranscript(); // Clear any existing transcript
    SpeechRecognition.startListening({
      continuous: true,
      language: "en-US",
    });
    isListeningForWakeWord.current = true;
    setIsWakeWordMode(true);
    console.log(
      "Wake word listening started, isListeningForWakeWord:",
      isListeningForWakeWord.current
    );
  }, [resetTranscript]);

  React.useEffect(() => {
    // Auto-stop after 10 seconds when listening for commands (not wake words)
    if (isListening && !isListeningForWakeWord.current) {
      setCountdown(10);

      // Update countdown every second
      const countdownInterval = setInterval(() => {
        setCountdown((prev) => {
          if (prev === null || prev <= 1) {
            return null;
          }
          return prev - 1;
        });
      }, 1000);

      // Auto-stop timer
      const timer = setTimeout(() => {
        console.log("Auto stopping after 10 seconds of continuous listening");
        setCountdown(null);
        handleRecognizedText({
          sender: "assistant",
          text: "Auto stopping after 10 seconds of continuous listening",
        });
        resetTranscript();
        stopRecognition(
          {
            setRecognizedText: handleRecognizedText,
            setIsListening,
            isListeningForWakeWord,
          },
          () => {
            // Callback executed after Azure SDK is properly stopped
            console.log("Azure SDK stopped, starting wake word listening...");
            startWakeWordListening();
          }
        );
      }, 60000); // 60 seconds

      return () => {
        clearTimeout(timer);
        clearInterval(countdownInterval);
        setCountdown(null);
      };
    } else {
      setCountdown(null);
    }
  }, [isListening, resetTranscript, startWakeWordListening]);

  React.useEffect(() => {
    // Clear transcript every 10 seconds when listening for wake words to prevent accumulation
    if (isWakeWordMode && !isListening) {
      const timer = setInterval(() => {
        console.log("Clearing transcript while listening for wake words");
        resetTranscript();
      }, 60000); // 60 seconds
      return () => clearInterval(timer);
    }
  }, [isWakeWordMode, isListening, resetTranscript]);

  React.useEffect(() => {
    if (transcript) {
      console.log(
        "Transcript received:",
        transcript,
        "isListeningForWakeWord:",
        isListeningForWakeWord.current
      );
      if (
        transcript.toLocaleLowerCase().includes("assistant") ||
        transcript.toLocaleLowerCase().includes("hey assistant")
      ) {
        // If the wake word is detected, reset the transcript and start listening for commands
        console.log("Wake word detected:", transcript);
        resetTranscript();
        handleRecognizedText({ sender: "user", text: transcript });
        isListeningForWakeWord.current = false;
        setIsWakeWordMode(false);
        SpeechRecognition.abortListening();

        startAzureSpeechRecognition({
          setIsListening,
          setRecognizedText: handleRecognizedText,
          isListeningForWakeWord,
        });
      }
    }
  }, [transcript, resetTranscript]);

  const handleRecognizedText = async (message: Message) => {
    setMessages((prevMessages) => [...prevMessages, message]);
    if (message.sender === "assistant" && message.messageToAnnounce) {
      const { audioBuffer } = await synthesizeTextToBuffer({
        text: message.messageToAnnounce,
      });

      if (!audioBuffer) {
        console.error("Failed to synthesize text to audio buffer");
        return;
      }
    }
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
        {isWakeWordMode
          ? "Listening for wake word..."
          : isListening
          ? `Listening for commands... (${countdown}s)`
          : "Start Voice Assistant"}
      </button>
      <button
        onClick={() => {
          SpeechRecognition.abortListening();
          stopRecognition({
            setIsListening,
            isListeningForWakeWord,
            setRecognizedText: handleRecognizedText,
          });
        }}
        disabled={!isListening && !isListeningForWakeWord.current}
        style={{ marginBottom: 16, marginLeft: 16 }}
      >
        {isWakeWordMode
          ? "Stop Wake Word Detection"
          : isListening
          ? "Stop Command Listening"
          : "Stop Voice Assistant"}
      </button>
      {countdown !== null && (
        <div style={{ marginBottom: 16, fontSize: 18, fontWeight: "bold" }}>
          Auto-stop in: {countdown}s
        </div>
      )}
      <Chat messages={messages} />
    </div>
  );
}

export default App;
