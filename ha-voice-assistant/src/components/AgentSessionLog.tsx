import React, { useState } from "react";
import { AgenticStep, AgenticFlowResponse } from "../types/agentic";

interface AgentSessionLogProps {
  sessionLog: SessionLogEntry[];
  onClose: () => void;
}

export interface SessionLogEntry {
  timestamp: number;
  type: "request" | "response" | "screenshot_capture" | "screenshot_error";
  iteration: number;
  /** The full API response (only on "response" entries). */
  response?: AgenticFlowResponse;
  /** Screenshot payload (only on screenshot entries). */
  screenshot?: {
    dataUrl?: string;
    error?: string;
    stepIndex?: number;
  };
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.6)",
  backdropFilter: "blur(4px)",
  zIndex: 9999,
  display: "flex",
  justifyContent: "center",
  alignItems: "center",
};

const panel: React.CSSProperties = {
  background: "#0f172a",
  color: "#e2e8f0",
  borderRadius: 16,
  width: "90vw",
  maxWidth: 820,
  maxHeight: "88vh",
  display: "flex",
  flexDirection: "column",
  boxShadow: "0 25px 60px rgba(0,0,0,0.5)",
  border: "1px solid #1e293b",
};

const header: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "16px 20px",
  borderBottom: "1px solid #1e293b",
  flexShrink: 0,
};

const scrollArea: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: "12px 20px 20px",
};

const badge = (bg: string): React.CSSProperties => ({
  display: "inline-block",
  padding: "2px 8px",
  borderRadius: 6,
  fontSize: 11,
  fontWeight: 600,
  background: bg,
  color: "#fff",
  marginRight: 6,
  textTransform: "uppercase",
  letterSpacing: 0.5,
});

const stepCard: React.CSSProperties = {
  background: "#1e293b",
  borderRadius: 10,
  padding: "12px 14px",
  marginBottom: 8,
  border: "1px solid #334155",
};

const mono: React.CSSProperties = {
  fontFamily: "'SF Mono', 'Fira Code', 'Consolas', monospace",
  fontSize: 12,
  background: "#0f172a",
  borderRadius: 6,
  padding: "8px 10px",
  overflowX: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-all",
  border: "1px solid #334155",
  marginTop: 6,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusColor(status: string): string {
  switch (status) {
    case "completed": return "#22c55e";
    case "error": return "#ef4444";
    case "awaiting_screenshot": return "#f59e0b";
    case "running": return "#3b82f6";
    default: return "#64748b";
  }
}

function toolColor(toolName: string): string {
  if (toolName.includes("screenshot")) return "#f59e0b";
  if (toolName.includes("navigate") || toolName.includes("scroll")) return "#3b82f6";
  if (toolName.includes("select") || toolName.includes("click")) return "#22c55e";
  if (toolName.includes("launch") || toolName.includes("open")) return "#a855f7";
  if (toolName.includes("wait")) return "#64748b";
  if (toolName.includes("analyze") || toolName.includes("verify")) return "#06b6d4";
  if (toolName.includes("power")) return "#ef4444";
  return "#8b5cf6";
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

const StepDetail: React.FC<{ step: AgenticStep; defaultExpanded?: boolean }> = ({
  step,
  defaultExpanded = false,
}) => {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const tool = step.toolName || "unknown";
  const success = step.toolSuccess;

  return (
    <div style={stepCard}>
      <div
        style={{ display: "flex", alignItems: "center", cursor: "pointer", gap: 6 }}
        onClick={() => setExpanded(!expanded)}
      >
        <span style={{ fontSize: 10, color: "#64748b", width: 14 }}>
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
        <span style={badge(toolColor(tool))}>{tool}</span>
        {success === true && <span style={{ color: "#22c55e", fontSize: 13 }}>OK</span>}
        {success === false && <span style={{ color: "#ef4444", fontSize: 13 }}>FAIL</span>}
        <span style={{ flex: 1, fontSize: 13, color: "#cbd5e1" }}>
          {step.actionSummary}
        </span>
        <span style={{ fontSize: 11, color: "#475569" }}>#{step.index}</span>
      </div>

      {expanded && (
        <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {/* Reasoning */}
          {step.reasoning && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2, fontWeight: 600 }}>
                Reasoning
              </div>
              <div style={{ fontSize: 13, color: "#e2e8f0" }}>{step.reasoning}</div>
            </div>
          )}

          {/* Tool arguments */}
          <div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2, fontWeight: 600 }}>
              Tool Arguments
            </div>
            <div style={mono}>{JSON.stringify(step.toolArguments, null, 2)}</div>
          </div>

          {/* Observation */}
          {step.observation && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2, fontWeight: 600 }}>
                Observation
              </div>
              <div style={{ fontSize: 13, color: "#e2e8f0", whiteSpace: "pre-wrap" }}>
                {step.observation}
              </div>
            </div>
          )}

          {/* App UI Context */}
          {step.appUiContext && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 2, fontWeight: 600 }}>
                App UI Context
              </div>
              <div style={mono}>{JSON.stringify(step.appUiContext, null, 2)}</div>
            </div>
          )}

          {/* Screenshot */}
          {step.screenshotDataUrl && (
            <div>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4, fontWeight: 600 }}>
                Screenshot
                {step.screenshotOutcome && (
                  <span style={badge(
                    step.screenshotOutcome === "captured" ? "#22c55e" :
                    step.screenshotOutcome === "error" ? "#ef4444" : "#f59e0b"
                  )}>
                    {step.screenshotOutcome}
                  </span>
                )}
              </div>
              <img
                src={step.screenshotDataUrl}
                alt={`Step ${step.index} screenshot`}
                style={{
                  width: "100%",
                  maxWidth: 400,
                  borderRadius: 8,
                  border: "1px solid #334155",
                }}
              />
            </div>
          )}

          {/* Screenshot error */}
          {step.screenshotError && (
            <div style={{
              padding: "8px 10px",
              borderRadius: 6,
              background: "rgba(239,68,68,0.15)",
              border: "1px solid rgba(239,68,68,0.3)",
              color: "#fca5a5",
              fontSize: 12,
            }}>
              Screenshot error: {step.screenshotError}
            </div>
          )}

          {/* Retry info */}
          {(step.retryCount !== undefined && step.retryCount > 0) && (
            <div style={{ fontSize: 11, color: "#f59e0b" }}>
              Retries: {step.retryCount}/{step.maxRetries ?? "?"}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

const AgentSessionLog: React.FC<AgentSessionLogProps> = ({ sessionLog, onClose }) => {
  const [expandAll, setExpandAll] = useState(false);

  if (sessionLog.length === 0) {
    return null;
  }

  // Collect all steps from the latest response that has them
  const latestWithSteps = [...sessionLog]
    .reverse()
    .find((e) => e.type === "response" && e.response?.steps?.length);
  const allSteps = latestWithSteps?.response?.steps ?? [];
  const finalStatus = latestWithSteps?.response?.status ?? "unknown";
  const sessionId = latestWithSteps?.response?.sessionId;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={header}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>Agent Session Log</span>
            <span style={badge(statusColor(finalStatus))}>{finalStatus}</span>
            {sessionId && (
              <span style={{ fontSize: 11, color: "#475569" }}>
                {sessionId.slice(0, 8)}...
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setExpandAll(!expandAll)}
              style={{
                background: "#1e293b",
                color: "#94a3b8",
                border: "1px solid #334155",
                borderRadius: 6,
                padding: "4px 10px",
                fontSize: 12,
                cursor: "pointer",
              }}
            >
              {expandAll ? "Collapse all" : "Expand all"}
            </button>
            <button
              onClick={onClose}
              style={{
                background: "transparent",
                color: "#94a3b8",
                border: "none",
                fontSize: 20,
                cursor: "pointer",
                padding: "0 4px",
              }}
            >
              x
            </button>
          </div>
        </div>

        {/* Timeline */}
        <div style={scrollArea}>
          {/* Summary bar */}
          <div style={{
            display: "flex",
            gap: 16,
            marginBottom: 16,
            padding: "10px 14px",
            background: "#1e293b",
            borderRadius: 10,
            border: "1px solid #334155",
            fontSize: 12,
            color: "#94a3b8",
            flexWrap: "wrap",
          }}>
            <span>Steps: <b style={{ color: "#e2e8f0" }}>{allSteps.length}</b></span>
            <span>
              Iterations: <b style={{ color: "#e2e8f0" }}>
                {sessionLog.filter((e) => e.type === "response").length}
              </b>
            </span>
            <span>
              Screenshots: <b style={{ color: "#e2e8f0" }}>
                {allSteps.filter((s) => s.screenshotDataUrl).length}
              </b>
            </span>
            {latestWithSteps?.response?.message && (
              <span style={{ flex: "1 1 100%", marginTop: 4, color: "#cbd5e1" }}>
                {latestWithSteps.response.message}
              </span>
            )}
          </div>

          {/* Event timeline */}
          {sessionLog.map((entry, i) => (
            <div key={i} style={{ marginBottom: 16 }}>
              {/* Entry header */}
              <div style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 6,
                fontSize: 12,
              }}>
                <span style={{ color: "#475569", fontFamily: "monospace" }}>
                  {formatTime(entry.timestamp)}
                </span>
                <span style={badge(
                  entry.type === "request" ? "#3b82f6" :
                  entry.type === "response" ? "#8b5cf6" :
                  entry.type === "screenshot_capture" ? "#22c55e" : "#ef4444"
                )}>
                  {entry.type.replace("_", " ")}
                </span>
                <span style={{ color: "#475569" }}>iter {entry.iteration}</span>
                {entry.type === "response" && entry.response && (
                  <span style={badge(statusColor(entry.response.status))}>
                    {entry.response.status}
                  </span>
                )}
              </div>

              {/* Response steps */}
              {entry.type === "response" && entry.response?.steps && (
                <div style={{ marginLeft: 12 }}>
                  {/* Show only new steps for this iteration */}
                  {entry.response.steps.map((step) => (
                    <StepDetail
                      key={`${i}-${step.index}`}
                      step={step}
                      defaultExpanded={expandAll}
                    />
                  ))}
                </div>
              )}

              {/* Screenshot capture */}
              {entry.type === "screenshot_capture" && entry.screenshot?.dataUrl && (
                <div style={{ marginLeft: 12 }}>
                  <div style={{
                    ...stepCard,
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                  }}>
                    <img
                      src={entry.screenshot.dataUrl}
                      alt={`Captured screenshot step ${entry.screenshot.stepIndex}`}
                      style={{
                        width: 180,
                        borderRadius: 6,
                        border: "1px solid #334155",
                      }}
                    />
                    <div style={{ fontSize: 12, color: "#94a3b8" }}>
                      Captured for step {entry.screenshot.stepIndex}
                    </div>
                  </div>
                </div>
              )}

              {/* Screenshot error */}
              {entry.type === "screenshot_error" && (
                <div style={{ marginLeft: 12 }}>
                  <div style={{
                    ...stepCard,
                    background: "rgba(239,68,68,0.1)",
                    borderColor: "rgba(239,68,68,0.3)",
                    color: "#fca5a5",
                    fontSize: 12,
                  }}>
                    {entry.screenshot?.error || "Unknown screenshot error"}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default AgentSessionLog;
