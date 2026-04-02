/**
 * Embeddings for similarity search
 * Uses Azure AI SDK embeddings to find similar recordings
 */

import { embed } from "ai";
import { azureProvider } from "../../../ai";
import { EMBEDDING_MODEL } from "../../../config";
import { loadIndex } from "./storage";
import { SimilarRecording } from "./types";

/**
 * Generate an embedding for a text string
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const { embedding } = await embed({
      model: azureProvider.embeddingModel(EMBEDDING_MODEL),
      value: text,
    });
    return embedding;
  } catch (error) {
    console.error("[Teaching Embeddings] Error generating embedding:", error);
    return [];
  }
}

/**
 * Calculate cosine similarity between two vectors
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Find recordings similar to a query
 */
export async function findSimilarRecordings(
  queryEmbedding: number[],
  topK: number = 5,
  minSimilarity: number = 0.7
): Promise<SimilarRecording[]> {
  const index = await loadIndex();

  if (queryEmbedding.length === 0) {
    return [];
  }

  const results: SimilarRecording[] = [];

  for (const entry of index) {
    if (!entry.embedding || entry.embedding.length === 0) {
      continue;
    }

    const similarity = cosineSimilarity(queryEmbedding, entry.embedding);
    if (similarity >= minSimilarity) {
      results.push({
        id: entry.id,
        taskName: entry.taskName,
        similarity,
        embedding: entry.embedding,
        filePath: entry.filePath,
      });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}

/**
 * Find the best matching recording for a query
 */
export async function findBestMatch(
  queryEmbedding: number[]
): Promise<SimilarRecording | null> {
  const results = await findSimilarRecordings(queryEmbedding, 1, 0);
  return results.length > 0 ? results[0] : null;
}

/**
 * Update embeddings for recordings that don't have them
 */
export async function updateMissingEmbeddings(): Promise<number> {
  const index = await loadIndex();
  let updatedCount = 0;

  for (const entry of index) {
    if (!entry.embedding || entry.embedding.length === 0) {
      const embedding = await generateEmbedding(entry.taskName);
      if (embedding.length > 0) {
        entry.embedding = embedding;
        updatedCount++;
      }
    }
  }

  return updatedCount;
}
