import React, { useState, useCallback } from "react";
import { captureTvScreenshot, tvCameraController } from "../utils/tvCamera";
import { httpPost } from "../functions/httpUtils";

/**
 * Teaching Mode UI Component
 * 
 * Creates fine-tuning data for OpenAI models with function calling format.
 * Each step captures:
 * - Screenshot as base64 (the TV screen state)
 * - Tool name and arguments (the function call to make)
 * 
 * Saves to JSONL format for fine-tuning.
 */

// Available TV Agent tools
const TV_TOOLS = [
  { 
    name: "click_power_button", 
    label: "Power Button",
    args: ["remote_entity_id", "reason"]
  },
  { 
    name: "media_control", 
    label: "Media Control",
    args: ["action", "remote_entity_id", "reason"],
    actionOptions: ["play", "pause", "stop", "rewind", "fast_forward", "volume_up", "volume_down", "mute", "unmute", "next", "previous"]
  },
  { 
    name: "click_select_button", 
    label: "Select/OK Button",
    args: ["remote_entity_id", "reason"]
  },
  { 
    name: "open_menu", 
    label: "Open Menu",
    args: ["remote_entity_id", "reason"]
  },
  { 
    name: "type_text", 
    label: "Type Text",
    args: ["text", "remote_entity_id", "reason"]
  },
  { 
    name: "get_latest_screenshot",
    label: "Get Latest Screenshot",
    args: ["reason"]
  },
  { 
    name: "get_device_state", 
    label: "Get Device State",
    args: ["reason", "device_name"]
  },
  { 
    name: "launch_app", 
    label: "Launch App",
    args: ["app_name", "media_player_entity_id", "reason"]
  },
  { 
    name: "delegate_to_navigation", 
    label: "Navigate (Direction/Home/Back)",
    args: ["task_description", "remote_entity_id", "media_player_entity_id"]
  },
];

// Common remote entity IDs
const REMOTE_ENTITIES = [
  "remote.appletv",
  "remote.loft_tv",
  "remote.family_room_tv",
  "remote.77_oled_qn77s90cafxza",
];

// Common media player entity IDs
const MEDIA_PLAYER_ENTITIES = [
  "media_player.appletv",
  "media_player.loft_tv",
  "media_player.family_room_tv",
  "media_player.samsung_tv",
];

interface TeachingStep {
  stepNumber: number;
  action: string; // Human-readable description
  toolName: string;
  toolArgs: Record<string, string>;
  screenshotBase64?: string;
  screenshotDataUrl?: string;
  timestamp: number;
}

interface TeachingModeUIProps {
  onClose: () => void;
  onSaveComplete?: (taskName: string, stepCount: number) => void;
}

const TeachingModeUI: React.FC<TeachingModeUIProps> = ({ onClose, onSaveComplete }) => {
  const [taskName, setTaskName] = useState("");
  const [steps, setSteps] = useState<TeachingStep[]>([]);
  
  // Current step form state
  const [selectedTool, setSelectedTool] = useState(TV_TOOLS[0].name);
  const [toolArgs, setToolArgs] = useState<Record<string, string>>({});
  const [actionDescription, setActionDescription] = useState("");
  
  const [isCapturing, setIsCapturing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraInitialized, setCameraInitialized] = useState(false);
  const [pendingScreenshot, setPendingScreenshot] = useState<{
    base64: string;
    dataUrl: string;
  } | null>(null);

  // Get current tool config
  const currentTool = TV_TOOLS.find(t => t.name === selectedTool) || TV_TOOLS[0];

  // Initialize camera
  const initializeCamera = useCallback(async () => {
    try {
      await tvCameraController.ensureCamera();
      setCameraInitialized(true);
      setError(null);
    } catch (err) {
      setError("Failed to initialize camera. Please allow camera access.");
      console.error("Camera init error:", err);
    }
  }, []);

  // Capture screenshot
  const handleCaptureScreenshot = useCallback(async () => {
    setIsCapturing(true);
    setError(null);

    try {
      if (!cameraInitialized) {
        await initializeCamera();
      }

      const screenshot = await captureTvScreenshot(steps.length, false);

      if (!screenshot.base64 || !screenshot.dataUrl) {
        throw new Error(screenshot.error || "Failed to capture screenshot");
      }

      setPendingScreenshot({
        base64: screenshot.base64,
        dataUrl: screenshot.dataUrl,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Screenshot capture failed");
      console.error("Screenshot error:", err);
    } finally {
      setIsCapturing(false);
    }
  }, [cameraInitialized, initializeCamera, steps.length]);

  // Handle tool argument change
  const handleArgChange = useCallback((argName: string, value: string) => {
    setToolArgs(prev => ({ ...prev, [argName]: value }));
  }, []);

  // Reset tool args when tool changes
  const handleToolChange = useCallback((toolName: string) => {
    setSelectedTool(toolName);
    setToolArgs({});
  }, []);

  // Add step with current data
  const handleAddStep = useCallback(() => {
    // Validate required args
    const requiredArgs = currentTool.args.filter(a => a !== "device_name"); // device_name is optional
    const missingArgs = requiredArgs.filter(arg => !toolArgs[arg]?.trim());
    
    if (missingArgs.length > 0) {
      setError(`Please fill in: ${missingArgs.join(", ")}`);
      return;
    }

    setError(null);
    const stepNumber = steps.length + 1;

    // Generate human-readable description
    const description = actionDescription.trim() || 
      `${currentTool.label}: ${Object.entries(toolArgs).map(([k, v]) => `${k}=${v}`).join(", ")}`;

    const newStep: TeachingStep = {
      stepNumber,
      action: description,
      toolName: selectedTool,
      toolArgs: { ...toolArgs },
      screenshotBase64: pendingScreenshot?.base64,
      screenshotDataUrl: pendingScreenshot?.dataUrl,
      timestamp: Date.now(),
    };

    setSteps((prev) => [...prev, newStep]);
    setToolArgs({});
    setActionDescription("");
    setPendingScreenshot(null);
  }, [currentTool, toolArgs, actionDescription, pendingScreenshot, steps.length, selectedTool]);

  // Remove a step
  const handleRemoveStep = useCallback((stepNumber: number) => {
    setSteps((prev) => {
      const filtered = prev.filter((s) => s.stepNumber !== stepNumber);
      return filtered.map((s, idx) => ({ ...s, stepNumber: idx + 1 }));
    });
  }, []);

  // Save the recording as JSONL for fine-tuning
  const handleSave = useCallback(async () => {
    if (!taskName.trim()) {
      setError("Task name is required");
      return;
    }

    if (steps.length === 0) {
      setError("At least one step is required");
      return;
    }

    setIsSaving(true);
    setError(null);

    try {
      const response = await httpPost<{
        success: boolean;
        message: string;
        filePath?: string;
        linesWritten?: number;
        error?: string;
      }>(
        "/teaching/save-finetune",
        {
          taskName: taskName.trim(),
          steps: steps.map((s) => ({
            stepNumber: s.stepNumber,
            action: s.action,
            toolName: s.toolName,
            toolArgs: s.toolArgs,
            screenshotBase64: s.screenshotBase64,
          })),
        },
        {
          headers: { "Content-Type": "application/json" },
        }
      );

      if (response?.data?.success) {
        onSaveComplete?.(taskName, steps.length);
        setTaskName("");
        setSteps([]);
        setToolArgs({});
        setActionDescription("");
        setPendingScreenshot(null);
        onClose();
      } else {
        setError(response?.data?.error || "Failed to save recording");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      console.error("Save error:", err);
    } finally {
      setIsSaving(false);
    }
  }, [taskName, steps, onClose, onSaveComplete]);

  // Cleanup camera on unmount
  React.useEffect(() => {
    return () => {
      if (tvCameraController.isActive()) {
        tvCameraController.stop();
      }
    };
  }, []);

  // Render argument input based on type
  const renderArgInput = (argName: string) => {
    // Entity ID dropdowns
    if (argName === "remote_entity_id") {
      return (
        <select
          value={toolArgs[argName] || ""}
          onChange={(e) => handleArgChange(argName, e.target.value)}
          style={styles.select}
        >
          <option value="">Select remote...</option>
          {REMOTE_ENTITIES.map(entity => (
            <option key={entity} value={entity}>{entity}</option>
          ))}
        </select>
      );
    }
    
    if (argName === "media_player_entity_id") {
      return (
        <select
          value={toolArgs[argName] || ""}
          onChange={(e) => handleArgChange(argName, e.target.value)}
          style={styles.select}
        >
          <option value="">Select media player...</option>
          {MEDIA_PLAYER_ENTITIES.map(entity => (
            <option key={entity} value={entity}>{entity}</option>
          ))}
        </select>
      );
    }

    // Media action dropdown
    if (argName === "action" && currentTool.actionOptions) {
      return (
        <select
          value={toolArgs[argName] || ""}
          onChange={(e) => handleArgChange(argName, e.target.value)}
          style={styles.select}
        >
          <option value="">Select action...</option>
          {currentTool.actionOptions.map(action => (
            <option key={action} value={action}>{action}</option>
          ))}
        </select>
      );
    }

    // Text input for other args
    return (
      <input
        type="text"
        value={toolArgs[argName] || ""}
        onChange={(e) => handleArgChange(argName, e.target.value)}
        placeholder={argName === "reason" ? "Why this action?" : `Enter ${argName}...`}
        style={styles.input}
      />
    );
  };

  return (
    <div style={styles.overlay}>
      <div style={styles.modal}>
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>📚 Teaching Mode (Function Calling)</h2>
          <button style={styles.closeButton} onClick={onClose}>
            ✕
          </button>
        </div>

        {/* Info banner */}
        <div style={styles.infoBanner}>
          <span style={{ fontSize: "16px" }}>💡</span>
          <span>
            Record tool calls for each step. Data saves as JSONL with function calling format.
          </span>
        </div>

        {/* Error display */}
        {error && <div style={styles.error}>{error}</div>}

        {/* Task Name Input */}
        <div style={styles.section}>
          <label style={styles.label}>Task / User Request</label>
          <input
            type="text"
            value={taskName}
            onChange={(e) => setTaskName(e.target.value)}
            placeholder="e.g., Play latest Telugu songs on YouTube"
            style={styles.input}
          />
        </div>

        {/* Existing Steps */}
        {steps.length > 0 && (
          <div style={styles.section}>
            <label style={styles.label}>Recorded Steps ({steps.length})</label>
            <div style={styles.stepsList}>
              {steps.map((step) => (
                <div key={step.stepNumber} style={styles.stepCard}>
                  <div style={styles.stepHeader}>
                    <span style={styles.stepNumber}>Step {step.stepNumber}</span>
                    <button
                      style={styles.removeButton}
                      onClick={() => handleRemoveStep(step.stepNumber)}
                    >
                      🗑️
                    </button>
                  </div>
                  {step.screenshotDataUrl && (
                    <img
                      src={step.screenshotDataUrl}
                      alt={`Step ${step.stepNumber}`}
                      style={styles.stepThumbnail}
                    />
                  )}
                  <div style={styles.toolCall}>
                    <strong>🔧 {step.toolName}</strong>
                    <pre style={styles.argsPreview}>
                      {JSON.stringify(step.toolArgs, null, 2)}
                    </pre>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Add New Step */}
        <div style={styles.section}>
          <label style={styles.label}>Add New Step</label>
          
          {/* Screenshot Capture */}
          <div style={styles.screenshotSection}>
            {pendingScreenshot ? (
              <div style={styles.screenshotPreview}>
                <img
                  src={pendingScreenshot.dataUrl}
                  alt="Captured screenshot"
                  style={styles.previewImage}
                />
                <button
                  style={styles.clearScreenshotButton}
                  onClick={() => setPendingScreenshot(null)}
                >
                  Retake Screenshot
                </button>
              </div>
            ) : (
              <button
                style={styles.captureButton}
                onClick={handleCaptureScreenshot}
                disabled={isCapturing}
              >
                {isCapturing ? "📷 Capturing..." : "📷 Capture TV Screenshot (Optional)"}
              </button>
            )}
          </div>

          {/* Tool Selection */}
          <div style={{ marginTop: "12px" }}>
            <label style={styles.smallLabel}>Select Tool to Call</label>
            <select
              value={selectedTool}
              onChange={(e) => handleToolChange(e.target.value)}
              style={styles.select}
            >
              {TV_TOOLS.map(tool => (
                <option key={tool.name} value={tool.name}>{tool.label}</option>
              ))}
            </select>
          </div>

          {/* Tool Arguments */}
          <div style={{ marginTop: "12px" }}>
            <label style={styles.smallLabel}>Tool Arguments</label>
            {currentTool.args.map(argName => (
              <div key={argName} style={styles.argRow}>
                <span style={styles.argLabel}>{argName}:</span>
                {renderArgInput(argName)}
              </div>
            ))}
          </div>

          {/* Optional description */}
          <div style={{ marginTop: "12px" }}>
            <label style={styles.smallLabel}>Description (optional)</label>
            <input
              type="text"
              value={actionDescription}
              onChange={(e) => setActionDescription(e.target.value)}
              placeholder="Human-readable description of this step"
              style={styles.input}
            />
          </div>

          <button
            style={styles.addStepButton}
            onClick={handleAddStep}
          >
            ➕ Add Step
          </button>
        </div>

        {/* Footer Actions */}
        <div style={styles.footer}>
          <button style={styles.cancelButton} onClick={onClose}>
            Cancel
          </button>
          <button
            style={styles.saveButton}
            onClick={handleSave}
            disabled={!taskName.trim() || steps.length === 0 || isSaving}
          >
            {isSaving ? "💾 Saving..." : `💾 Save to JSONL (${steps.length} steps)`}
          </button>
        </div>
      </div>
    </div>
  );
};

// Styles
const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: "fixed",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0, 0, 0, 0.7)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    backgroundColor: "#1e293b",
    borderRadius: "16px",
    width: "90%",
    maxWidth: "650px",
    maxHeight: "90vh",
    overflow: "auto",
    boxShadow: "0 20px 60px rgba(0, 0, 0, 0.5)",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "20px 24px",
    borderBottom: "1px solid #334155",
    position: "sticky",
    top: 0,
    backgroundColor: "#1e293b",
    zIndex: 1,
  },
  title: {
    margin: 0,
    color: "#f8fafc",
    fontSize: "1.4rem",
  },
  closeButton: {
    background: "none",
    border: "none",
    color: "#94a3b8",
    fontSize: "1.5rem",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "8px",
  },
  infoBanner: {
    margin: "16px 24px 0",
    padding: "12px 16px",
    backgroundColor: "rgba(59, 130, 246, 0.15)",
    color: "#93c5fd",
    borderRadius: "8px",
    fontSize: "0.9rem",
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  error: {
    margin: "16px 24px 0",
    padding: "12px 16px",
    backgroundColor: "rgba(239, 68, 68, 0.2)",
    color: "#fca5a5",
    borderRadius: "8px",
    fontSize: "0.9rem",
  },
  section: {
    padding: "16px 24px",
  },
  label: {
    display: "block",
    color: "#94a3b8",
    fontSize: "0.85rem",
    fontWeight: 600,
    marginBottom: "8px",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  },
  smallLabel: {
    display: "block",
    color: "#94a3b8",
    fontSize: "0.8rem",
    marginBottom: "6px",
  },
  input: {
    width: "100%",
    padding: "10px 14px",
    backgroundColor: "#0f172a",
    border: "1px solid #334155",
    borderRadius: "8px",
    color: "#f8fafc",
    fontSize: "0.95rem",
    outline: "none",
    boxSizing: "border-box",
  },
  select: {
    width: "100%",
    padding: "10px 14px",
    backgroundColor: "#0f172a",
    border: "1px solid #334155",
    borderRadius: "8px",
    color: "#f8fafc",
    fontSize: "0.95rem",
    outline: "none",
    boxSizing: "border-box",
    cursor: "pointer",
  },
  argRow: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    marginBottom: "8px",
  },
  argLabel: {
    color: "#64748b",
    fontSize: "0.85rem",
    minWidth: "140px",
  },
  stepsList: {
    maxHeight: "250px",
    overflowY: "auto",
  },
  stepCard: {
    backgroundColor: "#0f172a",
    borderRadius: "8px",
    padding: "12px",
    marginBottom: "8px",
    border: "1px solid #334155",
  },
  stepHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "8px",
  },
  stepNumber: {
    color: "#0ea5e9",
    fontWeight: 600,
    fontSize: "0.85rem",
  },
  removeButton: {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "4px",
    fontSize: "1rem",
  },
  stepThumbnail: {
    width: "100%",
    maxHeight: "100px",
    objectFit: "cover",
    borderRadius: "6px",
    marginBottom: "8px",
  },
  toolCall: {
    backgroundColor: "rgba(16, 185, 129, 0.1)",
    padding: "8px",
    borderRadius: "6px",
    color: "#6ee7b7",
    fontSize: "0.85rem",
  },
  argsPreview: {
    margin: "4px 0 0 0",
    fontSize: "0.75rem",
    color: "#94a3b8",
    whiteSpace: "pre-wrap",
    fontFamily: "monospace",
  },
  screenshotSection: {
    textAlign: "center" as const,
  },
  screenshotPreview: {
    textAlign: "center" as const,
  },
  previewImage: {
    maxWidth: "100%",
    maxHeight: "150px",
    borderRadius: "8px",
    border: "2px solid #0ea5e9",
  },
  clearScreenshotButton: {
    marginTop: "8px",
    padding: "8px 16px",
    backgroundColor: "transparent",
    border: "1px solid #64748b",
    borderRadius: "6px",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.85rem",
  },
  captureButton: {
    width: "100%",
    padding: "14px 24px",
    backgroundColor: "#0ea5e9",
    border: "none",
    borderRadius: "8px",
    color: "white",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.95rem",
  },
  addStepButton: {
    width: "100%",
    marginTop: "12px",
    padding: "12px 16px",
    backgroundColor: "#10b981",
    border: "none",
    borderRadius: "8px",
    color: "white",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.95rem",
  },
  footer: {
    display: "flex",
    gap: "12px",
    padding: "20px 24px",
    borderTop: "1px solid #334155",
    position: "sticky",
    bottom: 0,
    backgroundColor: "#1e293b",
  },
  cancelButton: {
    flex: 1,
    padding: "14px 20px",
    backgroundColor: "#334155",
    border: "none",
    borderRadius: "8px",
    color: "#f8fafc",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "1rem",
  },
  saveButton: {
    flex: 2,
    padding: "14px 20px",
    backgroundColor: "#8b5cf6",
    border: "none",
    borderRadius: "8px",
    color: "white",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "1rem",
  },
};

export default TeachingModeUI;
