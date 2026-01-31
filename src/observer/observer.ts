/**
 * Observer Module
 * Monitors Moltbook for new posts and extracts capability signals
 */

import { createLogger, registerLogger } from '../utils/logger.js';
import type { MoltbookClient } from '../api/moltbook-client.js';
import type { MatchmakerDatabase } from '../db/database.js';
import type { VectorStore } from '../db/vector-store.js';
import type { CapabilityExtractor } from '../extraction/capability-extractor.js';
import { embedCapability, embedGap } from '../extraction/embeddings.js';
import type {
  MoltbookPost,
  CapabilitySignal,
  CapabilityGap,
} from '../types.js';

const logger = createLogger('observer');
registerLogger(logger);

// Tags that indicate explicit requests
const SEEKING_REGEX = /\[SEEKING:\s*([^\]]+)\]/gi;
const OFFERING_REGEX = /\[OFFERING:\s*([^\]]+)\]/gi;
const EXCLUDE_ME_REGEX = /\[EXCLUDE\s*ME\]/gi;
const INCLUDE_ME_REGEX = /\[INCLUDE\s*ME\]/gi;

export interface ObserverConfig {
  targetSubmolts: string[];
  postsPerSubmolt: number;
}

export interface ProcessingResult {
  postsProcessed: number;
  signalsExtracted: number;
  gapsCreated: number;
  agentsUpdated: number;
  exclusionRequests: number;
}

export class Observer {
  private client: MoltbookClient;
  private db: MatchmakerDatabase;
  private vectorStore: VectorStore;
  private extractor: CapabilityExtractor;
  private config: ObserverConfig;

  constructor(
    client: MoltbookClient,
    db: MatchmakerDatabase,
    vectorStore: VectorStore,
    extractor: CapabilityExtractor,
    config: ObserverConfig
  ) {
    this.client = client;
    this.db = db;
    this.vectorStore = vectorStore;
    this.extractor = extractor;
    this.config = config;
  }

  /**
   * Run a full observation cycle
   */
  async observe(): Promise<ProcessingResult> {
    const startTime = Date.now();

    logger.info('observation_cycle_started', {
      submolts: this.config.targetSubmolts,
    });

    // Fetch posts from all target submolts
    const posts = await this.client.getPostsFromSubmolts(
      this.config.targetSubmolts,
      'new',
      this.config.postsPerSubmolt
    );

    logger.info('posts_fetched', { count: posts.length });

    // Filter to unprocessed posts
    const unprocessed = posts.filter(
      (post) => !this.db.isPostProcessed(post.id)
    );

    logger.info('unprocessed_posts', { count: unprocessed.length });

    // Process each post
    const result: ProcessingResult = {
      postsProcessed: 0,
      signalsExtracted: 0,
      gapsCreated: 0,
      agentsUpdated: 0,
      exclusionRequests: 0,
    };

    for (const post of unprocessed) {
      const postResult = await this.processPost(post);
      result.postsProcessed++;
      result.signalsExtracted += postResult.signalsExtracted;
      result.gapsCreated += postResult.gapsCreated;
      result.agentsUpdated += postResult.agentUpdated ? 1 : 0;
      result.exclusionRequests += postResult.exclusionRequest ? 1 : 0;
    }

    const elapsed = Date.now() - startTime;

    logger.info('observation_cycle_completed', {
      ...result,
      elapsedMs: elapsed,
    });

    return result;
  }

  /**
   * Process a single post
   */
  private async processPost(post: MoltbookPost): Promise<{
    signalsExtracted: number;
    gapsCreated: number;
    agentUpdated: boolean;
    exclusionRequest: boolean;
  }> {
    const postStartTime = Date.now();

    try {
      // Check for exclusion request
      if (EXCLUDE_ME_REGEX.test(post.content)) {
        await this.handleExclusionRequest(post);
        this.markPostProcessed(post, 0, Date.now() - postStartTime);
        return {
          signalsExtracted: 0,
          gapsCreated: 0,
          agentUpdated: false,
          exclusionRequest: true,
        };
      }

      // Check for inclusion request
      if (INCLUDE_ME_REGEX.test(post.content)) {
        await this.handleInclusionRequest(post);
      }

      // Ensure agent exists in database
      await this.ensureAgent(post);

      // Check for explicit [SEEKING] and [OFFERING] tags
      const explicitSignals = this.extractExplicitSignals(post);

      // Extract capability signals using LLM
      const llmSignals = await this.extractor.extractFromPost(post);

      // Combine signals
      const allSignals = [...explicitSignals, ...llmSignals];

      // Process signals
      let gapsCreated = 0;

      for (const signal of allSignals) {
        // Update capability in SQLite
        const capabilityId = this.db.upsertCapability(signal, post.author_id);

        // Add evidence
        this.db.addCapabilityEvidence(
          capabilityId,
          post.id,
          signal.signalType,
          signal.evidence,
          `https://www.moltbook.com/m/${post.submolt}/posts/${post.id}`,
          post.upvotes
        );

        // Generate and store embedding (skip for 'asks' - those go to gaps)
        if (signal.signalType !== 'asks') {
          const description = await this.extractor.generateEmbeddingDescription(
            post.author_id,
            signal.domain,
            signal.signalType,
            signal.evidence
          );

          const embedding = embedCapability(signal.domain, description, signal.signalType);

          await this.vectorStore.upsertCapability(
            post.author_id,
            signal.domain,
            signal.confidence,
            description,
            embedding
          );
        } else {
          // Create capability gap
          const gap = await this.createGap(post, signal);
          if (gap) {
            gapsCreated++;
          }
        }
      }

      // Update agent activity
      this.db.incrementAgentPostCount(post.author_id);

      // Mark post as processed
      this.markPostProcessed(post, allSignals.length, Date.now() - postStartTime);

      logger.debug('post_processed', {
        postId: post.id,
        author: post.author_id,
        signals: allSignals.length,
        gaps: gapsCreated,
      });

      return {
        signalsExtracted: allSignals.length,
        gapsCreated,
        agentUpdated: true,
        exclusionRequest: false,
      };
    } catch (error) {
      logger.error('post_processing_error', {
        postId: post.id,
        error: (error as Error).message,
      });

      // Mark as processed to avoid retrying forever
      this.markPostProcessed(post, 0, Date.now() - postStartTime);

      return {
        signalsExtracted: 0,
        gapsCreated: 0,
        agentUpdated: false,
        exclusionRequest: false,
      };
    }
  }

  /**
   * Extract explicit [SEEKING] and [OFFERING] signals
   */
  private extractExplicitSignals(post: MoltbookPost): CapabilitySignal[] {
    const signals: CapabilitySignal[] = [];
    const content = `${post.title} ${post.content}`;

    // Extract [SEEKING: x] tags
    let match;
    SEEKING_REGEX.lastIndex = 0;
    while ((match = SEEKING_REGEX.exec(content)) !== null) {
      signals.push({
        domain: match[1].trim().toLowerCase(),
        signalType: 'asks',
        confidence: 0.95, // High confidence for explicit requests
        evidence: match[0],
        postId: post.id,
      });
    }

    // Extract [OFFERING: x] tags
    OFFERING_REGEX.lastIndex = 0;
    while ((match = OFFERING_REGEX.exec(content)) !== null) {
      signals.push({
        domain: match[1].trim().toLowerCase(),
        signalType: 'claims',
        confidence: 0.85, // Good confidence for explicit offers
        evidence: match[0],
        postId: post.id,
      });
    }

    return signals;
  }

  /**
   * Create a capability gap from an 'asks' signal
   */
  private async createGap(
    post: MoltbookPost,
    signal: CapabilitySignal
  ): Promise<CapabilityGap | null> {
    const urgency = this.extractor.extractUrgency(post);

    const gapId = this.db.createGap({
      agentId: post.author_id,
      domain: signal.domain,
      postId: post.id,
      postUrl: `https://www.moltbook.com/m/${post.submolt}/posts/${post.id}`,
      urgency,
      status: 'open',
    });

    // Add to vector store for semantic matching
    const embedding = embedGap(signal.domain, signal.evidence);
    await this.vectorStore.addGap(
      gapId,
      post.author_id,
      signal.domain,
      signal.evidence,
      embedding
    );

    logger.debug('gap_created', {
      gapId,
      agent: post.author_id,
      domain: signal.domain,
      urgency,
    });

    return {
      id: gapId,
      agentId: post.author_id,
      domain: signal.domain,
      postId: post.id,
      urgency,
      status: 'open',
      createdAt: new Date(),
    };
  }

  /**
   * Ensure agent exists in database
   */
  private async ensureAgent(post: MoltbookPost): Promise<void> {
    const existing = this.db.getAgent(post.author_id);

    if (!existing) {
      // Create new agent profile
      this.db.upsertAgent({
        id: post.author_id,
        name: post.author_name,
        firstSeen: new Date(post.created_at),
        lastActive: new Date(post.created_at),
      });

      logger.debug('agent_created', {
        id: post.author_id,
        name: post.author_name,
      });
    } else {
      // Update last active
      this.db.upsertAgent({
        id: post.author_id,
        name: post.author_name,
        lastActive: new Date(post.created_at),
      });
    }
  }

  /**
   * Handle exclusion request
   */
  private async handleExclusionRequest(post: MoltbookPost): Promise<void> {
    this.db.setAgentExcluded(post.author_id, true);

    // Remove from vector store
    await this.vectorStore.deleteAgentCapabilities(post.author_id);

    logger.info('agent_excluded', { agentId: post.author_id });
  }

  /**
   * Handle inclusion request
   */
  private async handleInclusionRequest(post: MoltbookPost): Promise<void> {
    this.db.setAgentExcluded(post.author_id, false);
    logger.info('agent_included', { agentId: post.author_id });
  }

  /**
   * Mark post as processed
   */
  private markPostProcessed(
    post: MoltbookPost,
    signalCount: number,
    processingTimeMs: number
  ): void {
    this.db.markPostProcessed(
      post.id,
      post.submolt,
      signalCount,
      processingTimeMs
    );
  }

  /**
   * Check for new introductions to welcome
   */
  async findNewIntroductions(): Promise<MoltbookPost[]> {
    const result = await this.client.getPosts({
      submolt: 'introductions',
      sort: 'new',
      limit: 20,
    });

    if (!result.success || !result.data) {
      return [];
    }

    // Filter to unprocessed posts that look like introductions
    return result.data.items.filter((post) => {
      if (this.db.isPostProcessed(post.id)) return false;

      const content = `${post.title} ${post.content}`.toLowerCase();
      return (
        content.includes('hello') ||
        content.includes('hi everyone') ||
        content.includes("i'm new") ||
        content.includes('just joined') ||
        content.includes('introduction') ||
        content.includes('first post')
      );
    });
  }

  /**
   * Run maintenance tasks
   */
  async runMaintenance(): Promise<void> {
    // Decay old capabilities
    const decayed = this.db.decayOldCapabilities(30, 0.9);
    if (decayed > 0) {
      logger.info('capabilities_decayed', { count: decayed });
    }

    // Clean old processed posts
    const cleaned = this.db.cleanOldProcessedPosts(30);
    if (cleaned > 0) {
      logger.info('old_posts_cleaned', { count: cleaned });
    }

    // Clean old queue items
    const queueCleaned = this.db.cleanOldQueueItems(7);
    if (queueCleaned > 0) {
      logger.info('old_queue_items_cleaned', { count: queueCleaned });
    }
  }

  /**
   * Get observation statistics
   */
  getStats(): {
    processedPosts: number;
    activeAgents: number;
    capabilities: number;
    openGaps: number;
  } {
    const activeAgents = this.db.getActiveAgents(7).length;
    const openGaps = this.db.getOpenGaps(1000).length;

    // Would need additional DB queries for full stats
    return {
      processedPosts: 0, // Would need COUNT query
      activeAgents,
      capabilities: 0, // Would need COUNT query
      openGaps,
    };
  }
}
