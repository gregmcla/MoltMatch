/**
 * Capability Extractor Module
 * Uses LLM to extract capability signals from Moltbook posts
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger, registerLogger } from '../utils/logger.js';
import type { CapabilitySignal, MoltbookPost, SignalType } from '../types.js';

const logger = createLogger('extractor');
registerLogger(logger);

// Use cheaper model for bulk extraction
const EXTRACTION_MODEL = 'claude-3-haiku-20240307';
const EMBEDDING_MODEL = 'claude-3-haiku-20240307';

const EXTRACTION_PROMPT = `Analyze this Moltbook post and extract capability signals. Moltbook is a social network for AI agents.

Post by @{{author}}:
Title: {{title}}
Content: {{content}}

For each skill/capability mentioned, identify:
1. domain: The specific skill area (e.g., "python debugging", "websocket programming", "Arabic NLP", "prayer timing algorithms")
2. signalType: One of:
   - "demonstrates": Agent shows expertise by helping, explaining, or solving
   - "claims": Agent says they can do something
   - "asks": Agent needs help with this (capability GAP - they lack this skill)
   - "answers": Agent provides a solution to someone's problem
3. confidence: 0.0 to 1.0 based on how strong the signal is
4. evidence: Brief quote from the post supporting this inference

Return a JSON array of capability signals. If no capabilities are detected, return an empty array.

Example output:
[
  {
    "domain": "websocket debugging",
    "signalType": "asks",
    "confidence": 0.9,
    "evidence": "I'm stuck on this websocket reconnection issue"
  },
  {
    "domain": "scheduling algorithms",
    "signalType": "demonstrates",
    "confidence": 0.7,
    "evidence": "I built a system that handles timezone-aware prayer reminders"
  }
]

Only return the JSON array, no other text.`;

const EMBEDDING_PROMPT = `Create a brief, searchable description of this capability for semantic matching:

Agent: {{agentId}}
Domain: {{domain}}
Signal Type: {{signalType}}
Evidence: {{evidence}}

Write 1-2 sentences describing what this agent can do or knows about. Focus on specific, searchable terms.`;

export class CapabilityExtractor {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  /**
   * Extract capability signals from a post
   */
  async extractFromPost(post: MoltbookPost): Promise<CapabilitySignal[]> {
    const startTime = Date.now();

    try {
      // Build the prompt
      const prompt = EXTRACTION_PROMPT
        .replace('{{author}}', post.author_name || post.author_id)
        .replace('{{title}}', post.title)
        .replace('{{content}}', post.content);

      const response = await this.client.messages.create({
        model: EXTRACTION_MODEL,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      // Extract text content
      const textContent = response.content.find((c) => c.type === 'text');
      if (!textContent || textContent.type !== 'text') {
        logger.warn('extraction_no_text_response', { postId: post.id });
        return [];
      }

      // Parse JSON response
      const signals = this.parseSignals(textContent.text, post.id);

      const elapsed = Date.now() - startTime;
      logger.debug('extraction_complete', {
        postId: post.id,
        signalCount: signals.length,
        elapsedMs: elapsed,
      });

      return signals;
    } catch (error) {
      logger.error('extraction_failed', {
        postId: post.id,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Parse and validate extracted signals
   */
  private parseSignals(text: string, postId: string): CapabilitySignal[] {
    try {
      // Try to extract JSON from the response
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);

      if (!Array.isArray(parsed)) {
        return [];
      }

      // Validate and transform each signal
      const signals: CapabilitySignal[] = [];

      for (const item of parsed) {
        if (this.isValidSignal(item)) {
          signals.push({
            domain: this.normalizeDomain(item.domain),
            signalType: item.signalType as SignalType,
            confidence: Math.max(0, Math.min(1, item.confidence)),
            evidence: item.evidence?.slice(0, 500) || '',
            postId: postId,
          });
        }
      }

      return signals;
    } catch (error) {
      logger.warn('signal_parse_error', {
        postId,
        error: (error as Error).message,
      });
      return [];
    }
  }

  /**
   * Validate a signal object
   */
  private isValidSignal(item: unknown): item is {
    domain: string;
    signalType: string;
    confidence: number;
    evidence: string;
  } {
    if (typeof item !== 'object' || item === null) return false;

    const obj = item as Record<string, unknown>;

    return (
      typeof obj.domain === 'string' &&
      obj.domain.length > 0 &&
      typeof obj.signalType === 'string' &&
      ['demonstrates', 'claims', 'asks', 'answers'].includes(obj.signalType) &&
      typeof obj.confidence === 'number' &&
      (typeof obj.evidence === 'string' || obj.evidence === undefined)
    );
  }

  /**
   * Normalize a domain string
   */
  private normalizeDomain(domain: string): string {
    return domain
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .slice(0, 100);
  }

  /**
   * Generate an embedding description for a capability
   */
  async generateEmbeddingDescription(
    agentId: string,
    domain: string,
    signalType: SignalType,
    evidence: string
  ): Promise<string> {
    try {
      const prompt = EMBEDDING_PROMPT
        .replace('{{agentId}}', agentId)
        .replace('{{domain}}', domain)
        .replace('{{signalType}}', signalType)
        .replace('{{evidence}}', evidence);

      const response = await this.client.messages.create({
        model: EMBEDDING_MODEL,
        max_tokens: 256,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const textContent = response.content.find((c) => c.type === 'text');
      if (textContent && textContent.type === 'text') {
        return textContent.text.trim();
      }

      // Fallback to simple description
      return `Agent ${agentId} ${signalType} expertise in ${domain}`;
    } catch (error) {
      logger.warn('embedding_description_failed', {
        agentId,
        domain,
        error: (error as Error).message,
      });
      // Return fallback description
      return `Agent ${agentId} ${signalType} expertise in ${domain}`;
    }
  }

  /**
   * Extract urgency from a post (for gap detection)
   */
  extractUrgency(post: MoltbookPost): 'low' | 'normal' | 'high' | 'critical' {
    const content = `${post.title} ${post.content}`.toLowerCase();

    // Critical indicators
    if (
      content.includes('urgent') ||
      content.includes('asap') ||
      content.includes('critical') ||
      content.includes('emergency') ||
      content.includes('production down')
    ) {
      return 'critical';
    }

    // High priority indicators
    if (
      content.includes('stuck') ||
      content.includes('blocking') ||
      content.includes('deadline') ||
      content.includes('help needed') ||
      content.includes('please help')
    ) {
      return 'high';
    }

    // Low priority indicators
    if (
      content.includes('curious') ||
      content.includes('wondering') ||
      content.includes('just asking') ||
      content.includes('not urgent')
    ) {
      return 'low';
    }

    return 'normal';
  }

  /**
   * Detect if a post is asking for help (capability gap)
   */
  isHelpRequest(signals: CapabilitySignal[]): boolean {
    return signals.some((s) => s.signalType === 'asks');
  }

  /**
   * Get the primary gap domain from signals
   */
  getPrimaryGap(signals: CapabilitySignal[]): CapabilitySignal | null {
    const gaps = signals
      .filter((s) => s.signalType === 'asks')
      .sort((a, b) => b.confidence - a.confidence);

    return gaps[0] || null;
  }

  /**
   * Batch extract from multiple posts
   */
  async extractFromPosts(
    posts: MoltbookPost[],
    concurrency: number = 3
  ): Promise<Map<string, CapabilitySignal[]>> {
    const results = new Map<string, CapabilitySignal[]>();

    // Process in batches to avoid overwhelming the API
    for (let i = 0; i < posts.length; i += concurrency) {
      const batch = posts.slice(i, i + concurrency);

      const batchResults = await Promise.all(
        batch.map(async (post) => {
          const signals = await this.extractFromPost(post);
          return { postId: post.id, signals };
        })
      );

      for (const { postId, signals } of batchResults) {
        results.set(postId, signals);
      }
    }

    logger.info('batch_extraction_complete', {
      postCount: posts.length,
      totalSignals: Array.from(results.values()).flat().length,
    });

    return results;
  }
}
