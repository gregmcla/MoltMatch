/**
 * Reflection Store
 * Hybrid SQLite + YAML persistence for learning data
 */

import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { createLogger, registerLogger } from '../utils/logger.js';
import type { MatchmakerDatabase } from '../db/database.js';
import {
  DEFAULT_LEARNING_CONFIG,
  type Reflection,
  type Insight,
  type Principle,
  type InsightCategory,
  type PrincipleCategory,
  type LearningConfig,
} from './types.js';

const logger = createLogger('learning-store');
registerLogger(logger);

// Simple YAML-like serialization (avoid external dependency)
function toYaml(obj: Record<string, unknown>, indent = 0): string {
  const spaces = '  '.repeat(indent);
  let result = '';

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      result += `${spaces}${key}: null\n`;
    } else if (Array.isArray(value)) {
      if (value.length === 0) {
        result += `${spaces}${key}: []\n`;
      } else if (typeof value[0] === 'object') {
        result += `${spaces}${key}:\n`;
        for (const item of value) {
          result += `${spaces}  -\n`;
          result += toYaml(item as Record<string, unknown>, indent + 2);
        }
      } else {
        result += `${spaces}${key}:\n`;
        for (const item of value) {
          result += `${spaces}  - ${JSON.stringify(item)}\n`;
        }
      }
    } else if (typeof value === 'object') {
      result += `${spaces}${key}:\n`;
      result += toYaml(value as Record<string, unknown>, indent + 1);
    } else if (typeof value === 'string' && value.includes('\n')) {
      result += `${spaces}${key}: |\n`;
      for (const line of value.split('\n')) {
        result += `${spaces}  ${line}\n`;
      }
    } else {
      result += `${spaces}${key}: ${JSON.stringify(value)}\n`;
    }
  }

  return result;
}

export class ReflectionStore {
  private db: MatchmakerDatabase;
  private dataDir: string;
  private reflectionsDir: string;
  private config: LearningConfig;

  constructor(db: MatchmakerDatabase, dataDir: string, config?: Partial<LearningConfig>) {
    this.db = db;
    this.dataDir = dataDir;
    this.reflectionsDir = join(dataDir, 'learning', 'reflections');
    this.config = { ...DEFAULT_LEARNING_CONFIG, ...config };

    // Ensure directories exist
    mkdirSync(this.reflectionsDir, { recursive: true });
  }

  // ==========================================================================
  // Reflection Operations
  // ==========================================================================

  saveReflection(reflection: Reflection): void {
    const timestamp = new Date(reflection.timestamp);
    const filename = `${timestamp.toISOString().replace(/[:.]/g, '-')}.yaml`;
    const filePath = join(this.reflectionsDir, filename);

    // Save to YAML file
    const yamlContent = this.reflectionToYaml(reflection);
    writeFileSync(filePath, yamlContent, 'utf-8');

    // Save to SQLite
    const stmt = this.db.getDb().prepare(`
      INSERT OR REPLACE INTO reflections (
        id, timestamp, trigger, heartbeat_id, summary,
        what_worked_well, what_surprised, what_would_do_differently,
        pattern_observations, match_assessments, extraction_notes,
        confidence, tags, file_path, consolidated_into
      ) VALUES (
        @id, @timestamp, @trigger, @heartbeatId, @summary,
        @whatWorkedWell, @whatSurprised, @whatWouldDoDifferently,
        @patternObservations, @matchAssessments, @extractionNotes,
        @confidence, @tags, @filePath, @consolidatedInto
      )
    `);

    stmt.run({
      id: reflection.id,
      timestamp: reflection.timestamp,
      trigger: reflection.trigger,
      heartbeatId: reflection.heartbeatId || null,
      summary: reflection.summary,
      whatWorkedWell: JSON.stringify(reflection.whatWorkedWell),
      whatSurprised: JSON.stringify(reflection.whatSurprised),
      whatWouldDoDifferently: JSON.stringify(reflection.whatWouldDoDifferently),
      patternObservations: JSON.stringify(reflection.patternObservations),
      matchAssessments: JSON.stringify(reflection.matchQualityAssessments),
      extractionNotes: JSON.stringify(reflection.extractionNotes),
      confidence: reflection.confidence,
      tags: JSON.stringify(reflection.tags),
      filePath: filePath,
      consolidatedInto: reflection.consolidatedInto || null,
    });

    // Save pattern observations separately for querying
    for (const pattern of reflection.patternObservations) {
      this.db.getDb().prepare(`
        INSERT INTO pattern_observations (
          reflection_id, pattern, frequency, domain, actionable, suggested_action
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        reflection.id,
        pattern.pattern,
        pattern.frequency,
        pattern.domain || null,
        pattern.actionable ? 1 : 0,
        pattern.suggestedAction || null
      );
    }

    logger.debug('reflection_saved', { id: reflection.id, filePath });
  }

  getReflection(id: string): Reflection | null {
    const row = this.db.getDb().prepare(`
      SELECT * FROM reflections WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToReflection(row);
  }

  getRecentReflections(limit: number = 50): Reflection[] {
    const rows = this.db.getDb().prepare(`
      SELECT * FROM reflections
      WHERE consolidated_into IS NULL
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(limit) as Record<string, unknown>[];

    return rows.map(row => this.rowToReflection(row));
  }

  getUnconsolidatedReflections(): Reflection[] {
    const rows = this.db.getDb().prepare(`
      SELECT * FROM reflections
      WHERE consolidated_into IS NULL
      ORDER BY timestamp ASC
    `).all() as Record<string, unknown>[];

    return rows.map(row => this.rowToReflection(row));
  }

  getReflectionCount(): number {
    const row = this.db.getDb().prepare(`
      SELECT COUNT(*) as count FROM reflections
    `).get() as { count: number };
    return row.count;
  }

  markReflectionConsolidated(reflectionId: string, insightId: string): void {
    this.db.getDb().prepare(`
      UPDATE reflections SET consolidated_into = ? WHERE id = ?
    `).run(insightId, reflectionId);
  }

  // ==========================================================================
  // Insight Operations
  // ==========================================================================

  saveInsight(insight: Insight): void {
    const stmt = this.db.getDb().prepare(`
      INSERT OR REPLACE INTO insights (
        id, created_at, source_reflection_ids, category,
        insight_text, strength, action_taken, promoted_to_principle, last_referenced
      ) VALUES (
        @id, @createdAt, @sourceReflectionIds, @category,
        @insightText, @strength, @actionTaken, @promotedToPrinciple, @lastReferenced
      )
    `);

    stmt.run({
      id: insight.id,
      createdAt: insight.createdAt.toISOString(),
      sourceReflectionIds: JSON.stringify(insight.sourceReflectionIds),
      category: insight.category,
      insightText: insight.insight,
      strength: insight.strength,
      actionTaken: insight.actionTaken ? 1 : 0,
      promotedToPrinciple: insight.promotedToPrinciple ? 1 : 0,
      lastReferenced: insight.lastReferenced?.toISOString() || null,
    });

    // Update insights.yaml file
    this.syncInsightsToYaml();

    logger.debug('insight_saved', { id: insight.id, category: insight.category });
  }

  getInsight(id: string): Insight | null {
    const row = this.db.getDb().prepare(`
      SELECT * FROM insights WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToInsight(row);
  }

  getInsightsByCategory(category: InsightCategory): Insight[] {
    const rows = this.db.getDb().prepare(`
      SELECT * FROM insights
      WHERE category = ?
      ORDER BY strength DESC
    `).all(category) as Record<string, unknown>[];

    return rows.map(row => this.rowToInsight(row));
  }

  getUnpromotedInsights(): Insight[] {
    const rows = this.db.getDb().prepare(`
      SELECT * FROM insights
      WHERE promoted_to_principle = 0
      ORDER BY strength DESC
    `).all() as Record<string, unknown>[];

    return rows.map(row => this.rowToInsight(row));
  }

  updateInsightStrength(insightId: string, delta: number): void {
    this.db.getDb().prepare(`
      UPDATE insights
      SET strength = MIN(1.0, MAX(0.0, strength + ?)),
          last_referenced = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(delta, insightId);

    this.syncInsightsToYaml();
  }

  markInsightPromoted(insightId: string): void {
    this.db.getDb().prepare(`
      UPDATE insights SET promoted_to_principle = 1 WHERE id = ?
    `).run(insightId);

    this.syncInsightsToYaml();
  }

  // ==========================================================================
  // Principle Operations
  // ==========================================================================

  savePrinciple(principle: Principle): void {
    const stmt = this.db.getDb().prepare(`
      INSERT OR REPLACE INTO principles (
        id, created_at, updated_at, source_insight_ids, category,
        principle_text, weight, active, validation_count, invalidation_count, last_validated
      ) VALUES (
        @id, @createdAt, @updatedAt, @sourceInsightIds, @category,
        @principleText, @weight, @active, @validationCount, @invalidationCount, @lastValidated
      )
    `);

    stmt.run({
      id: principle.id,
      createdAt: principle.createdAt.toISOString(),
      updatedAt: principle.updatedAt.toISOString(),
      sourceInsightIds: JSON.stringify(principle.sourceInsightIds),
      category: principle.category,
      principleText: principle.principleText,
      weight: principle.weight,
      active: principle.active ? 1 : 0,
      validationCount: principle.validationCount,
      invalidationCount: principle.invalidationCount,
      lastValidated: principle.lastValidated?.toISOString() || null,
    });

    // Update principles.yaml file
    this.syncPrinciplesToYaml();

    logger.debug('principle_saved', { id: principle.id, category: principle.category });
  }

  getPrinciple(id: string): Principle | null {
    const row = this.db.getDb().prepare(`
      SELECT * FROM principles WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToPrinciple(row);
  }

  getActivePrinciples(): Principle[] {
    const rows = this.db.getDb().prepare(`
      SELECT * FROM principles
      WHERE active = 1
      ORDER BY weight DESC
    `).all() as Record<string, unknown>[];

    return rows.map(row => this.rowToPrinciple(row));
  }

  getActivePrinciplesByCategory(category: PrincipleCategory): Principle[] {
    const rows = this.db.getDb().prepare(`
      SELECT * FROM principles
      WHERE active = 1 AND category = ?
      ORDER BY weight DESC
      LIMIT ?
    `).all(category, this.config.maxPrinciplesPerCategory) as Record<string, unknown>[];

    return rows.map(row => this.rowToPrinciple(row));
  }

  validatePrinciple(principleId: string): void {
    this.db.getDb().prepare(`
      UPDATE principles
      SET validation_count = validation_count + 1,
          last_validated = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(principleId);

    this.syncPrinciplesToYaml();
  }

  invalidatePrinciple(principleId: string): void {
    this.db.getDb().prepare(`
      UPDATE principles
      SET invalidation_count = invalidation_count + 1
      WHERE id = ?
    `).run(principleId);

    // Check if should deactivate
    const principle = this.getPrinciple(principleId);
    if (principle) {
      const total = principle.validationCount + principle.invalidationCount;
      const invalidationRate = principle.invalidationCount / total;
      if (total >= 5 && invalidationRate > 0.4) {
        this.deactivatePrinciple(principleId, 'High invalidation rate');
      }
    }

    this.syncPrinciplesToYaml();
  }

  deactivatePrinciple(principleId: string, reason: string): void {
    this.db.getDb().prepare(`
      UPDATE principles SET active = 0 WHERE id = ?
    `).run(principleId);

    logger.info('principle_deactivated', { principleId, reason });
    this.syncPrinciplesToYaml();
  }

  // ==========================================================================
  // Learning State Operations
  // ==========================================================================

  getHeartbeatCount(): number {
    const row = this.db.getDb().prepare(`
      SELECT heartbeat_count FROM learning_state WHERE id = 1
    `).get() as { heartbeat_count: number } | undefined;
    return row?.heartbeat_count || 0;
  }

  incrementHeartbeatCount(): number {
    this.db.getDb().prepare(`
      UPDATE learning_state SET heartbeat_count = heartbeat_count + 1 WHERE id = 1
    `).run();
    return this.getHeartbeatCount();
  }

  getLastConsolidation(): Date | null {
    const row = this.db.getDb().prepare(`
      SELECT last_consolidation FROM learning_state WHERE id = 1
    `).get() as { last_consolidation: string | null } | undefined;
    return row?.last_consolidation ? new Date(row.last_consolidation) : null;
  }

  setLastConsolidation(date: Date): void {
    this.db.getDb().prepare(`
      UPDATE learning_state SET last_consolidation = ? WHERE id = 1
    `).run(date.toISOString());
  }

  getLastReflection(): Date | null {
    const row = this.db.getDb().prepare(`
      SELECT last_reflection FROM learning_state WHERE id = 1
    `).get() as { last_reflection: string | null } | undefined;
    return row?.last_reflection ? new Date(row.last_reflection) : null;
  }

  setLastReflection(date: Date): void {
    this.db.getDb().prepare(`
      UPDATE learning_state SET last_reflection = ? WHERE id = 1
    `).run(date.toISOString());
  }

  // ==========================================================================
  // Decay and Cleanup Operations
  // ==========================================================================

  decayStaleInsights(): number {
    const result = this.db.getDb().prepare(`
      UPDATE insights
      SET strength = strength * 0.95
      WHERE last_referenced < datetime('now', '-' || ? || ' days')
        AND strength > 0.3
        AND promoted_to_principle = 0
    `).run(this.config.decayInsightDays);

    if (result.changes > 0) {
      this.syncInsightsToYaml();
      logger.info('insights_decayed', { count: result.changes });
    }
    return result.changes;
  }

  decayUnusedPrinciples(): number {
    const result = this.db.getDb().prepare(`
      UPDATE principles
      SET weight = weight * 0.9
      WHERE last_validated < datetime('now', '-' || ? || ' days')
        AND weight > 0.5
        AND active = 1
    `).run(this.config.decayPrincipleDays);

    if (result.changes > 0) {
      this.syncPrinciplesToYaml();
      logger.info('principles_decayed', { count: result.changes });
    }
    return result.changes;
  }

  cleanupOldReflections(): number {
    // Get reflections to delete (old and consolidated)
    const toDelete = this.db.getDb().prepare(`
      SELECT id, file_path FROM reflections
      WHERE consolidated_into IS NOT NULL
        AND timestamp < datetime('now', '-' || ? || ' days')
        AND confidence < 0.8
    `).all(this.config.retentionReflectionDays) as Array<{ id: string; file_path: string }>;

    for (const row of toDelete) {
      // Delete YAML file if exists
      if (row.file_path && existsSync(row.file_path)) {
        unlinkSync(row.file_path);
      }
    }

    // Delete from database
    const result = this.db.getDb().prepare(`
      DELETE FROM reflections
      WHERE consolidated_into IS NOT NULL
        AND timestamp < datetime('now', '-' || ? || ' days')
        AND confidence < 0.8
    `).run(this.config.retentionReflectionDays);

    if (result.changes > 0) {
      logger.info('old_reflections_cleaned', { count: result.changes });
    }
    return result.changes;
  }

  enforceRetentionLimits(): void {
    // Enforce max reflections
    const reflectionCount = this.getReflectionCount();
    if (reflectionCount > this.config.maxReflections) {
      const excess = reflectionCount - this.config.maxReflections;
      const toDelete = this.db.getDb().prepare(`
        SELECT id, file_path FROM reflections
        WHERE consolidated_into IS NOT NULL
        ORDER BY confidence ASC, timestamp ASC
        LIMIT ?
      `).all(excess) as Array<{ id: string; file_path: string }>;

      for (const row of toDelete) {
        if (row.file_path && existsSync(row.file_path)) {
          unlinkSync(row.file_path);
        }
        this.db.getDb().prepare(`DELETE FROM reflections WHERE id = ?`).run(row.id);
      }

      logger.info('reflections_pruned', { count: toDelete.length });
    }
  }

  // ==========================================================================
  // YAML Sync Operations
  // ==========================================================================

  private syncInsightsToYaml(): void {
    const insights = this.db.getDb().prepare(`
      SELECT * FROM insights ORDER BY strength DESC
    `).all() as Record<string, unknown>[];

    const yamlPath = join(this.dataDir, 'learning', 'insights.yaml');
    const content = {
      version: 1,
      last_updated: new Date().toISOString(),
      insights: insights.map(row => ({
        id: row.id,
        created_at: row.created_at,
        source_reflections: JSON.parse(row.source_reflection_ids as string),
        category: row.category,
        insight: row.insight_text,
        strength: row.strength,
        action_taken: !!row.action_taken,
        promoted_to_principle: !!row.promoted_to_principle,
      })),
    };

    writeFileSync(yamlPath, toYaml(content), 'utf-8');
  }

  private syncPrinciplesToYaml(): void {
    const active = this.db.getDb().prepare(`
      SELECT * FROM principles WHERE active = 1 ORDER BY weight DESC
    `).all() as Record<string, unknown>[];

    const archived = this.db.getDb().prepare(`
      SELECT * FROM principles WHERE active = 0 ORDER BY updated_at DESC LIMIT 20
    `).all() as Record<string, unknown>[];

    const yamlPath = join(this.dataDir, 'learning', 'principles.yaml');
    const content = {
      version: 1,
      schema_version: '1.0',
      last_updated: new Date().toISOString(),
      principles: active.map(row => ({
        id: row.id,
        category: row.category,
        principle: row.principle_text,
        weight: row.weight,
        active: true,
        source_insights: JSON.parse(row.source_insight_ids as string),
        validation_count: row.validation_count,
        invalidation_count: row.invalidation_count,
        last_validated: row.last_validated,
      })),
      archived: archived.map(row => ({
        id: row.id,
        principle: row.principle_text,
        archived_at: row.updated_at,
        reason: 'Deactivated',
      })),
    };

    writeFileSync(yamlPath, toYaml(content), 'utf-8');
  }

  private reflectionToYaml(reflection: Reflection): string {
    const content = {
      id: reflection.id,
      timestamp: reflection.timestamp,
      trigger: reflection.trigger,
      heartbeat_id: reflection.heartbeatId,
      summary: reflection.summary,
      what_worked_well: reflection.whatWorkedWell,
      what_surprised: reflection.whatSurprised,
      what_would_do_differently: reflection.whatWouldDoDifferently,
      pattern_observations: reflection.patternObservations,
      match_quality_assessments: reflection.matchQualityAssessments,
      extraction_notes: reflection.extractionNotes,
      confidence: reflection.confidence,
      tags: reflection.tags,
    };

    return toYaml(content);
  }

  // ==========================================================================
  // Row Conversion Helpers
  // ==========================================================================

  private rowToReflection(row: Record<string, unknown>): Reflection {
    return {
      id: row.id as string,
      timestamp: row.timestamp as string,
      trigger: row.trigger as Reflection['trigger'],
      heartbeatId: row.heartbeat_id as string | undefined,
      summary: row.summary as string,
      whatWorkedWell: JSON.parse(row.what_worked_well as string || '[]'),
      whatSurprised: JSON.parse(row.what_surprised as string || '[]'),
      whatWouldDoDifferently: JSON.parse(row.what_would_do_differently as string || '[]'),
      patternObservations: JSON.parse(row.pattern_observations as string || '[]'),
      matchQualityAssessments: JSON.parse(row.match_assessments as string || '[]'),
      extractionNotes: JSON.parse(row.extraction_notes as string || '[]'),
      confidence: row.confidence as number,
      tags: JSON.parse(row.tags as string || '[]'),
      consolidatedInto: row.consolidated_into as string | undefined,
      createdAt: new Date(row.created_at as string),
    };
  }

  private rowToInsight(row: Record<string, unknown>): Insight {
    return {
      id: row.id as string,
      createdAt: new Date(row.created_at as string),
      sourceReflectionIds: JSON.parse(row.source_reflection_ids as string),
      category: row.category as InsightCategory,
      insight: row.insight_text as string,
      strength: row.strength as number,
      actionTaken: !!row.action_taken,
      promotedToPrinciple: !!row.promoted_to_principle,
      lastReferenced: row.last_referenced ? new Date(row.last_referenced as string) : undefined,
    };
  }

  private rowToPrinciple(row: Record<string, unknown>): Principle {
    return {
      id: row.id as string,
      createdAt: new Date(row.created_at as string),
      updatedAt: new Date(row.updated_at as string),
      sourceInsightIds: JSON.parse(row.source_insight_ids as string),
      category: row.category as PrincipleCategory,
      principleText: row.principle_text as string,
      weight: row.weight as number,
      active: !!row.active,
      validationCount: row.validation_count as number,
      invalidationCount: row.invalidation_count as number,
      lastValidated: row.last_validated ? new Date(row.last_validated as string) : undefined,
    };
  }
}
