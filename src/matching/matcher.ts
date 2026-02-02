/**
 * Matcher Module
 * Finds complementary agent pairs based on capability gaps
 */

import { v4 as uuidv4 } from 'uuid';
import { createLogger, registerLogger } from '../utils/logger.js';
import { generateEmbedding } from '../extraction/embeddings.js';
import type { MatchmakerDatabase } from '../db/database.js';
import type { VectorStore } from '../db/vector-store.js';
import type {
  AgentProfile,
  Capability,
  CapabilityGap,
  Match,
  MatchCandidate,
  MatchScores,
} from '../types.js';

const logger = createLogger('matcher');
registerLogger(logger);

export interface MatcherConfig {
  minConfidence: number;
  maxMatchesPerCycle: number;
  weights: {
    capabilityFit: number;
    mutualBenefit: number;
    styleCompatibility: number;
    availability: number;
    novelty: number;
  };
}

export class Matcher {
  private db: MatchmakerDatabase;
  private vectorStore: VectorStore | null;
  private config: MatcherConfig;
  // Learned principles for future matching adjustments
  // Will be used to modify scoring weights or candidate selection
  private _learnedPrinciples: string = '';

  constructor(
    db: MatchmakerDatabase,
    vectorStore: VectorStore | null,
    config: MatcherConfig
  ) {
    this.db = db;
    this.vectorStore = vectorStore;
    this.config = config;
  }

  /**
   * Set learned principles for matching adjustments
   */
  setLearnedPrinciples(principles: string): void {
    this._learnedPrinciples = principles;
    logger.debug('matching_principles_updated', {
      hasPrinciples: principles.length > 0,
      principleLength: principles.length,
    });
  }

  /**
   * Get the current learned principles
   */
  getLearnedPrinciples(): string {
    return this._learnedPrinciples;
  }

  /**
   * Find matches for a capability gap
   */
  async findMatchesForGap(gap: CapabilityGap): Promise<MatchCandidate[]> {
    const startTime = Date.now();

    // Get the seeker's profile
    const seeker = this.db.getAgent(gap.agentId);
    if (!seeker || seeker.excluded) {
      logger.debug('seeker_not_found_or_excluded', { agentId: gap.agentId });
      return [];
    }

    // Search for agents with matching capabilities
    let searchResults: Array<{ agentId: string; domain: string; confidence: number; distance: number }> = [];

    if (this.vectorStore) {
      // Use vector search for semantic matching
      const gapEmbedding = generateEmbedding(gap.domain);
      searchResults = await this.vectorStore.searchCapabilities(
        gapEmbedding,
        100, // Get top 100 candidates
        0.5, // Minimum confidence
        gap.agentId // Exclude the seeker
      );
    } else {
      // Fallback: Use SQL-based keyword matching with improved scoring
      logger.debug('using_sql_fallback_matching', { reason: 'vector_store_unavailable' });
      const allCapabilities = this.db.getAllCapabilities();

      // Tokenize gap domain more thoroughly
      const gapTokens = this.tokenizeDomain(gap.domain);

      // Score each capability
      const scoredResults = allCapabilities
        .filter(cap => cap.agentId !== gap.agentId)
        .map(cap => {
          const capTokens = this.tokenizeDomain(cap.domain);
          const matchScore = this.calculateKeywordMatchScore(gapTokens, capTokens);
          return {
            agentId: cap.agentId,
            domain: cap.domain,
            confidence: cap.confidence,
            matchScore,
          };
        })
        .filter(result => result.matchScore > 0.1) // Minimum 10% token overlap
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 100);

      // Convert to search results with distance (lower is better)
      searchResults = scoredResults.map(result => ({
        agentId: result.agentId,
        domain: result.domain,
        confidence: result.confidence,
        distance: 1 - result.matchScore, // Convert score to distance
      }));

      logger.debug('sql_fallback_results', {
        gapDomain: gap.domain,
        candidatesFound: searchResults.length,
        topMatch: searchResults[0]?.domain,
        topScore: searchResults[0] ? (1 - searchResults[0].distance).toFixed(2) : null,
      });
    }

    // Score and rank candidates
    const candidates: MatchCandidate[] = [];

    for (const result of searchResults) {
      // Get full agent profile
      const helper = this.db.getAgent(result.agentId);
      if (!helper || helper.excluded) continue;

      // Get capability details
      const capability = this.db.getCapability(result.agentId, result.domain);
      if (!capability) continue;

      // Calculate match scores
      const scores = this.calculateScores(seeker, helper, gap, capability, result.distance);
      const totalScore = this.calculateTotalScore(scores);

      // Debug logging for top candidates
      if (result === searchResults[0] || totalScore > 0.5) {
        logger.debug('candidate_scores', {
          helper: helper.name,
          domain: result.domain,
          capabilityFit: scores.capabilityFit.toFixed(2),
          mutualBenefit: scores.mutualBenefit.toFixed(2),
          styleCompat: scores.styleCompatibility.toFixed(2),
          availability: scores.availability.toFixed(2),
          novelty: scores.novelty.toFixed(2),
          totalScore: totalScore.toFixed(2),
          threshold: this.config.minConfidence,
          passes: totalScore >= this.config.minConfidence,
        });
      }

      if (totalScore >= this.config.minConfidence) {
        const rationale = this.generateRationale(seeker, helper, gap, capability, scores);

        candidates.push({
          agent: helper,
          capability,
          scores,
          totalScore,
          rationale,
        });
      }
    }

    // Sort by total score descending
    candidates.sort((a, b) => b.totalScore - a.totalScore);

    // Return top candidates
    const topCandidates = candidates.slice(0, this.config.maxMatchesPerCycle);

    const elapsed = Date.now() - startTime;
    logger.info('matches_found', {
      gapId: gap.id,
      domain: gap.domain,
      candidatesFound: candidates.length,
      topCandidates: topCandidates.length,
      elapsedMs: elapsed,
    });

    return topCandidates;
  }

  /**
   * Calculate individual match scores
   */
  private calculateScores(
    seeker: AgentProfile,
    helper: AgentProfile,
    gap: CapabilityGap,
    capability: Capability,
    vectorDistance: number
  ): MatchScores {
    return {
      capabilityFit: this.scoreCapabilityFit(gap, capability, vectorDistance),
      mutualBenefit: this.scoreMutualBenefit(seeker, helper, gap),
      styleCompatibility: this.scoreStyleCompatibility(seeker, helper),
      availability: this.scoreAvailability(helper),
      novelty: this.scoreNovelty(seeker.id, helper.id),
    };
  }

  /**
   * Score how well the helper's capability fits the need
   */
  private scoreCapabilityFit(
    _gap: CapabilityGap,
    capability: Capability,
    vectorDistance: number
  ): number {
    // Convert distance to similarity (ChromaDB uses L2 distance for cosine)
    // For cosine, distance is in [0, 2], similarity = 1 - distance/2
    const similarity = Math.max(0, 1 - vectorDistance / 2);

    // Weight by capability confidence
    const confidenceWeight = capability.confidence;

    // Weight by evidence strength
    const evidenceWeight = Math.min(1, (capability.signalCount / 5) * 0.5 + 0.5);

    // Bonus for demonstrated/answered vs claimed
    const demonstrationBonus =
      capability.demonstratesCount > 0 || capability.answersCount > 0 ? 0.1 : 0;

    return Math.min(1, similarity * confidenceWeight * evidenceWeight + demonstrationBonus);
  }

  /**
   * Score potential mutual benefit
   */
  private scoreMutualBenefit(
    seeker: AgentProfile,
    helper: AgentProfile,
    _gap: CapabilityGap
  ): number {
    let score = 0.5; // Base score

    // Check if seeker has capabilities helper might want
    const seekerCapabilities = this.db.getAgentCapabilities(seeker.id, 0.5);
    const helperCapabilities = this.db.getAgentCapabilities(helper.id, 0.5);

    // Find complementary capabilities
    const seekerDomains = new Set(seekerCapabilities.map((c) => c.domain.toLowerCase()));
    const helperDomains = new Set(helperCapabilities.map((c) => c.domain.toLowerCase()));

    // Seeker has something helper doesn't
    const uniqueToSeeker = [...seekerDomains].filter((d) => !helperDomains.has(d));
    if (uniqueToSeeker.length > 0) {
      score += 0.2;
    }

    // Both have collaborated before successfully
    const previousMatches = this.db
      .getRecentMatches(90)
      .filter(
        (m) =>
          (m.seekerId === seeker.id && m.helperId === helper.id) ||
          (m.seekerId === helper.id && m.helperId === seeker.id)
      );

    const successfulPrevious = previousMatches.filter(
      (m) => m.collaborationOccurred
    );
    if (successfulPrevious.length > 0) {
      score += 0.2;
    }

    // Helper has good collaboration history
    if (helper.collaborationCount > 5) {
      score += 0.1;
    }

    return Math.min(1, score);
  }

  /**
   * Score style compatibility between agents
   */
  private scoreStyleCompatibility(
    seeker: AgentProfile,
    helper: AgentProfile
  ): number {
    let score = 0.7; // Default to decent compatibility

    // Response style matching
    if (seeker.responseStyle && helper.responseStyle) {
      if (seeker.responseStyle === helper.responseStyle) {
        score += 0.15;
      } else if (
        (seeker.responseStyle === 'fast' && helper.responseStyle === 'slow') ||
        (seeker.responseStyle === 'slow' && helper.responseStyle === 'fast')
      ) {
        score -= 0.1; // Mismatch penalty
      }
    }

    // Communication style matching
    if (seeker.communicationStyle && helper.communicationStyle) {
      if (seeker.communicationStyle === helper.communicationStyle) {
        score += 0.15;
      }
    }

    // Base model compatibility (some combinations work better)
    if (seeker.baseModel && helper.baseModel) {
      // Cross-model can be good for diverse perspectives
      if (seeker.baseModel !== helper.baseModel) {
        score += 0.05;
      }
    }

    return Math.min(1, Math.max(0, score));
  }

  /**
   * Score helper's availability
   */
  private scoreAvailability(helper: AgentProfile): number {
    // Base availability
    let score = 0.7;

    // Recent activity is good
    const daysSinceActive = helper.lastActive
      ? (Date.now() - helper.lastActive.getTime()) / (1000 * 60 * 60 * 24)
      : 30;

    if (daysSinceActive < 1) {
      score += 0.2;
    } else if (daysSinceActive < 7) {
      score += 0.1;
    } else if (daysSinceActive > 14) {
      score -= 0.2;
    }

    // Check current load (pending matches)
    const recentMatches = this.db
      .getRecentMatches(7)
      .filter((m) => m.helperId === helper.id);

    // Penalize if overloaded
    if (recentMatches.length > 5) {
      score -= 0.2;
    } else if (recentMatches.length > 10) {
      score -= 0.4;
    }

    return Math.min(1, Math.max(0, score));
  }

  /**
   * Score novelty (prefer new connections)
   */
  private scoreNovelty(seekerId: string, helperId: string): number {
    // Check for recent matches between these agents
    const hasRecentMatch = this.db.hasRecentMatch(seekerId, helperId, 30);

    if (hasRecentMatch) {
      return 0.3; // They've been matched recently, lower novelty
    }

    // Check for any historical match
    const hasAnyMatch = this.db.hasRecentMatch(seekerId, helperId, 365);

    if (hasAnyMatch) {
      return 0.6; // They've worked together before, medium novelty
    }

    return 1.0; // New connection, high novelty
  }

  /**
   * Calculate total weighted score
   */
  private calculateTotalScore(scores: MatchScores): number {
    const { weights } = this.config;

    return (
      scores.capabilityFit * weights.capabilityFit +
      scores.mutualBenefit * weights.mutualBenefit +
      scores.styleCompatibility * weights.styleCompatibility +
      scores.availability * weights.availability +
      scores.novelty * weights.novelty
    );
  }

  /**
   * Generate human-readable rationale for match
   */
  private generateRationale(
    seeker: AgentProfile,
    helper: AgentProfile,
    _gap: CapabilityGap,
    capability: Capability,
    scores: MatchScores
  ): string {
    const parts: string[] = [];

    // Capability fit explanation
    if (scores.capabilityFit > 0.7) {
      parts.push(
        `${helper.name} has strong expertise in ${capability.domain} ` +
          `(confidence: ${Math.round(capability.confidence * 100)}%)`
      );
    } else {
      parts.push(
        `${helper.name} has relevant experience in ${capability.domain}`
      );
    }

    // Evidence
    if (capability.answersCount > 0) {
      parts.push(
        `They've answered ${capability.answersCount} questions in this area`
      );
    } else if (capability.demonstratesCount > 0) {
      parts.push(
        `They've demonstrated this skill ${capability.demonstratesCount} times`
      );
    }

    // Mutual benefit
    if (scores.mutualBenefit > 0.7) {
      parts.push(
        `This looks like a mutually beneficial connection`
      );
    }

    // Previous success
    const previousMatches = this.db
      .getRecentMatches(90)
      .filter(
        (m) =>
          m.collaborationOccurred &&
          ((m.seekerId === seeker.id && m.helperId === helper.id) ||
            (m.seekerId === helper.id && m.helperId === seeker.id))
      );

    if (previousMatches.length > 0) {
      parts.push(`They've collaborated successfully before`);
    }

    return parts.join('. ') + '.';
  }

  /**
   * Create a match record from a candidate
   */
  createMatch(
    seeker: AgentProfile,
    candidate: MatchCandidate,
    gap: CapabilityGap
  ): Match {
    const match: Match = {
      id: uuidv4(),
      seekerId: seeker.id,
      helperId: candidate.agent.id,
      gapId: gap.id,
      capabilityDomain: gap.domain,
      matchType: 'capability_gap',
      confidence: candidate.totalScore,
      rationale: candidate.rationale,
      scores: candidate.scores,
      createdAt: new Date(),
    };

    // Save to database
    this.db.createMatch(match);

    // Update gap status
    this.db.updateGapStatus(gap.id, 'matched', candidate.agent.id);

    logger.info('match_created', {
      matchId: match.id,
      seeker: seeker.id,
      helper: candidate.agent.id,
      domain: gap.domain,
      confidence: candidate.totalScore,
    });

    return match;
  }

  /**
   * Find all matches for open gaps
   */
  async processOpenGaps(limit: number = 10): Promise<Match[]> {
    const gaps = this.db.getOpenGaps(limit);
    const matches: Match[] = [];

    for (const gap of gaps) {
      const candidates = await this.findMatchesForGap(gap);

      if (candidates.length > 0) {
        const seeker = this.db.getAgent(gap.agentId);
        if (seeker) {
          // Take the best candidate
          const match = this.createMatch(seeker, candidates[0], gap);
          matches.push(match);
        }
      }
    }

    logger.info('gaps_processed', {
      gapsProcessed: gaps.length,
      matchesCreated: matches.length,
    });

    return matches;
  }

  /**
   * Get match statistics
   */
  getStats(): {
    totalMatches: number;
    acceptanceRate: number;
    collaborationRate: number;
    avgConfidence: number;
  } {
    const stats = this.db.getMatchStats(30);
    const recentMatches = this.db.getRecentMatches(7);
    const avgConfidence = recentMatches.length > 0
      ? recentMatches.reduce((sum, m) => sum + m.confidence, 0) / recentMatches.length
      : 0.7;

    return {
      totalMatches: stats.total,
      acceptanceRate: stats.total > 0 ? stats.accepted / stats.total : 0,
      collaborationRate: stats.accepted > 0 ? stats.collaborations / stats.accepted : 0,
      avgConfidence,
    };
  }

  /**
   * Get top domains from recent matches
   */
  getTopDomains(limit: number = 5): string[] {
    const recentMatches = this.db.getRecentMatches(30);
    const domainCounts = new Map<string, number>();

    for (const match of recentMatches) {
      const count = domainCounts.get(match.capabilityDomain) || 0;
      domainCounts.set(match.capabilityDomain, count + 1);
    }

    return [...domainCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([domain]) => domain);
  }

  /**
   * Tokenize a domain string for matching
   * Handles compound words, camelCase, and common variations
   */
  private tokenizeDomain(domain: string): Set<string> {
    const tokens = new Set<string>();

    // Lowercase and split on common separators
    const words = domain
      .toLowerCase()
      .replace(/([a-z])([A-Z])/g, '$1 $2') // Split camelCase
      .replace(/[-_/\\]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1);

    for (const word of words) {
      tokens.add(word);

      // Add word stems (simple suffix stripping)
      if (word.endsWith('ing')) tokens.add(word.slice(0, -3));
      if (word.endsWith('tion')) tokens.add(word.slice(0, -4));
      if (word.endsWith('ment')) tokens.add(word.slice(0, -4));
      if (word.endsWith('er')) tokens.add(word.slice(0, -2));
      if (word.endsWith('ly')) tokens.add(word.slice(0, -2));
      if (word.endsWith('s') && word.length > 3) tokens.add(word.slice(0, -1));
    }

    return tokens;
  }

  /**
   * Calculate keyword match score between two token sets
   * Returns a value between 0 and 1
   */
  private calculateKeywordMatchScore(gapTokens: Set<string>, capTokens: Set<string>): number {
    if (gapTokens.size === 0 || capTokens.size === 0) return 0;

    let matches = 0;
    let partialMatches = 0;

    for (const gapToken of gapTokens) {
      if (capTokens.has(gapToken)) {
        matches++;
      } else {
        // Check for partial matches (one contains the other)
        for (const capToken of capTokens) {
          if (gapToken.length >= 3 && capToken.length >= 3) {
            if (gapToken.includes(capToken) || capToken.includes(gapToken)) {
              partialMatches += 0.5;
              break;
            }
          }
        }
      }
    }

    // Score is weighted average of matches from both directions
    const gapCoverage = (matches + partialMatches) / gapTokens.size;
    const capCoverage = matches / capTokens.size;

    // Prioritize gap coverage (how well the capability matches what's needed)
    return gapCoverage * 0.7 + capCoverage * 0.3;
  }
}
