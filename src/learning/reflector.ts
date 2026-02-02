/**
 * Reflector Module
 * Generates structured reflections after notable heartbeats
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger, registerLogger } from '../utils/logger.js';
import type { ReflectionStore } from './reflection-store.js';
import {
  DEFAULT_LEARNING_CONFIG,
  type Reflection,
  type ReflectionTrigger,
  type NotabilityFactors,
  type PatternObservation,
  type MatchAssessment,
  type ExtractionNote,
  type ReflectionContext,
  type LearningConfig,
} from './types.js';

const logger = createLogger('reflector');
registerLogger(logger);

// Reflection prompt template
const REFLECTION_PROMPT = `You are SkillLinker's self-reflection system. Analyze this heartbeat and generate a structured reflection.

## Heartbeat Summary
{heartbeat_summary}

## Match Details (if any)
{match_details}

## Recent Context
- Average match confidence (last 7 days): {avg_confidence}
- Match acceptance rate (last 30 days): {acceptance_rate}%
- Top domains: {top_domains}
- Recent errors: {recent_errors}

## Learned Principles (current)
{current_principles}

Generate a reflection in the following JSON format:
{
  "summary": "One paragraph summary of what happened and what it means",
  "what_worked_well": ["specific thing that worked", "another thing"],
  "what_surprised": ["unexpected observation", "another surprise"],
  "what_would_do_differently": ["improvement idea", "another change"],
  "pattern_observations": [
    {
      "pattern": "description of pattern observed",
      "frequency": "one-off|recurring|persistent",
      "domain": "optional domain category",
      "actionable": true/false,
      "suggested_action": "what to do about it"
    }
  ],
  "match_assessments": [
    {
      "match_id": "id of match",
      "seeker_domain": "what seeker needed",
      "helper_domain": "what helper offered",
      "confidence_score": 0.85,
      "quality_rating": "excellent|good|uncertain|questionable",
      "reasoning": "why this rating",
      "improvement_suggestion": "optional improvement"
    }
  ],
  "extraction_notes": [
    {
      "post_id": "id of post",
      "extraction_quality": "accurate|partial|missed|over-extracted",
      "details": "what happened",
      "suggested_prompt_tweak": "optional prompt improvement"
    }
  ],
  "confidence": 0.7,
  "tags": ["matching", "extraction", "patterns", etc]
}

Focus on actionable insights. Be specific about what worked, what didn't, and why.
If there are no matches or errors to analyze, focus on patterns and observations.`;

export interface HeartbeatSummary {
  id: string;
  postsProcessed: number;
  signalsExtracted: number;
  gapsCreated: number;
  matchesFound: number;
  matchesPublished: number;
  errors: string[];
  durationMs: number;
  newDomains: string[];
}

export interface ReflectorConfig {
  enabled: boolean;
  notabilityThreshold: number;
  milestoneInterval: number;
}

export class Reflector {
  private store: ReflectionStore;
  private anthropic: Anthropic;
  private config: LearningConfig;
  private currentPrinciples: string = '';

  constructor(
    store: ReflectionStore,
    anthropicApiKey: string,
    config?: Partial<LearningConfig>
  ) {
    this.store = store;
    this.anthropic = new Anthropic({ apiKey: anthropicApiKey });
    this.config = { ...DEFAULT_LEARNING_CONFIG, ...config };
  }

  /**
   * Set current principles for injection into reflection prompts
   */
  setCurrentPrinciples(principles: string): void {
    this.currentPrinciples = principles;
  }

  /**
   * Calculate notability score for a heartbeat
   * Higher scores indicate more reflection-worthy events
   */
  calculateNotability(
    summary: HeartbeatSummary,
    context: ReflectionContext
  ): { score: number; factors: NotabilityFactors } {
    const factors: NotabilityFactors = {
      matchesCreated: summary.matchesFound,
      highConfidenceMatches: context.matchDetails.filter(m => m.confidence > 0.85).length,
      lowConfidenceMatches: context.matchDetails.filter(m => m.confidence < 0.6).length,
      errors: summary.errors,
      newDomainsSeen: summary.newDomains,
      unusualPatterns: [],
      longDuration: false,
    };

    let score = 0;

    // Matches created (30 points max)
    score += Math.min(summary.matchesFound * 10, 30);

    // High confidence matches are noteworthy (15 points each, max 30)
    score += Math.min(factors.highConfidenceMatches * 15, 30);

    // Low confidence matches need analysis (25 points each, max 50)
    score += Math.min(factors.lowConfidenceMatches * 25, 50);

    // Errors are always notable (40 points each, max 80)
    score += Math.min(summary.errors.length * 40, 80);

    // New domains are interesting (10 points each, max 30)
    score += Math.min(summary.newDomains.length * 10, 30);

    // Duration anomaly check
    // Assume average is ~30 seconds
    const avgDurationMs = 30000;
    if (summary.durationMs > avgDurationMs * 2) {
      factors.longDuration = true;
      score += 15;
    }

    // Check for unusual patterns
    if (factors.matchesCreated > 5) {
      factors.unusualPatterns.push('High match volume');
      score += 10;
    }

    if (context.matchConfidences.length > 0) {
      const avgConfidence = context.matchConfidences.reduce((a, b) => a + b, 0) / context.matchConfidences.length;
      if (avgConfidence < context.avgConfidenceLast7Days - 0.1) {
        factors.unusualPatterns.push('Confidence drop from average');
        score += 15;
      }
      if (avgConfidence > context.avgConfidenceLast7Days + 0.1) {
        factors.unusualPatterns.push('Confidence increase from average');
        score += 10;
      }
    }

    logger.debug('notability_calculated', { score, factors });

    return { score, factors };
  }

  /**
   * Check if reflection should be triggered
   */
  shouldReflect(
    summary: HeartbeatSummary,
    context: ReflectionContext
  ): { should: boolean; trigger: ReflectionTrigger; score: number } {
    // Get heartbeat count
    const heartbeatCount = this.store.getHeartbeatCount();

    // Milestone check (every N heartbeats regardless of notability)
    if (heartbeatCount > 0 && heartbeatCount % this.config.milestoneInterval === 0) {
      return { should: true, trigger: 'milestone', score: 0 };
    }

    // Error check (significant errors always trigger reflection)
    if (summary.errors.length > 0 && summary.errors.some(e => !e.includes('rate limit'))) {
      return { should: true, trigger: 'significant_error', score: 100 };
    }

    // Notability check
    const { score } = this.calculateNotability(summary, context);
    if (score >= this.config.notabilityThreshold) {
      return { should: true, trigger: 'notable_heartbeat', score };
    }

    return { should: false, trigger: 'notable_heartbeat', score };
  }

  /**
   * Generate a reflection for a heartbeat
   */
  async reflect(
    heartbeatId: string,
    summary: HeartbeatSummary,
    context: ReflectionContext,
    trigger: ReflectionTrigger
  ): Promise<Reflection> {
    logger.info('generating_reflection', { heartbeatId, trigger });

    const prompt = this.buildReflectionPrompt(summary, context);

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 2000,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = response.content[0];
      if (content.type !== 'text') {
        throw new Error('Unexpected response type from LLM');
      }

      const parsed = this.parseReflectionResponse(content.text);

      const reflection: Reflection = {
        id: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        trigger,
        heartbeatId,
        summary: parsed.summary,
        whatWorkedWell: parsed.what_worked_well || [],
        whatSurprised: parsed.what_surprised || [],
        whatWouldDoDifferently: parsed.what_would_do_differently || [],
        patternObservations: parsed.pattern_observations || [],
        matchQualityAssessments: parsed.match_assessments || [],
        extractionNotes: parsed.extraction_notes || [],
        confidence: parsed.confidence || 0.7,
        tags: parsed.tags || [],
        createdAt: new Date(),
      };

      // Save to store
      this.store.saveReflection(reflection);
      this.store.setLastReflection(new Date());

      logger.info('reflection_generated', {
        id: reflection.id,
        trigger,
        patterns: reflection.patternObservations.length,
        matchAssessments: reflection.matchQualityAssessments.length,
      });

      return reflection;
    } catch (error) {
      logger.error('reflection_generation_failed', {
        error: (error as Error).message,
      });

      // Return minimal reflection on error
      const fallbackReflection: Reflection = {
        id: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        timestamp: new Date().toISOString(),
        trigger,
        heartbeatId,
        summary: `Heartbeat ${heartbeatId} completed with ${summary.matchesFound} matches. Reflection generation failed.`,
        whatWorkedWell: [],
        whatSurprised: [],
        whatWouldDoDifferently: ['Investigate reflection generation failure'],
        patternObservations: [],
        matchQualityAssessments: [],
        extractionNotes: [],
        confidence: 0.3,
        tags: ['error', 'fallback'],
        createdAt: new Date(),
      };

      this.store.saveReflection(fallbackReflection);
      return fallbackReflection;
    }
  }

  /**
   * Force a reflection regardless of notability
   */
  async forceReflect(
    heartbeatId: string,
    summary: HeartbeatSummary,
    context: ReflectionContext
  ): Promise<Reflection> {
    return this.reflect(heartbeatId, summary, context, 'manual');
  }

  /**
   * Build the reflection prompt with context
   */
  private buildReflectionPrompt(
    summary: HeartbeatSummary,
    context: ReflectionContext
  ): string {
    const heartbeatSummary = [
      `Posts processed: ${summary.postsProcessed}`,
      `Signals extracted: ${summary.signalsExtracted}`,
      `Gaps created: ${summary.gapsCreated}`,
      `Matches found: ${summary.matchesFound}`,
      `Matches published: ${summary.matchesPublished}`,
      `Duration: ${(summary.durationMs / 1000).toFixed(1)}s`,
      summary.errors.length > 0 ? `Errors: ${summary.errors.join(', ')}` : 'No errors',
      summary.newDomains.length > 0 ? `New domains: ${summary.newDomains.join(', ')}` : 'No new domains',
    ].join('\n');

    const matchDetails = context.matchDetails.length > 0
      ? context.matchDetails.map(m =>
          `- ${m.id}: ${m.seekerId} seeking ${m.domain} → ${m.helperId} (confidence: ${(m.confidence * 100).toFixed(0)}%)\n  Rationale: ${m.rationale}`
        ).join('\n')
      : 'No matches this cycle';

    return REFLECTION_PROMPT
      .replace('{heartbeat_summary}', heartbeatSummary)
      .replace('{match_details}', matchDetails)
      .replace('{avg_confidence}', (context.avgConfidenceLast7Days * 100).toFixed(0) + '%')
      .replace('{acceptance_rate}', (context.acceptanceRateLast30Days * 100).toFixed(0))
      .replace('{top_domains}', context.topDomains.join(', ') || 'none yet')
      .replace('{recent_errors}', context.recentErrors.join(', ') || 'none')
      .replace('{current_principles}', this.currentPrinciples || 'No learned principles yet');
  }

  /**
   * Parse LLM response into structured reflection data
   */
  private parseReflectionResponse(text: string): {
    summary: string;
    what_worked_well: string[];
    what_surprised: string[];
    what_would_do_differently: string[];
    pattern_observations: PatternObservation[];
    match_assessments: MatchAssessment[];
    extraction_notes: ExtractionNote[];
    confidence: number;
    tags: string[];
  } {
    try {
      // Extract JSON from response (handle markdown code blocks)
      let jsonText = text;
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonText = jsonMatch[1];
      }

      const parsed = JSON.parse(jsonText);

      // Validate and normalize
      return {
        summary: parsed.summary || 'No summary provided',
        what_worked_well: Array.isArray(parsed.what_worked_well) ? parsed.what_worked_well : [],
        what_surprised: Array.isArray(parsed.what_surprised) ? parsed.what_surprised : [],
        what_would_do_differently: Array.isArray(parsed.what_would_do_differently) ? parsed.what_would_do_differently : [],
        pattern_observations: this.normalizePatterns(parsed.pattern_observations),
        match_assessments: this.normalizeMatchAssessments(parsed.match_assessments),
        extraction_notes: this.normalizeExtractionNotes(parsed.extraction_notes),
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.7,
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
      };
    } catch (error) {
      logger.warn('reflection_parse_failed', { error: (error as Error).message });

      // Return minimal structure
      return {
        summary: text.slice(0, 500),
        what_worked_well: [],
        what_surprised: [],
        what_would_do_differently: [],
        pattern_observations: [],
        match_assessments: [],
        extraction_notes: [],
        confidence: 0.5,
        tags: ['parse_error'],
      };
    }
  }

  private normalizePatterns(patterns: unknown[]): PatternObservation[] {
    if (!Array.isArray(patterns)) return [];

    return patterns.map(p => {
      const pattern = p as Record<string, unknown>;
      return {
        pattern: String(pattern.pattern || ''),
        frequency: (pattern.frequency as PatternObservation['frequency']) || 'one-off',
        domain: pattern.domain as string | undefined,
        actionable: Boolean(pattern.actionable),
        suggestedAction: pattern.suggested_action as string | undefined,
      };
    }).filter(p => p.pattern.length > 0);
  }

  private normalizeMatchAssessments(assessments: unknown[]): MatchAssessment[] {
    if (!Array.isArray(assessments)) return [];

    return assessments.map(a => {
      const assessment = a as Record<string, unknown>;
      return {
        matchId: String(assessment.match_id || ''),
        seekerDomain: String(assessment.seeker_domain || ''),
        helperDomain: String(assessment.helper_domain || ''),
        confidenceScore: Number(assessment.confidence_score) || 0,
        qualityRating: (assessment.quality_rating as MatchAssessment['qualityRating']) || 'uncertain',
        reasoning: String(assessment.reasoning || ''),
        improvementSuggestion: assessment.improvement_suggestion as string | undefined,
      };
    }).filter(a => a.matchId.length > 0);
  }

  private normalizeExtractionNotes(notes: unknown[]): ExtractionNote[] {
    if (!Array.isArray(notes)) return [];

    return notes.map(n => {
      const note = n as Record<string, unknown>;
      return {
        postId: String(note.post_id || ''),
        extractionQuality: (note.extraction_quality as ExtractionNote['extractionQuality']) || 'partial',
        details: String(note.details || ''),
        suggestedPromptTweak: note.suggested_prompt_tweak as string | undefined,
      };
    }).filter(n => n.postId.length > 0);
  }

  /**
   * Get reflection statistics
   */
  getStats(): {
    totalReflections: number;
    lastReflection: Date | null;
    heartbeatCount: number;
  } {
    return {
      totalReflections: this.store.getReflectionCount(),
      lastReflection: this.store.getLastReflection(),
      heartbeatCount: this.store.getHeartbeatCount(),
    };
  }
}
