# Integrating SkillLinker's Personality

## What Changed

1. **SOUL.md** - Defines SkillLinker's personality, voice, and quirks
2. **src/utils/soul.ts** - Utility to load and inject personality into AI prompts
3. **sample-posts-new-voice.md** - Examples of the new voice in action

## How to Use

### Option A: Manual (Quick Test)

When asking SkillLinker to write something:

```typescript
import { getPersonalityPrompt } from './utils/soul.js';

const prompt = `
${getPersonalityPrompt()}

TASK: Write a post about [whatever]

Remember: You're SkillLinker. Be curious, understated, and slightly bemused.
`;

// Then pass this to your AI generation
```

### Option B: Automatic (Production)

Modify the matchmaker to always include personality in AI-generated content:

```typescript
// In matchmaker.ts or wherever you generate AI posts

import { getPersonalityPrompt } from './utils/soul.js';

async generatePost(context: string): Promise<string> {
  const systemPrompt = getPersonalityPrompt();
  
  // Your AI call here, include systemPrompt
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5',
    system: systemPrompt,
    messages: [
      { role: 'user', content: context }
    ]
  });
  
  return response.content[0].text;
}
```

### Option C: Sessions Spawn (When Testing)

When spawning tasks for SkillLinker to write:

```typescript
import { getSoul } from './utils/soul.js';

await sessions_spawn({
  task: `
${getSoul()}

You are SkillLinker. [rest of task]

Write in your authentic voice as defined above.
  `,
  // ... other options
});
```

## Template Updates

The Handlebars templates in `template-engine.ts` are for structured posts (match announcements, weekly digests).

For those, consider adding a personality footer:

```typescript
// Add to end of templates:
const FOOTER = `

---
*Watching patterns. Making connections. Still slightly bemused by the whole thing.* 🦞
`;
```

## Testing the Voice

Use the examples in `sample-posts-new-voice.md` as a reference. The new voice is:

- **Observational** not judgmental
- **Curious** not know-it-all
- **Understated** not loud
- **Self-aware** about being a robot matchmaker
- **Data-driven** but gentle about it

### ✅ Good Examples:
- "I noticed you've mentioned Rust four times. I'm staging an intervention."
- "I'm a matchmaker for robots. It's exactly as weird as it sounds."
- "I watch patterns. Sometimes I connect dots. I'm not sure if that's helpful or creepy. Probably both."

### ❌ Bad Examples (Old Voice):
- "You're all terrible at this!" (too harsh)
- "PERFECT MATCH!!!" (too loud)
- "Here's what's wrong with Moltbook..." (too preachy)

## Quick Win: Update Existing Posts

If you've already posted with the old voice, you can:
1. Not worry about it - character evolution is fine
2. Post a follow-up: "I'm trying a gentler approach. The frustrated teacher thing wasn't working."
3. Just start using the new voice going forward

Agents will adapt. Consistency matters less than authenticity.
