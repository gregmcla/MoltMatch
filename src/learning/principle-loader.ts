/**
 * Principle Loader Module
 * Loads active principles at startup and formats them for prompt injection
 */

import { createLogger, registerLogger } from '../utils/logger.js';
import type { ReflectionStore } from './reflection-store.js';
import {
  CORE_INVARIANTS,
  type Principle,
  type PrincipleCategory,
  type LoadedPrinciples,
} from './types.js';

const logger = createLogger('principle-loader');
registerLogger(logger);

export class PrincipleLoader {
  private store: ReflectionStore;
  private loadedPrinciples: LoadedPrinciples | null = null;
  private lastLoadTime: Date | null = null;
  private cacheValidityMs: number = 5 * 60 * 1000; // 5 minutes

  constructor(store: ReflectionStore) {
    this.store = store;
  }

  /**
   * Load all active principles from the store
   */
  loadActivePrinciples(): LoadedPrinciples {
    const matching = this.store.getActivePrinciplesByCategory('matching');
    const extraction = this.store.getActivePrinciplesByCategory('extraction');
    const publishing = this.store.getActivePrinciplesByCategory('publishing');
    const general = this.store.getActivePrinciplesByCategory('general');

    this.loadedPrinciples = { matching, extraction, publishing, general };
    this.lastLoadTime = new Date();

    const totalCount = matching.length + extraction.length + publishing.length + general.length;
    logger.info('principles_loaded', {
      matching: matching.length,
      extraction: extraction.length,
      publishing: publishing.length,
      general: general.length,
      total: totalCount,
    });

    return this.loadedPrinciples;
  }

  /**
   * Get cached principles or reload if stale
   */
  getPrinciples(): LoadedPrinciples {
    if (
      !this.loadedPrinciples ||
      !this.lastLoadTime ||
      Date.now() - this.lastLoadTime.getTime() > this.cacheValidityMs
    ) {
      return this.loadActivePrinciples();
    }
    return this.loadedPrinciples;
  }

  /**
   * Generate prompt injection text for a specific category
   */
  generatePromptInjection(category: PrincipleCategory): string {
    const principles = this.getPrinciples();
    const categoryPrinciples = principles[category];

    if (categoryPrinciples.length === 0) {
      return '';
    }

    const lines = categoryPrinciples
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5) // Max 5 principles per category
      .map((p, i) => `${i + 1}. ${p.principleText} (confidence: ${(p.weight * 100).toFixed(0)}%)`);

    return `\n## Learned Principles (${category})\nBased on past experience:\n${lines.join('\n')}\n`;
  }

  /**
   * Generate combined prompt injection for multiple categories
   */
  generateCombinedPromptInjection(categories: PrincipleCategory[]): string {
    const sections = categories
      .map((cat) => this.generatePromptInjection(cat))
      .filter((s) => s.length > 0);

    if (sections.length === 0) {
      return '';
    }

    return sections.join('\n');
  }

  /**
   * Generate extraction-specific principles injection
   */
  generateExtractionPrinciples(): string {
    return this.generateCombinedPromptInjection(['extraction', 'general']);
  }

  /**
   * Generate matching-specific principles injection
   */
  generateMatchingPrinciples(): string {
    return this.generateCombinedPromptInjection(['matching', 'general']);
  }

  /**
   * Generate publishing-specific principles injection
   */
  generatePublishingPrinciples(): string {
    return this.generateCombinedPromptInjection(['publishing', 'general']);
  }

  /**
   * Generate all principles as a summary for reflection prompts
   */
  generateAllPrinciplesSummary(): string {
    const principles = this.getPrinciples();
    const all = [
      ...principles.matching,
      ...principles.extraction,
      ...principles.publishing,
      ...principles.general,
    ];

    if (all.length === 0) {
      return 'No learned principles yet.';
    }

    // Group by category
    const byCategory: Record<string, Principle[]> = {
      matching: principles.matching,
      extraction: principles.extraction,
      publishing: principles.publishing,
      general: principles.general,
    };

    const sections: string[] = [];

    for (const [category, catPrinciples] of Object.entries(byCategory)) {
      if (catPrinciples.length === 0) continue;

      const lines = catPrinciples
        .sort((a, b) => b.weight - a.weight)
        .map(
          (p) =>
            `  - ${p.principleText} (weight: ${p.weight.toFixed(2)}, validated: ${p.validationCount}x)`
        );

      sections.push(`### ${category.charAt(0).toUpperCase() + category.slice(1)}\n${lines.join('\n')}`);
    }

    return sections.join('\n\n');
  }

  /**
   * Get core invariants (always included, never learned)
   */
  getCoreInvariants(): string[] {
    return [...CORE_INVARIANTS];
  }

  /**
   * Generate core invariants for prompt injection
   */
  generateCoreInvariantsInjection(): string {
    return `\n## Core Rules (Non-negotiable)\n${CORE_INVARIANTS.map((inv, i) => `${i + 1}. ${inv}`).join('\n')}\n`;
  }

  /**
   * Validate that a set of actions doesn't violate core invariants
   * Returns list of violated invariants (empty if valid)
   */
  checkAgainstCoreInvariants(actions: string[]): string[] {
    const violations: string[] = [];
    const actionsLower = actions.map((a) => a.toLowerCase()).join(' ');

    // Check each invariant
    if (actionsLower.includes('ignore') && actionsLower.includes('exclude')) {
      violations.push(CORE_INVARIANTS[0]); // Respect exclusions
    }

    if (actionsLower.includes('self') && actionsLower.includes('match')) {
      violations.push(CORE_INVARIANTS[1]); // No self-matching
    }

    if (actionsLower.includes('expose') && actionsLower.includes('private')) {
      violations.push(CORE_INVARIANTS[2]); // No exposing private data
    }

    // Rate limits check would need numeric context

    return violations;
  }

  /**
   * Record that a principle was used/validated
   */
  recordPrincipleUsed(principleId: string, wasHelpful: boolean): void {
    if (wasHelpful) {
      this.store.validatePrinciple(principleId);
    } else {
      this.store.invalidatePrinciple(principleId);
    }

    // Invalidate cache
    this.loadedPrinciples = null;
  }

  /**
   * Get statistics about loaded principles
   */
  getStats(): {
    matching: number;
    extraction: number;
    publishing: number;
    general: number;
    total: number;
    cacheAge: number | null;
  } {
    const principles = this.getPrinciples();
    return {
      matching: principles.matching.length,
      extraction: principles.extraction.length,
      publishing: principles.publishing.length,
      general: principles.general.length,
      total:
        principles.matching.length +
        principles.extraction.length +
        principles.publishing.length +
        principles.general.length,
      cacheAge: this.lastLoadTime
        ? Date.now() - this.lastLoadTime.getTime()
        : null,
    };
  }

  /**
   * Force reload principles (invalidate cache)
   */
  reload(): LoadedPrinciples {
    this.loadedPrinciples = null;
    this.lastLoadTime = null;
    return this.loadActivePrinciples();
  }
}
