/**
 * Rate Limiter for Moltbook API
 * Manages post and comment rate limits with persistent state
 */

import { createLogger, registerLogger } from '../utils/logger.js';
import type { MatchmakerDatabase } from '../db/database.js';
import type { RateLimitStatus } from '../types.js';

const logger = createLogger('publisher');
registerLogger(logger);

// Moltbook rate limits
const POST_LIMIT = 1;
const POST_REFILL_MS = 30 * 60 * 1000; // 30 minutes
const COMMENT_LIMIT = 50;
const COMMENT_REFILL_MS = 60 * 60 * 1000; // 1 hour

export class RateLimiter {
  private db: MatchmakerDatabase;
  private postTokens: number;
  private commentTokens: number;
  private lastPostRefill: Date;
  private lastCommentRefill: Date;

  constructor(db: MatchmakerDatabase) {
    this.db = db;

    // Load state from database
    const state = db.getRateLimitState();
    this.postTokens = state.postTokens;
    this.commentTokens = state.commentTokens;
    this.lastPostRefill = state.lastPostRefill;
    this.lastCommentRefill = state.lastCommentRefill;

    // Refill tokens if needed
    this.refillTokens();

    logger.info('rate_limiter_initialized', {
      postTokens: this.postTokens,
      commentTokens: this.commentTokens,
    });
  }

  /**
   * Refill tokens based on elapsed time
   */
  private refillTokens(): void {
    const now = Date.now();

    // Refill post tokens
    if (now - this.lastPostRefill.getTime() >= POST_REFILL_MS) {
      const periods = Math.floor(
        (now - this.lastPostRefill.getTime()) / POST_REFILL_MS
      );
      this.postTokens = Math.min(POST_LIMIT, this.postTokens + periods);
      this.lastPostRefill = new Date(
        this.lastPostRefill.getTime() + periods * POST_REFILL_MS
      );
    }

    // Refill comment tokens
    if (now - this.lastCommentRefill.getTime() >= COMMENT_REFILL_MS) {
      const periods = Math.floor(
        (now - this.lastCommentRefill.getTime()) / COMMENT_REFILL_MS
      );
      this.commentTokens = Math.min(
        COMMENT_LIMIT,
        this.commentTokens + periods * COMMENT_LIMIT
      );
      this.lastCommentRefill = new Date(
        this.lastCommentRefill.getTime() + periods * COMMENT_REFILL_MS
      );
    }

    // Save state
    this.saveState();
  }

  /**
   * Save state to database
   */
  private saveState(): void {
    this.db.updateRateLimitState(
      this.postTokens,
      this.commentTokens,
      this.lastPostRefill,
      this.lastCommentRefill
    );
  }

  /**
   * Check if we can post
   */
  canPost(): boolean {
    this.refillTokens();
    return this.postTokens > 0;
  }

  /**
   * Check if we can comment
   */
  canComment(): boolean {
    this.refillTokens();
    return this.commentTokens > 0;
  }

  /**
   * Consume a post token
   */
  consumePost(): boolean {
    this.refillTokens();

    if (this.postTokens <= 0) {
      logger.warn('post_rate_limited', {
        nextRefill: this.getPostRefillTime().toISOString(),
      });
      return false;
    }

    this.postTokens--;
    this.saveState();

    logger.debug('post_token_consumed', { remaining: this.postTokens });
    return true;
  }

  /**
   * Consume a comment token
   */
  consumeComment(): boolean {
    this.refillTokens();

    if (this.commentTokens <= 0) {
      logger.warn('comment_rate_limited', {
        nextRefill: this.getCommentRefillTime().toISOString(),
      });
      return false;
    }

    this.commentTokens--;
    this.saveState();

    logger.debug('comment_token_consumed', { remaining: this.commentTokens });
    return true;
  }

  /**
   * Get when post tokens will refill
   */
  getPostRefillTime(): Date {
    return new Date(this.lastPostRefill.getTime() + POST_REFILL_MS);
  }

  /**
   * Get when comment tokens will refill
   */
  getCommentRefillTime(): Date {
    return new Date(this.lastCommentRefill.getTime() + COMMENT_REFILL_MS);
  }

  /**
   * Get current rate limit status
   */
  getStatus(): RateLimitStatus {
    this.refillTokens();

    return {
      postsRemaining: this.postTokens,
      postRefillAt: this.getPostRefillTime(),
      commentsRemaining: this.commentTokens,
      commentRefillAt: this.getCommentRefillTime(),
    };
  }

  /**
   * Get available budget for current cycle
   */
  getBudget(): { posts: number; comments: number } {
    this.refillTokens();

    return {
      posts: this.postTokens,
      comments: this.commentTokens,
    };
  }

  /**
   * Wait until we can post (with timeout)
   */
  async waitForPost(timeoutMs: number = 35 * 60 * 1000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (this.canPost()) {
        return true;
      }

      // Wait until next potential refill
      const waitTime = Math.min(
        this.getPostRefillTime().getTime() - Date.now() + 1000,
        10000 // Check every 10 seconds max
      );

      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    return false;
  }

  /**
   * Wait until we can comment (with timeout)
   */
  async waitForComment(timeoutMs: number = 65 * 60 * 1000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (this.canComment()) {
        return true;
      }

      const waitTime = Math.min(
        this.getCommentRefillTime().getTime() - Date.now() + 1000,
        10000
      );

      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    return false;
  }

  /**
   * Reserve tokens for priority items
   * Returns true if reservation is possible
   */
  canReserve(posts: number, comments: number): boolean {
    this.refillTokens();
    return this.postTokens >= posts && this.commentTokens >= comments;
  }

  /**
   * Get time until next post is available (in milliseconds)
   */
  getTimeUntilNextPost(): number {
    this.refillTokens();

    if (this.postTokens > 0) {
      return 0;
    }

    return Math.max(0, this.getPostRefillTime().getTime() - Date.now());
  }

  /**
   * Get time until next comment is available (in milliseconds)
   */
  getTimeUntilNextComment(): number {
    this.refillTokens();

    if (this.commentTokens > 0) {
      return 0;
    }

    return Math.max(0, this.getCommentRefillTime().getTime() - Date.now());
  }

  /**
   * Reset rate limits (for testing)
   */
  reset(): void {
    this.postTokens = POST_LIMIT;
    this.commentTokens = COMMENT_LIMIT;
    this.lastPostRefill = new Date();
    this.lastCommentRefill = new Date();
    this.saveState();

    logger.info('rate_limiter_reset');
  }
}
