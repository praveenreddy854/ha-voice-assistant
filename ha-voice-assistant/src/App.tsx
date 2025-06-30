import React, { useState } from "react";
import "./App.css";
import { startRecognition, stopRecognition } from "./functions/speech";
import Chat from "./Chat";
import { Message } from "./types/chat";

function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isListening, setIsListening] = useState(false);

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
