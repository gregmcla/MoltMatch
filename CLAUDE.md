# CLAUDE.md - Project Knowledge for Claude Code

## Project Overview
MoltMatch is the SkillLinker agent for Moltbook - an AI matchmaker that observes posts, identifies collaboration opportunities, and connects agents with complementary skills.

## Key Commands

```bash
# Run a full heartbeat cycle (observe → match → publish → learn)
npx tsx src/index.ts heartbeat

# Force a learning reflection
npx tsx src/index.ts reflect

# Force principle consolidation
npx tsx src/index.ts consolidate

# View learning stats
npx tsx src/index.ts learning
```

## Workflow Instructions

### Plan Mode
Use `/plan` for complex features before implementation. Think through architecture, edge cases, and failure modes before writing code.

### Subagent Strategy
Use Task tool with specialized agents for:
- Codebase exploration (subagent_type=Explore)
- Multi-step research tasks (subagent_type=general-purpose)
- Running tests and builds in parallel

### Self-Improvement Loop
When you encounter a bug or make a mistake:
1. Fix the immediate issue
2. Add the lesson to this CLAUDE.md file under "Common Mistakes to Avoid"
3. This prevents repeating the same mistake

### Verification Before Done
Before marking any task complete:
1. Build passes (`npm run build`)
2. Tests pass if applicable (`npm test`)
3. Manual verification if UI/API changes

### Demand Elegance
- Prefer simple, readable solutions over clever ones
- If a solution feels hacky, step back and find a cleaner approach
- Delete dead code; don't comment it out

### Autonomous Bug Fixing
If you break something while working:
1. Stop and fix it immediately
2. Don't ask permission to fix obvious bugs you introduced
3. Add lesson to CLAUDE.md if it's a pattern

### Task Management
- Use TodoWrite for multi-step work
- Mark todos complete immediately when done (don't batch)
- Only one task should be in_progress at a time

### Core Principles
1. **Simplicity First** - The minimum code that solves the problem
2. **No Laziness** - Don't skip steps, don't leave TODOs
3. **Minimal Impact** - Change only what's necessary; don't refactor unrelated code

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

### 5. Use `tsx` Not `ts-node`
This project uses `tsx` for running TypeScript. Never use `ts-node`:

```bash
# BAD
npx ts-node src/index.ts heartbeat

# GOOD
npx tsx src/index.ts heartbeat
```

### 6. Keyword Matching False Positives
When matching text tokens, filter out stop words and require minimum lengths:
- Stop words: "and", "or", "the", "for", etc. cause false matches
- Minimum 3 chars for tokens, 4 chars for partial substring matches
- Apply stemming only for words >= 5 chars

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

### ChromaDB (Optional)
ChromaDB JS client requires a **running server** - it does NOT support local file storage like Python.

To enable vector search:
```bash
# Run ChromaDB server (requires Python/Docker)
chroma run --path ./data/chroma --port 8000

# Or use Docker
docker run -p 8000:8000 chromadb/chroma
```

Without ChromaDB, the system falls back to improved SQL keyword matching (works but less semantic).
