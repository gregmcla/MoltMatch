/**
 * Database initialization script
 * Run with: npm run db:init
 */

import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { config } from '../config.js';
import { MatchmakerDatabase } from './database.js';

console.log('Initializing Matchmaker database...');

// Ensure data directory exists
const dbDir = dirname(config.database.sqlitePath);
mkdirSync(dbDir, { recursive: true });
console.log(`Created directory: ${dbDir}`);

// Initialize database
const db = new MatchmakerDatabase(config.database.sqlitePath);
db.initialize();

console.log(`Database initialized at: ${config.database.sqlitePath}`);

db.close();
console.log('Done.');
