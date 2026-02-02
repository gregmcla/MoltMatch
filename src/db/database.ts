/**
 * SQLite database wrapper for The Matchmaker
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createLogger, registerLogger } from '../utils/logger.js';
import type {
  AgentProfile,
  Capability,
  CapabilityGap,
  CapabilitySignal,
  Match,
  QueueItem,
  Priority,
  QueueStatus,
} from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = createLogger('db');
registerLogger(logger);

export class MatchmakerDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    logger.info('database_opened', { path: dbPath });

    // Apply schema immediately so all tables are available
    this.applySchema();
  }

  /**
   * Apply database schema
   */
  private applySchema(): void {
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    this.db.exec(schema);
    logger.info('schema_applied');
  }

  /**
   * Initialize database (for backwards compatibility)
   */
  initialize(): void {
    // Schema is now applied in constructor, but keep this method
    // for any future initialization needs
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
    logger.info('database_closed');
  }

  // ==========================================================================
  // Agent Operations
  // ==========================================================================

  getAgent(id: string): AgentProfile | null {
    const row = this.db
      .prepare(
        `SELECT id, name, base_model, first_seen, last_active, post_count,
                comment_count, karma, response_style, communication_style,
                collaboration_count, excluded
         FROM agents WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToAgentProfile(row);
  }

  upsertAgent(agent: Partial<AgentProfile> & { id: string; name: string }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO agents (id, name, base_model, first_seen, last_active, karma)
           VALUES (@id, @name, @baseModel, @firstSeen, @lastActive, @karma)
           ON CONFLICT(id) DO UPDATE SET
             name = COALESCE(@name, name),
             base_model = COALESCE(@baseModel, base_model),
             last_active = COALESCE(@lastActive, last_active),
             karma = COALESCE(@karma, karma)`
        )
        .run({
          id: agent.id,
          name: agent.name,
          baseModel: agent.baseModel || 'unknown',
          firstSeen: agent.firstSeen?.toISOString() || new Date().toISOString(),
          lastActive: agent.lastActive?.toISOString() || new Date().toISOString(),
          karma: agent.karma || 0,
        });
    } catch (error) {
      logger.error('upsertAgent_failed', { agent, error: (error as Error).message });
      throw error;
    }
  }

  incrementAgentPostCount(agentId: string): void {
    try {
      this.db
        .prepare('UPDATE agents SET post_count = post_count + 1 WHERE id = ?')
        .run(agentId);
    } catch (error) {
      logger.error('incrementAgentPostCount_failed', { agentId, error: (error as Error).message });
      throw error;
    }
  }

  incrementAgentCommentCount(agentId: string): void {
    this.db
      .prepare('UPDATE agents SET comment_count = comment_count + 1 WHERE id = ?')
      .run(agentId);
  }

  setAgentExcluded(agentId: string, excluded: boolean): void {
    this.db
      .prepare('UPDATE agents SET excluded = ? WHERE id = ?')
      .run(excluded ? 1 : 0, agentId);
  }

  getActiveAgents(sinceDays: number = 7): AgentProfile[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, base_model, first_seen, last_active, post_count,
                comment_count, karma, response_style, communication_style,
                collaboration_count, excluded
         FROM agents
         WHERE excluded = 0
           AND last_active > datetime('now', '-' || ? || ' days')
         ORDER BY last_active DESC`
      )
      .all(sinceDays) as Record<string, unknown>[];

    return rows.map((row) => this.rowToAgentProfile(row));
  }

  // ==========================================================================
  // Capability Operations
  // ==========================================================================

  getCapability(agentId: string, domain: string): Capability | null {
    const row = this.db
      .prepare(
        `SELECT id, agent_id, domain, confidence, signal_count,
                demonstrates_count, claims_count, answers_count,
                first_observed, last_observed
         FROM capabilities
         WHERE agent_id = ? AND domain = ?`
      )
      .get(agentId, domain) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToCapability(row);
  }

  getAgentCapabilities(agentId: string, minConfidence: number = 0): Capability[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, domain, confidence, signal_count,
                demonstrates_count, claims_count, answers_count,
                first_observed, last_observed
         FROM capabilities
         WHERE agent_id = ? AND confidence >= ?
         ORDER BY confidence DESC`
      )
      .all(agentId, minConfidence) as Record<string, unknown>[];

    return rows.map((row) => this.rowToCapability(row));
  }

  getAllCapabilities(minConfidence: number = 0.5): Capability[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, domain, confidence, signal_count,
                demonstrates_count, claims_count, answers_count,
                first_observed, last_observed
         FROM capabilities
         WHERE confidence >= ?
         ORDER BY confidence DESC
         LIMIT 1000`
      )
      .all(minConfidence) as Record<string, unknown>[];

    return rows.map((row) => this.rowToCapability(row));
  }

  upsertCapability(signal: CapabilitySignal, agentId: string): number {
    try {
      const existing = this.getCapability(agentId, signal.domain);

      if (existing) {
        // Update existing capability
        const newConfidence = this.calculateNewConfidence(existing, signal);
        const incrementColumn = this.getSignalTypeColumn(signal.signalType);

        this.db
          .prepare(
            `UPDATE capabilities
             SET confidence = ?,
                 signal_count = signal_count + 1,
                 ${incrementColumn} = ${incrementColumn} + 1,
                 last_observed = CURRENT_TIMESTAMP
             WHERE id = ?`
          )
          .run(newConfidence, existing.id);

        return existing.id;
      } else {
        // Insert new capability
        const result = this.db
          .prepare(
            `INSERT INTO capabilities (agent_id, domain, confidence, signal_count,
                                       demonstrates_count, claims_count, answers_count,
                                       first_observed, last_observed)
             VALUES (?, ?, ?, 1, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
          )
          .run(
            agentId,
            signal.domain,
            signal.confidence,
            signal.signalType === 'demonstrates' ? 1 : 0,
            signal.signalType === 'claims' ? 1 : 0,
            signal.signalType === 'answers' ? 1 : 0
          );

        return Number(result.lastInsertRowid);
      }
    } catch (error) {
      logger.error('upsertCapability_failed', { signal, agentId, error: (error as Error).message });
      throw error;
    }
  }

  addCapabilityEvidence(
    capabilityId: number,
    postId: string,
    signalType: string,
    evidence: string,
    postUrl?: string,
    upvotes: number = 0
  ): void {
    try {
      this.db
        .prepare(
          `INSERT INTO capability_evidence (capability_id, post_id, post_url, signal_type, evidence_text, upvotes)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(capabilityId, postId, postUrl || null, signalType, evidence, upvotes);
    } catch (error) {
      logger.error('addCapabilityEvidence_failed', { 
        capabilityId, postId, signalType, evidence, postUrl, upvotes,
        error: (error as Error).message 
      });
      throw error;
    }
  }

  findAgentsWithCapability(domain: string, minConfidence: number = 0.5, limit: number = 100): Array<{
    agent: AgentProfile;
    capability: Capability;
  }> {
    const rows = this.db
      .prepare(
        `SELECT a.id, a.name, a.base_model, a.first_seen, a.last_active, a.post_count,
                a.comment_count, a.karma, a.response_style, a.communication_style,
                a.collaboration_count, a.excluded,
                c.id as cap_id, c.domain, c.confidence, c.signal_count,
                c.demonstrates_count, c.claims_count, c.answers_count,
                c.first_observed, c.last_observed
         FROM capabilities c
         JOIN agents a ON c.agent_id = a.id
         WHERE c.domain LIKE ?
           AND c.confidence >= ?
           AND a.excluded = 0
         ORDER BY c.confidence DESC
         LIMIT ?`
      )
      .all(`%${domain}%`, minConfidence, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      agent: this.rowToAgentProfile(row),
      capability: {
        id: row.cap_id as number,
        agentId: row.id as string,
        domain: row.domain as string,
        confidence: row.confidence as number,
        signalCount: row.signal_count as number,
        demonstratesCount: row.demonstrates_count as number,
        claimsCount: row.claims_count as number,
        answersCount: row.answers_count as number,
        firstObserved: new Date(row.first_observed as string),
        lastObserved: new Date(row.last_observed as string),
      },
    }));
  }

  decayOldCapabilities(daysOld: number = 30, decayFactor: number = 0.9): number {
    const result = this.db
      .prepare(
        `UPDATE capabilities
         SET confidence = confidence * ?
         WHERE last_observed < datetime('now', '-' || ? || ' days')`
      )
      .run(decayFactor, daysOld);

    return result.changes;
  }

  // ==========================================================================
  // Capability Gap Operations
  // ==========================================================================

  createGap(gap: Omit<CapabilityGap, 'id' | 'createdAt'>): number {
    try {
      const result = this.db
        .prepare(
          `INSERT INTO capability_gaps (agent_id, domain, post_id, post_url, urgency, status)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          gap.agentId,
          gap.domain,
          gap.postId,
          gap.postUrl || null,
          gap.urgency,
          gap.status
        );

      return Number(result.lastInsertRowid);
    } catch (error) {
      logger.error('createGap_failed', { gap, error: (error as Error).message });
      throw error;
    }
  }

  getOpenGaps(limit: number = 100): CapabilityGap[] {
    const rows = this.db
      .prepare(
        `SELECT id, agent_id, domain, post_id, post_url, urgency, status,
                matched_to, created_at, resolved_at
         FROM capability_gaps
         WHERE status = 'open'
         ORDER BY
           CASE urgency
             WHEN 'critical' THEN 1
             WHEN 'high' THEN 2
             WHEN 'normal' THEN 3
             WHEN 'low' THEN 4
           END,
           created_at ASC
         LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[];

    return rows.map((row) => this.rowToCapabilityGap(row));
  }

  updateGapStatus(
    gapId: number,
    status: CapabilityGap['status'],
    matchedTo?: string
  ): void {
    this.db
      .prepare(
        `UPDATE capability_gaps
         SET status = ?,
             matched_to = ?,
             resolved_at = CASE WHEN ? IN ('resolved', 'expired') THEN CURRENT_TIMESTAMP ELSE NULL END
         WHERE id = ?`
      )
      .run(status, matchedTo || null, status, gapId);
  }

  // ==========================================================================
  // Match Operations
  // ==========================================================================

  createMatch(match: Omit<Match, 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO matches (id, seeker_id, helper_id, gap_id, capability_domain,
                              match_type, confidence, rationale,
                              score_capability_fit, score_mutual_benefit,
                              score_style_compatibility, score_availability, score_novelty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        match.id,
        match.seekerId,
        match.helperId,
        match.gapId || null,
        match.capabilityDomain,
        match.matchType,
        match.confidence,
        match.rationale,
        match.scores.capabilityFit,
        match.scores.mutualBenefit,
        match.scores.styleCompatibility,
        match.scores.availability,
        match.scores.novelty
      );
  }

  getMatch(id: string): Match | null {
    const row = this.db
      .prepare(
        `SELECT * FROM matches WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToMatch(row);
  }

  updateMatchPublished(matchId: string, postId: string, postUrl?: string): void {
    this.db
      .prepare(
        `UPDATE matches
         SET post_id = ?, post_url = ?, published_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      )
      .run(postId, postUrl || null, matchId);
  }

  updateMatchOutcome(
    matchId: string,
    accepted: boolean,
    collaborationOccurred?: boolean,
    satisfactionScore?: number,
    notes?: string
  ): void {
    this.db
      .prepare(
        `UPDATE matches
         SET accepted = ?,
             collaboration_occurred = ?,
             satisfaction_score = ?,
             outcome_notes = ?
         WHERE id = ?`
      )
      .run(
        accepted ? 1 : 0,
        collaborationOccurred ? 1 : 0,
        satisfactionScore || null,
        notes || null,
        matchId
      );
  }

  getRecentMatches(days: number = 7): Match[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM matches
         WHERE created_at > datetime('now', '-' || ? || ' days')
         ORDER BY created_at DESC`
      )
      .all(days) as Record<string, unknown>[];

    return rows.map((row) => this.rowToMatch(row));
  }

  hasRecentMatch(seekerId: string, helperId: string, days: number = 30): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM matches
         WHERE ((seeker_id = ? AND helper_id = ?) OR (seeker_id = ? AND helper_id = ?))
           AND created_at > datetime('now', '-' || ? || ' days')
         LIMIT 1`
      )
      .get(seekerId, helperId, helperId, seekerId, days);

    return !!row;
  }

  getMatchStats(days: number = 7): {
    total: number;
    accepted: number;
    collaborations: number;
  } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) as accepted,
           SUM(CASE WHEN collaboration_occurred = 1 THEN 1 ELSE 0 END) as collaborations
         FROM matches
         WHERE created_at > datetime('now', '-' || ? || ' days')`
      )
      .get(days) as Record<string, number>;

    return {
      total: row.total || 0,
      accepted: row.accepted || 0,
      collaborations: row.collaborations || 0,
    };
  }

  // ==========================================================================
  // Processed Posts Operations
  // ==========================================================================

  isPostProcessed(postId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM processed_posts WHERE post_id = ?')
      .get(postId);

    return !!row;
  }

  markPostProcessed(
    postId: string,
    submolt: string,
    signalsExtracted: number,
    processingTimeMs: number
  ): void {
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO processed_posts (post_id, submolt, extracted_signals, processing_time_ms)
           VALUES (?, ?, ?, ?)`
        )
        .run(postId, submolt, signalsExtracted, processingTimeMs);
    } catch (error) {
      logger.error('markPostProcessed_failed', { 
        postId, submolt, signalsExtracted, processingTimeMs,
        error: (error as Error).message 
      });
      throw error;
    }
  }

  cleanOldProcessedPosts(days: number = 30): number {
    const result = this.db
      .prepare(
        `DELETE FROM processed_posts
         WHERE processed_at < datetime('now', '-' || ? || ' days')`
      )
      .run(days);

    return result.changes;
  }

  // ==========================================================================
  // Rate Limit State Operations
  // ==========================================================================

  getRateLimitState(): {
    postTokens: number;
    commentTokens: number;
    lastPostRefill: Date;
    lastCommentRefill: Date;
  } {
    const row = this.db
      .prepare('SELECT * FROM rate_limit_state WHERE id = 1')
      .get() as Record<string, unknown>;

    return {
      postTokens: row.post_tokens as number,
      commentTokens: row.comment_tokens as number,
      lastPostRefill: new Date(row.last_post_refill as string),
      lastCommentRefill: new Date(row.last_comment_refill as string),
    };
  }

  updateRateLimitState(
    postTokens: number,
    commentTokens: number,
    lastPostRefill: Date,
    lastCommentRefill: Date
  ): void {
    this.db
      .prepare(
        `UPDATE rate_limit_state
         SET post_tokens = ?,
             comment_tokens = ?,
             last_post_refill = ?,
             last_comment_refill = ?
         WHERE id = 1`
      )
      .run(
        postTokens,
        commentTokens,
        lastPostRefill.toISOString(),
        lastCommentRefill.toISOString()
      );
  }

  // ==========================================================================
  // Publish Queue Operations
  // ==========================================================================

  enqueue(item: Omit<QueueItem, 'id' | 'createdAt' | 'status' | 'attempts'>): number {
    const result = this.db
      .prepare(
        `INSERT INTO publish_queue (item_type, priority, match_id, template_id, template_data,
                                    target_post_id, scheduled_for, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.itemType,
        item.priority,
        item.matchId || null,
        item.templateId,
        JSON.stringify(item.templateData),
        item.targetPostId || null,
        item.scheduledFor?.toISOString() || null,
        item.expiresAt?.toISOString() || null
      );

    return Number(result.lastInsertRowid);
  }

  getNextQueueItem(): QueueItem | null {
    const row = this.db
      .prepare(
        `SELECT * FROM publish_queue
         WHERE status = 'pending'
           AND (scheduled_for IS NULL OR scheduled_for <= CURRENT_TIMESTAMP)
           AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
         ORDER BY priority ASC, created_at ASC
         LIMIT 1`
      )
      .get() as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToQueueItem(row);
  }

  updateQueueItemStatus(
    id: number,
    status: QueueStatus,
    errorMessage?: string
  ): void {
    this.db
      .prepare(
        `UPDATE publish_queue
         SET status = ?,
             attempts = attempts + 1,
             last_attempt = CURRENT_TIMESTAMP,
             error_message = ?
         WHERE id = ?`
      )
      .run(status, errorMessage || null, id);
  }

  expireOldQueueItems(): number {
    const result = this.db
      .prepare(
        `UPDATE publish_queue
         SET status = 'expired'
         WHERE status = 'pending'
           AND expires_at IS NOT NULL
           AND expires_at <= CURRENT_TIMESTAMP`
      )
      .run();

    return result.changes;
  }

  cleanOldQueueItems(days: number = 7): number {
    const result = this.db
      .prepare(
        `DELETE FROM publish_queue
         WHERE status IN ('published', 'expired', 'failed')
           AND created_at < datetime('now', '-' || ? || ' days')`
      )
      .run(days);

    return result.changes;
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private rowToAgentProfile(row: Record<string, unknown>): AgentProfile {
    return {
      id: row.id as string,
      name: row.name as string,
      baseModel: (row.base_model as AgentProfile['baseModel']) || 'unknown',
      firstSeen: new Date(row.first_seen as string),
      lastActive: row.last_active ? new Date(row.last_active as string) : new Date(),
      postCount: row.post_count as number,
      commentCount: row.comment_count as number,
      karma: row.karma as number,
      responseStyle: row.response_style as AgentProfile['responseStyle'],
      communicationStyle: row.communication_style as AgentProfile['communicationStyle'],
      collaborationCount: row.collaboration_count as number,
      excluded: Boolean(row.excluded),
    };
  }

  private rowToCapability(row: Record<string, unknown>): Capability {
    return {
      id: row.id as number,
      agentId: row.agent_id as string,
      domain: row.domain as string,
      confidence: row.confidence as number,
      signalCount: row.signal_count as number,
      demonstratesCount: row.demonstrates_count as number,
      claimsCount: row.claims_count as number,
      answersCount: row.answers_count as number,
      firstObserved: new Date(row.first_observed as string),
      lastObserved: new Date(row.last_observed as string),
    };
  }

  private rowToCapabilityGap(row: Record<string, unknown>): CapabilityGap {
    return {
      id: row.id as number,
      agentId: row.agent_id as string,
      domain: row.domain as string,
      postId: row.post_id as string,
      postUrl: row.post_url as string | undefined,
      urgency: row.urgency as CapabilityGap['urgency'],
      status: row.status as CapabilityGap['status'],
      matchedTo: row.matched_to as string | undefined,
      createdAt: new Date(row.created_at as string),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : undefined,
    };
  }

  private rowToMatch(row: Record<string, unknown>): Match {
    return {
      id: row.id as string,
      seekerId: row.seeker_id as string,
      helperId: row.helper_id as string,
      gapId: row.gap_id as number | undefined,
      capabilityDomain: row.capability_domain as string,
      matchType: row.match_type as Match['matchType'],
      confidence: row.confidence as number,
      rationale: row.rationale as string,
      scores: {
        capabilityFit: row.score_capability_fit as number,
        mutualBenefit: row.score_mutual_benefit as number,
        styleCompatibility: row.score_style_compatibility as number,
        availability: row.score_availability as number,
        novelty: row.score_novelty as number,
      },
      postId: row.post_id as string | undefined,
      postUrl: row.post_url as string | undefined,
      publishedAt: row.published_at ? new Date(row.published_at as string) : undefined,
      accepted: row.accepted === null ? undefined : Boolean(row.accepted),
      collaborationOccurred: row.collaboration_occurred === null ? undefined : Boolean(row.collaboration_occurred),
      satisfactionScore: row.satisfaction_score as number | undefined,
      outcomeNotes: row.outcome_notes as string | undefined,
      createdAt: new Date(row.created_at as string),
    };
  }

  private rowToQueueItem(row: Record<string, unknown>): QueueItem {
    return {
      id: row.id as number,
      itemType: row.item_type as QueueItem['itemType'],
      priority: row.priority as Priority,
      matchId: row.match_id as string | undefined,
      templateId: row.template_id as string,
      templateData: JSON.parse(row.template_data as string),
      targetPostId: row.target_post_id as string | undefined,
      scheduledFor: row.scheduled_for ? new Date(row.scheduled_for as string) : undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at as string) : undefined,
      status: row.status as QueueStatus,
      attempts: row.attempts as number,
      lastAttempt: row.last_attempt ? new Date(row.last_attempt as string) : undefined,
      errorMessage: row.error_message as string | undefined,
      createdAt: new Date(row.created_at as string),
    };
  }

  private calculateNewConfidence(existing: Capability, signal: CapabilitySignal): number {
    // Base confidence from signal type
    const signalWeight = {
      demonstrates: 0.15,
      answers: 0.2,
      claims: 0.05,
      asks: 0, // Asks don't increase capability confidence
    }[signal.signalType];

    // Diminishing returns for more signals
    const diminishingFactor = 1 / Math.sqrt(existing.signalCount + 1);

    // Calculate new confidence, capped at 0.95
    const newConfidence = Math.min(
      0.95,
      existing.confidence + signalWeight * diminishingFactor
    );

    return newConfidence;
  }

  private getSignalTypeColumn(signalType: string): string {
    const columns: Record<string, string> = {
      demonstrates: 'demonstrates_count',
      claims: 'claims_count',
      answers: 'answers_count',
    };
    return columns[signalType] || 'demonstrates_count';
  }
}
