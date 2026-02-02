/**
 * Consolidator Module
 * Consolidates reflections into insights and promotes insights to principles
 */

import Anthropic from '@anthropic-ai/sdk';
import { createLogger, registerLogger } from '../utils/logger.js';
import type { ReflectionStore } from './reflection-store.js';
import {
  DEFAULT_LEARNING_CONFIG,
  CORE_INVARIANTS,
  type Insight,
  type Principle,
  type Reflection,
  type InsightCategory,
  type PrincipleCategory,
  type LearningConfig,
  type ConsolidationResult,
} from './types.js';

const logger = createLogger('consolidator');
registerLogger(logger);

// Consolidation prompt template
const CONSOLIDATION_PROMPT = `You are SkillLinker's learning consolidation system. Analyze recent reflections and extract durable insights.

## Recent Reflections (${'{reflection_count}'})
{reflections}

## Existing Insights
{existing_insights}

## Core Invariants (cannot be contradicted)
${CORE_INVARIANTS.map((inv, i) => `${i + 1}. ${inv}`).join('\n')}

Analyze the reflections and generate consolidation recommendations in this JSON format:
{
  "new_insights": [
    {
      "category": "matching|extraction|patterns|publishing|quality",
      "insight": "A specific, actionable insight based on multiple reflections",
      "source_reflections": ["ref_id1", "ref_id2"],
      "strength": 0.6
    }
  ],
  "strengthen_insights": [
    {
      "insight_id": "existing insight ID",
      "delta": 0.1,
      "reason": "why this insight is being reinforced"
    }
  ],
  "weaken_insights": [
    {
      "insight_id": "existing insight ID",
      "delta": -0.05,
      "reason": "why this insight is being weakened"
    }
  ],
  "promote_to_principles": ["insight_id that should become a principle"]
}

Guidelines:
- Only create new insights if they appear in 2+ reflections
- Insights should be specific and actionable, not vague observations
- Strengthen insights that are consistently validated
- Weaken insights that are contradicted or not useful
- Only promote to principle if insight has strength >= 0.75 and 5+ source reflections
- Never create insights that contradict core invariants`;

// Principle check prompt
const PRINCIPLE_CHECK_PROMPT = `You are validating a proposed principle against core invariants.

## Proposed Principle
{principle}

## Core Invariants
${CORE_INVARIANTS.map((inv, i) => `${i + 1}. ${inv}`).join('\n')}

Does this principle contradict any core invariant? Respond with JSON:
{
  "valid": true/false,
  "reason": "explanation if invalid"
}`;

export class Consolidator {
  private store: ReflectionStore;
  private anthropic: Anthropic;
  private config: LearningConfig;

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
   * Check if consolidation should run
   */
  shouldConsolidate(): boolean {
    const unconsolidated = this.store.getUnconsolidatedReflections();
    const lastConsolidation = this.store.getLastConsolidation();

    // Trigger if enough reflections accumulated
    if (unconsolidated.length >= this.config.consolidationReflectionCount) {
      return true;
    }

    // Trigger if enough time passed (even with fewer reflections)
    if (lastConsolidation) {
      const hoursSinceConsolidation =
        (Date.now() - lastConsolidation.getTime()) / (1000 * 60 * 60);
      if (
        hoursSinceConsolidation >= this.config.consolidationMaxHours &&
        unconsolidated.length >= 3
      ) {
        return true;
      }
    }

    return false;
  }

  /**
   * Run consolidation to generate insights from reflections
   */
  async consolidate(): Promise<ConsolidationResult> {
    const unconsolidated = this.store.getUnconsolidatedReflections();

    if (unconsolidated.length < 3) {
      logger.info('consolidation_skipped', { reason: 'Not enough reflections' });
      return {
        newInsights: [],
        strengthenInsights: [],
        weakenInsights: [],
        promoteToePrinciples: [],
      };
    }

    logger.info('consolidation_started', { reflectionCount: unconsolidated.length });

    // Get existing insights for context
    const existingInsights = this.store.getUnpromotedInsights();

    const prompt = this.buildConsolidationPrompt(unconsolidated, existingInsights);

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
        throw new Error('Unexpected response type from LLM');
      }

      const result = this.parseConsolidationResponse(content.text);

      // Apply the consolidation results
      await this.applyConsolidationResult(result, unconsolidated);

      // Update last consolidation time
      this.store.setLastConsolidation(new Date());

      logger.info('consolidation_completed', {
        newInsights: result.newInsights.length,
        strengthened: result.strengthenInsights.length,
        weakened: result.weakenInsights.length,
        promoted: result.promoteToePrinciples.length,
      });

      return result;
    } catch (error) {
      logger.error('consolidation_failed', { error: (error as Error).message });
      return {
        newInsights: [],
        strengthenInsights: [],
        weakenInsights: [],
        promoteToePrinciples: [],
      };
    }
  }

  /**
   * Force consolidation regardless of thresholds
   */
  async forceConsolidate(): Promise<ConsolidationResult> {
    return this.consolidate();
  }

  /**
   * Manually promote an insight to a principle
   */
  async promoteInsight(insightId: string): Promise<Principle | null> {
    const insight = this.store.getInsight(insightId);
    if (!insight) {
      logger.warn('promote_failed', { reason: 'Insight not found', insightId });
      return null;
    }

    // Validate against core invariants
    const isValid = await this.validateAgainstInvariants(insight.insight);
    if (!isValid) {
      logger.warn('promote_failed', {
        reason: 'Violates core invariants',
        insightId,
      });
      return null;
    }

    // Create principle
    const principle: Principle = {
      id: `prin_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      sourceInsightIds: [insightId],
      category: this.insightToPrincipleCategory(insight.category),
      principleText: insight.insight,
      weight: Math.min(insight.strength + 0.1, 1.0),
      active: true,
      validationCount: 0,
      invalidationCount: 0,
    };

    // Save principle
    this.store.savePrinciple(principle);

    // Mark insight as promoted
    this.store.markInsightPromoted(insightId);

    logger.info('insight_promoted', {
      insightId,
      principleId: principle.id,
      category: principle.category,
    });

    return principle;
  }

  /**
   * Run decay operations for stale insights and principles
   */
  runDecay(): { insightsDecayed: number; principlesDecayed: number } {
    const insightsDecayed = this.store.decayStaleInsights();
    const principlesDecayed = this.store.decayUnusedPrinciples();

    return { insightsDecayed, principlesDecayed };
  }

  /**
   * Run cleanup operations
   */
  runCleanup(): number {
    this.store.enforceRetentionLimits();
    return this.store.cleanupOldReflections();
  }

  /**
   * Build consolidation prompt
   */
  private buildConsolidationPrompt(
    reflections: Reflection[],
    existingInsights: Insight[]
  ): string {
    const reflectionSummaries = reflections.map((r) => {
      const patterns = r.patternObservations
        .map((p) => `  - ${p.pattern} (${p.frequency})`)
        .join('\n');
      const assessments = r.matchQualityAssessments
        .map((a) => `  - ${a.matchId}: ${a.qualityRating} - ${a.reasoning}`)
        .join('\n');

      return `
### ${r.id} (${r.trigger}, ${r.timestamp})
**Summary:** ${r.summary}
**Worked well:** ${r.whatWorkedWell.join(', ') || 'none noted'}
**Surprised:** ${r.whatSurprised.join(', ') || 'none noted'}
**Would change:** ${r.whatWouldDoDifferently.join(', ') || 'none noted'}
**Patterns:**
${patterns || '  none'}
**Match assessments:**
${assessments || '  none'}`;
    }).join('\n');

    const insightSummaries = existingInsights.length > 0
      ? existingInsights.map((i) =>
          `- ${i.id} [${i.category}] (strength: ${i.strength.toFixed(2)}): ${i.insight}`
        ).join('\n')
      : 'No existing insights yet';

    return CONSOLIDATION_PROMPT
      .replace('{reflection_count}', String(reflections.length))
      .replace('{reflections}', reflectionSummaries)
      .replace('{existing_insights}', insightSummaries);
  }

  /**
   * Parse consolidation response
   */
  private parseConsolidationResponse(text: string): ConsolidationResult {
    try {
      // Extract JSON from response
      let jsonText = text;
      const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonText = jsonMatch[1];
      }

      const parsed = JSON.parse(jsonText);

      return {
        newInsights: Array.isArray(parsed.new_insights)
          ? parsed.new_insights.map((i: Record<string, unknown>) => ({
              category: i.category as InsightCategory,
              insight: String(i.insight),
              sourceReflections: Array.isArray(i.source_reflections)
                ? i.source_reflections
                : [],
              strength: Number(i.strength) || 0.5,
            }))
          : [],
        strengthenInsights: Array.isArray(parsed.strengthen_insights)
          ? parsed.strengthen_insights.map((s: Record<string, unknown>) => ({
              insightId: String(s.insight_id),
              delta: Number(s.delta) || 0.05,
              reason: String(s.reason),
            }))
          : [],
        weakenInsights: Array.isArray(parsed.weaken_insights)
          ? parsed.weaken_insights.map((w: Record<string, unknown>) => ({
              insightId: String(w.insight_id),
              delta: Number(w.delta) || -0.05,
              reason: String(w.reason),
            }))
          : [],
        promoteToePrinciples: Array.isArray(parsed.promote_to_principles)
          ? parsed.promote_to_principles
          : [],
      };
    } catch (error) {
      logger.warn('consolidation_parse_failed', {
        error: (error as Error).message,
      });
      return {
        newInsights: [],
        strengthenInsights: [],
        weakenInsights: [],
        promoteToePrinciples: [],
      };
    }
  }

  /**
   * Apply consolidation results
   */
  private async applyConsolidationResult(
    result: ConsolidationResult,
    reflections: Reflection[]
  ): Promise<void> {
    // Create new insights
    for (const newInsight of result.newInsights) {
      const insight: Insight = {
        id: `ins_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        createdAt: new Date(),
        sourceReflectionIds: newInsight.sourceReflections,
        category: newInsight.category,
        insight: newInsight.insight,
        strength: newInsight.strength,
        actionTaken: false,
        promotedToPrinciple: false,
        lastReferenced: new Date(),
      };

      this.store.saveInsight(insight);

      // Mark source reflections as consolidated
      for (const refId of newInsight.sourceReflections) {
        this.store.markReflectionConsolidated(refId, insight.id);
      }

      logger.debug('insight_created', {
        id: insight.id,
        category: insight.category,
        sourceCount: newInsight.sourceReflections.length,
      });
    }

    // Strengthen existing insights
    for (const strengthen of result.strengthenInsights) {
      this.store.updateInsightStrength(strengthen.insightId, strengthen.delta);
      logger.debug('insight_strengthened', {
        insightId: strengthen.insightId,
        delta: strengthen.delta,
        reason: strengthen.reason,
      });
    }

    // Weaken existing insights
    for (const weaken of result.weakenInsights) {
      this.store.updateInsightStrength(weaken.insightId, weaken.delta);
      logger.debug('insight_weakened', {
        insightId: weaken.insightId,
        delta: weaken.delta,
        reason: weaken.reason,
      });
    }

    // Promote to principles
    for (const insightId of result.promoteToePrinciples) {
      await this.checkAndPromote(insightId);
    }

    // Mark remaining reflections as consolidated (even if not used directly)
    const consolidationMarker = `consolidated_${Date.now()}`;
    for (const reflection of reflections) {
      if (!reflection.consolidatedInto) {
        this.store.markReflectionConsolidated(reflection.id, consolidationMarker);
      }
    }
  }

  /**
   * Check if insight qualifies for promotion and promote if so
   */
  private async checkAndPromote(insightId: string): Promise<void> {
    const insight = this.store.getInsight(insightId);
    if (!insight) return;

    // Check promotion criteria
    if (insight.strength < this.config.principlePromotionMinStrength) {
      logger.debug('promotion_skipped', {
        insightId,
        reason: 'Strength too low',
        strength: insight.strength,
      });
      return;
    }

    if (insight.sourceReflectionIds.length < this.config.principlePromotionMinSources) {
      logger.debug('promotion_skipped', {
        insightId,
        reason: 'Not enough sources',
        sources: insight.sourceReflectionIds.length,
      });
      return;
    }

    const ageDays =
      (Date.now() - insight.createdAt.getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays < this.config.principlePromotionMinAgeDays) {
      logger.debug('promotion_skipped', {
        insightId,
        reason: 'Too new',
        ageDays,
      });
      return;
    }

    await this.promoteInsight(insightId);
  }

  /**
   * Validate principle against core invariants
   */
  private async validateAgainstInvariants(
    principleText: string
  ): Promise<boolean> {
    try {
      const prompt = PRINCIPLE_CHECK_PROMPT.replace('{principle}', principleText);

      const response = await this.anthropic.messages.create({
        model: 'claude-3-5-haiku-latest',
        max_tokens: 200,
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      });

      const content = response.content[0];
      if (content.type !== 'text') return true; // Default to valid on error

      const match = content.text.match(/\{[\s\S]*\}/);
      if (!match) return true;

      const result = JSON.parse(match[0]);
      if (!result.valid) {
        logger.warn('principle_invariant_violation', {
          principle: principleText,
          reason: result.reason,
        });
      }
      return result.valid;
    } catch (error) {
      logger.warn('invariant_check_failed', {
        error: (error as Error).message,
      });
      return true; // Default to valid on error
    }
  }

  /**
   * Map insight category to principle category
   */
  private insightToPrincipleCategory(category: InsightCategory): PrincipleCategory {
    switch (category) {
      case 'matching':
        return 'matching';
      case 'extraction':
        return 'extraction';
      case 'publishing':
        return 'publishing';
      case 'patterns':
      case 'quality':
      default:
        return 'general';
    }
  }

  /**
   * Get consolidation statistics
   */
  getStats(): {
    unconsolidatedReflections: number;
    totalInsights: number;
    activePrinciples: number;
    lastConsolidation: Date | null;
  } {
    return {
      unconsolidatedReflections: this.store.getUnconsolidatedReflections().length,
      totalInsights: this.store.getUnpromotedInsights().length,
      activePrinciples: this.store.getActivePrinciples().length,
      lastConsolidation: this.store.getLastConsolidation(),
    };
  }
}
