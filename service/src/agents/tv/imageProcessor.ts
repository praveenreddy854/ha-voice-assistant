/**
 * TV Agent Image Processing Utilities
 * Handles TV detection and image cropping using OpenAI vision and Sharp
 */

import { generateText } from "ai";
import {
  AZURE_AI_AGENT_MODEL,
} from "../../config";
import {
  getAzureResponsesModel,
  isAzureAiSdkConfigured,
} from "../../aiSdk";
import { BoundingBox, CroppedImage } from "./types";
import {
  saveScreenshotToServerFile,
  saveCroppedScreenshotToServerFile,
} from "./screenshotSaver";
import sharp from "sharp";

/**
 * Detects TV in the image and returns bounding box coordinates using OpenAI vision
 */
export async function detectTvBoundingBox(
  base64Image: string,
  contentType: string,
): Promise<BoundingBox | null> {
  if (!isAzureAiSdkConfigured()) {
    console.warn(
      "[TV Agent] OpenAI configuration missing, skipping image cropping",
    );
    return null;
  }

  try {
    const visionModel = AZURE_AI_AGENT_MODEL || "gpt-5-mini";
    console.log(`[TV Agent] Detecting TV in image using ${visionModel}...`);

    const response = await generateText({
      model: getAzureResponsesModel(visionModel),
      maxOutputTokens: 200,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Analyze this image and detect if there is a TV screen visible. Look for:
- A rectangular display showing content (video, UI, apps, menus)
- TV bezel or frame around the display
- The actual content area, not the wall or surroundings

If a TV is found, return ONLY a JSON object with the bounding box of the CONTENT AREA (not including bezels):
{"found": true, "x": <left-x>, "y": <top-y>, "width": <width>, "height": <height>}

Coordinates must be normalized between 0 and 1 (percentage of image dimensions).
Example: {"found": true, "x": 0.15, "y": 0.1, "width": 0.7, "height": 0.8}

If no TV is found, return: {"found": false}

IMPORTANT: Return ONLY the JSON object, no other text.`,
            },
            {
              type: "image",
              image: `data:${contentType};base64,${base64Image}`,
            },
          ],
        },
      ],
    });

    const content = response.text;
    if (!content) {
      console.warn(`[TV Agent] No response from ${visionModel} vision model`);
      return null;
    }

    console.log(`[TV Agent] ${visionModel} response:`, content);

    // Parse the JSON response
    const jsonMatch = content.match(/\{[^}]+\}/);
    if (!jsonMatch) {
      console.warn("[TV Agent] Could not extract JSON from vision response");
      return null;
    }

    const result = JSON.parse(jsonMatch[0]);
    if (!result.found) {
      console.log("[TV Agent] No TV detected in image");
      return null;
    }

    console.log("[TV Agent] TV detected at:", {
      x: result.x,
      y: result.y,
      width: result.width,
      height: result.height,
    });

    return {
      x: result.x,
      y: result.y,
      width: result.width,
      height: result.height,
    };
  } catch (error) {
    console.error("[TV Agent] Error detecting TV in image:", error);
    return null;
  }
}

/**
 * Crops the image to focus on the TV using Sharp library
 * Applies moderate compression to balance quality and token consumption:
 * - Resizes to max 640x640 pixels for better detail visibility
 * - Uses 60% JPEG quality for reasonable clarity
 * - Enables progressive and mozjpeg compression
 */
export async function cropImageToTv(
  base64Image: string,
  contentType: string,
  sessionId?: string,
  stepIndex?: number,
  toolName?: string,
  boundingBoxHint?: BoundingBox,
): Promise<CroppedImage | null> {
  try {
    const clamp = (value: number, min: number, max: number): number =>
      Math.min(Math.max(value, min), max);

    const normalizeBoundingBox = (
      boundingBox?: BoundingBox,
    ): BoundingBox | null => {
      if (!boundingBox) return null;
      const x = clamp(boundingBox.x, 0, 1);
      const y = clamp(boundingBox.y, 0, 1);
      const width = clamp(boundingBox.width, 0, 1 - x);
      const height = clamp(boundingBox.height, 0, 1 - y);

      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
      if (width <= 0 || height <= 0) return null;

      return { x, y, width, height };
    };

    const cropWithBoundingBox = async (
      boundingBox: BoundingBox,
    ): Promise<CroppedImage | null> => {
      // Convert base64 to buffer
      const imageBuffer = Buffer.from(base64Image, "base64");

      // Get image metadata to determine dimensions
      const metadata = await sharp(imageBuffer).metadata();
      if (!metadata.width || !metadata.height) {
        console.warn("[TV Agent] Could not determine image dimensions");
        return null;
      }

      // Calculate actual pixel coordinates from normalized values
      const left = Math.round(boundingBox.x * metadata.width);
      const top = Math.round(boundingBox.y * metadata.height);
      const width = Math.round(boundingBox.width * metadata.width);
      const height = Math.round(boundingBox.height * metadata.height);

      const maxWidth = metadata.width - left;
      const maxHeight = metadata.height - top;
      const safeWidth = Math.max(1, Math.min(width, maxWidth));
      const safeHeight = Math.max(1, Math.min(height, maxHeight));

      if (safeWidth <= 1 || safeHeight <= 1) {
        console.warn("[TV Agent] Bounding box too small after clamping");
        return null;
      }

      console.log("[TV Agent] Cropping to pixels:", {
        left,
        top,
        width: safeWidth,
        height: safeHeight,
      });

      // Crop the image with moderate compression for better navigation accuracy
      const croppedBuffer = await sharp(imageBuffer)
        .extract({ left, top, width: safeWidth, height: safeHeight })
        .resize(640, 640, {
          fit: "inside",
          withoutEnlargement: true,
        }) // Resize to max 640x640 for better detail
        .jpeg({
          quality: 60, // Higher quality for UI element visibility
          progressive: true,
          mozjpeg: true, // Better compression if available
        })
        .toBuffer();

      const croppedBase64 = croppedBuffer.toString("base64");

      console.log(
        `[TV Agent] Image cropped and compressed. Original: ${
          base64Image.length
        } bytes, Cropped: ${croppedBase64.length} bytes (${Math.round(
          (croppedBase64.length / base64Image.length) * 100,
        )}% of original size)`,
      );

      // Save both original and cropped images if session info is provided
      if (sessionId) {
        try {
          const baseToolName = toolName || "unknown_tool";

          // Save original image
          await saveScreenshotToServerFile({
            base64Data: base64Image,
            sessionId,
            toolName: `${baseToolName}_original`,
            stepIndex,
          });

          // Save cropped image
          await saveCroppedScreenshotToServerFile({
            base64Data: croppedBase64,
            sessionId,
            toolName: `${baseToolName}_cropped`,
            stepIndex,
            originalSize: base64Image.length,
            croppedSize: croppedBase64.length,
            cropInfo: `TV crop at (${left},${top}) ${safeWidth}x${safeHeight}`,
          });
        } catch (saveError) {
          console.warn("[TV Agent] Error saving screenshot files:", saveError);
        }
      }

      return {
        base64: croppedBase64,
        contentType: "image/jpeg",
        boundingBox,
      };
    };

    const normalizedHint = normalizeBoundingBox(boundingBoxHint);

    if (normalizedHint) {
      const cropped = await cropWithBoundingBox(normalizedHint);
      if (cropped) {
        return cropped;
      }
      console.warn(
        "[TV Agent] Cached bounding box failed, attempting fresh detection",
      );
    }

    const detectedBox = await detectTvBoundingBox(base64Image, contentType);
    const normalizedDetected = normalizeBoundingBox(detectedBox || undefined);

    if (!normalizedDetected) {
      console.log(
        "[TV Agent] Skipping image crop - no TV detected or detection failed",
      );
      return null;
    }

    console.log("[TV Agent] Cropping image to TV bounds...");

    return await cropWithBoundingBox(normalizedDetected);
  } catch (error) {
    console.error("[TV Agent] Error cropping image:", error);
    return null;
  }
}
