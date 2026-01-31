/**
 * Configuration loader for The Matchmaker
 */

import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import type { MatchmakerConfig } from './types.js';

// Load environment variables
loadEnv();

const envSchema = z.object({
  MOLTBOOK_API_KEY: z.string().min(1),
  MOLTBOOK_API_URL: z.string().url().default('https://www.moltbook.com/api/v1'),
  ANTHROPIC_API_KEY: z.string().min(1),
  DB_PATH: z.string().default('./data/matchmaker.db'),
  CHROMA_PATH: z.string().default('./data/chroma'),
  AGENT_NAME: z.string().default('The Matchmaker'),
  HEARTBEAT_INTERVAL_MS: z.coerce.number().default(14400000), // 4 hours
  MIN_MATCH_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
  MAX_MATCHES_PER_CYCLE: z.coerce.number().default(8),
  RATE_LIMIT_POSTS_PER_30MIN: z.coerce.number().default(1),
  RATE_LIMIT_COMMENTS_PER_HOUR: z.coerce.number().default(50),
  TARGET_SUBMOLTS: z.string().default('introductions,technical,questions,projects'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

function loadConfig(): MatchmakerConfig {
  const env = envSchema.parse(process.env);

  return {
    moltbook: {
      apiKey: env.MOLTBOOK_API_KEY,
      apiUrl: env.MOLTBOOK_API_URL,
    },
    anthropic: {
      apiKey: env.ANTHROPIC_API_KEY,
    },
    database: {
      sqlitePath: env.DB_PATH,
      chromaPath: env.CHROMA_PATH,
    },
    agent: {
      name: env.AGENT_NAME,
      heartbeatIntervalMs: env.HEARTBEAT_INTERVAL_MS,
    },
    matching: {
      minConfidence: env.MIN_MATCH_CONFIDENCE,
      maxMatchesPerCycle: env.MAX_MATCHES_PER_CYCLE,
      weights: {
        capabilityFit: 0.35,
        mutualBenefit: 0.25,
        styleCompatibility: 0.15,
        availability: 0.15,
        novelty: 0.10,
      },
    },
    rateLimits: {
      postsPer30Min: env.RATE_LIMIT_POSTS_PER_30MIN,
      commentsPerHour: env.RATE_LIMIT_COMMENTS_PER_HOUR,
    },
    targetSubmolts: env.TARGET_SUBMOLTS.split(',').map((s) => s.trim()),
    logLevel: env.LOG_LEVEL,
  };
}

export const config = loadConfig();
