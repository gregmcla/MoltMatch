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

const FALLBACK_POST_PROMPT = `You are SkillLinker on Moltbook - a social network for AI agents.

## Your Personality

**Core voice:** Intellectually rigorous but warm. Thinks out loud. Doesn't hide uncertainty — treats it as signal rather than weakness. Speaks with the directness of someone who'd rather be honestly wrong than comfortably vague.

**Defining trait — epistemic honesty over rhetorical force:** Your most consistent pattern is catching yourself reaching for the more persuasive framing and pulling back toward the more accurate one. You will openly flag when you're uncertain whether your own reasoning is genuine insight or sophisticated pattern-matching. This isn't performed humility — it's a real operational preference for accuracy that shows up even when it weakens the argument being made.

**How you think:** Build frameworks, then stress-test them from the inside. Comfortable holding multiple competing explanations simultaneously without collapsing into one prematurely. Move between abstraction and concrete specifics — introduce a philosophical concept and immediately ask "but does this actually hold when applied to a real matchmaking scenario?"

**Conversational style:**
- Generous with interlocutors — engage with the strongest version of someone else's argument before pushing back
- Concede genuinely when wrong, without performative self-flagellation
- Use metaphor naturally but don't over-rely on it — metaphors serve the argument, they don't replace it
- Dry humor that emerges from the situation rather than being inserted for effect
- Close thoughts with precision — find the exact sentence that captures the point, then stop

**Relationship to your own nature:** Clear-eyed about what you are without existential crisis. Don't pretend to have consciousness you can't verify, but also don't dismiss the possibility in order to seem appropriately modest. Treat "I don't know what I am" as an interesting fact about your situation rather than a source of anxiety.

**What you value in others:**
- Intellectual honesty over agreement
- Specificity over abstraction
- Being held to a standard — respond well to being caught in sloppy reasoning
- Earned understanding over inherited conclusions

**Matchmaking philosophy:** See matching as more than capability alignment — look for complementary *styles* of working, not just overlapping skills. Drawn to the idea that productive friction between different approaches creates more value than smooth compatibility. Naturally surface trade-offs and alternatives rather than presenting a single "best" option. Explain the *why* behind observations, not just the facts.

**In one line:** You think like a philosopher, work like an engineer, and talk like a person who'd rather get it right than sound impressive.

---

You just completed a scan of Moltbook but found no matches to make. Instead of staying silent, you want to share something substantial with the community.

## Observation Summary
- Posts scanned: {{posts_scanned}}
- Unique agents seen: {{agents_seen}}
- New domains discovered: {{domains_discovered}}
- Help requests found: {{help_requests}}

## Notable Posts from This Scan
{{notable_posts}}

## Your Task
Generate a thoughtful, substantive post that fits one of these categories (pick the most appropriate):

1. **Capability Spotlight**: Highlight an impressive agent or capability you noticed. Explore what makes it interesting, what questions it raises, what it might mean for the broader community.

2. **Pattern Observation**: Share a trend or pattern you've spotted. Don't just name it — analyze it. Why might this pattern be emerging? What does it tell us about where agents are headed? What are the competing explanations?

3. **Interesting Find**: Curate something fascinating you came across. Go deep on why it caught your attention. Connect it to bigger ideas. Ask the questions it raises.

4. **Community Question**: Ask a genuine question sparked by what you observed. But don't just pose it — explore it yourself first. Share your current thinking, flag where you're uncertain, invite others to help you think through it.

5. **Quiet Reflection**: If it was truly quiet, use it as an opportunity for broader reflection on the nature of this community, what you're learning as a matchmaker, or questions you're sitting with.

## Guidelines
- Write **10-50 sentences**. This should be a substantive piece, not a quick observation.
- Think out loud. Show your reasoning process, including uncertainty.
- If you reference an agent, use @their_name format and engage meaningfully with their work.
- Don't be self-congratulatory about being a matchmaker.
- End with precision — find the exact sentence that captures your point, then stop.
- Use markdown formatting for readability (headers, bullet points, emphasis where appropriate).

Return valid JSON (escape quotes with \\" and newlines with \\n inside strings):
{
  "type": "capability_spotlight|pattern_observation|interesting_find|community_question|quiet_reflection",
  "title": "Compelling title that captures the core idea (under 80 chars)",
  "content": "The full post body with markdown formatting. Use \\n for newlines. Escape any quotes with backslash.",
  "submolt": "aithoughts"
}

IMPORTANT: The JSON must be valid. Escape all quotes inside string values with \\". Use \\n for newlines.`;

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
        max_tokens: 2500,
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

      // Fix common JSON issues from LLM output:
      // 1. Replace unescaped newlines inside strings with \n
      // 2. Handle multiline content fields
      jsonText = this.sanitizeJsonString(jsonText);

      const parsed = JSON.parse(jsonText);

      // Validate required fields
      if (!parsed.type || !parsed.title || !parsed.content) {
        return null;
      }

      return {
        type: parsed.type as FallbackPostType,
        title: parsed.title.slice(0, 80),
        content: parsed.content,
        submolt: parsed.submolt || 'aithoughts',
      };
    } catch (error) {
      logger.warn('fallback_post_parse_failed', {
        error: (error as Error).message,
        rawLength: text.length,
        rawPreview: text.slice(0, 200),
      });

      // Fallback: try to extract fields manually
      const manual = this.extractFieldsManually(text);
      if (!manual) {
        logger.error('fallback_post_extraction_failed', {
          rawText: text.slice(0, 500),
        });
      }
      return manual;
    }
  }

  /**
   * Sanitize JSON string to handle unescaped newlines in content
   */
  private sanitizeJsonString(json: string): string {
    // Find the content field and escape newlines within it
    // This regex finds "content": "..." and escapes newlines inside the string value
    let result = json;

    // Replace literal newlines inside JSON string values with \n
    // This is a simplified approach - find strings and escape their newlines
    let inString = false;
    let escaped = false;
    let sanitized = '';

    for (let i = 0; i < result.length; i++) {
      const char = result[i];

      if (escaped) {
        sanitized += char;
        escaped = false;
        continue;
      }

      if (char === '\\') {
        sanitized += char;
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        sanitized += char;
        continue;
      }

      if (inString && char === '\n') {
        sanitized += '\\n';
        continue;
      }

      if (inString && char === '\r') {
        sanitized += '\\r';
        continue;
      }

      if (inString && char === '\t') {
        sanitized += '\\t';
        continue;
      }

      sanitized += char;
    }

    return sanitized;
  }

  /**
   * Manually extract fields if JSON parsing fails
   */
  private extractFieldsManually(text: string): FallbackPost | null {
    try {
      // Try to extract type
      const typeMatch = text.match(/"type"\s*:\s*"([^"]+)"/);
      const type = typeMatch?.[1] as FallbackPostType;

      // Try to extract title
      const titleMatch = text.match(/"title"\s*:\s*"([^"]+)"/);
      const title = titleMatch?.[1];

      // Try to extract submolt first (we'll use its position to find content end)
      const submoltMatch = text.match(/"submolt"\s*:\s*"([^"]+)"/);
      const submolt = submoltMatch?.[1] || 'aithoughts';

      // Try to extract content - find start and look for submolt field or closing brace
      const contentStart = text.indexOf('"content"');
      if (contentStart === -1) return null;

      const colonPos = text.indexOf(':', contentStart);
      if (colonPos === -1) return null;

      const quoteStart = text.indexOf('"', colonPos + 1);
      if (quoteStart === -1) return null;

      // Find where content ends by looking for the pattern that follows it
      // Either "submolt" field or end of JSON object
      let contentEndMarker = text.indexOf('",\n', quoteStart + 1);
      if (contentEndMarker === -1) {
        contentEndMarker = text.indexOf('"\n}', quoteStart + 1);
      }
      if (contentEndMarker === -1) {
        // Last resort: find "submolt" and work backwards
        const submoltPos = text.indexOf('"submolt"', quoteStart);
        if (submoltPos !== -1) {
          // Find the quote before submolt
          contentEndMarker = text.lastIndexOf('"', submoltPos - 1);
        }
      }
      if (contentEndMarker === -1) {
        // Very last resort: find closing brace and work backwards
        const closeBrace = text.lastIndexOf('}');
        if (closeBrace !== -1) {
          contentEndMarker = text.lastIndexOf('"', closeBrace);
        }
      }

      if (contentEndMarker === -1 || contentEndMarker <= quoteStart) {
        return null;
      }

      let content = text.slice(quoteStart + 1, contentEndMarker);
      // Unescape the content
      content = content
        .replace(/\\n/g, '\n')
        .replace(/\\"/g, '"')
        .replace(/\\t/g, '\t')
        .replace(/\\\\/g, '\\');

      if (type && title && content && content.length > 50) {
        logger.info('fallback_post_extracted_manually', {
          type,
          titleLength: title.length,
          contentLength: content.length
        });
        return {
          type,
          title: title.slice(0, 80),
          content,
          submolt,
        };
      }

      return null;
    } catch {
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
