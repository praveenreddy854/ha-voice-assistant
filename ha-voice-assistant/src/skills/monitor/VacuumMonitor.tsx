import React, { useState, useEffect, useRef } from "react";

interface VacuumStatus {
  entity_id: string;
  state: string;
  last_changed: string;
  last_updated: string;
  attributes: any;
}

interface VacuumMonitorProps {
  onAnnouncement?: (message: string) => void;
}

const VacuumMonitor: React.FC<VacuumMonitorProps> = ({ onAnnouncement }) => {
  const [vacuumStatus, setVacuumStatus] = useState<VacuumStatus | null>(null);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastAnnouncementDate, setLastAnnouncementDate] = useState<string>("");

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const timeCheckRef = useRef<NodeJS.Timeout | null>(null);

  const CHECK_INTERVAL_MS = 60000 * 60; // Check every hour
  const ANNOUNCEMENT_TIME = 9; // 9 AM

  useEffect(() => {
    startMonitoring();

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      if (timeCheckRef.current) {
        clearInterval(timeCheckRef.current);
      }
    };
  }, []);

  const fetchVacuumStatus = async (): Promise<VacuumStatus | null> => {
    try {
      const response = await fetch("http://localhost:3005/api/vacuum-status");
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const data = await response.json();
      return data;
    } catch (error) {
      console.error("Error fetching vacuum status:", error);
      setError("Failed to fetch vacuum status");
      return null;
    }
  };

  const isDocked = (status: VacuumStatus): boolean => {
    return (
      status.state === "docked" || status.attributes?.status === "Charging"
    );
  };

  const checkTime = () => {
    const now = new Date();
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const today = now.toDateString();

    // Check if it's 9:00 AM and we haven't announced today yet
    if (
      currentHour === ANNOUNCEMENT_TIME &&
      currentMinute === 0 &&
      lastAnnouncementDate !== today
    ) {
      checkVacuumAndAnnounce(today);
    }
  };

  const checkVacuumAndAnnounce = async (today: string) => {
    const status = await fetchVacuumStatus();
    if (!status) return;

    if (!isDocked(status)) {
      const message =
        "The robot vacuum is not docked. It might be stuck somewhere and needs assistance.";
      console.log(message);
      if (onAnnouncement) {
        onAnnouncement(message);
      }
      setLastAnnouncementDate(today);
    }
  };

  const checkVacuumState = async () => {
    const status = await fetchVacuumStatus();
    if (!status) return;

    setVacuumStatus(status);
    setError(null);

    // Check time for 9 AM announcement
    checkTime();
  };

  const startMonitoring = () => {
    if (isMonitoring) return;

    setIsMonitoring(true);
    setError(null);

    // Initial check
    checkVacuumState();

    // Set up interval for periodic checks
    intervalRef.current = setInterval(checkVacuumState, CHECK_INTERVAL_MS);

    console.log("Vacuum monitoring started");
  };

  const getStatusDisplay = (
    status: VacuumStatus
  ): { text: string; color: string } => {
    if (isDocked(status)) {
      return { text: "Docked/Charging", color: "#28a745" };
    } else if (status.state === "cleaning") {
      return { text: "Cleaning", color: "#007bff" };
    } else if (status.state === "returning") {
      return { text: "Returning to dock", color: "#ffc107" };
    } else if (status.state === "error") {
      return { text: "Error - Possibly stuck", color: "#dc3545" };
    } else {
      return { text: status.state, color: "#6c757d" };
    }
  };

  const getNextAnnouncementTime = (): string => {
    const now = new Date();
    const nextAnnouncement = new Date();
    nextAnnouncement.setHours(ANNOUNCEMENT_TIME, 0, 0, 0);

    if (now.getHours() >= ANNOUNCEMENT_TIME) {
      nextAnnouncement.setDate(nextAnnouncement.getDate() + 1);
    }

    return nextAnnouncement.toLocaleString();
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
      <h3>Vacuum Monitor</h3>

      {error && (
        <div style={{ color: "red", marginBottom: "10px" }}>Error: {error}</div>
      )}

      {vacuumStatus && (
        <div style={{ marginBottom: "10px" }}>
          <p>
            <strong>Status:</strong>{" "}
            <span
              style={{
                color: getStatusDisplay(vacuumStatus).color,
                fontWeight: "bold",
              }}
            >
              {getStatusDisplay(vacuumStatus).text}
            </span>
          </p>
          <p>
            <strong>Battery:</strong>{" "}
            {vacuumStatus.attributes?.battery_level || "Unknown"}%
          </p>
          <p>
            <strong>Last Updated:</strong>{" "}
            {new Date(vacuumStatus.last_updated).toLocaleString()}
          </p>
        </div>
      )}

      <div style={{ fontSize: "12px", color: "#666", marginTop: "10px" }}>
        <p>
          {isMonitoring
            ? "Monitoring active - checking every minute"
            : "Monitoring inactive"}
        </p>
        <p>Next announcement check: {getNextAnnouncementTime()}</p>
        {lastAnnouncementDate && (
          <p>Last announcement: {lastAnnouncementDate}</p>
        )}
      </div>
    </div>
  );
};

export default VacuumMonitor;
