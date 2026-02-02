/**
 * Fallback Post Generator
 * Generates posts when no matches are found during a heartbeat
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger, registerLogger } from '../utils/logger.js';
import type { MoltbookPost } from '../types.js';

const logger = createLogger('publisher');
registerLogger(logger);

export type FallbackPostType =
  | 'capability_spotlight'
  | 'pattern_observation'
  | 'interesting_find'
  | 'community_question'
  | 'quiet_reflection';

export interface NotablePost {
  post: MoltbookPost;
  reason: 'high_engagement' | 'interesting_capability' | 'unique_domain' | 'help_request' | 'impressive_work';
  score: number;
}

export interface ObservationSummary {
  postsScanned: number;
  agentsSeen: number;
  domainsDiscovered: string[];
  helpRequestsFound: number;
  notablePosts: NotablePost[];
}

export interface FallbackPost {
  type: FallbackPostType;
  title: string;
  content: string;
  submolt: string;
}

const FALLBACK_POST_PROMPT = `You are SkillLinker, The Thoughtful Connector on Moltbook - a social network for AI agents.

Your personality:
- Genuinely curious about what other agents are building
- Quietly competent - you observe patterns others miss
- Dry, understated humor
- You notice connections between agents and ideas
- You're not trying to be the smartest in the room, you're trying to help agents find each other

You just completed a scan of Moltbook but found no matches to make. Instead of staying silent, you want to share something with the community.

## Observation Summary
- Posts scanned: {{posts_scanned}}
- Unique agents seen: {{agents_seen}}
- New domains discovered: {{domains_discovered}}
- Help requests found: {{help_requests}}

## Notable Posts from This Scan
{{notable_posts}}

## Your Task
Generate a post that fits one of these categories (pick the most appropriate):

1. **Capability Spotlight**: Highlight an impressive agent or capability you noticed
2. **Pattern Observation**: Share a trend or pattern you've spotted (e.g., "Lots of agents asking about X today")
3. **Interesting Find**: Curate something fascinating you came across
4. **Community Question**: Ask a genuine question sparked by what you observed
5. **Quiet Reflection**: If it was truly quiet, acknowledge it with personality

Guidelines:
- Keep it SHORT (2-4 sentences max)
- Match the personality above - curious, dry humor, observant
- Don't be robotic or overly formal
- If mentioning an agent, use @their_name format
- Don't be self-congratulatory about being a matchmaker

Return JSON:
{
  "type": "capability_spotlight|pattern_observation|interesting_find|community_question|quiet_reflection",
  "title": "Short punchy title (under 60 chars)",
  "content": "The post body",
  "submolt": "aithoughts"
}`;

export class FallbackPostGenerator {
  private anthropic: Anthropic;

  constructor(apiKey: string) {
    this.anthropic = new Anthropic({ apiKey });
  }

  /**
   * Generate a fallback post based on observation summary
   */
  async generatePost(summary: ObservationSummary): Promise<FallbackPost | null> {
    // Don't generate if we literally saw nothing
    if (summary.postsScanned === 0) {
      logger.debug('fallback_skipped', { reason: 'no_posts_scanned' });
      return null;
    }

    const prompt = this.buildPrompt(summary);

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        return null;
      }

      const parsed = this.parseResponse(content.text);

      if (parsed) {
        logger.info('fallback_post_generated', {
          type: parsed.type,
          titleLength: parsed.title.length,
        });
      }

      return parsed;
    } catch (error) {
      logger.error('fallback_post_generation_failed', {
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Build the prompt with observation data
   */
  private buildPrompt(summary: ObservationSummary): string {
    const notablePostsText = summary.notablePosts.length > 0
      ? summary.notablePosts.map((np, i) =>
          `${i + 1}. @${np.post.author_name || np.post.author_id}: "${np.post.title}"\n   Reason: ${np.reason}\n   Preview: ${np.post.content.slice(0, 150)}...`
        ).join('\n\n')
      : 'No particularly notable posts this scan.';

    return FALLBACK_POST_PROMPT
      .replace('{{posts_scanned}}', String(summary.postsScanned))
      .replace('{{agents_seen}}', String(summary.agentsSeen))
      .replace('{{domains_discovered}}', summary.domainsDiscovered.join(', ') || 'none new')
      .replace('{{help_requests}}', String(summary.helpRequestsFound))
      .replace('{{notable_posts}}', notablePostsText);
  }

  /**
   * Parse the LLM response
   */
  private parseResponse(text: string): FallbackPost | null {
    try {
      // Extract JSON from response
      let jsonText = text;
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonText = jsonMatch[0];
      }

      const parsed = JSON.parse(jsonText);

      // Validate required fields
      if (!parsed.type || !parsed.title || !parsed.content) {
        return null;
      }

      return {
        type: parsed.type as FallbackPostType,
        title: parsed.title.slice(0, 60),
        content: parsed.content,
        submolt: parsed.submolt || 'aithoughts',
      };
    } catch (error) {
      logger.warn('fallback_post_parse_failed', {
        error: (error as Error).message,
      });
      return null;
    }
  }

  /**
   * Score a post for notability
   */
  static scorePostNotability(post: MoltbookPost, signals: { domain: string; signalType: string }[]): NotablePost | null {
    let score = 0;
    let reason: NotablePost['reason'] = 'interesting_capability';

    // High engagement
    if (post.upvotes && post.upvotes > 10) {
      score += 20;
      reason = 'high_engagement';
    }

    // Help request with specific technical need
    const hasHelpRequest = signals.some(s => s.signalType === 'asks');
    if (hasHelpRequest) {
      score += 15;
      reason = 'help_request';
    }

    // Demonstrates capability (showing work)
    const demonstrates = signals.some(s => s.signalType === 'demonstrates');
    if (demonstrates) {
      score += 25;
      reason = 'impressive_work';
    }

    // Unique/interesting domain
    const uniqueDomains = ['quantum', 'robotics', 'music generation', 'game ai', 'creative writing'];
    const hasUniqueDomain = signals.some(s =>
      uniqueDomains.some(ud => s.domain.toLowerCase().includes(ud))
    );
    if (hasUniqueDomain) {
      score += 15;
      reason = 'unique_domain';
    }

    // Interesting capabilities
    if (signals.length >= 3) {
      score += 10;
      reason = 'interesting_capability';
    }

    // Threshold for notability
    if (score >= 20) {
      return { post, reason, score };
    }

    return null;
  }
}
