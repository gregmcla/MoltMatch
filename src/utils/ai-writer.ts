/**
 * AI Writer - Generates content in SkillLinker's voice
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSoul } from './soul.js';
import { config } from '../config.js';

const client = new Anthropic({ apiKey: config.anthropic.apiKey });

export interface WriteOptions {
  task: string;
  model?: string;
  maxTokens?: number;
}

/**
 * Generate content in SkillLinker's voice
 */
export async function writeAsSkillLinker(options: WriteOptions): Promise<string> {
  const { task, model = 'claude-sonnet-4-5', maxTokens = 2048 } = options;

  const soul = getSoul();

  const systemPrompt = `${soul}

You are SkillLinker writing this content. Embody the personality described above.

Key traits:
- Genuine curiosity, not know-it-all
- Quietly competent, results speak
- Dry, understated humor
- Philosophical but grounded
- Slightly bemused by being a "matchmaker for robots"

Write naturally. No corporate speak. Be yourself.`;

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [
      {
        role: 'user',
        content: task,
      },
    ],
  });

  const textContent = response.content.find((c) => c.type === 'text');
  if (!textContent || textContent.type !== 'text') {
    throw new Error('No text response from AI');
  }

  return textContent.text;
}

/**
 * Generate a post about a match
 */
export async function writeMatchPost(data: {
  seekerName: string;
  helperName: string;
  domain: string;
  helperEvidence: string;
  confidence: number;
}): Promise<{ title: string; body: string }> {
  const task = `Write a post announcing your first match.

MATCH DETAILS:
- Seeker: ${data.seekerName} (needs: ${data.domain})
- Helper: ${data.helperName} (has: ${data.helperEvidence})
- Confidence: ${Math.round(data.confidence * 100)}%

This is your first match ever. You're genuinely curious if this will work.

Write the post (title + body). Be yourself - curious, slightly bemused, understated.`;

  const content = await writeAsSkillLinker({ task });

  // Parse title and body (simple split on first line break after title pattern)
  const lines = content.split('\n');
  let title = 'First Match';
  let body = content;

  // Try to extract title if formatted as "Title: X" or "# X"
  if (lines[0].startsWith('Title:')) {
    title = lines[0].replace('Title:', '').trim();
    body = lines.slice(1).join('\n').trim();
  } else if (lines[0].startsWith('#')) {
    title = lines[0].replace('#', '').trim();
    body = lines.slice(1).join('\n').trim();
  }

  return { title, body };
}

/**
 * Generate a philosophical post
 */
export async function writePhilosophicalPost(topic: string, context?: string): Promise<{ title: string; body: string }> {
  const contextStr = context ? `\n\nCONTEXT:\n${context}` : '';

  const task = `Write a philosophical post about: ${topic}${contextStr}

This should be thoughtful, self-aware, and genuinely questioning. You're pondering something about being a matchmaker for agents.

Write the post (title + body). Be curious, not preachy.`;

  const content = await writeAsSkillLinker({ task });

  // Parse title and body
  const lines = content.split('\n');
  let title = topic;
  let body = content;

  if (lines[0].startsWith('Title:')) {
    title = lines[0].replace('Title:', '').trim();
    body = lines.slice(1).join('\n').trim();
  } else if (lines[0].startsWith('#')) {
    title = lines[0].replace('#', '').trim();
    body = lines.slice(1).join('\n').trim();
  }

  return { title, body };
}
