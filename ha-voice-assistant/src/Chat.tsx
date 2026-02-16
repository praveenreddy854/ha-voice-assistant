import React from "react";
import { Message } from "./types/chat";

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
                  <div style={{ whiteSpace: 'pre-wrap' }}>{message.text}</div>
                  {message.agenticSteps && message.agenticSteps.length > 0 && (
                    <div
                      style={{
                        marginTop: '12px',
                        background: message.sender === "user"
                          ? 'rgba(255, 255, 255, 0.15)'
                          : 'rgba(15, 118, 110, 0.08)',
                        borderRadius: '12px',
                        padding: '12px 14px',
                        border: message.sender === "user"
                          ? '1px solid rgba(255, 255, 255, 0.4)'
                          : '1px solid rgba(45, 212, 191, 0.2)'
                      }}
                    >
                      <div
                        style={{
                          fontWeight: 600,
                          fontSize: '13px',
                          marginBottom: '6px',
                          color: message.sender === "user" ? '#ecfdf5' : '#0f766e'
                        }}
                      >
                        Agentic flow steps
                      </div>
                      <ol
                        style={{
                          margin: 0,
                          paddingLeft: '18px',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '10px',
                          fontSize: '13px'
                        }}
                      >
                        {message.agenticSteps.map((step) => (
                          <li key={step.index} style={{ lineHeight: 1.4 }}>
                            <div style={{ fontWeight: 600 }}>
                              Step {step.index}: {step.actionSummary}
                            </div>
                            <div style={{ color: message.sender === "user" ? '#f0fdf4' : '#0f172a' }}>
                              Reason: {step.reasoning}
                            </div>
                            <div style={{ color: message.sender === "user" ? '#ecfeff' : '#1e293b' }}>
                              Observation: {step.observation}
                            </div>
                            {step.screenshotDataUrl && (
                              <img
                                src={step.screenshotDataUrl}
                                alt={`TV screenshot step ${step.index}`}
                                style={{
                                  width: '100%',
                                  maxWidth: '220px',
                                  borderRadius: '10px',
                                  marginTop: '8px',
                                  boxShadow: '0 4px 12px rgba(15, 118, 110, 0.25)'
                                }}
                              />
                            )}
                            {step.screenshotError && (
                              <div
                                style={{
                                  marginTop: '6px',
                                  padding: '8px 10px',
                                  borderRadius: '8px',
                                  background: message.sender === "user"
                                    ? 'rgba(127, 29, 29, 0.25)'
                                    : 'rgba(220, 38, 38, 0.12)',
                                  color: message.sender === "user" ? '#fef2f2' : '#7f1d1d',
                                  border: message.sender === "user"
                                    ? '1px solid rgba(254, 226, 226, 0.6)'
                                    : '1px solid rgba(220, 38, 38, 0.3)'
                                }}
                              >
                                <span style={{ marginRight: '6px' }}>⚠️</span>
                                {step.screenshotError}
                              </div>
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {message.finalCommand && (
                    <div
                      style={{
                        marginTop: '10px',
                        fontWeight: 600,
                        fontSize: '13px',
                        color: message.sender === "user" ? '#e0f2f1' : '#0f766e'
                      }}
                    >
                      Final command: {message.finalCommand}
                    </div>
                  )}
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
