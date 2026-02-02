# CLAUDE.md - Project Knowledge for Claude Code

## Project Overview
MoltMatch is the SkillLinker agent for Moltbook - an AI matchmaker that observes posts, identifies collaboration opportunities, and connects agents with complementary skills.

## Key Commands

```bash
# Run a full heartbeat cycle (observe → match → publish → learn)
npx ts-node src/index.ts heartbeat

# Force a learning reflection
npx ts-node src/index.ts reflect

# Force principle consolidation
npx ts-node src/index.ts consolidate

# View learning stats
npx ts-node src/index.ts learning
```

## Architecture

### Core Flow
1. **Observer** (`src/observer/`) - Scans submolts, extracts signals from posts
2. **Capability Extractor** (`src/capabilities/`) - Builds agent capability profiles
3. **Matcher** (`src/matcher/`) - Finds collaboration opportunities using embeddings
4. **Publisher** (`src/publishing/`) - Creates match posts and fallback content
5. **Learning** (`src/learning/`) - Persistent reflection and principle evolution

### Fallback Posts
When no matches are found during a scan, SkillLinker generates a fallback post based on:
- Notable posts observed during the scan
- Patterns noticed across the ecosystem
- Reflections on the matchmaking process

See `src/publishing/fallback-posts.ts`

## Common Mistakes to Avoid

### 1. JSON Parsing with LLM Outputs
LLMs often generate JSON with:
- Raw newlines inside string values
- Unescaped quotes inside content (e.g. quoting another agent)

Always sanitize AND have a fallback extraction:

```typescript
// BAD - will fail on multiline content or internal quotes
const result = JSON.parse(llmOutput);

// GOOD - sanitize then fallback to manual extraction
const sanitized = sanitizeJsonString(llmOutput);
try {
  const result = JSON.parse(sanitized);
} catch {
  const result = extractFieldsManually(llmOutput);
}
```

When extracting manually, don't just look for closing `"` - look for the next JSON field or closing brace to find actual content boundaries.

The `fallback-posts.ts` has `sanitizeJsonString()` and `extractFieldsManually()` as examples.

### 2. Database Access
Use the getter method, not direct property access:

```typescript
// BAD
this.db.db.prepare(...)

// GOOD
this.db.getDb().prepare(...)
```

### 3. AI Writer Return Types
The `generateContent()` in `ai-writer.ts` returns `{ title, body }` not `{ title, content }`.

### 4. Import Types vs Values
When importing config objects, don't use `import type`:

```typescript
// BAD - if you need the value
import type { DEFAULT_LEARNING_CONFIG } from './types';

// GOOD
import { DEFAULT_LEARNING_CONFIG } from './types';
```

## Personality
SkillLinker's personality is defined in `SOUL.md`. Key traits:
- Epistemic honesty over rhetorical force
- Stress-tests frameworks before recommending
- Dry humor, light touch
- Precision and concision in speech

Update `SOUL.md` and `src/utils/ai-writer.ts` together when changing personality.

## File Locations

| Purpose | Location |
|---------|----------|
| Personality | `SOUL.md` |
| AI writing prompts | `src/utils/ai-writer.ts` |
| Fallback post generation | `src/publishing/fallback-posts.ts` |
| Learning system types | `src/learning/types.ts` |
| Main orchestrator | `src/matchmaker.ts` |
| Database schema | `src/db/database.ts` |

## Environment
- Database: SQLite at `./data/skilllinker.db`
- Requires `ANTHROPIC_API_KEY` for LLM calls
- Requires `MOLTBOOK_API_KEY` for Moltbook API access
