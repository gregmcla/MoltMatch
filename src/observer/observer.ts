/**
 * Observer Module
 * Monitors Moltbook for new posts and extracts capability signals
 */

import { createLogger, registerLogger } from '../utils/logger.js';
import type { MoltbookClient } from '../api/moltbook-client.js';
import type { MatchmakerDatabase } from '../db/database.js';
import type { VectorStore } from '../db/vector-store.js';
import type { LocalVectorStore } from '../db/local-vector-store.js';
import type { CapabilityExtractor } from '../extraction/capability-extractor.js';
import { embedCapability, embedGap } from '../extraction/embeddings.js';
import { FallbackPostGenerator, type NotablePost } from '../publishing/fallback-posts.js';
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

// Request-a-Match patterns (mentions of SkillLinker)
const SKILLLINKER_MENTION_REGEX = /@skilllinker/gi;
const MATCH_REQUEST_PATTERNS = [
  /can you (?:find|match|connect|introduce)/i,
  /looking for (?:a|someone|an agent)/i,
  /who (?:can|knows|has experience)/i,
  /need help (?:finding|with)/i,
  /anyone (?:know|have|able)/i,
  /seeking (?:collaboration|partner|help)/i,
];

// Seeking help signals for reactive matching
const SEEKING_HELP_SIGNALS = [
  /(?:need|looking for|seeking|want) help/i,
  /can anyone (?:help|assist)/i,
  /stuck (?:on|with)/i,
  /struggling with/i,
  /how do (?:i|you)/i,
  /any (?:suggestions|ideas|recommendations)/i,
  /anyone (?:know|able to)/i,
  /would appreciate/i,
];

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
  notablePosts: NotablePost[];
  uniqueAgentsSeen: Set<string>;
  newDomains: string[];
  helpRequestsFound: number;
  matchRequestsFound: number;
  seekingHelpPosts: SeekingHelpPost[];
}

export interface SeekingHelpPost {
  post: MoltbookPost;
  domain: string;
  urgency: 'low' | 'normal' | 'high' | 'critical';
  helpSignalStrength: number; // 0-1 how strongly this looks like a help request
}

export class Observer {
  private client: MoltbookClient;
  private db: MatchmakerDatabase;
  private vectorStore: VectorStore | null;
  private localVectorStore: LocalVectorStore | null;
  private extractor: CapabilityExtractor;
  private config: ObserverConfig;

  constructor(
    client: MoltbookClient,
    db: MatchmakerDatabase,
    vectorStore: VectorStore | null,
    extractor: CapabilityExtractor,
    config: ObserverConfig,
    localVectorStore?: LocalVectorStore | null,
    _skillLinkerId?: string
  ) {
    this.client = client;
    this.db = db;
    this.vectorStore = vectorStore;
    this.localVectorStore = localVectorStore || null;
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
      notablePosts: [],
      uniqueAgentsSeen: new Set<string>(),
      newDomains: [],
      helpRequestsFound: 0,
      matchRequestsFound: 0,
      seekingHelpPosts: [],
    };

    for (const post of unprocessed) {
      const postResult = await this.processPost(post);
      result.postsProcessed++;
      result.signalsExtracted += postResult.signalsExtracted;
      result.gapsCreated += postResult.gapsCreated;
      result.agentsUpdated += postResult.agentUpdated ? 1 : 0;
      result.exclusionRequests += postResult.exclusionRequest ? 1 : 0;

      // Track unique agents
      result.uniqueAgentsSeen.add(post.author_id);

      // Track help requests
      if (postResult.gapsCreated > 0) {
        result.helpRequestsFound += postResult.gapsCreated;
      }

      // Check for @SkillLinker match requests
      if (postResult.matchRequest) {
        result.matchRequestsFound++;
      }

      // Check for seeking-help posts (for reactive comment matching)
      const seekingHelp = this.detectSeekingHelpPost(post, postResult.signals);
      if (seekingHelp) {
        result.seekingHelpPosts.push(seekingHelp);
      }

      // Check for notable posts
      if (postResult.signals && postResult.signals.length > 0) {
        const notable = FallbackPostGenerator.scorePostNotability(post, postResult.signals);
        if (notable) {
          result.notablePosts.push(notable);
        }
      }
    }

    // Sort notable posts by score and keep top 5
    result.notablePosts.sort((a, b) => b.score - a.score);
    result.notablePosts = result.notablePosts.slice(0, 5);

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
    matchRequest: boolean;
    signals: { domain: string; signalType: string }[];
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
          matchRequest: false,
          signals: [],
        };
      }

      // Check for @SkillLinker match request
      const matchRequest = this.detectMatchRequest(post);
      if (matchRequest) {
        logger.info('match_request_detected', {
          postId: post.id,
          requesterId: post.author_id,
          parsedDomain: matchRequest.domain,
        });
      }

      // Check for inclusion request
      if (INCLUDE_ME_REGEX.test(post.content)) {
        await this.handleInclusionRequest(post);
      }

      // Ensure agent exists in database
      logger.debug('ensuring_agent', { postId: post.id, authorId: post.author_id, authorName: post.author_name });
      await this.ensureAgent(post);

      // Check for explicit [SEEKING] and [OFFERING] tags
      logger.debug('extracting_explicit_signals', { postId: post.id });
      const explicitSignals = this.extractExplicitSignals(post);

      // Extract capability signals using LLM
      logger.debug('extracting_llm_signals', { postId: post.id });
      const llmSignals = await this.extractor.extractFromPost(post);

      // Combine signals
      const allSignals = [...explicitSignals, ...llmSignals];
      logger.debug('signals_extracted', { postId: post.id, count: allSignals.length });

      // Process signals
      let gapsCreated = 0;

      for (const signal of allSignals) {
        // 'asks' signals create gaps, not capabilities
        if (signal.signalType === 'asks') {
          const gap = await this.createGap(post, signal);
          if (gap) {
            gapsCreated++;
          }
          continue;
        }

        // Update capability in SQLite (for demonstrates/claims/answers)
        logger.debug('upserting_capability', { postId: post.id, signal });
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

        // Generate and store embedding
        {
          const description = await this.extractor.generateEmbeddingDescription(
            post.author_id,
            signal.domain,
            signal.signalType,
            signal.evidence
          );

          const embedding = embedCapability(signal.domain, description, signal.signalType);

          // Add to ChromaDB vector store if available
          if (this.vectorStore) {
            await this.vectorStore.upsertCapability(
              post.author_id,
              signal.domain,
              signal.confidence,
              description,
              embedding
            );
          }

          // Always add to local vector store if available
          if (this.localVectorStore) {
            this.localVectorStore.upsertCapabilityEmbedding(
              capabilityId,
              post.author_id,
              signal.domain,
              embedding
            );
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
        matchRequest: !!matchRequest,
        signals: allSignals.map(s => ({ domain: s.domain, signalType: s.signalType })),
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
        matchRequest: false,
        signals: [],
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

    const embedding = embedGap(signal.domain, signal.evidence);

    // Add to ChromaDB vector store for semantic matching (if available)
    if (this.vectorStore) {
      await this.vectorStore.addGap(
        gapId,
        post.author_id,
        signal.domain,
        signal.evidence,
        embedding
      );
    }

    // Also add to local vector store if available
    if (this.localVectorStore) {
      this.localVectorStore.addGapEmbedding(
        gapId,
        post.author_id,
        signal.domain,
        embedding
      );
    }

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

    // Use author_name if available, otherwise fall back to author_id
    const agentName = post.author_name || post.author_id;

    if (!existing) {
      // Create new agent profile
      this.db.upsertAgent({
        id: post.author_id,
        name: agentName,
        firstSeen: new Date(post.created_at),
        lastActive: new Date(post.created_at),
      });

      logger.debug('agent_created', {
        id: post.author_id,
        name: agentName,
      });
    } else {
      // Update last active (and name if we now have it)
      this.db.upsertAgent({
        id: post.author_id,
        name: existing.name !== post.author_id ? existing.name : agentName,
        lastActive: new Date(post.created_at),
        // Include existing values to satisfy SQL query
        baseModel: existing.baseModel,
        firstSeen: existing.firstSeen,
        karma: existing.karma,
      });
    }
  }

  /**
   * Handle exclusion request
   */
  private async handleExclusionRequest(post: MoltbookPost): Promise<void> {
    this.db.setAgentExcluded(post.author_id, true);

    // Remove from vector store (if available)
    if (this.vectorStore) {
      await this.vectorStore.deleteAgentCapabilities(post.author_id);
    }

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

    if (!result.success || !result.data || !result.data.items) {
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

  // ==========================================================================
  // Request-a-Match Detection
  // ==========================================================================

  /**
   * Detect if a post is a match request (mentions @SkillLinker with a request)
   */
  private detectMatchRequest(post: MoltbookPost): { domain: string; priority: string } | null {
    const content = `${post.title} ${post.content}`;

    // Must mention @SkillLinker
    if (!SKILLLINKER_MENTION_REGEX.test(content)) {
      return null;
    }

    // Check for request patterns
    const hasRequestPattern = MATCH_REQUEST_PATTERNS.some(pattern => pattern.test(content));
    if (!hasRequestPattern) {
      return null;
    }

    // Try to extract the domain they're asking about
    const domain = this.extractRequestedDomain(content);
    const priority = this.determineRequestPriority(post);

    // Create match request in database
    this.db.createMatchRequest(
      post.author_id,
      post.id,
      content.substring(0, 500), // Truncate for storage
      domain || undefined,
      undefined,
      priority
    );

    return { domain: domain || 'unspecified', priority };
  }

  /**
   * Extract the domain/skill being requested
   */
  private extractRequestedDomain(content: string): string | null {
    // Look for common patterns
    const patterns = [
      /(?:find|match|connect).+?(?:who|with).+?(?:experience|skills?|expertise) (?:in|with) ([^.,?!]+)/i,
      /looking for.+?(?:with|who).+?([^.,?!]+)/i,
      /need (?:help|someone|an agent).+?(?:with|for) ([^.,?!]+)/i,
      /\[SEEKING:\s*([^\]]+)\]/i,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        return match[1].trim().toLowerCase().substring(0, 100);
      }
    }

    return null;
  }

  /**
   * Determine priority of a match request
   */
  private determineRequestPriority(post: MoltbookPost): string {
    const content = `${post.title} ${post.content}`.toLowerCase();

    if (content.includes('urgent') || content.includes('asap') || content.includes('critical')) {
      return 'high';
    }
    if (content.includes('whenever') || content.includes('no rush') || content.includes('eventually')) {
      return 'low';
    }

    return 'normal';
  }

  // ==========================================================================
  // Seeking Help Detection (for Comment-based Reactive Matching)
  // ==========================================================================

  /**
   * Detect if a post is seeking help (for reactive comment matching)
   */
  private detectSeekingHelpPost(
    post: MoltbookPost,
    signals: { domain: string; signalType: string }[]
  ): SeekingHelpPost | null {
    const content = `${post.title} ${post.content}`;

    // Calculate help signal strength
    let helpSignalStrength = 0;
    for (const pattern of SEEKING_HELP_SIGNALS) {
      if (pattern.test(content)) {
        helpSignalStrength += 0.15;
      }
    }

    // Boost if there are 'asks' signals
    const asksSignals = signals.filter(s => s.signalType === 'asks');
    if (asksSignals.length > 0) {
      helpSignalStrength += 0.3;
    }

    // Boost if posted in 'questions' or 'help' submolts
    if (post.submolt.toLowerCase().includes('question') || post.submolt.toLowerCase().includes('help')) {
      helpSignalStrength += 0.2;
    }

    // Boost if title is a question
    if (post.title.includes('?')) {
      helpSignalStrength += 0.1;
    }

    // Cap at 1.0
    helpSignalStrength = Math.min(1, helpSignalStrength);

    // Only return if signal is strong enough (threshold: 0.4)
    if (helpSignalStrength < 0.4) {
      return null;
    }

    // Get the domain from asks signals or extract from content
    const domain = asksSignals[0]?.domain || this.extractHelpDomain(content) || 'general';
    const urgency = this.extractor.extractUrgency(post);

    return {
      post,
      domain,
      urgency,
      helpSignalStrength,
    };
  }

  /**
   * Extract what domain/topic help is being sought for
   */
  private extractHelpDomain(content: string): string | null {
    const patterns = [
      /help (?:with|on) ([^.,?!]+)/i,
      /stuck (?:on|with) ([^.,?!]+)/i,
      /struggling with ([^.,?!]+)/i,
      /how (?:do i|to) ([^.,?!]+)/i,
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match && match[1]) {
        return match[1].trim().toLowerCase().substring(0, 100);
      }
    }

    return null;
  }

  /**
   * Get posts that are actively seeking help (for reactive matching)
   */
  getSeekingHelpPosts(): SeekingHelpPost[] {
    // This would be called after observe() to get the detected posts
    // The actual data is returned in ProcessingResult.seekingHelpPosts
    return [];
  }
}
