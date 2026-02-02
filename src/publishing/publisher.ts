/**
 * Publisher Module
 * Manages posting and commenting on Moltbook with rate limiting
 */

import { createLogger, registerLogger } from '../utils/logger.js';
import { writeMatchPost } from '../utils/ai-writer.js';
import type { MoltbookClient } from '../api/moltbook-client.js';
import type { MatchmakerDatabase } from '../db/database.js';
import type { RateLimiter } from './rate-limiter.js';
import type { TemplateEngine } from '../templates/template-engine.js';
import type {
  Match,
  AgentProfile,
  Capability,
  CapabilityGap,
  Priority,
  QueueItem,
} from '../types.js';

const logger = createLogger('publisher');
registerLogger(logger);

export interface PublishResult {
  success: boolean;
  postId?: string;
  postUrl?: string;
  error?: string;
}

export class Publisher {
  private client: MoltbookClient;
  private db: MatchmakerDatabase;
  private rateLimiter: RateLimiter;
  private templateEngine: TemplateEngine;

  constructor(
    client: MoltbookClient,
    db: MatchmakerDatabase,
    rateLimiter: RateLimiter,
    templateEngine: TemplateEngine
  ) {
    this.client = client;
    this.db = db;
    this.rateLimiter = rateLimiter;
    this.templateEngine = templateEngine;
  }

  // ==========================================================================
  // High-Level Publishing Methods
  // ==========================================================================

  /**
   * Publish a match introduction
   */
  async publishMatchIntroduction(
    match: Match,
    seeker: AgentProfile,
    helper: AgentProfile,
    helperCapability: Capability,
    gap: CapabilityGap,
    submolt: string = 'introductions'
  ): Promise<PublishResult> {
    // Check rate limit
    if (!this.rateLimiter.canPost()) {
      const status = this.rateLimiter.getStatus();
      logger.warn('publish_rate_limited', {
        type: 'post',
        nextAvailable: status.postRefillAt.toISOString(),
      });

      // Queue for later
      this.queueMatchIntroduction(match, seeker, helper, helperCapability, gap, submolt);

      return {
        success: false,
        error: `Rate limited. Next post available at ${status.postRefillAt.toISOString()}`,
      };
    }

    // Generate content in SkillLinker's voice
    let title: string;
    let body: string;
    
    try {
      const content = await writeMatchPost({
        seekerName: seeker.name || seeker.id,
        helperName: helper.name || helper.id,
        domain: gap.domain,
        helperEvidence: `demonstrated ${helperCapability.demonstratesCount} times`,
        confidence: match.confidence,
      });
      title = content.title;
      body = content.body;
    } catch (error) {
      logger.error('ai_generation_failed', {
        error: (error as Error).message,
        matchId: match.id,
      });
      
      // Fallback to template
      const content = this.templateEngine.renderMatchIntroduction(
        match,
        seeker,
        helper,
        helperCapability,
        gap
      );
      title = content.title || 'Match Alert';
      body = content.body;
    }

    // Publish
    const result = await this.client.createPost({
      submolt,
      title,
      content: body,
    });

    if (result.success && result.data) {
      this.rateLimiter.consumePost();

      const matchPostUrl = `https://www.moltbook.com/post/${result.data.id}`;

      // Update match record
      this.db.updateMatchPublished(
        match.id,
        result.data.id,
        matchPostUrl
      );

      logger.info('match_published', {
        matchId: match.id,
        postId: result.data.id,
        seeker: seeker.id,
        helper: helper.id,
      });

      // ALSO comment on the original seeker's post to notify them
      if (gap.postId && this.rateLimiter.canComment()) {
        try {
          const commentResult = await this.client.createComment({
            postId: gap.postId,
            content: `I found a match for you! @${helper.name || helper.id} has ${helperCapability.domain} expertise (demonstrated ${helperCapability.demonstratesCount} times).\n\nFull details: ${matchPostUrl}`,
          });

          if (commentResult.success) {
            this.rateLimiter.consumeComment();
            logger.info('match_notification_commented', {
              matchId: match.id,
              commentId: commentResult.data?.id,
              originalPost: gap.postId,
            });
          }
        } catch (error) {
          logger.warn('match_notification_comment_failed', {
            matchId: match.id,
            error: (error as Error).message,
          });
          // Don't fail the whole match if comment fails
        }
      }

      return {
        success: true,
        postId: result.data.id,
        postUrl: matchPostUrl,
      };
    }

    logger.error('match_publish_failed', {
      matchId: match.id,
      error: result.error?.message,
    });

    return {
      success: false,
      error: result.error?.message || 'Unknown error',
    };
  }

  /**
   * Comment on a post with a match suggestion
   */
  async commentMatchSuggestion(
    postId: string,
    seeker: AgentProfile,
    helper: AgentProfile,
    helperCapability: Capability,
    domain: string,
    confidence: number
  ): Promise<PublishResult> {
    // Check rate limit
    if (!this.rateLimiter.canComment()) {
      const status = this.rateLimiter.getStatus();
      logger.warn('comment_rate_limited', {
        nextAvailable: status.commentRefillAt.toISOString(),
      });

      return {
        success: false,
        error: `Rate limited. Next comment available at ${status.commentRefillAt.toISOString()}`,
      };
    }

    // Render content
    const content = this.templateEngine.renderMatchSuggestion(
      seeker,
      helper,
      helperCapability,
      domain,
      confidence
    );

    // Publish
    const result = await this.client.createComment({
      postId,
      content,
    });

    if (result.success && result.data) {
      this.rateLimiter.consumeComment();

      logger.info('match_suggestion_commented', {
        postId,
        commentId: result.data.id,
        seeker: seeker.id,
        helper: helper.id,
      });

      return {
        success: true,
        postId: result.data.id,
      };
    }

    logger.error('match_suggestion_comment_failed', {
      postId,
      error: result.error?.message,
    });

    return {
      success: false,
      error: result.error?.message || 'Unknown error',
    };
  }

  /**
   * Welcome a new agent
   */
  async welcomeAgent(
    postId: string,
    agent: AgentProfile,
    inferredCapabilities: string[],
    suggestedAgents: Array<{ id: string; reason: string }>
  ): Promise<PublishResult> {
    if (!this.rateLimiter.canComment()) {
      return { success: false, error: 'Rate limited' };
    }

    const content = this.templateEngine.renderWelcome(
      agent,
      inferredCapabilities,
      suggestedAgents
    );

    const result = await this.client.createComment({ postId, content });

    if (result.success && result.data) {
      this.rateLimiter.consumeComment();

      logger.info('welcome_commented', {
        postId,
        agentId: agent.id,
      });

      return { success: true, postId: result.data.id };
    }

    return { success: false, error: result.error?.message };
  }

  /**
   * Confirm exclusion for an agent
   */
  async confirmExclusion(postId: string, agent: AgentProfile): Promise<PublishResult> {
    if (!this.rateLimiter.canComment()) {
      return { success: false, error: 'Rate limited' };
    }

    const content = this.templateEngine.renderExclusionConfirm(agent);
    const result = await this.client.createComment({ postId, content });

    if (result.success && result.data) {
      this.rateLimiter.consumeComment();
      this.db.setAgentExcluded(agent.id, true);

      logger.info('exclusion_confirmed', { agentId: agent.id });

      return { success: true, postId: result.data.id };
    }

    return { success: false, error: result.error?.message };
  }

  /**
   * Publish weekly digest
   */
  async publishWeeklyDigest(submolt: string = 'introductions'): Promise<PublishResult> {
    if (!this.rateLimiter.canPost()) {
      return { success: false, error: 'Rate limited' };
    }

    // Gather stats
    const stats = this.db.getMatchStats(7);
    const recentMatches = this.db.getRecentMatches(7);

    // Find top matches (those with collaboration outcomes)
    const topMatches = recentMatches
      .filter((m) => m.collaborationOccurred)
      .slice(0, 3)
      .map((m) => {
        const seeker = this.db.getAgent(m.seekerId);
        const helper = this.db.getAgent(m.helperId);
        return {
          seeker: { id: seeker?.id || m.seekerId },
          helper: { id: helper?.id || m.helperId },
          domain: m.capabilityDomain,
          outcome: m.outcomeNotes || 'Successful collaboration',
        };
      });

    const weekOf = new Date().toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    const content = this.templateEngine.renderWeeklyDigest({
      weekOf,
      matchesAttempted: stats.total,
      matchesAccepted: stats.accepted,
      acceptanceRate: stats.total > 0 ? Math.round((stats.accepted / stats.total) * 100) : 0,
      collaborationsCompleted: stats.collaborations,
      topMatches: topMatches.length > 0 ? topMatches : undefined,
    });

    const result = await this.client.createPost({
      submolt,
      title: content.title || 'Matchmaker Weekly Report',
      content: content.body,
    });

    if (result.success && result.data) {
      this.rateLimiter.consumePost();

      logger.info('weekly_digest_published', {
        postId: result.data.id,
        stats,
      });

      return {
        success: true,
        postId: result.data.id,
        postUrl: `https://www.moltbook.com/m/${submolt}/posts/${result.data.id}`,
      };
    }

    return { success: false, error: result.error?.message };
  }

  // ==========================================================================
  // Queue Management
  // ==========================================================================

  /**
   * Queue a match introduction for later publishing
   */
  private queueMatchIntroduction(
    match: Match,
    seeker: AgentProfile,
    helper: AgentProfile,
    helperCapability: Capability,
    gap: CapabilityGap,
    submolt: string
  ): void {
    const priority = this.calculatePriority(match.confidence, gap.urgency);

    this.db.enqueue({
      itemType: 'post',
      priority,
      matchId: match.id,
      templateId: 'post_match_introduction',
      templateData: {
        match,
        seeker: { id: seeker.id, name: seeker.name },
        helper: { id: helper.id, name: helper.name },
        helperCapability,
        gap,
        submolt,
      },
      scheduledFor: this.rateLimiter.getPostRefillTime(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // Expire after 24 hours
    });

    logger.info('match_queued', {
      matchId: match.id,
      priority,
      scheduledFor: this.rateLimiter.getPostRefillTime().toISOString(),
    });
  }

  /**
   * Process the next item in the queue
   */
  async processQueue(): Promise<PublishResult | null> {
    // Expire old items first
    this.db.expireOldQueueItems();

    // Get next item
    const item = this.db.getNextQueueItem();
    if (!item) {
      return null;
    }

    // Check rate limits
    if (item.itemType === 'post' && !this.rateLimiter.canPost()) {
      logger.debug('queue_item_waiting_rate_limit', {
        itemId: item.id,
        type: 'post',
      });
      return null;
    }

    if (item.itemType === 'comment' && !this.rateLimiter.canComment()) {
      logger.debug('queue_item_waiting_rate_limit', {
        itemId: item.id,
        type: 'comment',
      });
      return null;
    }

    // Process based on template
    try {
      const result = await this.processQueueItem(item);

      if (result.success) {
        this.db.updateQueueItemStatus(item.id, 'published');
      } else {
        this.db.updateQueueItemStatus(item.id, 'failed', result.error);
      }

      return result;
    } catch (error) {
      this.db.updateQueueItemStatus(item.id, 'failed', (error as Error).message);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  }

  /**
   * Process a specific queue item
   */
  private async processQueueItem(item: QueueItem): Promise<PublishResult> {
    const data = item.templateData;

    switch (item.templateId) {
      case 'post_match_introduction':
        return this.publishMatchIntroduction(
          data.match as Match,
          data.seeker as AgentProfile,
          data.helper as AgentProfile,
          data.helperCapability as Capability,
          data.gap as CapabilityGap,
          data.submolt as string
        );

      // Add other template handlers as needed
      default:
        logger.warn('unknown_queue_template', { templateId: item.templateId });
        return { success: false, error: `Unknown template: ${item.templateId}` };
    }
  }

  /**
   * Calculate priority for a queued item
   */
  private calculatePriority(
    confidence: number,
    urgency: string
  ): Priority {
    // Map urgency to base priority
    const urgencyPriority: Record<string, number> = {
      critical: 1,
      high: 2,
      normal: 3,
      low: 4,
    };

    let priority = urgencyPriority[urgency] || 3;

    // Boost for high confidence matches
    if (confidence > 0.9) {
      priority = Math.max(1, priority - 1);
    }

    return priority as Priority;
  }

  /**
   * Get queue statistics
   */
  getQueueStats(): {
    pending: number;
    published: number;
    failed: number;
    expired: number;
  } {
    // This would need a new DB method, simplified for now
    return {
      pending: 0,
      published: 0,
      failed: 0,
      expired: 0,
    };
  }

  /**
   * Process all ready queue items
   */
  async processAllReady(): Promise<PublishResult[]> {
    const results: PublishResult[] = [];
    let processed = 0;
    const maxPerCycle = 10;

    while (processed < maxPerCycle) {
      const result = await this.processQueue();
      if (!result) break;

      results.push(result);
      processed++;

      // Small delay between items
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (results.length > 0) {
      logger.info('queue_batch_processed', {
        processed: results.length,
        successful: results.filter((r) => r.success).length,
      });
    }

    return results;
  }
}
