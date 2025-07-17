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
        background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
        borderRadius: '20px',
        padding: '1px',
        boxShadow: '0 10px 30px rgba(16, 185, 129, 0.3)',
        animation: 'glow 3s ease-in-out infinite',
        width: '100%',
        maxWidth: '600px',
        margin: '20px 0'
      }}
    >
      <div
        style={{
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
          borderRadius: '19px',
          padding: '20px',
          height: '320px',
          overflowY: 'auto',
          position: 'relative'
        }}
      >
        <div style={{
          position: 'absolute',
          top: '16px',
          left: '20px',
          right: '20px',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          paddingBottom: '12px',
          borderBottom: '1px solid rgba(16, 185, 129, 0.1)',
          marginBottom: '16px'
        }}>
          <span style={{ fontSize: '20px' }}>💬</span>
          <h3 style={{
            margin: 0,
            fontSize: '16px',
            fontWeight: '600',
            background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text'
          }}>
            Voice Assistant Chat
          </h3>
        </div>
        
        <div style={{ 
          paddingTop: '60px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px'
        }}>
          {messages.length === 0 ? (
            <div style={{
              textAlign: 'center',
              color: '#64748b',
              fontSize: '14px',
              fontStyle: 'italic',
              padding: '40px 20px'
            }}>
              <span style={{ fontSize: '32px', display: 'block', marginBottom: '8px' }}>🎤</span>
              Start a conversation by saying "Hey Assistant"
            </div>
          ) : (
            messages.map((message, index) => (
              <div
                key={index}
                style={{
                  display: 'flex',
                  justifyContent: message.sender === "user" ? "flex-end" : "flex-start",
                  animation: `slideIn 0.3s ease-out ${index * 0.1}s both`
                }}
              >
                <div
                  style={{
                    background: message.sender === "user" 
                      ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                      : 'linear-gradient(135deg, #f1f5f9 0%, #e2e8f0 100%)',
                    color: message.sender === "user" ? 'white' : '#334155',
                    padding: '12px 16px',
                    borderRadius: message.sender === "user" ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                    maxWidth: '75%',
                    fontSize: '14px',
                    lineHeight: '1.4',
                    boxShadow: message.sender === "user" 
                      ? '0 4px 12px rgba(16, 185, 129, 0.3)'
                      : '0 2px 8px rgba(0, 0, 0, 0.1)',
                    border: message.sender === "user" 
                      ? '1px solid rgba(255, 255, 255, 0.3)'
                      : '1px solid rgba(226, 232, 240, 0.8)',
                    position: 'relative'
                  }}
                >
                  {message.text}
                  {message.sender === "user" && (
                    <div style={{
                      position: 'absolute',
                      top: '-2px',
                      left: '-2px',
                      right: '-2px',
                      bottom: '-2px',
                      background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
                      borderRadius: '20px',
                      opacity: 0.3,
                      filter: 'blur(4px)',
                      zIndex: -1
                    }} />
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default Chat;
