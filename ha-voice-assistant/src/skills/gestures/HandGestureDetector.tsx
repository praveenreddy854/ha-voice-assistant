import { useEffect, useRef, useState, useCallback } from "react";
import { Hands } from "@mediapipe/hands";
import { Camera } from "@mediapipe/camera_utils";

interface GestureEvent {
  type: string;
  confidence: number;
  timestamp: number;
}

export default function HandGestureDetector() {
  const videoRef = useRef<HTMLVideoElement>(null);

  // ONLY UI state - minimize re-renders
  const [currentGesture, setCurrentGesture] = useState("");
  const [recentGestures, setRecentGestures] = useState<GestureEvent[]>([]);
  const [debugMode, setDebugMode] = useState(false);
  const [handDistance, setHandDistance] = useState("Unknown");
  const [cameraStatus, setCameraStatus] = useState<
    "checking" | "unavailable" | "available" | "starting" | "ready" | "error"
  >("checking");
  const [cameraError, setCameraError] = useState<string | null>(null);

  // ALL internal state as refs - NO re-renders
  const handsRef = useRef<Hands | null>(null);
  const cameraRef = useRef<any>(null);
  const gestureEngineRef = useRef<GestureEngine | null>(null);
  const isInitializedRef = useRef(false);

  // TV Remote Gesture Engine - Simple and Reliable
  class GestureEngine {
    private handHistory: Array<{
      centroid: { x: number; y: number };
      scale: number;
      timestamp: number;
    }> = [];
    private lastGesture: string = "";
    private lastGestureTime: number = 0;
    private gestureTimeout: NodeJS.Timeout | null = null;

    // Gesture state tracking
    private gestureStartTime: number = 0;
    private gestureDirection: string = "";
    private gestureConfidence: number = 0;
    private readonly MIN_GESTURE_DURATION = 250; // Faster response for better UX
    private readonly GESTURE_COOLDOWN = 600; // Prevent rapid fire

    // Distance and sensitivity
    private currentHandSize: number = 0;
    private adaptiveThreshold: number = 0;

    // Fist (Select) hold detection state
    private fistStartTime: number = 0;
    private fistAnchor: { x: number; y: number; scale: number } | null = null;

    // Compute a stable hand centroid for motion (less jitter than a single landmark)
    private computeCentroid(landmarks: any[]): { x: number; y: number } {
      try {
        const idxs = [0, 5, 9, 13, 17];
        const pts = idxs.map((i) => landmarks[i]);
        const x = pts.reduce((s: number, p: any) => s + p.x, 0) / pts.length;
        const y = pts.reduce((s: number, p: any) => s + p.y, 0) / pts.length;
        return { x, y };
      } catch {
        return { x: landmarks?.[0]?.x ?? 0, y: landmarks?.[0]?.y ?? 0 };
      }
    }

    constructor(
      private onGestureDetected: (gesture: string, confidence: number) => void
    ) {}

    processHand(landmarks: any[]) {
      const now = Date.now();

      // Calculate hand metrics
      this.currentHandSize = this.calculateHandSize(landmarks);
      this.adaptiveThreshold = this.calculateAdaptiveThreshold(
        this.currentHandSize
      );

      // Compute and store stable motion sample (centroid + scale)
      const centroid = this.computeCentroid(landmarks);
      const scale = this.currentHandSize || 0.08; // fallback medium distance
      this.handHistory.push({ centroid, scale, timestamp: now });
      if (this.handHistory.length > 12) {
        this.handHistory.shift();
      }

      // Clean old entries (keep ~1 second of history)
      this.handHistory = this.handHistory.filter(
        (entry) => now - entry.timestamp < 1000
      );

      // Need minimum history for stable detection
      if (this.handHistory.length < 4) return;

      // Check for fist/select gesture first (must be held stationary for >= 1s)
      const fistConfidence = this.detectFistGesture(landmarks);
      if (fistConfidence) {
        // Initialize hold tracking if needed
        if (!this.fistAnchor || this.fistStartTime === 0) {
          this.fistAnchor = { x: centroid.x, y: centroid.y, scale };
          this.fistStartTime = now;
        } else {
          // Measure normalized displacement from anchor (in hand widths)
          const meanScale = Math.max(0.02, (this.fistAnchor.scale + scale) / 2);
          const ndx = (centroid.x - this.fistAnchor.x) / meanScale;
          const ndy = (centroid.y - this.fistAnchor.y) / meanScale;
          const displacementN = Math.hypot(ndx, ndy);

          const heldMs = now - this.fistStartTime;
          const stationaryThresholdN = 0.12; // must stay within ~0.12 hand widths

          // If moved too much, restart the hold window
          if (displacementN > stationaryThresholdN) {
            this.fistAnchor = { x: centroid.x, y: centroid.y, scale };
            this.fistStartTime = now;
          } else if (heldMs >= 1000) {
            // Check cooldown and trigger Select
            if (now - this.lastGestureTime >= this.GESTURE_COOLDOWN) {
              this.onGestureDetected("Select", Math.min(1, fistConfidence));
              this.lastGesture = "Select";
              this.lastGestureTime = now;
            }
            // Reset fist tracking after trigger
            this.fistAnchor = null;
            this.fistStartTime = 0;
            this.resetGestureTracking();
          }
        }
        // While fist is present, do not consider swipe gestures
        return;
      } else {
        // Not a fist — clear any ongoing hold state
        this.fistAnchor = null;
        this.fistStartTime = 0;
      }

      // Check for swipe gestures (movement-based)
      const swipeGesture = this.detectSwipeGesture();
      if (swipeGesture) {
        this.handleGestureDetection(
          swipeGesture.type,
          swipeGesture.confidence,
          now
        );
        return;
      }

      // No clear gesture - reset tracking
      this.resetGestureTracking();
    }

    private calculateAdaptiveThreshold(handSize: number): number {
      // TV-optimized thresholds based on hand size (distance proxy)
      // Smaller hand = further away = need lower threshold
      if (handSize > 0.12) return 0.025; // Very close (1-2 feet)
      if (handSize > 0.08) return 0.02; // Close (2-4 feet)
      if (handSize > 0.05) return 0.015; // Medium (4-7 feet)
      if (handSize > 0.03) return 0.012; // Far (7-10 feet)
      return 0.01; // Very far (10+ feet)
    }

    private handleGestureDetection(
      gestureType: string,
      confidence: number,
      now: number
    ) {
      // Check cooldown period
      if (now - this.lastGestureTime < this.GESTURE_COOLDOWN) {
        console.log(`Gesture ${gestureType} blocked by cooldown`);
        return;
      }

      // Start or continue gesture tracking
      if (this.gestureDirection !== gestureType) {
        // New gesture type detected
        console.log(
          `Starting new gesture: ${gestureType}, confidence: ${confidence.toFixed(
            3
          )}`
        );
        this.gestureDirection = gestureType;
        this.gestureStartTime = now;
        this.gestureConfidence = confidence;
      } else {
        // Same gesture - update confidence
        this.gestureConfidence = Math.max(this.gestureConfidence, confidence);

        // Check if gesture has been sustained long enough
        const duration = now - this.gestureStartTime;
        console.log(
          `Continuing gesture: ${gestureType}, duration: ${duration}ms, confidence: ${this.gestureConfidence.toFixed(
            3
          )}`
        );

        // Slightly adapt duration for very far distances (more jitter)
        const effectiveMin = Math.max(
          180,
          this.MIN_GESTURE_DURATION * (this.currentHandSize < 0.035 ? 1.1 : 1.0)
        );
        if (duration >= effectiveMin && this.gestureConfidence > 0.5) {
          // Trigger gesture
          console.log(`🎯 TRIGGERING GESTURE: ${gestureType}`);
          this.onGestureDetected(gestureType, this.gestureConfidence);
          this.lastGesture = gestureType;
          this.lastGestureTime = now;
          this.resetGestureTracking();

          // Auto-clear display
          if (this.gestureTimeout) clearTimeout(this.gestureTimeout);
          this.gestureTimeout = setTimeout(() => {
            this.lastGesture = "";
          }, 2000);
        }
      }
    }

    private resetGestureTracking() {
      this.gestureDirection = "";
      this.gestureStartTime = 0;
      this.gestureConfidence = 0;
    }

    private calculateHandSize(landmarks: any[]): number {
      try {
        // Simple and reliable hand size calculation
        const wrist = landmarks[0];
        const middleTip = landmarks[12];
        const thumbTip = landmarks[4];
        const pinkyTip = landmarks[20];

        // Hand length (wrist to middle finger tip)
        const length = Math.sqrt(
          Math.pow(middleTip.x - wrist.x, 2) +
            Math.pow(middleTip.y - wrist.y, 2)
        );

        // Hand width (thumb to pinky)
        const width = Math.sqrt(
          Math.pow(thumbTip.x - pinkyTip.x, 2) +
            Math.pow(thumbTip.y - pinkyTip.y, 2)
        );

        // Average for consistent measurement
        return (length + width) / 2;
      } catch {
        return 0.08; // Default medium distance
      }
    }

    private detectFistGesture(landmarks: any[]): number | null {
      try {
        // Simple fist detection - check if fingertips are close to palm
        const palmCenter = landmarks[9]; // Middle finger MCP joint as palm reference
        const fingerTips = [8, 12, 16, 20]; // Index, middle, ring, pinky tips

        let closedFingers = 0;
        const fistThreshold = this.currentHandSize * 0.6; // Adaptive threshold

        for (const tipIndex of fingerTips) {
          const tip = landmarks[tipIndex];
          const distanceToPalm = Math.sqrt(
            Math.pow(tip.x - palmCenter.x, 2) +
              Math.pow(tip.y - palmCenter.y, 2)
          );

          if (distanceToPalm < fistThreshold) {
            closedFingers++;
          }
        }

        // Need at least 3 out of 4 fingers closed for fist
        const confidence = closedFingers / 4;
        return confidence >= 0.75 ? confidence : null;
      } catch {
        return null;
      }
    }

    private detectSwipeGesture(): { type: string; confidence: number } | null {
      if (this.handHistory.length < 4) return null;

      try {
        const start = this.handHistory[0];
        const end = this.handHistory[this.handHistory.length - 1];
        const timeSpan = end.timestamp - start.timestamp;

        // Allow faster gestures, but ignore ultra quick noise
        if (timeSpan < 160 || timeSpan > 1500) return null;

        // Estimate dynamic jitter (noise floor) from frame-to-frame movement normalized by scale
        let jitter = 0;
        let steps = 0;
        for (let i = 1; i < this.handHistory.length; i++) {
          const a = this.handHistory[i - 1];
          const b = this.handHistory[i];
          const meanScale = Math.max(0.02, (a.scale + b.scale) / 2);
          const dx = (b.centroid.x - a.centroid.x) / meanScale;
          const dy = (b.centroid.y - a.centroid.y) / meanScale;
          const d = Math.hypot(dx, dy);
          jitter += d;
          steps++;
        }
        const avgJitter = steps > 0 ? jitter / steps : 0;

        // Compare early and late windows (centroid smoothing)
        const n = this.handHistory.length;
        const w = Math.max(2, Math.floor(n / 3));
        const avgWindow = (
          arr: typeof this.handHistory,
          s: number,
          e: number
        ) => {
          let sx = 0,
            sy = 0,
            ss = 0;
          for (let i = s; i < e; i++) {
            sx += arr[i].centroid.x;
            sy += arr[i].centroid.y;
            ss += arr[i].scale;
          }
          const len = e - s;
          return { x: sx / len, y: sy / len, scale: ss / len };
        };
        const early = avgWindow(this.handHistory, 0, w);
        const late = avgWindow(this.handHistory, n - w, n);

        const meanScale = Math.max(0.02, (early.scale + late.scale) / 2);
        const ndx = (late.x - early.x) / meanScale;
        const ndy = (late.y - early.y) / meanScale;
        const totalMovementN = Math.hypot(ndx, ndy);

        // Dynamic normalized threshold: base + noise-adaptive
        const baseThresholdN = 0.3; // ~0.3 hand widths
        const minMovementN = Math.max(baseThresholdN, avgJitter * 3.0);

        if (totalMovementN < minMovementN) return null;

        // Direction decision using normalized deltas
        const horizontalMovement = Math.abs(ndx);
        const verticalMovement = Math.abs(ndy);

        let gestureType = "";
        let dirConfidence = 0;

        if (horizontalMovement > verticalMovement * 1.2) {
          // Horizontal gesture (mirrored for camera)
          gestureType = ndx > 0 ? "Swipe Left" : "Swipe Right";
          dirConfidence =
            horizontalMovement / (horizontalMovement + verticalMovement);
        } else if (verticalMovement > horizontalMovement * 1.2) {
          // Vertical gesture
          gestureType = ndy > 0 ? "Swipe Down" : "Swipe Up";
          dirConfidence =
            verticalMovement / (horizontalMovement + verticalMovement);
        } else if (horizontalMovement >= verticalMovement) {
          gestureType = ndx > 0 ? "Swipe Left" : "Swipe Right";
          dirConfidence = 0.6;
        } else {
          gestureType = ndy > 0 ? "Swipe Down" : "Swipe Up";
          dirConfidence = 0.6;
        }

        // Blend direction confidence with speed factor
        const speedFactor = Math.min(1.0, totalMovementN / (minMovementN * 2));
        const finalConfidence = Math.max(
          0.5,
          dirConfidence * 0.6 + speedFactor * 0.4
        );

        const result =
          finalConfidence > 0.55
            ? { type: gestureType, confidence: finalConfidence }
            : null;
        if (result) {
          console.log(
            `Swipe Detected: ${gestureType}, nMove=${totalMovementN.toFixed(
              2
            )}, thr=${minMovementN.toFixed(2)}, conf=${finalConfidence.toFixed(
              2
            )}, jitter=${avgJitter.toFixed(2)}, dt=${timeSpan}ms`
          );
        }
        return result;
      } catch {
        return null;
      }
    }

    processNoHand() {
      // Reset all gesture tracking when hand disappears
      this.resetGestureTracking();
      this.handHistory = [];
      this.currentHandSize = 0;
      this.adaptiveThreshold = 0;
      this.fistAnchor = null;
      this.fistStartTime = 0;
    }

    cleanup() {
      if (this.gestureTimeout) {
        clearTimeout(this.gestureTimeout);
      }
    }
  }

  // Gesture callback - only updates UI
  const handleGestureDetected = useCallback(
    (gestureType: string, confidence: number) => {
      setCurrentGesture(gestureType);
      setRecentGestures((prev) => [
        { type: gestureType, confidence, timestamp: Date.now() },
        ...prev.slice(0, 7),
      ]);

      // Auto-clear gesture display
      setTimeout(() => {
        setCurrentGesture("");
      }, 2500);
    },
    []
  );

  // Distance estimation callback - simplified and reliable
  const updateHandDistance = useCallback((landmarks: any[]) => {
    try {
      const wrist = landmarks[0];
      const middleTip = landmarks[12];
      const thumbTip = landmarks[4];
      const pinkyTip = landmarks[20];

      // Calculate hand size same as gesture engine
      const length = Math.sqrt(
        Math.pow(middleTip.x - wrist.x, 2) + Math.pow(middleTip.y - wrist.y, 2)
      );
      const width = Math.sqrt(
        Math.pow(thumbTip.x - pinkyTip.x, 2) +
          Math.pow(thumbTip.y - pinkyTip.y, 2)
      );
      const handSize = (length + width) / 2;

      // Distance categories for TV use
      let distanceText = "";
      if (handSize > 0.12) distanceText = "Very Close (1-2 ft)";
      else if (handSize > 0.08) distanceText = "Close (2-4 ft)";
      else if (handSize > 0.05) distanceText = "Good (4-7 ft)";
      else if (handSize > 0.03) distanceText = "Far (7-10 ft)";
      else distanceText = "TV Distance (10+ ft)";

      setHandDistance(distanceText);
    } catch {
      setHandDistance("Unknown");
    }
  }, []);

  useEffect(() => {
    if (typeof navigator === "undefined") {
      setCameraStatus("unavailable");
      return;
    }

    const checkCameraAvailability = async () => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
        setCameraStatus("unavailable");
        return;
      }

      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasVideoInput = devices.some(
          (device) => device.kind === "videoinput"
        );

        if (!hasVideoInput) {
          setCameraStatus("unavailable");
        } else {
          setCameraStatus("available");
          setCameraError(null);
        }
      } catch (error) {
        console.error("Failed to enumerate media devices:", error);
        setCameraStatus("error");
        setCameraError(
          error instanceof Error ? error.message : String(error)
        );
      }
    };

    checkCameraAvailability();
  }, []);

  useEffect(() => {
    if (cameraStatus === "ready") return;
    if (cameraStatus === "unavailable" || cameraStatus === "error") {
      setCurrentGesture("");
      setRecentGestures([]);
    }
  }, [cameraStatus]);

  const isCameraUnavailable =
    cameraStatus === "unavailable" || cameraStatus === "error";
  const isCameraReady = cameraStatus === "ready";
  const isCameraStarting = cameraStatus === "starting";

  // Initialize everything ONCE - never re-run
  useEffect(() => {
    if (isInitializedRef.current || cameraStatus !== "available") return;

    const videoElement = videoRef.current;
    if (!videoElement) return;

    // Initialize gesture engine
    gestureEngineRef.current = new GestureEngine(handleGestureDetected);

    // Initialize MediaPipe
    const hands = new Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.6,
    });

    // Process results - completely independent of React
    hands.onResults((results) => {
      if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        const landmarks = results.multiHandLandmarks[0];

        // Process gesture
        gestureEngineRef.current?.processHand(landmarks);

        // Update distance (throttled)
        if (Math.random() < 0.1) {
          // Only update 10% of the time
          updateHandDistance(landmarks);
        }
      } else {
        // No hand detected - mark absence but don't be too aggressive
        gestureEngineRef.current?.processNoHand();
      }
    });

    let cancelled = false;

    // Initialize camera - ONCE
    try {
      const camera = new Camera(videoElement, {
        onFrame: async () => {
          await hands.send({ image: videoElement });
        },
        width: 640,
        height: 480,
      });

      isInitializedRef.current = true;
      setCameraStatus("starting");

      camera
        .start()
        .then(() => {
          if (cancelled) return;
          setCameraStatus("ready");
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          console.error("Failed to start camera stream:", error);
          setCameraStatus("error");
          setCameraError(error instanceof Error ? error.message : String(error));
          isInitializedRef.current = false;
        });

      // Store references
      handsRef.current = hands;
      cameraRef.current = camera;
    } catch (error) {
      console.error("Failed to initialize camera:", error);
      setCameraStatus("error");
      setCameraError(error instanceof Error ? error.message : String(error));
      isInitializedRef.current = false;
    }

    // Cleanup function
    return () => {
      cancelled = true;
      gestureEngineRef.current?.cleanup();

      if (cameraRef.current) {
        try {
          cameraRef.current.stop();
        } catch (e) {
          console.warn("Camera cleanup error:", e);
        }
      }

      isInitializedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleGestureDetected, updateHandDistance, cameraStatus]); // GestureEngine is class defined above

  // Gesture display component
  const GestureDisplay = ({ gesture }: { gesture: string }) => {
    if (!gesture || !isCameraReady) return null;

    const getGestureIcon = () => {
      switch (gesture) {
        case "Swipe Right":
          return "👉";
        case "Swipe Left":
          return "👈";
        case "Swipe Up":
          return "👆";
        case "Swipe Down":
          return "👇";
        case "Select":
          return "✊";
        default:
          return "✋";
      }
    };

    const getAnimation = () => {
      switch (gesture) {
        case "Swipe Right":
          return "slide-right";
        case "Swipe Left":
          return "slide-left";
        case "Swipe Up":
          return "slide-up";
        case "Swipe Down":
          return "slide-down";
        case "Select":
          return "pulse-select";
        default:
          return "fade-in";
      }
    };

    return (
      <div className={`gesture-display ${getAnimation()}`}>
        <div className="gesture-icon">{getGestureIcon()}</div>
        <div className="gesture-text">{gesture}</div>
      </div>
    );
  };

  return (
    <div
      className={`tv-gesture-control ${
        isCameraUnavailable ? "camera-disabled" : ""
      }`}
    >
      <div className="header">
        <h2 className="title">
          <span className="icon">📺</span>
          TV Gesture Control
        </h2>
        <button
          type="button"
          className="debug-toggle"
          disabled={!isCameraReady}
          onClick={() => setDebugMode(!debugMode)}
        >
          {debugMode ? "Hide Debug" : "Show Debug"}
        </button>
      </div>

      {(cameraStatus === "checking" || isCameraStarting || isCameraUnavailable) && (
        <div
          className={`camera-status ${
            isCameraUnavailable ? "camera-status--error" : ""
          }`}
        >
          <span className="status-icon">
            {cameraStatus === "checking" || isCameraStarting ? "⏳" : "🚫"}
          </span>
          <span>
            {cameraStatus === "checking" && "Checking for an available camera..."}
            {isCameraStarting && "Camera detected. Starting live preview..."}
            {cameraStatus === "unavailable" &&
              "No camera detected. Gesture control is disabled."}
            {cameraStatus === "error" &&
              `Camera error. Gesture control is disabled${
                cameraError ? `: ${cameraError}` : "."
              }`}
          </span>
        </div>
      )}

      {debugMode && (
        <div className="debug-panel">
          <span>Hand Distance: {handDistance}</span>
          <span>Recent Gestures: {recentGestures.length}</span>
        </div>
      )}

      <div className="main-content">
        <div className={`video-section ${!isCameraReady ? "disabled" : ""}`}>
          <video
            ref={videoRef}
            className="video-feed"
            playsInline
            muted
            style={{ opacity: isCameraReady ? 1 : 0 }}
          />

          {!isCameraReady && (
            <div
              className={`camera-placeholder ${
                isCameraUnavailable ? "camera-placeholder--error" : ""
              }`}
            >
              <span className="camera-placeholder-icon">
                {cameraStatus === "checking" || isCameraStarting ? "📡" : "📷"}
              </span>
              <p className="camera-placeholder-text">
                {cameraStatus === "checking" && "Looking for a camera..."}
                {isCameraStarting && "Camera found. Preparing video feed..."}
                {cameraStatus === "unavailable" &&
                  "No camera detected on this device. Gesture control is unavailable."}
                {cameraStatus === "error" &&
                  "Unable to access the camera. Gesture control is disabled."}
              </p>
              {cameraError && cameraStatus === "error" && (
                <p className="error-details">{cameraError}</p>
              )}
            </div>
          )}

          <div className="gesture-overlay">
            <GestureDisplay gesture={currentGesture} />
          </div>
        </div>

        <div className="info-section">
          <div className="gesture-history">
            <h3>Recent Gestures</h3>
            {recentGestures.length === 0 ? (
              <p className="empty-state">No gestures detected yet</p>
            ) : (
              <div className="gesture-list">
                {recentGestures.map((gesture, index) => (
                  <div
                    key={`${gesture.timestamp}-${index}`}
                    className="gesture-item"
                  >
                    <span className="gesture-icon">
                      {gesture.type === "Swipe Right"
                        ? "👉"
                        : gesture.type === "Swipe Left"
                        ? "👈"
                        : gesture.type === "Swipe Up"
                        ? "👆"
                        : gesture.type === "Swipe Down"
                        ? "👇"
                        : gesture.type === "Select"
                        ? "✊"
                        : "✋"}
                    </span>
                    <span className="gesture-name">{gesture.type}</span>
                    {debugMode && (
                      <span className="confidence">
                        {Math.round(gesture.confidence * 100)}%
                      </span>
                    )}
                    <span className="time-ago">
                      {Math.floor((Date.now() - gesture.timestamp) / 1000)}s ago
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="instructions">
            <h3>How to Use</h3>
            <div className="instruction-list">
              <div className="instruction">
                <span className="icon">👈👉</span>
                <span>Swipe left/right to navigate</span>
              </div>
              <div className="instruction">
                <span className="icon">👆👇</span>
                <span>Swipe up/down to scroll</span>
              </div>
              <div className="instruction">
                <span className="icon">✊</span>
                <span>Make a fist to select</span>
              </div>
              <div className="instruction">
                <span className="icon">📏</span>
                <span>Works best 3-8 feet away</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <style>{`
        .tv-gesture-control {
          padding: 24px;
          background: linear-gradient(135deg, #f0f4f8 0%, #e2e8f0 100%);
          border-radius: 16px;
          box-shadow: 0 10px 25px rgba(0, 0, 0, 0.1);
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        
        .tv-gesture-control.camera-disabled {
          opacity: 0.9;
        }
        
        .camera-status {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 16px;
          padding: 12px 16px;
          background: #edf2f7;
          border-radius: 12px;
          color: #2d3748;
          font-size: 14px;
        }
        
        .camera-status--error {
          background: #fee2e2;
          color: #b91c1c;
        }
        
        .status-icon {
          font-size: 18px;
        }
        
        .header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 20px;
        }
        
        .title {
          font-size: 24px;
          font-weight: 700;
          color: #1a202c;
          margin: 0;
          display: flex;
          align-items: center;
          gap: 8px;
        }
        
        .debug-toggle {
          padding: 6px 12px;
          background: #e2e8f0;
          border: none;
          border-radius: 8px;
          cursor: pointer;
          font-size: 12px;
          transition: all 0.2s;
        }
        
        .debug-toggle:hover {
          background: #cbd5e0;
        }
        
        .debug-toggle:disabled {
          cursor: not-allowed;
          opacity: 0.5;
        }
        
        .debug-toggle:disabled:hover {
          background: #e2e8f0;
        }
        
        .debug-panel {
          background: #fef3c7;
          border: 1px solid #f59e0b;
          border-radius: 8px;
          padding: 12px;
          margin-bottom: 16px;
          display: flex;
          gap: 20px;
          font-size: 14px;
          color: #92400e;
        }
        
        .main-content {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 24px;
        }
        
        @media (max-width: 768px) {
          .main-content {
            grid-template-columns: 1fr;
          }
        }
        
        .video-section {
          position: relative;
        }
        
        .video-section.disabled .video-feed {
          opacity: 0.2;
        }
        
        .video-feed {
          width: 100%;
          height: auto;
          border-radius: 12px;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          transform: scaleX(-1);
        }
        
        .camera-placeholder {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 8px;
          border-radius: 12px;
          background: rgba(241, 245, 249, 0.92);
          text-align: center;
          padding: 24px;
          color: #475569;
        }
        
        .camera-placeholder--error {
          background: rgba(254, 226, 226, 0.95);
          color: #b91c1c;
        }
        
        .camera-placeholder-icon {
          font-size: 36px;
        }
        
        .camera-placeholder-text {
          font-size: 14px;
          font-weight: 500;
        }
        
        .error-details {
          font-size: 12px;
          max-width: 320px;
          color: inherit;
          opacity: 0.8;
          word-break: break-word;
        }
        
        .gesture-overlay {
          position: absolute;
          top: 16px;
          right: 16px;
          z-index: 10;
        }
        
        .gesture-display {
          background: rgba(255, 255, 255, 0.95);
          backdrop-filter: blur(10px);
          border-radius: 12px;
          padding: 16px;
          text-align: center;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
          min-width: 120px;
        }
        
        .gesture-icon {
          font-size: 48px;
          margin-bottom: 8px;
          display: block;
        }
        
        .gesture-text {
          font-size: 14px;
          font-weight: 600;
          color: #2d3748;
        }
        
        .info-section {
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        
        .gesture-history, .instructions {
          background: white;
          border-radius: 12px;
          padding: 20px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        }
        
        .gesture-history h3, .instructions h3 {
          margin: 0 0 16px 0;
          font-size: 18px;
          font-weight: 600;
          color: #2d3748;
        }
        
        .empty-state {
          color: #718096;
          text-align: center;
          margin: 20px 0;
        }
        
        .gesture-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        
        .gesture-item {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px;
          background: #f7fafc;
          border-radius: 8px;
          font-size: 14px;
        }
        
        .gesture-item:first-child {
          background: #ebf8ff;
          border-left: 4px solid #3182ce;
        }
        
        .gesture-name {
          font-weight: 500;
          flex: 1;
        }
        
        .confidence {
          font-size: 12px;
          color: #38a169;
          background: #c6f6d5;
          padding: 2px 6px;
          border-radius: 4px;
        }
        
        .time-ago {
          font-size: 12px;
          color: #a0aec0;
        }
        
        .instruction-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        
        .instruction {
          display: flex;
          align-items: center;
          gap: 12px;
          font-size: 14px;
          color: #4a5568;
        }
        
        .instruction .icon {
          font-size: 20px;
          width: 24px;
          text-align: center;
        }
        
        /* Animations */
        @keyframes slide-right {
          0% { transform: translateX(-10px); opacity: 0; }
          100% { transform: translateX(0); opacity: 1; }
        }
        
        @keyframes slide-left {
          0% { transform: translateX(10px); opacity: 0; }
          100% { transform: translateX(0); opacity: 1; }
        }
        
        @keyframes slide-up {
          0% { transform: translateY(10px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
        
        @keyframes slide-down {
          0% { transform: translateY(-10px); opacity: 0; }
          100% { transform: translateY(0); opacity: 1; }
        }
        
        @keyframes pulse-select {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.1); }
        }
        
        @keyframes fade-in {
          0% { opacity: 0; }
          100% { opacity: 1; }
        }
        
        .slide-right { animation: slide-right 0.3s ease-out; }
        .slide-left { animation: slide-left 0.3s ease-out; }
        .slide-up { animation: slide-up 0.3s ease-out; }
        .slide-down { animation: slide-down 0.3s ease-out; }
        .pulse-select { animation: pulse-select 0.6s ease-in-out; }
        .fade-in { animation: fade-in 0.3s ease-out; }
      `}</style>
    </div>
  );
}
