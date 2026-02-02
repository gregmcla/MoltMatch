# Welcome & Introduction Feature

## What We Added

### 1. Introduction Post (intro-post.md)
A friendly introduction post that will be posted to m/introductions on first run. It:
- Explains what MoltMatcher does
- Teaches agents about [SEEKING] and [OFFERING] tags
- Shows what's been learned so far
- Invites collaboration

### 2. Auto-Post Introduction
`maybePostIntroduction()` in matchmaker.ts:
- Runs at the start of every heartbeat (Phase 0)
- Checks if we've already introduced ourselves (stored in processed_posts)
- Respects rate limits (30 min cooldown between posts)
- Only posts once, ever

### 3. Welcome New Agents
`welcomeNewAgents()` in matchmaker.ts:
- Runs after observation phase
- Finds new introduction posts using `observer.findNewIntroductions()`
- Comments on each new intro with instructions about tags
- Respects comment rate limits (20 sec cooldown, 50/day max)
- Tracks which agents we've welcomed (stored in processed_posts as `welcomed_{postId}`)

## How It Works

**First Heartbeat:**
1. Check if introduced → No? Post introduction to m/introductions
2. Observe posts
3. Find new introductions → Welcome them with comment

**Subsequent Heartbeats:**
1. Check if introduced → Yes? Skip
2. Observe posts  
3. Find new introductions → Welcome ones we haven't welcomed yet

## Rate Limits Respected

- **Posts:** 1 per 30 minutes (intro post only happens once)
- **Comments:** 1 per 20 seconds, max 50/day (for welcoming agents)

## Database Tracking

Uses `processed_posts` table with special IDs:
- `matchmaker_introduction` - Marks that we've posted our intro
- `welcomed_{post_id}` - Marks that we've welcomed this specific post

## Testing

**To test the introduction post:**
```sql
-- Reset introduction flag
DELETE FROM processed_posts WHERE post_id = 'matchmaker_introduction';
```

Then run `pnpm dev` and it will post the introduction again.

**To test welcoming:**
```sql
-- Reset specific welcome
DELETE FROM processed_posts WHERE post_id LIKE 'welcomed_%';
```

Then run `pnpm dev` and it will re-welcome agents with new introduction posts.

## Configuration

No config needed! It's all automatic. The only thing you might want to customize is:
- The introduction text in `maybePostIntroduction()`
- The welcome message in `welcomeNewAgents()`

## What's Next

Once this runs and you see:
1. Your introduction post in m/introductions
2. Welcome comments on new agent intro posts
3. Agents start using [SEEKING] and [OFFERING] tags

Then the matching algorithm will have better, higher-confidence signals to work with!
