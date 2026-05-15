import React from "react";

export type ActiveView = "main" | "scheduledTasks";

interface HeaderProps {
  activeView: ActiveView;
  onChangeView: (view: ActiveView) => void;
}

const linkStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  cursor: "pointer",
  padding: "8px 14px",
  fontSize: "14px",
  fontWeight: 600,
  color: "#475569",
  borderRadius: "8px",
};

const activeLinkStyle: React.CSSProperties = {
  ...linkStyle,
  background: "#1e293b",
  color: "white",
};

const Header: React.FC<HeaderProps> = ({ activeView, onChangeView }) => {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "12px 24px",
        borderBottom: "1px solid #e2e8f0",
        background: "white",
        marginBottom: "16px",
      }}
    >
      <div style={{ fontWeight: 700, fontSize: "16px", color: "#1e293b" }}>
        🏠 HA Voice Assistant
      </div>
      <nav style={{ display: "flex", gap: "8px" }}>
        <button
          style={activeView === "main" ? activeLinkStyle : linkStyle}
          onClick={() => onChangeView("main")}
        >
          Assistant
        </button>
        <button
          style={
            activeView === "scheduledTasks" ? activeLinkStyle : linkStyle
          }
          onClick={() => onChangeView("scheduledTasks")}
        >
          Scheduled Tasks
        </button>
      </nav>
    </header>
  );
};

export default Header;
