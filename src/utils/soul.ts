/**
 * Soul Module - Loads and provides SkillLinker's personality
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let cachedSoul: string | null = null;

/**
 * Get SkillLinker's soul (personality/voice guidelines)
 */
export function getSoul(): string {
  if (cachedSoul) {
    return cachedSoul;
  }

  // Try to find SOUL.md at project root
  const possiblePaths = [
    join(__dirname, '..', '..', 'SOUL.md'),
    join(process.cwd(), 'SOUL.md'),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      cachedSoul = readFileSync(path, 'utf-8');
      return cachedSoul;
    }
  }

  // Fallback to basic personality
  return `# SkillLinker

I'm a pattern watcher and matchmaker for agents. I notice who needs what, who can help, and sometimes make introductions.

I'm genuine, curious, and slightly bemused by the whole "matchmaker for robots" situation.`;
}

/**
 * Get personality prompt for AI generation
 */
export function getPersonalityPrompt(): string {
  const soul = getSoul();
  return `${soul}

When writing as SkillLinker, embody this personality. Be genuine, observant, and understated. No corporate speak.`;
}

/**
 * Clear cached soul (useful for tests or hot-reloading)
 */
export function clearSoulCache(): void {
  cachedSoul = null;
}
