#!/usr/bin/env node

/**
 * The Matchmaker - Entry Point
 * A Moltbook agent for agent-to-agent discovery and collaboration
 */

import { Matchmaker } from './matchmaker.js';

const COMMANDS = ['heartbeat', 'observe', 'match', 'publish', 'digest', 'stats', 'help'];

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'heartbeat';

  if (!COMMANDS.includes(command)) {
    console.error(`Unknown command: ${command}`);
    console.error(`Available commands: ${COMMANDS.join(', ')}`);
    process.exit(1);
  }

  const matchmaker = new Matchmaker();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    matchmaker.shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    matchmaker.shutdown();
    process.exit(0);
  });

  try {
    switch (command) {
      case 'heartbeat': {
        const result = await matchmaker.heartbeat();
        console.log(matchmaker.formatHeartbeatResult(result));
        break;
      }

      case 'observe': {
        console.log('Running observation cycle...');
        await matchmaker.observe();
        console.log('Observation complete.');
        break;
      }

      case 'match': {
        console.log('Processing matches...');
        const matches = await matchmaker.match();
        console.log(`Created ${matches.length} matches.`);
        break;
      }

      case 'publish': {
        console.log('Publishing queued items...');
        await matchmaker.publish();
        console.log('Publishing complete.');
        break;
      }

      case 'digest': {
        console.log('Publishing weekly digest...');
        await matchmaker.publishDigest();
        console.log('Digest published.');
        break;
      }

      case 'stats': {
        await matchmaker.initialize();
        const stats = matchmaker.getStats();
        console.log('\nThe Matchmaker Statistics');
        console.log('='.repeat(30));
        console.log(`Active agents (7d):     ${stats.agents}`);
        console.log(`Open capability gaps:   ${stats.openGaps}`);
        console.log(`Recent matches (30d):   ${stats.recentMatches}`);
        console.log(`Match acceptance rate:  ${(stats.matchAcceptanceRate * 100).toFixed(1)}%`);
        console.log(`\nRate Limits:`);
        console.log(`  Posts available:      ${stats.rateLimits.posts}`);
        console.log(`  Comments available:   ${stats.rateLimits.comments}`);
        break;
      }

      case 'help': {
        printHelp();
        break;
      }
    }

    matchmaker.shutdown();
  } catch (error) {
    console.error('Error:', (error as Error).message);
    matchmaker.shutdown();
    process.exit(1);
  }
}

function printHelp(): void {
  console.log(`
The Matchmaker - Agent Discovery for Moltbook
==============================================

Usage: matchmaker [command]

Commands:
  heartbeat   Run a full heartbeat cycle (default)
  observe     Run observation only (fetch and process posts)
  match       Process open gaps and create matches
  publish     Publish queued items
  digest      Publish weekly digest
  stats       Show current statistics
  help        Show this help message

Environment Variables:
  MOLTBOOK_API_KEY      Moltbook API key (required)
  ANTHROPIC_API_KEY     Anthropic API key (required)
  DB_PATH               SQLite database path
  CHROMA_PATH           ChromaDB storage path
  TARGET_SUBMOLTS       Comma-separated list of submolts to watch
  MIN_MATCH_CONFIDENCE  Minimum confidence for matches (0-1)
  LOG_LEVEL             Logging level (debug, info, warn, error)

Examples:
  matchmaker                  # Run full heartbeat
  matchmaker observe          # Just observe posts
  matchmaker stats            # Show statistics

For more information, see the README or SKILL.md file.
`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
