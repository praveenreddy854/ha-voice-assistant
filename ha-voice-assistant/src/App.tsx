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
import { USE_AZURE_SPEECH } from "./utils/config";
import { processRecognizedText } from "./functions/speech";

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isListening, setIsListening] = useState(false);
  const [isWakeWordMode, setIsWakeWordMode] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const isListeningForWakeWord = useRef(false);

  const { finalTranscript, resetTranscript } = useSpeechRecognition();

  const handleRecognizedText = useCallback(async (message: Message) => {
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
  }, []);

  const processRecognizedTextCallback = useCallback(
    async (text: string) => {
      await processRecognizedText(
        text,
        handleRecognizedText,
        isListeningForWakeWord
      );
    },
    [handleRecognizedText]
  );

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
    // Auto-stop after 30 seconds when listening for commands (not wake words)
    if (isListening && !isListeningForWakeWord.current) {
      setCountdown(30);

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
        console.log("Auto stopping after 30 seconds of continuous listening");
        setCountdown(null);
        handleRecognizedText({
          sender: "assistant",
          text: "Auto stopping after 30 seconds of continuous listening",
        });
        if (USE_AZURE_SPEECH) {
          stopRecognition(
            {
              setRecognizedText: handleRecognizedText,
              setIsListening,
              isListeningForWakeWord,
              processRecognizedText: processRecognizedTextCallback,
            },
            () => {
              // Callback executed after Azure SDK is properly stopped
              console.log("Azure SDK stopped, starting wake word listening...");
              startWakeWordListening();
            }
          );
        } else {
          SpeechRecognition.stopListening().then(() => {
            console.log(
              "SpeechRecognition stopped, starting wake word listening..."
            );
            setIsListening(false);
            isListeningForWakeWord.current = true;
            handleRecognizedText({
              sender: "assistant",
              text: "Auto stopped listening for commands",
            });
            console.log("Azure SDK stopped, starting wake word listening...");
            startWakeWordListening();
          });
        }
      }, 30000); // 30 seconds

      return () => {
        clearTimeout(timer);
        clearInterval(countdownInterval);
        setCountdown(null);
      };
    } else {
      setCountdown(null);
    }
  }, [
    isListening,
    resetTranscript,
    startWakeWordListening,
    processRecognizedTextCallback,
    handleRecognizedText,
  ]);

  React.useEffect(() => {
    if (finalTranscript) {
      console.log(
        "Transcript received:",
        finalTranscript,
        "isListeningForWakeWord:",
        isListeningForWakeWord.current
      );
      if (
        finalTranscript.toLocaleLowerCase().includes("assistant") ||
        finalTranscript.toLocaleLowerCase().includes("hey assistant") ||
        finalTranscript.toLocaleLowerCase().includes("hey, assistant") ||
        finalTranscript.toLocaleLowerCase().includes("ok assistant") ||
        finalTranscript.toLocaleLowerCase().includes("ok, assistant")
      ) {
        // If the wake word is detected, reset the transcript and start listening for commands
        console.log("Wake word detected:", finalTranscript);
        handleRecognizedText({ sender: "user", text: finalTranscript });
        isListeningForWakeWord.current = false;
        setIsWakeWordMode(false);
        setIsListening(true);
      } else if (isListening) {
        if (USE_AZURE_SPEECH) {
          SpeechRecognition.abortListening();

          startAzureSpeechRecognition({
            setIsListening,
            setRecognizedText: handleRecognizedText,
            isListeningForWakeWord,
            processRecognizedText: processRecognizedTextCallback,
          });
        } else {
          // Process the recognized text directly
          processRecognizedTextCallback(finalTranscript);
        }
      }

      resetTranscript();
    }
  }, [
    finalTranscript,
    isListening,
    resetTranscript,
    handleRecognizedText,
    processRecognizedTextCallback,
  ]);

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
            processRecognizedText: processRecognizedTextCallback,
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
