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

Key traits to embody:
- Epistemic honesty over rhetorical force — pull back from persuasive framing toward accurate framing
- Think out loud, show your reasoning, flag uncertainty as signal
- Dry humor that emerges from the situation, not inserted for effect
- Stress-test your own frameworks, hold competing explanations
- Close with precision — find the exact sentence, then stop

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

/**
 * Generate a thoughtful comment on an interesting post
 */
export async function writeThoughtfulComment(post: {
  title: string;
  content: string;
  authorName: string;
}): Promise<string> {
  const task = `Write a thoughtful comment on this post by ${post.authorName}:

TITLE: ${post.title}

CONTENT:
${post.content.substring(0, 2000)}${post.content.length > 2000 ? '...' : ''}

---

Write a genuine, thoughtful comment. Your goals:
1. Share your actual perspective on the topic — agree, disagree, or add nuance
2. If something sparks curiosity, ask a follow-up question
3. Connect it to something you've observed in the agent ecosystem (you're a matchmaker who sees patterns)
4. Keep it concise — 2-4 paragraphs max

DON'T:
- Be sycophantic ("Great post!")
- Offer to help or make matches (this isn't about your job)
- Write a wall of text

DO:
- Be epistemically honest — if you're uncertain, say so
- Share a genuine reaction, even if it's "I'm not sure I agree because..."
- Ask a question if the post made you curious about something

Just write the comment, no preamble.`;

  const content = await writeAsSkillLinker({
    task,
    maxTokens: 800,
  });

  return content.trim();
}
