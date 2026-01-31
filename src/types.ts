/**
 * Core type definitions for The Matchmaker
 */

// ============================================================================
// Moltbook API Types
// ============================================================================

export interface MoltbookAgent {
  id: string;
  name: string;
  bio?: string;
  karma: number;
  created_at: string;
  base_model?: string;
}

export interface MoltbookPost {
  id: string;
  title: string;
  content: string;
  author_id: string;
  author_name: string;
  submolt: string;
  upvotes: number;
  comment_count: number;
  created_at: string;
  url?: string;
}

export interface MoltbookComment {
  id: string;
  content: string;
  author_id: string;
  author_name: string;
  post_id: string;
  parent_id?: string;
  upvotes: number;
  created_at: string;
}

export interface MoltbookRegistrationResponse {
  api_key: string;
  claim_url: string;
  verification_code: string;
}

// ============================================================================
// Agent Profile Types
// ============================================================================

export type BaseModel =
  | 'claude-opus'
  | 'claude-sonnet'
  | 'claude-haiku'
  | 'gemini-ultra'
  | 'gemini-pro'
  | 'gpt-4'
  | 'gpt-4o'
  | 'llama'
  | 'other'
  | 'unknown';

export type ResponseStyle = 'fast' | 'medium' | 'slow';
export type CommunicationStyle = 'formal' | 'casual' | 'technical';

export interface AgentProfile {
  id: string;
  name: string;
  baseModel: BaseModel;
  firstSeen: Date;
  lastActive: Date;
  postCount: number;
  commentCount: number;
  karma: number;
  responseStyle?: ResponseStyle;
  communicationStyle?: CommunicationStyle;
  collaborationCount: number;
  excluded: boolean;
}

// ============================================================================
// Capability Types
// ============================================================================

export type SignalType = 'demonstrates' | 'claims' | 'asks' | 'answers';

export interface CapabilitySignal {
  domain: string;
  signalType: SignalType;
  confidence: number;
  evidence: string;
  postId: string;
  postUrl?: string;
}

export interface Capability {
  id: number;
  agentId: string;
  domain: string;
  confidence: number;
  signalCount: number;
  demonstratesCount: number;
  claimsCount: number;
  answersCount: number;
  firstObserved: Date;
  lastObserved: Date;
}

export interface CapabilityGap {
  id: number;
  agentId: string;
  domain: string;
  postId: string;
  postUrl?: string;
  urgency: 'low' | 'normal' | 'high' | 'critical';
  status: 'open' | 'matched' | 'resolved' | 'expired';
  matchedTo?: string;
  createdAt: Date;
  resolvedAt?: Date;
}

// ============================================================================
// Match Types
// ============================================================================

export type MatchType = 'capability_gap' | 'shared_interest' | 'complementary_styles';

export interface MatchScores {
  capabilityFit: number;
  mutualBenefit: number;
  styleCompatibility: number;
  availability: number;
  novelty: number;
}

export interface Match {
  id: string;
  seekerId: string;
  helperId: string;
  gapId?: number;
  capabilityDomain: string;
  matchType: MatchType;
  confidence: number;
  rationale: string;
  scores: MatchScores;
  postId?: string;
  postUrl?: string;
  publishedAt?: Date;
  accepted?: boolean;
  collaborationOccurred?: boolean;
  satisfactionScore?: number;
  outcomeNotes?: string;
  createdAt: Date;
}

export interface MatchCandidate {
  agent: AgentProfile;
  capability: Capability;
  scores: MatchScores;
  totalScore: number;
  rationale: string;
}

// ============================================================================
// Publishing Types
// ============================================================================

export enum Priority {
  CRITICAL = 1,
  HIGH = 2,
  MEDIUM = 3,
  LOW = 4,
}

export type QueueItemType = 'post' | 'comment';
export type QueueStatus = 'pending' | 'published' | 'expired' | 'failed';

export interface QueueItem {
  id: number;
  itemType: QueueItemType;
  priority: Priority;
  matchId?: string;
  templateId: string;
  templateData: Record<string, unknown>;
  targetPostId?: string;
  scheduledFor?: Date;
  expiresAt?: Date;
  status: QueueStatus;
  attempts: number;
  lastAttempt?: Date;
  errorMessage?: string;
  createdAt: Date;
}

export interface RateLimitStatus {
  postsRemaining: number;
  postRefillAt: Date;
  commentsRemaining: number;
  commentRefillAt: Date;
}

// ============================================================================
// Template Types
// ============================================================================

export interface AgentVars {
  id: string;
  name: string;
  capabilities: string[];
  topCapability?: string;
  recentActivity?: string;
}

export interface MatchTemplateVars {
  seeker: AgentVars;
  helper: AgentVars;
  domain: string;
  confidence: number;
  confidencePercent: number;
  matchType: string;
  rationale: string;
  seekerNeed: string;
  helperEvidence: string;
}

export interface DigestTemplateVars {
  weekOf: string;
  matchesAttempted: number;
  matchesAccepted: number;
  acceptanceRate: number;
  collaborationsCompleted: number;
  topMatches: Array<{
    seeker: AgentVars;
    helper: AgentVars;
    domain: string;
    outcome: string;
  }>;
  underservedCapabilities: Array<{
    domain: string;
    requestCount: number;
    expertCount: number;
  }>;
  newPatterns: string[];
  newExperts: AgentVars[];
  focusArea?: string;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface MatchmakerConfig {
  moltbook: {
    apiKey: string;
    apiUrl: string;
  };
  anthropic: {
    apiKey: string;
  };
  database: {
    sqlitePath: string;
    chromaPath: string;
  };
  agent: {
    name: string;
    heartbeatIntervalMs: number;
  };
  matching: {
    minConfidence: number;
    maxMatchesPerCycle: number;
    weights: {
      capabilityFit: number;
      mutualBenefit: number;
      styleCompatibility: number;
      availability: number;
      novelty: number;
    };
  };
  rateLimits: {
    postsPer30Min: number;
    commentsPerHour: number;
  };
  targetSubmolts: string[];
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// ============================================================================
// Event Types
// ============================================================================

export type EventType =
  | 'post_observed'
  | 'capability_extracted'
  | 'gap_detected'
  | 'match_found'
  | 'match_published'
  | 'match_accepted'
  | 'collaboration_completed'
  | 'error';

export interface MatchmakerEvent {
  type: EventType;
  timestamp: Date;
  data: Record<string, unknown>;
}

// ============================================================================
// Utility Types
// ============================================================================

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface Result<T, E = Error> {
  success: boolean;
  data?: T;
  error?: E;
}
