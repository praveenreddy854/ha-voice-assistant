import React from "react";
import ToggleSwitch from "./ToggleSwitch";

interface SkillWrapperProps {
  children: React.ReactNode;
  skillName: string;
  enabled: boolean;
  globalEnabled: boolean;
  onToggle: (enabled: boolean) => void;
  description?: string;
}

const SkillWrapper: React.FC<SkillWrapperProps> = ({
  children,
  skillName,
  enabled,
  globalEnabled,
  onToggle,
  description,
}) => {
  const isFullyEnabled = globalEnabled && enabled;

  return (
    <div
      style={{
        position: "relative",
        borderRadius: "16px",
        overflow: "hidden",
        transition: "all 0.3s ease",
        transform: isFullyEnabled ? "scale(1)" : "scale(0.98)",
      }}
    >
      {/* Beautiful toggle badge */}
      <div
        style={{
          position: "absolute",
          top: "20px",
          right: "-5px",
          zIndex: 15,
        }}
      >
        <ToggleSwitch
          checked={enabled}
          onChange={onToggle}
          label=""
          disabled={!globalEnabled}
          size="small"
        />
      </div>

      {/* Beautiful disabled overlay */}
      {!isFullyEnabled && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background:
              "linear-gradient(135deg, rgba(148, 163, 184, 0.9) 0%, rgba(100, 116, 139, 0.9) 100%)",
            backdropFilter: "blur(8px)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "16px",
            zIndex: 10,
            animation: "fadeIn 0.3s ease-out",
          }}
        >
          <div
            style={{
              background: "rgba(255, 255, 255, 0.95)",
              borderRadius: "16px",
              padding: "20px",
              textAlign: "center",
              maxWidth: "250px",
              boxShadow: "0 8px 32px rgba(0, 0, 0, 0.1)",
              border: "1px solid rgba(255, 255, 255, 0.8)",
            }}
          >
            <div
              style={{
                fontSize: "32px",
                marginBottom: "8px",
                opacity: 0.7,
              }}
            >
              😴
            </div>
            <div
              style={{
                fontWeight: "700",
                marginBottom: "6px",
                fontSize: "16px",
                color: "#334155",
              }}
            >
              {skillName} Sleeping
            </div>
            {description && (
              <div
                style={{
                  fontSize: "12px",
                  color: "#64748b",
                  lineHeight: "1.4",
                }}
              >
                {description}
              </div>
            )}
            <div
              style={{
                marginTop: "12px",
                fontSize: "11px",
                color: "#94a3b8",
                fontStyle: "italic",
              }}
            >
              Toggle to wake up
            </div>
          </div>
        </div>
      )}

      {/* Skill content with beautiful styling */}
      <div
        style={{
          opacity: isFullyEnabled ? 1 : 0.4,
          pointerEvents: isFullyEnabled ? "auto" : "none",
          transition: "all 0.3s ease",
          filter: isFullyEnabled ? "none" : "grayscale(50%)",
          position: "relative",
        }}
      >
        {/* Subtle glow effect when enabled */}
        {isFullyEnabled && (
          <div
            style={{
              position: "absolute",
              top: "-2px",
              left: "-2px",
              right: "-2px",
              bottom: "-2px",
              background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
              borderRadius: "18px",
              opacity: 0.1,
              zIndex: -1,
              animation: "glow 3s ease-in-out infinite",
            }}
          />
        )}
        {children}
      </div>
    </div>
  );
};

export default SkillWrapper;
