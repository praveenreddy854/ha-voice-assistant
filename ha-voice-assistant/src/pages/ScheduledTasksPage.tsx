import React, { useCallback, useEffect, useState } from "react";
import {
  ScheduledTask,
  cancelRecurrenceFamily,
  cancelScheduledTask,
  listScheduledTasks,
} from "../functions/scheduledTasks";

const REFRESH_MS = 60 * 60 * 1000; // 1h cache refresh per design

const containerStyle: React.CSSProperties = {
  padding: "24px",
  maxWidth: "900px",
  margin: "0 auto",
};

const cardStyle: React.CSSProperties = {
  border: "1px solid #e2e8f0",
  borderRadius: "12px",
  padding: "16px",
  marginBottom: "12px",
  background: "white",
  display: "flex",
  justifyContent: "space-between",
  gap: "16px",
  alignItems: "flex-start",
};

const buttonStyle: React.CSSProperties = {
  padding: "6px 12px",
  border: "1px solid #e2e8f0",
  borderRadius: "6px",
  cursor: "pointer",
  background: "white",
  fontSize: "12px",
};

const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: "#fee2e2",
  borderColor: "#fecaca",
  color: "#b91c1c",
};

function formatEffect(t: ScheduledTask): string {
  if (t.effect.kind === "announcement") return "Announcement";
  if (t.effect.kind === "action")
    return `Action → ${t.effect.entityId ?? "(no entity)"}`;
  return "Unknown";
}

function formatRecurrence(t: ScheduledTask): string {
  if (!t.isRecurring || !t.recurringPattern) return "One-shot";
  const { type, interval } = t.recurringPattern;
  return `Every ${interval} ${type}${interval === 1 ? "" : "s"}`;
}

const ScheduledTasksPage: React.FC = () => {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await listScheduledTasks();
    if (result.success && result.data) {
      const sorted = [...result.data].sort(
        (a, b) =>
          new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
      );
      setTasks(sorted);
    } else {
      setError(result.errorMessage || "Failed to load");
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const handleCancel = async (t: ScheduledTask) => {
    const result = await cancelScheduledTask(t.id, t.recurrenceFamilyId);
    if (result.success) refresh();
    else setError(result.errorMessage || "Cancel failed");
  };

  const handleCancelFamily = async (t: ScheduledTask) => {
    const result = await cancelRecurrenceFamily(t.recurrenceFamilyId);
    if (result.success) refresh();
    else setError(result.errorMessage || "Cancel family failed");
  };

  return (
    <div style={containerStyle}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "16px",
        }}
      >
        <h2 style={{ margin: 0 }}>Scheduled Tasks</h2>
        <button style={buttonStyle} onClick={refresh}>
          Refresh
        </button>
      </div>

      {loading && <p>Loading…</p>}
      {error && (
        <p style={{ color: "#b91c1c" }}>Error: {error}</p>
      )}

      {!loading && tasks.length === 0 && (
        <p style={{ color: "#64748b" }}>No scheduled tasks.</p>
      )}

      {tasks.map((t) => (
        <div key={t.id} style={cardStyle}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: "15px" }}>{t.title}</div>
            {t.description && (
              <div
                style={{
                  fontSize: "12px",
                  color: "#64748b",
                  marginTop: "2px",
                }}
              >
                {t.description}
              </div>
            )}
            <div
              style={{
                fontSize: "12px",
                color: "#475569",
                marginTop: "6px",
                display: "flex",
                gap: "10px",
                flexWrap: "wrap",
              }}
            >
              <span>📅 {new Date(t.dueDate).toLocaleString()}</span>
              <span>{formatEffect(t)}</span>
              <span>{formatRecurrence(t)}</span>
              <span>· {t.category}</span>
              <span>· priority {t.priority}</span>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            <button style={buttonStyle} onClick={() => handleCancel(t)}>
              Cancel this
            </button>
            {t.isRecurring && (
              <button
                style={dangerButtonStyle}
                onClick={() => handleCancelFamily(t)}
              >
                Cancel all future
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

export default ScheduledTasksPage;
