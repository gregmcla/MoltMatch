/**
 * The Matchmaker - Main Orchestrator
 * Coordinates all modules for the heartbeat cycle
 */

import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from './config.js';
import { createLogger, registerLogger, setGlobalLogLevel } from './utils/logger.js';
import { MatchmakerDatabase } from './db/database.js';
import { VectorStore } from './db/vector-store.js';
import { MoltbookClient } from './api/moltbook-client.js';
import { CapabilityExtractor } from './extraction/capability-extractor.js';
import { Observer } from './observer/observer.js';
import { Matcher } from './matching/matcher.js';
import { RateLimiter } from './publishing/rate-limiter.js';
import { Publisher } from './publishing/publisher.js';
import { TemplateEngine } from './templates/template-engine.js';
import type { Match, AgentProfile, Capability, CapabilityGap } from './types.js';

const logger = createLogger('main');
registerLogger(logger);

export interface HeartbeatResult {
  success: boolean;
  duration: number;
  observation: {
    postsProcessed: number;
    signalsExtracted: number;
    gapsCreated: number;
  };
  matching: {
    gapsProcessed: number;
    matchesCreated: number;
  };
  publishing: {
    itemsPublished: number;
    itemsFailed: number;
  };
  errors: string[];
}

export class Matchmaker {
  private db: MatchmakerDatabase;
  private vectorStore: VectorStore | null = null;
  private client: MoltbookClient;
  private extractor: CapabilityExtractor;
  private observer: Observer | null = null;
  private matcher: Matcher | null = null;
  private rateLimiter: RateLimiter;
  private publisher: Publisher;
  private templateEngine: TemplateEngine;
  private initialized = false;
  private vectorStoreEnabled = false;

  constructor() {
    // Set log level
    setGlobalLogLevel(config.logLevel);

    // Ensure data directory exists
    mkdirSync(dirname(config.database.sqlitePath), { recursive: true });

    // Initialize components
    this.db = new MatchmakerDatabase(config.database.sqlitePath);

    this.client = new MoltbookClient({
      apiKey: config.moltbook.apiKey,
      apiUrl: config.moltbook.apiUrl,
    });

    this.extractor = new CapabilityExtractor(config.anthropic.apiKey);

    this.templateEngine = new TemplateEngine();
    this.rateLimiter = new RateLimiter(this.db);

    this.publisher = new Publisher(
      this.client,
      this.db,
      this.rateLimiter,
      this.templateEngine
    );
  }

  /**
   * Initialize all components
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info('initializing_matchmaker', { agent: config.agent.name });

    // Initialize database
    this.db.initialize();

    // Try to initialize vector store (optional - continues without it)
    try {
      this.vectorStore = new VectorStore(config.database.chromaPath);
      await this.vectorStore.initialize();
      this.vectorStoreEnabled = true;
      logger.info('vector_store_enabled');
    } catch (error) {
      logger.warn('vector_store_disabled', {
        reason: 'ChromaDB not available - running without semantic search',
        error: (error as Error).message
      });
      this.vectorStore = null;
      this.vectorStoreEnabled = false;
    }

    // Initialize observer and matcher (with or without vector store)
    this.observer = new Observer(
      this.client,
      this.db,
      this.vectorStore,
      this.extractor,
      {
        targetSubmolts: config.targetSubmolts,
        postsPerSubmolt: 25,
      }
    );

    this.matcher = new Matcher(this.db, this.vectorStore, {
      minConfidence: config.matching.minConfidence,
      maxMatchesPerCycle: config.matching.maxMatchesPerCycle,
      weights: config.matching.weights,
    });

    // Verify API connection
    const healthy = await this.client.healthCheck();
    if (!healthy) {
      throw new Error('Failed to connect to Moltbook API');
    }

    this.initialized = true;
    logger.info('matchmaker_initialized', { vectorStoreEnabled: this.vectorStoreEnabled });
  }

  /**
   * Run a full heartbeat cycle
   */
  async heartbeat(): Promise<HeartbeatResult> {
    const startTime = Date.now();

    if (!this.initialized) {
      await this.initialize();
    }

    logger.info('heartbeat_started');

    const result: HeartbeatResult = {
      success: true,
      duration: 0,
      observation: { postsProcessed: 0, signalsExtracted: 0, gapsCreated: 0 },
      matching: { gapsProcessed: 0, matchesCreated: 0 },
      publishing: { itemsPublished: 0, itemsFailed: 0 },
      errors: [],
    };

    try {
      // Phase 1: Observe
      logger.info('phase_observe_start');
      const observeResult = await this.observer.observe();
      result.observation = {
        postsProcessed: observeResult.postsProcessed,
        signalsExtracted: observeResult.signalsExtracted,
        gapsCreated: observeResult.gapsCreated,
      };
      logger.info('phase_observe_complete', result.observation);
    } catch (error) {
      const msg = `Observation failed: ${(error as Error).message}`;
      result.errors.push(msg);
      logger.error('phase_observe_error', { error: msg });
    }

    try {
      // Phase 2: Match
      logger.info('phase_match_start');
      const gaps = this.db.getOpenGaps(config.matching.maxMatchesPerCycle);
      result.matching.gapsProcessed = gaps.length;

      for (const gap of gaps) {
        const candidates = await this.matcher.findMatchesForGap(gap);

        if (candidates.length > 0) {
          const seeker = this.db.getAgent(gap.agentId);
          if (seeker) {
            const match = this.matcher.createMatch(seeker, candidates[0], gap);
            result.matching.matchesCreated++;

            // Try to publish immediately
            const helper = this.db.getAgent(candidates[0].agent.id);
            if (helper) {
              const publishResult = await this.publisher.publishMatchIntroduction(
                match,
                seeker,
                helper,
                candidates[0].capability,
                gap
              );

              if (publishResult.success) {
                result.publishing.itemsPublished++;
              } else {
                // Will be queued for later
                logger.debug('match_queued_for_later', { matchId: match.id });
              }
            }
          }
        }
      }
      logger.info('phase_match_complete', result.matching);
    } catch (error) {
      const msg = `Matching failed: ${(error as Error).message}`;
      result.errors.push(msg);
      logger.error('phase_match_error', { error: msg });
    }

    try {
      // Phase 3: Publish queued items
      logger.info('phase_publish_start');
      const publishResults = await this.publisher.processAllReady();
      result.publishing.itemsPublished += publishResults.filter((r) => r.success).length;
      result.publishing.itemsFailed += publishResults.filter((r) => !r.success).length;
      logger.info('phase_publish_complete', result.publishing);
    } catch (error) {
      const msg = `Publishing failed: ${(error as Error).message}`;
      result.errors.push(msg);
      logger.error('phase_publish_error', { error: msg });
    }

    try {
      // Phase 4: Maintenance
      logger.info('phase_maintenance_start');
      await this.observer.runMaintenance();
      logger.info('phase_maintenance_complete');
    } catch (error) {
      const msg = `Maintenance failed: ${(error as Error).message}`;
      result.errors.push(msg);
      logger.error('phase_maintenance_error', { error: msg });
    }

    result.duration = Date.now() - startTime;
    result.success = result.errors.length === 0;

    logger.info('heartbeat_complete', {
      success: result.success,
      duration: result.duration,
      errors: result.errors.length,
    });

    return result;
  }

  /**
   * Run observation only
   */
  async observe(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    await this.observer.observe();
  }

  /**
   * Run matching only
   */
  async match(): Promise<Match[]> {
    if (!this.initialized) {
      await this.initialize();
    }

    return this.matcher.processOpenGaps(config.matching.maxMatchesPerCycle);
  }

  /**
   * Publish queued items
   */
  async publish(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    await this.publisher.processAllReady();
  }

  /**
   * Publish weekly digest
   */
  async publishDigest(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }

    await this.publisher.publishWeeklyDigest();
  }

  /**
   * Get current statistics
   */
  getStats(): {
    agents: number;
    capabilities: number;
    openGaps: number;
    recentMatches: number;
    matchAcceptanceRate: number;
    rateLimits: { posts: number; comments: number };
  } {
    const matchStats = this.matcher.getStats();
    const budget = this.rateLimiter.getBudget();
    const activeAgents = this.db.getActiveAgents(7);
    const openGaps = this.db.getOpenGaps(1000);

    return {
      agents: activeAgents.length,
      capabilities: 0, // Would need additional query
      openGaps: openGaps.length,
      recentMatches: matchStats.totalMatches,
      matchAcceptanceRate: matchStats.acceptanceRate,
      rateLimits: budget,
    };
  }

  /**
   * Shutdown gracefully
   */
  shutdown(): void {
    logger.info('shutting_down');
    this.db.close();
  }

  /**
   * Format heartbeat result for display
   */
  formatHeartbeatResult(result: HeartbeatResult): string {
    if (result.errors.length === 0 &&
        result.observation.postsProcessed === 0 &&
        result.matching.matchesCreated === 0 &&
        result.publishing.itemsPublished === 0) {
      return 'HEARTBEAT_OK';
    }

    const lines = [
      'Heartbeat Complete:',
      `- Observed: ${result.observation.postsProcessed} posts`,
      `- Extracted: ${result.observation.signalsExtracted} capability signals`,
      `- Gaps created: ${result.observation.gapsCreated}`,
      `- Matches made: ${result.matching.matchesCreated}`,
      `- Published: ${result.publishing.itemsPublished} items`,
      `- Duration: ${result.duration}ms`,
    ];

    if (result.errors.length > 0) {
      lines.push('', 'Errors:');
      result.errors.forEach((e) => lines.push(`- ${e}`));
    }

    return lines.join('\n');
  }
}
