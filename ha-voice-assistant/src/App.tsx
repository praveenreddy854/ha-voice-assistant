import React, { useRef, useState } from "react";
import "./App.css";
import { startRecognition, stopRecognition } from "./functions/speech";
import Chat from "./Chat";
import { Message } from "./types/chat";

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isListening, setIsListening] = useState(false);
  const isListeningForWakeWord = useRef(false);

  React.useEffect(() => {
    // Automatically start listening for the wake word after 1 minute
    // if not already listening for it.
    // This is to ensure the app is ready to respond without user intervention.
    // If the user has already started listening for the wake word, we don't set a timer
    // to avoid interrupting their session.
    if (!isListeningForWakeWord.current) {
      const timer = setTimeout(() => {
        isListeningForWakeWord.current = true;
      }, 60000); // 1 minute
      return () => clearTimeout(timer);
    }
  }, [isListeningForWakeWord]);

  const handleRecognizedText = (message: Message) => {
    setMessages((prevMessages) => [...prevMessages, message]);
  };

  return (
    <div className="App">
      <button
        onClick={() =>
          startRecognition({
            setIsListening,
            setRecognizedText: handleRecognizedText,
            isListeningForWakeWord,
          })
        }
        disabled={isListening}
        style={{ marginBottom: 16 }}
      >
        {isListening ? "Listening..." : "Start Speech Recognition"}
      </button>
      <button
        onClick={() => stopRecognition()}
        disabled={!isListening}
        style={{ marginBottom: 16, marginLeft: 16 }}
      >
        Stop Speech Recognition
      </button>
      <Chat messages={messages} />
    </div>
  );
}

export default App;
