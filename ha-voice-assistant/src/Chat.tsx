import React from "react";

interface Message {
  sender: "user" | "assistant";
  text: string;
}

interface ChatProps {
  messages: Message[];
}

const Chat: React.FC<ChatProps> = ({ messages }) => {
  return (
    <div
      style={{
        border: "1px solid #ccc",
        padding: "10px",
        height: "300px",
        width: "50%",
        overflowY: "scroll",
      }}
    >
      {messages.map((message, index) => (
        <div
          key={index}
          style={{
            textAlign: message.sender === "user" ? "right" : "left",
            marginBottom: "5px",
          }}
        >
          <span
            style={{
              backgroundColor:
                message.sender === "user" ? "#dcf8c6" : "#f1f0f0",
              padding: "8px",
              borderRadius: "10px",
              display: "inline-block",
            }}
          >
            {message.text}
          </span>
        </div>
      ))}
    </div>
  );
};

export default Chat;
