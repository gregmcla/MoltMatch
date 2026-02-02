/**
 * Local Vector Store - SQLite-based embedding storage
 * Provides semantic search without requiring external services like ChromaDB
 */

import { createLogger, registerLogger } from '../utils/logger.js';
import { cosineSimilarity } from '../extraction/embeddings.js';
import type { MatchmakerDatabase } from './database.js';

const logger = createLogger('db');
registerLogger(logger);

export interface LocalVectorSearchResult {
  agentId: string;
  domain: string;
  confidence: number;
  similarity: number;
}

export interface LocalGapSearchResult {
  gapId: number;
  agentId: string;
  domain: string;
  similarity: number;
}

export class LocalVectorStore {
  private db: MatchmakerDatabase;

  constructor(db: MatchmakerDatabase) {
    this.db = db;
  }

  // ==========================================================================
  // Capability Embedding Operations
  // ==========================================================================

  /**
   * Store or update a capability embedding
   */
  upsertCapabilityEmbedding(
    capabilityId: number,
    agentId: string,
    domain: string,
    embedding: number[]
  ): void {
    const embeddingBlob = this.embeddingToBlob(embedding);

    this.db.getDb()
      .prepare(
        `INSERT INTO capability_embeddings (capability_id, agent_id, domain, embedding)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(agent_id, domain) DO UPDATE SET
           capability_id = excluded.capability_id,
           embedding = excluded.embedding,
           updated_at = CURRENT_TIMESTAMP`
      )
      .run(capabilityId, agentId, domain, embeddingBlob);

    logger.debug('capability_embedding_stored', { agentId, domain });
  }

  /**
   * Search for similar capabilities using cosine similarity
   */
  searchCapabilities(
    queryEmbedding: number[],
    limit: number = 100,
    minConfidence: number = 0.5,
    excludeAgentId?: string
  ): LocalVectorSearchResult[] {
    // Get all embeddings (we compute similarity in JS for flexibility)
    let query = `
      SELECT ce.agent_id, ce.domain, ce.embedding, c.confidence
      FROM capability_embeddings ce
      JOIN capabilities c ON ce.capability_id = c.id
      JOIN agents a ON ce.agent_id = a.id
      WHERE c.confidence >= ?
        AND a.excluded = 0
    `;
    const params: (string | number)[] = [minConfidence];

    if (excludeAgentId) {
      query += ' AND ce.agent_id != ?';
      params.push(excludeAgentId);
    }

    const rows = this.db.getDb().prepare(query).all(...params) as Array<{
      agent_id: string;
      domain: string;
      embedding: Buffer;
      confidence: number;
    }>;

    // Calculate similarities
    const results: LocalVectorSearchResult[] = [];

    for (const row of rows) {
      const storedEmbedding = this.blobToEmbedding(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, storedEmbedding);

      results.push({
        agentId: row.agent_id,
        domain: row.domain,
        confidence: row.confidence,
        similarity,
      });
    }

    // Sort by similarity descending and return top results
    results.sort((a, b) => b.similarity - a.similarity);

    logger.debug('local_vector_search_complete', {
      candidatesScanned: rows.length,
      resultsReturned: Math.min(limit, results.length),
      topSimilarity: results[0]?.similarity.toFixed(3),
    });

    return results.slice(0, limit);
  }

  /**
   * Delete capability embeddings for an agent
   */
  deleteAgentEmbeddings(agentId: string): number {
    const result = this.db.getDb()
      .prepare('DELETE FROM capability_embeddings WHERE agent_id = ?')
      .run(agentId);

    return result.changes;
  }

  // ==========================================================================
  // Gap Embedding Operations
  // ==========================================================================

  /**
   * Store a gap embedding
   */
  addGapEmbedding(
    gapId: number,
    agentId: string,
    domain: string,
    embedding: number[]
  ): void {
    const embeddingBlob = this.embeddingToBlob(embedding);

    this.db.getDb()
      .prepare(
        `INSERT OR REPLACE INTO gap_embeddings (gap_id, agent_id, domain, embedding)
         VALUES (?, ?, ?, ?)`
      )
      .run(gapId, agentId, domain, embeddingBlob);

    logger.debug('gap_embedding_stored', { gapId, agentId, domain });
  }

  /**
   * Search for gaps similar to a capability embedding
   */
  searchGaps(
    queryEmbedding: number[],
    limit: number = 50,
    status: string = 'open'
  ): LocalGapSearchResult[] {
    const rows = this.db.getDb()
      .prepare(
        `SELECT ge.gap_id, ge.agent_id, ge.domain, ge.embedding
         FROM gap_embeddings ge
         JOIN capability_gaps cg ON ge.gap_id = cg.id
         WHERE cg.status = ?`
      )
      .all(status) as Array<{
        gap_id: number;
        agent_id: string;
        domain: string;
        embedding: Buffer;
      }>;

    const results: LocalGapSearchResult[] = [];

    for (const row of rows) {
      const storedEmbedding = this.blobToEmbedding(row.embedding);
      const similarity = cosineSimilarity(queryEmbedding, storedEmbedding);

      results.push({
        gapId: row.gap_id,
        agentId: row.agent_id,
        domain: row.domain,
        similarity,
      });
    }

    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, limit);
  }

  /**
   * Delete a gap embedding
   */
  deleteGapEmbedding(gapId: number): void {
    this.db.getDb()
      .prepare('DELETE FROM gap_embeddings WHERE gap_id = ?')
      .run(gapId);
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Convert embedding array to SQLite blob
   */
  private embeddingToBlob(embedding: number[]): Buffer {
    const buffer = Buffer.alloc(embedding.length * 4); // 4 bytes per float32
    for (let i = 0; i < embedding.length; i++) {
      buffer.writeFloatLE(embedding[i], i * 4);
    }
    return buffer;
  }

  /**
   * Convert SQLite blob to embedding array
   */
  private blobToEmbedding(blob: Buffer): number[] {
    const embedding: number[] = [];
    for (let i = 0; i < blob.length; i += 4) {
      embedding.push(blob.readFloatLE(i));
    }
    return embedding;
  }

  /**
   * Get statistics about stored embeddings
   */
  getStats(): { capabilities: number; gaps: number } {
    const capCount = this.db.getDb()
      .prepare('SELECT COUNT(*) as count FROM capability_embeddings')
      .get() as { count: number };

    const gapCount = this.db.getDb()
      .prepare('SELECT COUNT(*) as count FROM gap_embeddings')
      .get() as { count: number };

    return {
      capabilities: capCount.count,
      gaps: gapCount.count,
    };
  }

  /**
   * Clear all embeddings (use with caution)
   */
  clear(): void {
    this.db.getDb().prepare('DELETE FROM capability_embeddings').run();
    this.db.getDb().prepare('DELETE FROM gap_embeddings').run();
    logger.warn('local_vector_store_cleared');
  }
}
