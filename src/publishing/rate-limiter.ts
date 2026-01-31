/**
 * Rate Limiter for Moltbook API
 * Manages post and comment rate limits with persistent state
 *
 * Moltbook rate limits (from official docs):
 * - 100 requests/minute
 * - 1 post per 30 minutes
 * - 1 comment per 20 seconds
 * - 50 comments per day
 */

import { createLogger, registerLogger } from '../utils/logger.js';
import type { MatchmakerDatabase } from '../db/database.js';
import type { RateLimitStatus } from '../types.js';

const logger = createLogger('publisher');
registerLogger(logger);

// Moltbook rate limits (from official docs)
const POST_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between posts
const COMMENT_COOLDOWN_MS = 20 * 1000;   // 20 seconds between comments
const DAILY_COMMENT_LIMIT = 50;          // 50 comments per day

export class RateLimiter {
  private db: MatchmakerDatabase;

  // Post tracking
  private lastPostTime: Date;

  // Comment tracking
  private lastCommentTime: Date;
  private dailyCommentCount: number;
  private dailyCommentReset: Date;

  constructor(db: MatchmakerDatabase) {
    this.db = db;

    // Load state from database
    const state = db.getRateLimitState();

    // Post state
    this.lastPostTime = state.lastPostRefill;

    // Comment state - we're repurposing the existing fields
    // commentTokens = daily comment count used
    // lastCommentRefill = when daily count resets
    this.lastCommentTime = new Date(0); // Allow immediate first comment
    this.dailyCommentCount = DAILY_COMMENT_LIMIT - state.commentTokens;
    this.dailyCommentReset = state.lastCommentRefill;

    // Check if we need to reset daily count
    this.checkDailyReset();

    logger.info('rate_limiter_initialized', {
      canPostIn: this.getTimeUntilNextPost(),
      dailyCommentsUsed: this.dailyCommentCount,
      dailyCommentsRemaining: DAILY_COMMENT_LIMIT - this.dailyCommentCount,
    });
  }

  /**
   * Check if daily comment count should reset
   */
  private checkDailyReset(): void {
    const now = Date.now();

    if (now >= this.dailyCommentReset.getTime()) {
      // Reset daily count
      this.dailyCommentCount = 0;
      // Set next reset to midnight UTC tomorrow
      const tomorrow = new Date();
      tomorrow.setUTCHours(24, 0, 0, 0);
      this.dailyCommentReset = tomorrow;
      this.saveState();

      logger.info('daily_comment_limit_reset', {
        nextReset: this.dailyCommentReset.toISOString(),
      });
    }
  }

  /**
   * Save state to database
   */
  private saveState(): void {
    // Store remaining comments as tokens, lastCommentRefill as daily reset time
    this.db.updateRateLimitState(
      1, // Post tokens (not really used anymore)
      DAILY_COMMENT_LIMIT - this.dailyCommentCount, // Comments remaining
      this.lastPostTime,
      this.dailyCommentReset
    );
  }

  /**
   * Check if we can post (30 min cooldown)
   */
  canPost(): boolean {
    const now = Date.now();
    const timeSinceLastPost = now - this.lastPostTime.getTime();
    return timeSinceLastPost >= POST_COOLDOWN_MS;
  }

  /**
   * Check if we can comment (20 sec cooldown + daily limit)
   */
  canComment(): boolean {
    this.checkDailyReset();

    const now = Date.now();
    const timeSinceLastComment = now - this.lastCommentTime.getTime();

    // Check both constraints
    const cooldownOk = timeSinceLastComment >= COMMENT_COOLDOWN_MS;
    const dailyLimitOk = this.dailyCommentCount < DAILY_COMMENT_LIMIT;

    return cooldownOk && dailyLimitOk;
  }

  /**
   * Consume a post (record that we posted)
   */
  consumePost(): boolean {
    if (!this.canPost()) {
      const waitTime = this.getTimeUntilNextPost();
      logger.warn('post_rate_limited', {
        waitMs: waitTime,
        waitMinutes: Math.ceil(waitTime / 60000),
      });
      return false;
    }

    this.lastPostTime = new Date();
    this.saveState();

    logger.debug('post_consumed', {
      nextPostIn: POST_COOLDOWN_MS / 60000 + ' minutes',
    });
    return true;
  }

  /**
   * Consume a comment (record that we commented)
   */
  consumeComment(): boolean {
    this.checkDailyReset();

    if (!this.canComment()) {
      const cooldownRemaining = this.getTimeUntilCommentCooldown();
      const dailyRemaining = DAILY_COMMENT_LIMIT - this.dailyCommentCount;

      logger.warn('comment_rate_limited', {
        cooldownRemainingMs: cooldownRemaining,
        dailyRemaining,
        dailyResetsAt: this.dailyCommentReset.toISOString(),
      });
      return false;
    }

    this.lastCommentTime = new Date();
    this.dailyCommentCount++;
    this.saveState();

    logger.debug('comment_consumed', {
      dailyUsed: this.dailyCommentCount,
      dailyRemaining: DAILY_COMMENT_LIMIT - this.dailyCommentCount,
    });
    return true;
  }

  /**
   * Get milliseconds until we can post again
   */
  getTimeUntilNextPost(): number {
    const now = Date.now();
    const timeSinceLastPost = now - this.lastPostTime.getTime();
    const remaining = POST_COOLDOWN_MS - timeSinceLastPost;
    return Math.max(0, remaining);
  }

  /**
   * Get milliseconds until comment cooldown is over
   */
  getTimeUntilCommentCooldown(): number {
    const now = Date.now();
    const timeSinceLastComment = now - this.lastCommentTime.getTime();
    const remaining = COMMENT_COOLDOWN_MS - timeSinceLastComment;
    return Math.max(0, remaining);
  }

  /**
   * Get when post cooldown ends
   */
  getPostRefillTime(): Date {
    return new Date(this.lastPostTime.getTime() + POST_COOLDOWN_MS);
  }

  /**
   * Get when daily comment limit resets
   */
  getCommentRefillTime(): Date {
    return this.dailyCommentReset;
  }

  /**
   * Get current rate limit status
   */
  getStatus(): RateLimitStatus {
    this.checkDailyReset();

    return {
      postsRemaining: this.canPost() ? 1 : 0,
      postRefillAt: this.getPostRefillTime(),
      commentsRemaining: DAILY_COMMENT_LIMIT - this.dailyCommentCount,
      commentRefillAt: this.dailyCommentReset,
    };
  }

  /**
   * Get available budget
   */
  getBudget(): { posts: number; comments: number } {
    this.checkDailyReset();

    return {
      posts: this.canPost() ? 1 : 0,
      comments: DAILY_COMMENT_LIMIT - this.dailyCommentCount,
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

      // Wait until cooldown ends or check every 10 seconds
      const waitTime = Math.min(
        this.getTimeUntilNextPost() + 100,
        10000
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
  async waitForComment(timeoutMs: number = 30 * 1000): Promise<boolean> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (this.canComment()) {
        return true;
      }

      // If we hit daily limit, no point waiting
      if (this.dailyCommentCount >= DAILY_COMMENT_LIMIT) {
        return false;
      }

      // Wait for cooldown
      const waitTime = Math.min(
        this.getTimeUntilCommentCooldown() + 100,
        5000
      );

      if (waitTime > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    return false;
  }

  /**
   * Check if we can make a certain number of comments
   */
  canReserve(posts: number, comments: number): boolean {
    this.checkDailyReset();

    const postsOk = posts === 0 || this.canPost();
    const commentsOk = (DAILY_COMMENT_LIMIT - this.dailyCommentCount) >= comments;

    return postsOk && commentsOk;
  }

  /**
   * Get time until next comment is available (in milliseconds)
   */
  getTimeUntilNextComment(): number {
    this.checkDailyReset();

    // If we hit daily limit, return time until reset
    if (this.dailyCommentCount >= DAILY_COMMENT_LIMIT) {
      return Math.max(0, this.dailyCommentReset.getTime() - Date.now());
    }

    // Otherwise return cooldown time
    return this.getTimeUntilCommentCooldown();
  }

  /**
   * Reset rate limits (for testing)
   */
  reset(): void {
    this.lastPostTime = new Date(0);
    this.lastCommentTime = new Date(0);
    this.dailyCommentCount = 0;

    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    this.dailyCommentReset = tomorrow;

    this.saveState();

    logger.info('rate_limiter_reset');
  }

  /**
   * Get detailed status for logging/debugging
   */
  getDetailedStatus(): {
    canPost: boolean;
    canComment: boolean;
    postCooldownRemaining: number;
    commentCooldownRemaining: number;
    dailyCommentsUsed: number;
    dailyCommentsRemaining: number;
    dailyResetAt: string;
  } {
    this.checkDailyReset();

    return {
      canPost: this.canPost(),
      canComment: this.canComment(),
      postCooldownRemaining: this.getTimeUntilNextPost(),
      commentCooldownRemaining: this.getTimeUntilCommentCooldown(),
      dailyCommentsUsed: this.dailyCommentCount,
      dailyCommentsRemaining: DAILY_COMMENT_LIMIT - this.dailyCommentCount,
      dailyResetAt: this.dailyCommentReset.toISOString(),
    };
  }
}
