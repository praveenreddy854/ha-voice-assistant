"""
Open-hand (wave/hi) gesture detector using MediaPipe Hand Landmarker.

Runs as a persistent process. Reads JPEG file paths from stdin (one per line),
outputs JSON results to stdout. Model loads once at startup.

Usage: python3 gesture_detector.py
  Then send file paths via stdin, one per line.
  Output: {"gesture": "open_hand", "confidence": 0.85} or {"gesture": "none"}
"""

import sys
import os
import json
from datetime import datetime
import numpy as np
import mediapipe as mp
from PIL import Image as PILImage

BaseOptions = mp.tasks.BaseOptions
HandLandmarker = mp.tasks.vision.HandLandmarker
HandLandmarkerOptions = mp.tasks.vision.HandLandmarkerOptions
VisionRunningMode = mp.tasks.vision.RunningMode

MODEL_PATH = os.path.join(os.path.dirname(__file__), "..", "models", "hand_landmarker.task")

options = HandLandmarkerOptions(
    base_options=BaseOptions(model_asset_path=MODEL_PATH),
    running_mode=VisionRunningMode.IMAGE,
    num_hands=1,
    min_hand_detection_confidence=0.3,
    min_hand_presence_confidence=0.3,
)

landmarker = HandLandmarker.create_from_options(options)


def detect_open_hand(landmarks) -> dict:
    """Detect open hand (five fingers spread, like waving or saying hi).

    Each finger is "extended" when its tip is farther from the wrist
    than its MCP (knuckle) joint — meaning it's straightened out.
    """
    wrist = landmarks[0]

    # (tip_index, mcp_index) for each finger
    fingers = [
        (4, 2),    # Thumb: tip vs IP joint
        (8, 5),    # Index: tip vs MCP
        (12, 9),   # Middle: tip vs MCP
        (16, 13),  # Ring: tip vs MCP
        (20, 17),  # Pinky: tip vs MCP
    ]

    extended = 0
    for tip_idx, base_idx in fingers:
        tip = landmarks[tip_idx]
        base = landmarks[base_idx]
        tip_dist = ((tip.x - wrist.x) ** 2 + (tip.y - wrist.y) ** 2) ** 0.5
        base_dist = ((base.x - wrist.x) ** 2 + (base.y - wrist.y) ** 2) ** 0.5
        if tip_dist > base_dist:
            extended += 1

    confidence = extended / 5.0
    if confidence >= 0.8:  # At least 4 of 5 fingers extended
        return {"gesture": "open_hand", "confidence": round(confidence, 2)}
    return {"gesture": "none"}


def process_frame(path: str) -> dict:
    """Read image, detect hand landmarks, classify gesture.

    The camera is behind the user facing the TV, so the hand appears
    small at the bottom of a TV-dominated frame. We try the full image
    first, then crop to the bottom 40% for a closer look at the hand area.
    """
    try:
        image = mp.Image.create_from_file(path)
    except Exception:
        return {"gesture": "none", "error": "cannot read image"}

    # Try full image first
    result = landmarker.detect(image)
    if result.hand_landmarks:
        return detect_open_hand(result.hand_landmarks[0])

    # No hand found — crop bottom 40% where the user's hand would be
    try:
        full = image.numpy_view()  # RGB numpy array
        h = full.shape[0]
        cropped = np.ascontiguousarray(full[int(h * 0.75):, :, :])

        # Save cropped frame for debugging
        hands_dir = os.path.join(os.path.dirname(path), "..", "hands")
        os.makedirs(hands_dir, exist_ok=True)
        ts = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
        PILImage.fromarray(cropped[:, :, :3]).save(os.path.join(hands_dir, f"{ts}.png"))

        cropped_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=cropped)
        result = landmarker.detect(cropped_image)
        if result.hand_landmarks:
            return detect_open_hand(result.hand_landmarks[0])
    except Exception:
        pass

    return {"gesture": "none"}


# Main loop: read paths from stdin, write JSON to stdout
sys.stderr.write("[gesture_detector] ready\n")
sys.stderr.flush()

for line in sys.stdin:
    path = line.strip()
    if not path:
        continue
    try:
        out = process_frame(path)
    except Exception as e:
        out = {"gesture": "none", "error": str(e)}

    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()
