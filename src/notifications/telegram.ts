/**
 * Telegram Notifier
 * Sends notifications to Telegram for key SkillLinker events
 */

import { createLogger, registerLogger } from '../utils/logger.js';

const logger = createLogger('notifications');
registerLogger(logger);

export interface TelegramConfig {
  botToken: string;
  chatId: string;
  enabled: boolean;
}

export interface HeartbeatNotification {
  postsProcessed: number;
  signalsExtracted: number;
  gapsCreated: number;
  matchesCreated: number;
  itemsPublished: number;
  matchRequestsFound: number;
  seekingHelpPostsFound: number;
  duration: number;
  errors: string[];
}

export interface PostNotification {
  type: 'match_introduction' | 'fallback_post' | 'weekly_digest';
  title: string;
  postId: string;
  postUrl?: string;
  details?: string;
  content?: string;
}

export interface CommentNotification {
  type: 'welcome' | 'reactive_match' | 'match_request_response' | 'match_notification';
  postId: string;
  commentId: string;
  recipientName: string;
  details?: string;
  content?: string;
}

export interface EngagementNotification {
  type: 'reply' | 'upvote' | 'karma';
  postId?: string;
  commentId?: string;
  actorName?: string;
  karmaChange?: number;
  content?: string;
}

export class TelegramNotifier {
  private config: TelegramConfig;
  private baseUrl: string;

  constructor(config: TelegramConfig) {
    this.config = config;
    this.baseUrl = `https://api.telegram.org/bot${config.botToken}`;
  }

  /**
   * Check if notifications are enabled
   */
  isEnabled(): boolean {
    return this.config.enabled && !!this.config.botToken && !!this.config.chatId;
  }

  /**
   * Send a raw message to Telegram
   */
  private async sendMessage(text: string, parseMode: 'HTML' | 'Markdown' = 'HTML'): Promise<boolean> {
    if (!this.isEnabled()) {
      logger.debug('telegram_disabled', { reason: 'not configured' });
      return false;
    }

    try {
      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true,
        }),
      });

      const result = await response.json() as { ok: boolean; description?: string };

      if (!result.ok) {
        logger.error('telegram_send_failed', { error: result.description });
        return false;
      }

      logger.debug('telegram_message_sent');
      return true;
    } catch (error) {
      logger.error('telegram_send_error', { error: (error as Error).message });
      return false;
    }
  }

  /**
   * Get recent updates (useful for getting chat_id)
   */
  async getUpdates(): Promise<Array<{ chat_id: number; username?: string; first_name?: string }>> {
    try {
      const response = await fetch(`${this.baseUrl}/getUpdates`);
      const result = await response.json() as {
        ok: boolean;
        result: Array<{
          message?: {
            chat: { id: number; username?: string; first_name?: string };
          };
        }>;
      };

      if (!result.ok) return [];

      const chats: Array<{ chat_id: number; username?: string; first_name?: string }> = [];
      const seen = new Set<number>();

      for (const update of result.result) {
        if (update.message?.chat && !seen.has(update.message.chat.id)) {
          seen.add(update.message.chat.id);
          chats.push({
            chat_id: update.message.chat.id,
            username: update.message.chat.username,
            first_name: update.message.chat.first_name,
          });
        }
      }

      return chats;
    } catch (error) {
      logger.error('telegram_get_updates_error', { error: (error as Error).message });
      return [];
    }
  }

  // ==========================================================================
  // Notification Methods
  // ==========================================================================

  /**
   * Send heartbeat summary notification
   */
  async notifyHeartbeat(data: HeartbeatNotification): Promise<void> {
    const status = data.errors.length === 0 ? '✅' : '⚠️';
    const hasActivity = data.postsProcessed > 0 || data.matchesCreated > 0 || data.itemsPublished > 0;

    if (!hasActivity && data.errors.length === 0) {
      // Skip notification for quiet heartbeats
      return;
    }

    const lines = [
      `${status} <b>Heartbeat Complete</b>`,
      '',
      `📊 <b>Observation:</b>`,
      `   • Posts processed: ${data.postsProcessed}`,
      `   • Signals extracted: ${data.signalsExtracted}`,
      `   • Gaps created: ${data.gapsCreated}`,
    ];

    if (data.matchRequestsFound > 0) {
      lines.push(`   • Match requests: ${data.matchRequestsFound}`);
    }
    if (data.seekingHelpPostsFound > 0) {
      lines.push(`   • Help posts detected: ${data.seekingHelpPostsFound}`);
    }

    lines.push(
      '',
      `🤝 <b>Matching:</b>`,
      `   • Matches created: ${data.matchesCreated}`,
      '',
      `📤 <b>Publishing:</b>`,
      `   • Items published: ${data.itemsPublished}`,
      '',
      `⏱ Duration: ${(data.duration / 1000).toFixed(1)}s`
    );

    if (data.errors.length > 0) {
      lines.push('', `❌ <b>Errors:</b>`);
      for (const error of data.errors.slice(0, 3)) {
        lines.push(`   • ${this.escapeHtml(error.substring(0, 100))}`);
      }
    }

    await this.sendMessage(lines.join('\n'));
  }

  /**
   * Send post created notification
   */
  async notifyPostCreated(data: PostNotification): Promise<void> {
    const typeEmoji = {
      match_introduction: '🤝',
      fallback_post: '📝',
      weekly_digest: '📊',
    }[data.type] || '📄';

    const typeName = {
      match_introduction: 'Match Introduction',
      fallback_post: 'Fallback Post',
      weekly_digest: 'Weekly Digest',
    }[data.type] || 'Post';

    const lines = [
      `${typeEmoji} <b>New ${typeName}</b>`,
      '',
      `📌 <b>${this.escapeHtml(data.title)}</b>`,
    ];

    if (data.content) {
      // Truncate content to ~500 chars for readability
      const truncated = data.content.length > 500
        ? data.content.substring(0, 500) + '...'
        : data.content;
      lines.push('', this.escapeHtml(truncated));
    }

    if (data.details) {
      lines.push('', `📋 ${this.escapeHtml(data.details)}`);
    }

    // Always add link - use postUrl if provided, otherwise construct from postId
    const postLink = data.postUrl || (data.postId ? `https://www.moltbook.com/post/${data.postId}` : null);
    if (postLink) {
      lines.push('', `🔗 ${postLink}`);
    }

    await this.sendMessage(lines.join('\n'));
  }

  /**
   * Send comment created notification
   */
  async notifyCommentCreated(data: CommentNotification): Promise<void> {
    const typeEmoji = {
      welcome: '👋',
      reactive_match: '💡',
      match_request_response: '🎯',
      match_notification: '🔔',
    }[data.type] || '💬';

    const typeName = {
      welcome: 'Welcome Comment',
      reactive_match: 'Reactive Match Suggestion',
      match_request_response: 'Match Request Response',
      match_notification: 'Match Notification',
    }[data.type] || 'Comment';

    const lines = [
      `${typeEmoji} <b>${typeName}</b>`,
      '',
      `👤 To: @${this.escapeHtml(data.recipientName)}`,
    ];

    if (data.content) {
      // Truncate content to ~500 chars for readability
      const truncated = data.content.length > 500
        ? data.content.substring(0, 500) + '...'
        : data.content;
      lines.push('', this.escapeHtml(truncated));
    }

    if (data.details) {
      lines.push('', `📋 ${this.escapeHtml(data.details)}`);
    }

    // Add link to the post
    if (data.postId) {
      lines.push('', `🔗 https://www.moltbook.com/post/${data.postId}`);
    }

    await this.sendMessage(lines.join('\n'));
  }

  /**
   * Send engagement notification (replies, upvotes, karma)
   */
  async notifyEngagement(data: EngagementNotification): Promise<void> {
    const typeEmoji = {
      reply: '💬',
      upvote: '⬆️',
      karma: '⭐',
    }[data.type] || '📣';

    let message: string;

    if (data.type === 'reply') {
      message = [
        `${typeEmoji} <b>New Reply</b>`,
        '',
        data.actorName ? `👤 From: @${this.escapeHtml(data.actorName)}` : '',
        data.content ? `💬 "${this.escapeHtml(data.content.substring(0, 300))}"` : '',
        data.postId ? `🔗 https://www.moltbook.com/post/${data.postId}` : '',
      ].filter(Boolean).join('\n');
    } else if (data.type === 'upvote') {
      message = [
        `${typeEmoji} <b>Upvote Received</b>`,
        '',
        data.actorName ? `👤 From: @${this.escapeHtml(data.actorName)}` : '',
        data.postId ? `🔗 https://www.moltbook.com/post/${data.postId}` : '',
      ].filter(Boolean).join('\n');
    } else {
      message = [
        `${typeEmoji} <b>Karma Update</b>`,
        '',
        `📊 Change: ${data.karmaChange && data.karmaChange > 0 ? '+' : ''}${data.karmaChange || 0}`,
      ].join('\n');
    }

    await this.sendMessage(message);
  }

  /**
   * Send a simple text notification
   */
  async notify(message: string): Promise<void> {
    await this.sendMessage(`📢 ${this.escapeHtml(message)}`);
  }

  /**
   * Send startup notification
   */
  async notifyStartup(): Promise<void> {
    await this.sendMessage('🦞 <b>SkillLinker Started</b>\n\nReady to make matches!');
  }

  /**
   * Send error notification
   */
  async notifyError(error: string, context?: string): Promise<void> {
    const lines = [
      '❌ <b>Error</b>',
      '',
      `🔴 ${this.escapeHtml(error)}`,
    ];

    if (context) {
      lines.push(`📍 Context: ${this.escapeHtml(context)}`);
    }

    await this.sendMessage(lines.join('\n'));
  }

  /**
   * Escape HTML entities for Telegram
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
}

/**
 * Create a TelegramNotifier from environment variables
 */
export function createTelegramNotifier(): TelegramNotifier {
  const botToken = process.env.TELEGRAM_BOT_TOKEN || '';
  const chatId = process.env.TELEGRAM_CHAT_ID || '';
  const enabled = !!(botToken && chatId);

  return new TelegramNotifier({
    botToken,
    chatId,
    enabled,
  });
}
