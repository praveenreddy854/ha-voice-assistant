/**
 * Azure Blob Storage for Teaching Screenshots
 * 
 * Uploads screenshots to Azure Blob Storage and returns public URLs
 * for use in fine-tuning training data (JSONL files)
 */

import { BlobServiceClient, ContainerClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { v4 as uuidv4 } from "uuid";

// Azure Blob Storage configuration from environment variables
const AZURE_STORAGE_ACCOUNT_NAME = process.env.AZURE_STORAGE_ACCOUNT_NAME || "hatvagent";
const AZURE_STORAGE_ACCOUNT_KEY = process.env.AZURE_STORAGE_ACCOUNT_KEY || "";
const AZURE_STORAGE_CONTAINER_NAME = process.env.AZURE_STORAGE_CONTAINER_NAME || "ftimages";

// Base URL for blob storage
const BLOB_BASE_URL = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net/${AZURE_STORAGE_CONTAINER_NAME}`;

let containerClient: ContainerClient | null = null;

/**
 * Initialize the blob storage client
 */
function getContainerClient(): ContainerClient | null {
  if (containerClient) {
    return containerClient;
  }

  if (!AZURE_STORAGE_ACCOUNT_KEY) {
    console.warn("[BlobStorage] AZURE_STORAGE_ACCOUNT_KEY not set, blob upload disabled");
    return null;
  }

  try {
    const sharedKeyCredential = new StorageSharedKeyCredential(
      AZURE_STORAGE_ACCOUNT_NAME,
      AZURE_STORAGE_ACCOUNT_KEY
    );

    const blobServiceClient = new BlobServiceClient(
      `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net`,
      sharedKeyCredential
    );

    containerClient = blobServiceClient.getContainerClient(AZURE_STORAGE_CONTAINER_NAME);
    console.log(`[BlobStorage] Initialized container client for: ${AZURE_STORAGE_CONTAINER_NAME}`);
    return containerClient;
  } catch (error) {
    console.error("[BlobStorage] Failed to initialize client:", error);
    return null;
  }
}

/**
 * Get file extension from content type
 */
function getExtensionFromContentType(contentType: string): string {
  const mimeToExt: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
  };
  return mimeToExt[contentType] || "png";
}

/**
 * Generate a unique blob name for a teaching screenshot
 */
function generateBlobName(taskName: string, stepNumber: number, contentType: string): string {
  // Sanitize task name for use in blob path
  const sanitizedTask = taskName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 50);

  const extension = getExtensionFromContentType(contentType);
  const timestamp = Date.now();
  const uniqueId = uuidv4().substring(0, 8);

  return `teaching/${sanitizedTask}/step-${stepNumber}-${timestamp}-${uniqueId}.${extension}`;
}

/**
 * Upload a screenshot to Azure Blob Storage
 * 
 * @param base64Data - Base64 encoded image data (without data: prefix)
 * @param contentType - MIME type of the image (e.g., "image/png")
 * @param taskName - Name of the teaching task
 * @param stepNumber - Step number in the teaching session
 * @returns URL of the uploaded blob, or null if upload failed
 */
export async function uploadScreenshotToBlob(
  base64Data: string,
  contentType: string,
  taskName: string,
  stepNumber: number
): Promise<string | null> {
  const client = getContainerClient();
  
  if (!client) {
    console.warn("[BlobStorage] Container client not available, skipping upload");
    return null;
  }

  try {
    // Remove data URL prefix if present
    const cleanBase64 = base64Data.replace(/^data:[^;]+;base64,/, "");
    
    // Convert base64 to buffer
    const buffer = Buffer.from(cleanBase64, "base64");
    
    // Generate blob name
    const blobName = generateBlobName(taskName, stepNumber, contentType);
    
    // Get blob client
    const blockBlobClient = client.getBlockBlobClient(blobName);
    
    // Upload the image
    await blockBlobClient.uploadData(buffer, {
      blobHTTPHeaders: {
        blobContentType: contentType,
        blobCacheControl: "public, max-age=31536000", // Cache for 1 year
      },
    });
    
    // Construct the public URL
    const blobUrl = `${BLOB_BASE_URL}/${blobName}`;
    
    console.log(`[BlobStorage] Uploaded screenshot: ${blobUrl}`);
    return blobUrl;
  } catch (error) {
    console.error("[BlobStorage] Failed to upload screenshot:", error);
    return null;
  }
}

/**
 * Check if blob storage is configured and available
 */
export function isBlobStorageAvailable(): boolean {
  return !!AZURE_STORAGE_ACCOUNT_KEY;
}

/**
 * Get the blob URL base for reference
 */
export function getBlobBaseUrl(): string {
  return BLOB_BASE_URL;
}
