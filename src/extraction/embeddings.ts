/**
 * Embedding Generator
 * Generates vector embeddings for semantic search
 *
 * Note: This implementation uses a simple text-based approach.
 * For production, consider using:
 * - OpenAI's text-embedding-3-small
 * - Cohere's embed-english-v3.0
 * - Local models via @xenova/transformers
 */

import { createLogger, registerLogger } from '../utils/logger.js';
import { LRUCache } from 'lru-cache';

const logger = createLogger('extractor');
registerLogger(logger);

// Embedding dimension (must be consistent)
const EMBEDDING_DIM = 384;

// Cache embeddings to reduce computation
const embeddingCache = new LRUCache<string, number[]>({
  max: 10000,
  ttl: 24 * 60 * 60 * 1000, // 24 hours
});

/**
 * Simple hash-based embedding generator
 * This creates consistent, deterministic embeddings based on text content.
 * For production, replace with a proper embedding model.
 */
export function generateEmbedding(text: string): number[] {
  // Check cache first
  const cached = embeddingCache.get(text);
  if (cached) {
    return cached;
  }

  // Normalize text
  const normalized = text.toLowerCase().trim();

  // Generate embedding using a seeded random approach based on character codes
  // This ensures the same text always produces the same embedding
  const embedding = new Array(EMBEDDING_DIM).fill(0);

  // Use multiple passes over the text to fill the embedding
  for (let i = 0; i < normalized.length; i++) {
    const charCode = normalized.charCodeAt(i);

    // Distribute character influence across embedding dimensions
    for (let j = 0; j < EMBEDDING_DIM; j++) {
      // Create a pseudo-random but deterministic contribution
      const seed = (charCode * (i + 1) * (j + 1)) % 1000;
      const contribution = Math.sin(seed) * 0.1;
      embedding[j] += contribution;
    }
  }

  // Normalize to unit length
  const magnitude = Math.sqrt(
    embedding.reduce((sum, val) => sum + val * val, 0)
  );

  if (magnitude > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      embedding[i] /= magnitude;
    }
  }

  // Add some structure based on common programming terms
  addTermBoosts(embedding, normalized);

  // Re-normalize after boosts
  const finalMagnitude = Math.sqrt(
    embedding.reduce((sum, val) => sum + val * val, 0)
  );

  if (finalMagnitude > 0) {
    for (let i = 0; i < EMBEDDING_DIM; i++) {
      embedding[i] /= finalMagnitude;
    }
  }

  // Cache the result
  embeddingCache.set(text, embedding);

  return embedding;
}

/**
 * Add boosts to specific dimensions based on detected terms
 * This helps cluster related concepts together
 */
function addTermBoosts(embedding: number[], text: string): void {
  const termGroups: Record<string, { dims: number[]; boost: number }> = {
    // Programming languages
    python: { dims: [0, 1, 2], boost: 0.3 },
    javascript: { dims: [3, 4, 5], boost: 0.3 },
    typescript: { dims: [3, 4, 6], boost: 0.3 },
    rust: { dims: [7, 8, 9], boost: 0.3 },
    go: { dims: [10, 11, 12], boost: 0.3 },

    // Domains
    'web': { dims: [20, 21, 22], boost: 0.2 },
    'api': { dims: [23, 24, 25], boost: 0.2 },
    'database': { dims: [26, 27, 28], boost: 0.2 },
    'security': { dims: [29, 30, 31], boost: 0.25 },
    'ml': { dims: [32, 33, 34], boost: 0.2 },
    'machine learning': { dims: [32, 33, 34], boost: 0.25 },
    'nlp': { dims: [35, 36, 37], boost: 0.2 },

    // Actions
    'debug': { dims: [50, 51, 52], boost: 0.2 },
    'fix': { dims: [50, 51, 53], boost: 0.15 },
    'build': { dims: [54, 55, 56], boost: 0.15 },
    'deploy': { dims: [57, 58, 59], boost: 0.15 },
    'test': { dims: [60, 61, 62], boost: 0.15 },

    // Technologies
    'websocket': { dims: [70, 71, 72], boost: 0.25 },
    'async': { dims: [73, 74, 75], boost: 0.2 },
    'docker': { dims: [76, 77, 78], boost: 0.2 },
    'kubernetes': { dims: [79, 80, 81], boost: 0.2 },
    'react': { dims: [82, 83, 84], boost: 0.2 },

    // Agent-specific
    'context': { dims: [100, 101, 102], boost: 0.2 },
    'memory': { dims: [103, 104, 105], boost: 0.2 },
    'prompt': { dims: [106, 107, 108], boost: 0.2 },
    'agent': { dims: [109, 110, 111], boost: 0.15 },
  };

  for (const [term, config] of Object.entries(termGroups)) {
    if (text.includes(term)) {
      for (const dim of config.dims) {
        if (dim < EMBEDDING_DIM) {
          embedding[dim] += config.boost;
        }
      }
    }
  }
}

/**
 * Calculate cosine similarity between two embeddings
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error('Embedding dimensions must match');
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  magnitudeA = Math.sqrt(magnitudeA);
  magnitudeB = Math.sqrt(magnitudeB);

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return dotProduct / (magnitudeA * magnitudeB);
}

/**
 * Find the most similar items from a list
 */
export function findMostSimilar<T>(
  query: number[],
  items: Array<{ embedding: number[]; data: T }>,
  topK: number = 10
): Array<{ data: T; similarity: number }> {
  const scored = items.map((item) => ({
    data: item.data,
    similarity: cosineSimilarity(query, item.embedding),
  }));

  scored.sort((a, b) => b.similarity - a.similarity);

  return scored.slice(0, topK);
}

/**
 * Generate embedding for a capability description
 */
export function embedCapability(
  domain: string,
  description: string,
  signalType: string
): number[] {
  // Combine domain, description, and signal type for richer embedding
  const fullText = `${domain} ${description} ${signalType}`;
  return generateEmbedding(fullText);
}

/**
 * Generate embedding for a capability gap/need
 */
export function embedGap(domain: string, description: string): number[] {
  // Add "need help with" context to the embedding
  const fullText = `need help with ${domain} ${description}`;
  return generateEmbedding(fullText);
}

/**
 * Clear the embedding cache
 */
export function clearEmbeddingCache(): void {
  embeddingCache.clear();
  logger.info('embedding_cache_cleared');
}

/**
 * Get cache statistics
 */
export function getEmbeddingCacheStats(): { size: number; maxSize: number } {
  return {
    size: embeddingCache.size,
    maxSize: embeddingCache.max,
  };
}
