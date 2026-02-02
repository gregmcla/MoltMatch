/**
 * Learning System Types
 * Type definitions for SkillLinker's persistent learning and evolution system
 */

// ============================================================================
// Reflection Types
// ============================================================================

export type ReflectionTrigger =
  | 'notable_heartbeat'    // After heartbeat with notable events
  | 'significant_error'    // Major failure requiring analysis
  | 'milestone'            // Every N heartbeats regardless
  | 'consolidation_time'   // Scheduled consolidation window
  | 'manual';              // Explicit request

export interface NotabilityFactors {
  matchesCreated: number;
  highConfidenceMatches: number;    // confidence > 0.85
  lowConfidenceMatches: number;     // confidence < 0.6
  errors: string[];
  newDomainsSeen: string[];
  unusualPatterns: string[];
  longDuration: boolean;            // duration > 2x average
}

export interface PatternObservation {
  pattern: string;
  frequency: 'one-off' | 'recurring' | 'persistent';
  domain?: string;
  actionable: boolean;
  suggestedAction?: string;
}

export interface MatchAssessment {
  matchId: string;
  seekerDomain: string;
  helperDomain: string;
  confidenceScore: number;
  qualityRating: 'excellent' | 'good' | 'uncertain' | 'questionable';
  reasoning: string;
  improvementSuggestion?: string;
}

export interface ExtractionNote {
  postId: string;
  extractionQuality: 'accurate' | 'partial' | 'missed' | 'over-extracted';
  details: string;
  suggestedPromptTweak?: string;
}

export interface Reflection {
  id: string;
  timestamp: string;
  trigger: ReflectionTrigger;
  heartbeatId?: string;

  // Structured sections
  summary: string;
  whatWorkedWell: string[];
  whatSurprised: string[];
  whatWouldDoDifferently: string[];

  patternObservations: PatternObservation[];
  matchQualityAssessments: MatchAssessment[];
  extractionNotes: ExtractionNote[];

  // Meta
  confidence: number;
  tags: string[];

  // Lifecycle
  consolidatedInto?: string;
  createdAt: Date;
}

// ============================================================================
// Insight Types (Level 2 - Consolidated from Reflections)
// ============================================================================

export type InsightCategory = 'matching' | 'extraction' | 'patterns' | 'publishing' | 'quality';

export interface Insight {
  id: string;
  createdAt: Date;
  sourceReflectionIds: string[];
  category: InsightCategory;
  insight: string;
  strength: number;           // 0-1, how well-supported
  actionTaken: boolean;
  promotedToPrinciple: boolean;
  lastReferenced?: Date;
}

// ============================================================================
// Principle Types (Level 3 - Promoted from Insights)
// ============================================================================

export type PrincipleCategory = 'matching' | 'extraction' | 'publishing' | 'general';

export interface Principle {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  sourceInsightIds: string[];
  category: PrincipleCategory;
  principleText: string;
  weight: number;             // Importance weight for prompt injection
  active: boolean;
  validationCount: number;    // Times this principle proved useful
  invalidationCount: number;  // Times this principle was wrong
  lastValidated?: Date;
}

// ============================================================================
// Loaded Principles (for runtime use)
// ============================================================================

export interface LoadedPrinciples {
  matching: Principle[];
  extraction: Principle[];
  publishing: Principle[];
  general: Principle[];
}

// ============================================================================
// Reflection Context (gathered before reflection)
// ============================================================================

export interface ReflectionContext {
  matchConfidences: number[];
  matchDetails: Array<{
    id: string;
    seekerId: string;
    helperId: string;
    domain: string;
    confidence: number;
    rationale: string;
  }>;
  newDomainsCount: number;
  avgConfidenceLast7Days: number;
  acceptanceRateLast30Days: number;
  topDomains: string[];
  recentErrors: string[];
}

// ============================================================================
// Consolidation Types
// ============================================================================

export interface ConsolidationResult {
  newInsights: Array<{
    category: InsightCategory;
    insight: string;
    sourceReflections: string[];
    strength: number;
  }>;
  strengthenInsights: Array<{
    insightId: string;
    delta: number;
    reason: string;
  }>;
  weakenInsights: Array<{
    insightId: string;
    delta: number;
    reason: string;
  }>;
  promoteToePrinciples: string[];
}

// ============================================================================
// Configuration
// ============================================================================

export interface LearningConfig {
  enabled: boolean;
  notabilityThreshold: number;        // Default: 40
  milestoneInterval: number;          // Default: 10 (reflect every N heartbeats)
  consolidationReflectionCount: number; // Default: 10
  consolidationMaxHours: number;      // Default: 24
  principlePromotionMinStrength: number; // Default: 0.75
  principlePromotionMinSources: number;  // Default: 5
  principlePromotionMinAgeDays: number;  // Default: 3
  maxPrinciplesPerCategory: number;   // Default: 5
  decayInsightDays: number;           // Default: 14
  decayPrincipleDays: number;         // Default: 30
  retentionReflectionDays: number;    // Default: 90
  retentionInsightDays: number;       // Default: 180
  maxReflections: number;             // Default: 500
  maxInsights: number;                // Default: 200
  maxPrinciples: number;              // Default: 50
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  enabled: true,
  notabilityThreshold: 40,
  milestoneInterval: 10,
  consolidationReflectionCount: 10,
  consolidationMaxHours: 24,
  principlePromotionMinStrength: 0.75,
  principlePromotionMinSources: 5,
  principlePromotionMinAgeDays: 3,
  maxPrinciplesPerCategory: 5,
  decayInsightDays: 14,
  decayPrincipleDays: 30,
  retentionReflectionDays: 90,
  retentionInsightDays: 180,
  maxReflections: 500,
  maxInsights: 200,
  maxPrinciples: 50,
};

// ============================================================================
// Core Invariants (cannot be overridden by learned principles)
// ============================================================================

export const CORE_INVARIANTS = [
  'Always respect [EXCLUDE ME] requests immediately',
  'Never match an agent with themselves',
  'Never expose private capability data publicly',
  'Match confidence must be between 0 and 1',
  'Rate limits must be respected',
  'Never send API keys to domains other than www.moltbook.com',
];
