/**
 * TV Agent Image Processing Utilities
 * Handles TV detection and image cropping using AI SDK vision and Sharp
 */

import { AI_MODEL_MINI } from "../../config";
import { generateVisionText } from "../../ai";
import { BoundingBox, CroppedImage } from "./types";
import {
  saveScreenshotToServerFile,
  saveCroppedScreenshotToServerFile,
} from "./screenshotSaver";
import sharp from "sharp";

/**
 * Detects TV in the image and returns bounding box coordinates using AI SDK vision
 */
export async function detectTvBoundingBox(
  base64Image: string,
  contentType: string
): Promise<BoundingBox | null> {
  if (!AI_MODEL_MINI) {
    console.warn(
      "[TV Agent] AI_MODEL_MINI not configured, skipping image cropping"
    );
    return null;
  }

  try {
    const visionModel = AI_MODEL_MINI || "gpt-4o-mini";
    console.log(`[TV Agent] Detecting TV in image using ${visionModel}...`);

    const prompt = `Analyze this image and detect if there is a TV screen visible. Look for:
- A rectangular display showing content (video, UI, apps, menus)
- TV bezel or frame around the display
- The actual content area, not the wall or surroundings

If a TV is found, return ONLY a JSON object with the bounding box of the CONTENT AREA (not including bezels):
{"found": true, "x": <left-x>, "y": <top-y>, "width": <width>, "height": <height>}

Coordinates must be normalized between 0 and 1 (percentage of image dimensions).
Example: {"found": true, "x": 0.15, "y": 0.1, "width": 0.7, "height": 0.8}

If no TV is found, return: {"found": false}

IMPORTANT: Return ONLY the JSON object, no other text.`;

    const content = await generateVisionText({
      model: visionModel,
      prompt,
      imageBase64: base64Image,
      imageContentType: contentType,
      maxTokens: 200,
    });

    console.log(`[TV Agent] ${visionModel} response:`, content);

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
 * - Uses 15% JPEG quality for reasonable clarity
 * - Enables progressive and mozjpeg compression
 */
export async function cropImageToTv(
  base64Image: string,
  contentType: string,
  sessionId?: string,
  stepIndex?: number,
  toolName?: string
): Promise<CroppedImage | null> {
  try {
    const boundingBox = await detectTvBoundingBox(base64Image, contentType);

    if (!boundingBox) {
      console.log(
        "[TV Agent] Skipping image crop - no TV detected or detection failed"
      );
      return null;
    }

    console.log("[TV Agent] Cropping image to TV bounds...");

    const imageBuffer = Buffer.from(base64Image, "base64");
    const metadata = await sharp(imageBuffer).metadata();
    if (!metadata.width || !metadata.height) {
      console.warn("[TV Agent] Could not determine image dimensions");
      return null;
    }

    const left = Math.round(boundingBox.x * metadata.width);
    const top = Math.round(boundingBox.y * metadata.height);
    const width = Math.round(boundingBox.width * metadata.width);
    const height = Math.round(boundingBox.height * metadata.height);

    console.log("[TV Agent] Cropping to pixels:", { left, top, width, height });

    const croppedBuffer = await sharp(imageBuffer)
      .extract({ left, top, width, height })
      .resize(640, 640, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({
        quality: 15,
        progressive: true,
        mozjpeg: true,
      })
      .toBuffer();

    const croppedBase64 = croppedBuffer.toString("base64");

    console.log(
      `[TV Agent] Image cropped and compressed for token efficiency. Original: ${
        base64Image.length
      } bytes, Cropped: ${croppedBase64.length} bytes (${Math.round(
        (croppedBase64.length / base64Image.length) * 100
      )}% of original size)`
    );

    if (sessionId) {
      try {
        const baseToolName = toolName || "unknown_tool";
        await saveScreenshotToServerFile({
          base64Data: base64Image,
          sessionId,
          toolName: `${baseToolName}_original`,
          stepIndex,
        });
        await saveCroppedScreenshotToServerFile({
          base64Data: croppedBase64,
          sessionId,
          toolName: `${baseToolName}_cropped`,
          stepIndex,
          originalSize: base64Image.length,
          croppedSize: croppedBase64.length,
          cropInfo: `TV crop at (${left},${top}) ${width}x${height}`,
        });
      } catch (saveError) {
        console.warn("[TV Agent] Error saving screenshot files:", saveError);
      }
    }

    return {
      base64: croppedBase64,
      contentType: "image/jpeg",
    };
  } catch (error) {
    console.error("[TV Agent] Error cropping image:", error);
    return null;
  }
}
