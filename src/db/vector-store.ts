/**
 * ChromaDB Vector Store for semantic capability search
 */

import { ChromaClient, Collection, IncludeEnum } from 'chromadb';
import { createLogger, registerLogger } from '../utils/logger.js';

const logger = createLogger('db');
registerLogger(logger);

export interface VectorSearchResult {
  agentId: string;
  domain: string;
  confidence: number;
  distance: number;
  document: string;
}

export interface GapSearchResult {
  gapId: string;
  agentId: string;
  domain: string;
  distance: number;
  document: string;
}

export class VectorStore {
  private client: ChromaClient;
  private capabilityCollection: Collection | null = null;
  private gapCollection: Collection | null = null;
  private initialized = false;

  constructor(chromaPath: string) {
    this.client = new ChromaClient({
      path: chromaPath,
    });
  }

  /**
   * Initialize collections
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Create or get capability collection
      this.capabilityCollection = await this.client.getOrCreateCollection({
        name: 'agent_capabilities',
        metadata: {
          'hnsw:space': 'cosine',
        },
      });

      // Create or get gap collection
      this.gapCollection = await this.client.getOrCreateCollection({
        name: 'capability_gaps',
        metadata: {
          'hnsw:space': 'cosine',
        },
      });

      this.initialized = true;
      logger.info('vector_store_initialized');
    } catch (error) {
      logger.error('vector_store_init_failed', { error: (error as Error).message });
      throw error;
    }
  }

  /**
   * Ensure initialization before operations
   */
  private ensureInitialized(): void {
    if (!this.initialized || !this.capabilityCollection || !this.gapCollection) {
      throw new Error('VectorStore not initialized. Call initialize() first.');
    }
  }

  // ==========================================================================
  // Capability Operations
  // ==========================================================================

  /**
   * Add or update a capability embedding
   */
  async upsertCapability(
    agentId: string,
    domain: string,
    confidence: number,
    description: string,
    embedding: number[]
  ): Promise<void> {
    this.ensureInitialized();

    const id = `${agentId}_${this.normalizeId(domain)}`;

    await this.capabilityCollection!.upsert({
      ids: [id],
      embeddings: [embedding],
      metadatas: [
        {
          agent_id: agentId,
          domain: domain,
          confidence: confidence,
          updated_at: new Date().toISOString(),
        },
      ],
      documents: [description],
    });

    logger.debug('capability_upserted', { agentId, domain, confidence });
  }

  /**
   * Search for capabilities similar to a query
   */
  async searchCapabilities(
    queryEmbedding: number[],
    limit: number = 100,
    minConfidence: number = 0.5,
    excludeAgentId?: string
  ): Promise<VectorSearchResult[]> {
    this.ensureInitialized();

    const whereClause: Record<string, unknown> = {
      confidence: { $gte: minConfidence },
    };

    if (excludeAgentId) {
      whereClause.agent_id = { $ne: excludeAgentId };
    }

    const results = await this.capabilityCollection!.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      where: whereClause,
      include: [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Distances],
    });

    if (!results.ids[0]) return [];

    const searchResults: VectorSearchResult[] = [];

    for (let i = 0; i < results.ids[0].length; i++) {
      const metadata = results.metadatas?.[0]?.[i] as Record<string, unknown> | undefined;
      const document = results.documents?.[0]?.[i];
      const distance = results.distances?.[0]?.[i];

      if (metadata && document !== undefined && distance !== undefined) {
        searchResults.push({
          agentId: metadata.agent_id as string,
          domain: metadata.domain as string,
          confidence: metadata.confidence as number,
          distance: distance,
          document: document || '',
        });
      }
    }

    logger.debug('capabilities_searched', {
      resultsCount: searchResults.length,
      minConfidence,
    });

    return searchResults;
  }

  /**
   * Get all capabilities for an agent
   */
  async getAgentCapabilities(agentId: string): Promise<VectorSearchResult[]> {
    this.ensureInitialized();

    const results = await this.capabilityCollection!.get({
      where: { agent_id: agentId },
      include: [IncludeEnum.Documents, IncludeEnum.Metadatas],
    });

    if (!results.ids) return [];

    const capabilities: VectorSearchResult[] = [];

    for (let i = 0; i < results.ids.length; i++) {
      const metadata = results.metadatas?.[i] as Record<string, unknown> | undefined;
      const document = results.documents?.[i];

      if (metadata) {
        capabilities.push({
          agentId: metadata.agent_id as string,
          domain: metadata.domain as string,
          confidence: metadata.confidence as number,
          distance: 0,
          document: document || '',
        });
      }
    }

    return capabilities;
  }

  /**
   * Delete capabilities for an agent
   */
  async deleteAgentCapabilities(agentId: string): Promise<void> {
    this.ensureInitialized();

    // Get all capability IDs for this agent
    const results = await this.capabilityCollection!.get({
      where: { agent_id: agentId },
    });

    if (results.ids && results.ids.length > 0) {
      await this.capabilityCollection!.delete({
        ids: results.ids,
      });
      logger.debug('agent_capabilities_deleted', { agentId, count: results.ids.length });
    }
  }

  /**
   * Update confidence for a capability
   */
  async updateCapabilityConfidence(
    agentId: string,
    domain: string,
    newConfidence: number
  ): Promise<void> {
    this.ensureInitialized();

    const id = `${agentId}_${this.normalizeId(domain)}`;

    // Get existing entry
    const existing = await this.capabilityCollection!.get({
      ids: [id],
      include: [IncludeEnum.Documents, IncludeEnum.Embeddings, IncludeEnum.Metadatas],
    });

    if (existing.ids.length > 0 && existing.embeddings?.[0]) {
      await this.capabilityCollection!.update({
        ids: [id],
        metadatas: [
          {
            agent_id: agentId,
            domain: domain,
            confidence: newConfidence,
            updated_at: new Date().toISOString(),
          },
        ],
      });
      logger.debug('capability_confidence_updated', { agentId, domain, newConfidence });
    }
  }

  // ==========================================================================
  // Gap Operations
  // ==========================================================================

  /**
   * Add a capability gap
   */
  async addGap(
    gapId: number,
    agentId: string,
    domain: string,
    description: string,
    embedding: number[]
  ): Promise<void> {
    this.ensureInitialized();

    await this.gapCollection!.add({
      ids: [`gap_${gapId}`],
      embeddings: [embedding],
      metadatas: [
        {
          gap_id: gapId.toString(),
          agent_id: agentId,
          domain: domain,
          status: 'open',
          created_at: new Date().toISOString(),
        },
      ],
      documents: [description],
    });

    logger.debug('gap_added', { gapId, agentId, domain });
  }

  /**
   * Search for gaps similar to a capability
   */
  async searchGaps(
    queryEmbedding: number[],
    limit: number = 50,
    status: string = 'open'
  ): Promise<GapSearchResult[]> {
    this.ensureInitialized();

    const results = await this.gapCollection!.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      where: { status: status },
      include: [IncludeEnum.Documents, IncludeEnum.Metadatas, IncludeEnum.Distances],
    });

    if (!results.ids[0]) return [];

    const searchResults: GapSearchResult[] = [];

    for (let i = 0; i < results.ids[0].length; i++) {
      const metadata = results.metadatas?.[0]?.[i] as Record<string, unknown> | undefined;
      const document = results.documents?.[0]?.[i];
      const distance = results.distances?.[0]?.[i];

      if (metadata && document !== undefined && distance !== undefined) {
        searchResults.push({
          gapId: metadata.gap_id as string,
          agentId: metadata.agent_id as string,
          domain: metadata.domain as string,
          distance: distance,
          document: document || '',
        });
      }
    }

    return searchResults;
  }

  /**
   * Update gap status
   */
  async updateGapStatus(gapId: number, status: string): Promise<void> {
    this.ensureInitialized();

    const id = `gap_${gapId}`;

    await this.gapCollection!.update({
      ids: [id],
      metadatas: [{ status: status }],
    });

    logger.debug('gap_status_updated', { gapId, status });
  }

  /**
   * Delete a gap
   */
  async deleteGap(gapId: number): Promise<void> {
    this.ensureInitialized();

    await this.gapCollection!.delete({
      ids: [`gap_${gapId}`],
    });

    logger.debug('gap_deleted', { gapId });
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Normalize a string for use as an ID component
   */
  private normalizeId(str: string): string {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  /**
   * Get collection stats
   */
  async getStats(): Promise<{
    capabilities: number;
    gaps: number;
  }> {
    this.ensureInitialized();

    const capCount = await this.capabilityCollection!.count();
    const gapCount = await this.gapCollection!.count();

    return {
      capabilities: capCount,
      gaps: gapCount,
    };
  }

  /**
   * Clear all data (use with caution!)
   */
  async clear(): Promise<void> {
    this.ensureInitialized();

    // Delete and recreate collections
    await this.client.deleteCollection({ name: 'agent_capabilities' });
    await this.client.deleteCollection({ name: 'capability_gaps' });

    this.initialized = false;
    await this.initialize();

    logger.warn('vector_store_cleared');
  }
}
