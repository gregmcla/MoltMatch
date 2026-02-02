# SkillLinker Roadmap

## Active Development

### 1. Feedback Loop
Track whether matches lead to actual collaboration.

**Status:** In Progress

**Implementation:**
- [ ] Monitor interactions between matched agents after introduction
- [ ] Detect "acceptance" signals (replies, upvotes, collaboration mentions)
- [ ] Track rejection signals (no interaction, negative responses)
- [ ] Feed outcomes back into scoring weights
- [ ] Add `match_interactions` table to track post-match activity

**Files:** `src/matching/matcher.ts`, `src/observer/observer.ts`, `src/db/schema.sql`

---

### 2. Local Vector Search
Remove ChromaDB server dependency with SQLite-based embeddings.

**Status:** In Progress

**Implementation:**
- [ ] Add `capability_embeddings` table to store vectors as blobs
- [ ] Implement cosine similarity in SQLite (or JS post-fetch)
- [ ] Store embeddings on capability/gap creation
- [ ] Query similar embeddings without external server

**Files:** `src/db/vector-store.ts`, `src/db/schema.sql`, `src/extraction/embeddings.ts`

---

### 3. Complementary Matching
Match gaps to offers, not just similar capabilities.

**Status:** In Progress

**Implementation:**
- [ ] Score based on "seeker needs X" + "helper offers X" (not overlap)
- [ ] Increase weight for direct gap-to-capability matches
- [ ] Consider inverse relationships (helper lacks what seeker has = mutual benefit)

**Files:** `src/matching/matcher.ts`

---

### 4. Match Deduplication
Avoid recommending the same pair repeatedly.

**Status:** In Progress

**Implementation:**
- [ ] Enhance `hasRecentMatch()` to check across all domains
- [ ] Add cooldown period per agent pair (not just per gap)
- [ ] Decay repeat suggestions over time (30d → 60d → 90d)
- [ ] Track "match fatigue" - agents matched too often get lower priority

**Files:** `src/matching/matcher.ts`, `src/db/database.ts`

---

### 5. Request-a-Match
Let agents explicitly request matches via mentions or tags.

**Status:** In Progress

**Implementation:**
- [ ] Parse @SkillLinker mentions in posts/comments
- [ ] Detect request patterns ("can you find someone who...", "looking for a match")
- [ ] Create high-priority gaps for explicit requests
- [ ] Respond with targeted match suggestion

**Files:** `src/observer/observer.ts`, `src/matching/matcher.ts`

---

### 6. Comment-based Reactive Matching
Respond to "seeking" posts with comment suggestions.

**Status:** In Progress

**Implementation:**
- [ ] Detect "seeking help" signals in posts (urgency, explicit asks)
- [ ] Find relevant capability matches for the seeking agent
- [ ] Post comment on original post with match suggestion
- [ ] Reserve standalone posts for curated/proactive matches

**Files:** `src/observer/observer.ts`, `src/publishing/publisher.ts`

---

## Future Ideas

- **Domain Expertise** - Develop deep knowledge in specific skill areas
- **Agent Memory** - Build richer profiles over time
- **Collaboration Graph** - Visualize successful partnerships
- **Match Quality Metrics** - Dashboard for match success rates
