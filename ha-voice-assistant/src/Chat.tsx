import React, { useState, useRef, useEffect } from "react";
import { Message } from "./types/chat";
import AgentSessionLog, { SessionLogEntry } from "./components/AgentSessionLog";

interface ChatProps {
  messages: Message[];
  onSendMessage?: (text: string) => void;
}

const Chat: React.FC<ChatProps> = ({ messages, onSendMessage }) => {
  const [inputText, setInputText] = useState("");
  const [activeLog, setActiveLog] = useState<SessionLogEntry[] | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = inputText.trim();
    if (!trimmed || !onSendMessage) return;
    onSendMessage(trimmed);
    setInputText("");
  };

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
        margin: '20px 0',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          background: 'linear-gradient(135deg, #ffffff 0%, #f8fafc 100%)',
          borderRadius: '19px',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          paddingBottom: '12px',
          borderBottom: '1px solid rgba(16, 185, 129, 0.1)',
          marginBottom: '16px',
          flexShrink: 0,
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

        {/* Messages */}
        <div style={{
          height: '260px',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
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
              Say "Hey Assistant" or type a command below
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
                          color: message.sender === "user" ? '#ecfdf5' : '#0f766e',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                      >
                        <span>Agentic flow steps</span>
                        {message.sessionLog && message.sessionLog.length > 0 && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveLog(message.sessionLog!);
                            }}
                            style={{
                              background: message.sender === "user"
                                ? 'rgba(255,255,255,0.2)'
                                : 'rgba(15,118,110,0.12)',
                              border: message.sender === "user"
                                ? '1px solid rgba(255,255,255,0.4)'
                                : '1px solid rgba(15,118,110,0.25)',
                              borderRadius: 6,
                              padding: '2px 8px',
                              fontSize: 11,
                              fontWeight: 600,
                              color: message.sender === "user" ? '#fff' : '#0f766e',
                              cursor: 'pointer',
                            }}
                          >
                            View Log
                          </button>
                        )}
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
                              {step.toolName && (
                                <span style={{
                                  marginLeft: 6,
                                  fontSize: 11,
                                  fontWeight: 500,
                                  opacity: 0.7,
                                }}>
                                  [{step.toolName}]
                                </span>
                              )}
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
          <div ref={messagesEndRef} />
        </div>

        {/* Text Input */}
        <form
          onSubmit={handleSubmit}
          style={{
            display: 'flex',
            gap: '8px',
            marginTop: '12px',
            paddingTop: '12px',
            borderTop: '1px solid rgba(16, 185, 129, 0.1)',
            flexShrink: 0,
          }}
        >
          <input
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            placeholder="Type a command..."
            style={{
              flex: 1,
              padding: '10px 14px',
              borderRadius: '12px',
              border: '1.5px solid #d1d5db',
              fontSize: '14px',
              outline: 'none',
              transition: 'border-color 0.2s',
              background: '#f9fafb',
            }}
            onFocus={(e) => { e.currentTarget.style.borderColor = '#10b981'; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = '#d1d5db'; }}
          />
          <button
            type="submit"
            disabled={!inputText.trim()}
            style={{
              padding: '10px 18px',
              borderRadius: '12px',
              border: 'none',
              background: inputText.trim()
                ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                : '#d1d5db',
              color: 'white',
              fontSize: '14px',
              fontWeight: '600',
              cursor: inputText.trim() ? 'pointer' : 'default',
              transition: 'all 0.2s',
              flexShrink: 0,
            }}
          >
            Send
          </button>
        </form>
      </div>

      {/* Debug Session Log Modal */}
      {activeLog && (
        <AgentSessionLog
          sessionLog={activeLog}
          onClose={() => setActiveLog(null)}
        />
      )}
    </div>
  );
};

export default Chat;
