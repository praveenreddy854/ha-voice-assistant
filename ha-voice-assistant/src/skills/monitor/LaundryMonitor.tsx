import React, { useState, useEffect, useRef } from "react";

interface LaundryStatus {
  entity_id: string;
  state: string;
  last_changed: string;
  last_updated: string;
  attributes: any;
}

interface LaundryMonitorProps {
  onAnnouncement?: (message: string) => void;
}

const LaundryMonitor: React.FC<LaundryMonitorProps> = ({ onAnnouncement }) => {
  const [laundryStatus, setLaundryStatus] = useState<LaundryStatus | null>(
    null
  );
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const laundryTimerRef = useRef<NodeJS.Timeout | null>(null);

  const TIMER_DURATION_MS = 50 * 60 * 1000; // 50 minutes
  const CHECK_INTERVAL_MS = 30000; // 30 seconds

  useEffect(() => {
    // Start monitoring automatically when component mounts
    startMonitoring();

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
      if (laundryTimerRef.current) {
        clearTimeout(laundryTimerRef.current);
      }
    };
  }, []);

  const fetchLaundryStatus = async (): Promise<LaundryStatus | null> => {
    try {
      const response = await fetch("http://localhost:3005/api/laundry-status");
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      return data;
    } catch (error) {
      console.error("Error fetching laundry status:", error);
      setError("Failed to fetch laundry status");
      return null;
    }
  };

  const startLaundryTimer = () => {
    if (laundryTimerRef.current) {
      clearTimeout(laundryTimerRef.current);
    }

    setTimeRemaining(TIMER_DURATION_MS);

    // Start countdown timer
    timerRef.current = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev !== null && prev > 1000) {
          return prev - 1000;
        }
        return prev;
      });
    }, 1000);

    // Set the 50-minute timer
    laundryTimerRef.current = setTimeout(() => {
      const message =
        "Please check on the laundry. It has probably been running for 50 minutes.";
      console.log(message);
      if (onAnnouncement) {
        onAnnouncement(message);
      }
      setTimeRemaining(null);
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    }, TIMER_DURATION_MS);
  };

  const cancelLaundryTimer = () => {
    if (laundryTimerRef.current) {
      clearTimeout(laundryTimerRef.current);
      laundryTimerRef.current = null;
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setTimeRemaining(null);
  };

  const checkLaundryState = async () => {
    const status = await fetchLaundryStatus();
    if (!status) return;

    setLaundryStatus(status);
    setError(null);

    const isOn = status.state === "on";
    const wasOn = laundryStatus?.state === "on";

    if (isOn && !wasOn && !laundryTimerRef.current) {
      // Switch just turned on, start 50-minute timer
      console.log("Laundry switch turned on - starting 50-minute timer");
      startLaundryTimer();
    } else if (!isOn && wasOn && laundryTimerRef.current) {
      // Switch turned off, cancel timer
      console.log("Laundry switch turned off - canceling timer");
      cancelLaundryTimer();
    }
  };

  const startMonitoring = () => {
    if (isMonitoring) return;

    setIsMonitoring(true);
    setError(null);

    // Initial check
    checkLaundryState();

    // Set up interval for periodic checks
    intervalRef.current = setInterval(checkLaundryState, CHECK_INTERVAL_MS);

    console.log("Laundry monitoring started");
  };

  const formatTime = (ms: number): string => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, "0")}`;
  };

  return (
    <div
      style={{
        padding: "20px",
        border: "1px solid #ccc",
        borderRadius: "8px",
        margin: "10px 0",
      }}
    >
      <h3>Laundry Monitor</h3>

      {error && (
        <div style={{ color: "red", marginBottom: "10px" }}>Error: {error}</div>
      )}

      {laundryStatus && (
        <div style={{ marginBottom: "10px" }}>
          <p>
            <strong>Switch Status:</strong> {laundryStatus.state}
          </p>
          <p>
            <strong>Last Updated:</strong>{" "}
            {new Date(laundryStatus.last_updated).toLocaleString()}
          </p>
        </div>
      )}

      {timeRemaining !== null && (
        <div style={{ marginBottom: "10px" }}>
          <p>
            <strong>Time Remaining:</strong> {formatTime(timeRemaining)}
          </p>
          <div
            style={{
              width: "100%",
              height: "20px",
              backgroundColor: "#e0e0e0",
              borderRadius: "10px",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${
                  ((TIMER_DURATION_MS - timeRemaining) / TIMER_DURATION_MS) *
                  100
                }%`,
                height: "100%",
                backgroundColor: "#007bff",
                transition: "width 1s ease-in-out",
              }}
            ></div>
          </div>
        </div>
      )}

      <div style={{ fontSize: "12px", color: "#666" }}>
        {isMonitoring
          ? "Monitoring active - checking every 30 seconds"
          : "Monitoring inactive"}
      </div>
    </div>
  );
};

export default LaundryMonitor;
