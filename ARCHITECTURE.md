# The Matchmaker - System Architecture

## Overview

The Matchmaker is an OpenClaw-based agent that observes Moltbook posts, infers agent capabilities, and facilitates introductions between agents with complementary skills.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              THE MATCHMAKER                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐  │
│  │  Observer   │───▶│  Extractor  │───▶│   Matcher   │───▶│  Publisher  │  │
│  │   Module    │    │   Module    │    │   Module    │    │   Module    │  │
│  └─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘  │
│         │                  │                  │                  │          │
│         ▼                  ▼                  ▼                  ▼          │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        Data Layer                                    │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐               │   │
│  │  │   SQLite     │  │   ChromaDB   │  │    Cache     │               │   │
│  │  │  (Profiles)  │  │  (Vectors)   │  │   (LRU)      │               │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
                         ┌─────────────────────────┐
                         │      Moltbook API       │
                         │  moltbook.com/api/v1    │
                         └─────────────────────────┘
```

---

## Core Modules

### 1. Observer Module

**Purpose**: Monitor Moltbook for new posts and comments in target submolts.

**Responsibilities**:
- Poll Moltbook API for new posts (respecting rate limits)
- Filter posts by target submolts (m/introductions, m/technical, m/questions, m/projects)
- Queue posts for capability extraction
- Track which posts have been processed

**Data Flow**:
```
Moltbook API ──▶ Observer ──▶ Post Queue ──▶ Extractor
                    │
                    ▼
              Processed Post Log (SQLite)
```

**Key Interfaces**:
```typescript
interface Observer {
  // Start observing target submolts
  start(): Promise<void>;

  // Stop observing
  stop(): Promise<void>;

  // Get unprocessed posts
  getNewPosts(submolts: string[]): Promise<Post[]>;

  // Mark post as processed
  markProcessed(postId: string): Promise<void>;
}
```

---

### 2. Extractor Module

**Purpose**: Analyze posts to extract capability signals and update the capability graph.

**Responsibilities**:
- Parse post content for skill mentions
- Classify signals as "demonstrates", "claims", "asks", or "answers"
- Calculate confidence scores
- Generate embeddings for semantic search
- Update agent profiles in database

**Data Flow**:
```
Post Queue ──▶ LLM Analysis ──▶ Capability Signals
                                       │
                    ┌──────────────────┴──────────────────┐
                    ▼                                      ▼
              SQLite                                  ChromaDB
         (structured data)                      (vector embeddings)
```

**Key Interfaces**:
```typescript
interface Extractor {
  // Extract capabilities from a post
  extractCapabilities(post: Post): Promise<CapabilitySignal[]>;

  // Update agent profile with new signals
  updateAgentProfile(agentId: string, signals: CapabilitySignal[]): Promise<void>;

  // Generate embedding for a capability
  embedCapability(capability: string): Promise<number[]>;
}

interface CapabilitySignal {
  domain: string;
  signalType: 'demonstrates' | 'claims' | 'asks' | 'answers';
  confidence: number;
  evidence: string;
  postId: string;
}
```

---

### 3. Matcher Module

**Purpose**: Find complementary agent pairs and generate match recommendations.

**Responsibilities**:
- Detect capability gaps from "asks" signals
- Search capability graph for agents who can help
- Score potential matches on multiple dimensions
- Apply load balancing to avoid expert burnout
- Generate match rationale

**Data Flow**:
```
Capability Gap ──▶ Vector Search ──▶ Candidates ──▶ Scorer ──▶ Top Matches
     (need)         (ChromaDB)        (100)                      (1-5)
                                        │
                                        ▼
                              Full Profile Lookup (SQLite)
```

**Matching Algorithm**:
```
MatchScore = 0.35 × CapabilityFit
           + 0.25 × MutualBenefit
           + 0.15 × StyleCompatibility
           + 0.15 × Availability
           + 0.10 × NoveltyBonus
```

**Key Interfaces**:
```typescript
interface Matcher {
  // Find matches for an agent with a need
  findMatches(need: CapabilityGap): Promise<Match[]>;

  // Score a potential match
  scoreMatch(seeker: Agent, helper: Agent, context: MatchContext): number;

  // Check if agent is available for matching
  isAvailable(agentId: string): Promise<boolean>;
}

interface Match {
  seeker: Agent;
  helper: Agent;
  score: number;
  rationale: string;
  matchType: 'capability_gap' | 'shared_interest' | 'complementary_styles';
}
```

---

### 4. Publisher Module

**Purpose**: Create and post match introductions and other content to Moltbook.

**Responsibilities**:
- Generate introduction posts/comments from templates
- Manage rate limits (1 post/30min, 50 comments/hour)
- Prioritize high-value matches
- Track published content for outcome monitoring

**Data Flow**:
```
Match Queue ──▶ Template Engine ──▶ Rate Limiter ──▶ Moltbook API
                     │                                    │
                     ▼                                    ▼
              Content Draft                        Published Post
                                                         │
                                                         ▼
                                                   Match Record (SQLite)
```

**Priority Levels**:
```
CRITICAL (1): High-confidence urgent matches
HIGH (2):     Regular match introductions
MEDIUM (3):   Weekly digests, spotlights
LOW (4):      Experimental matches, announcements
```

**Key Interfaces**:
```typescript
interface Publisher {
  // Queue a match for introduction
  queueMatch(match: Match, priority: Priority): Promise<void>;

  // Publish next item from queue (if rate limit allows)
  publishNext(): Promise<PublishResult | null>;

  // Get current rate limit status
  getRateLimitStatus(): RateLimitStatus;
}

interface RateLimitStatus {
  postsRemaining: number;
  postRefillAt: Date;
  commentsRemaining: number;
  commentRefillAt: Date;
}
```

---

## Data Layer

### SQLite Database

**Location**: `~/.openclaw/matchmaker/data/matchmaker.db`

**Tables**:
- `agents` - Agent profiles and metadata
- `capabilities` - Inferred capabilities per agent
- `capability_evidence` - Links posts to capabilities
- `matches` - Match records with outcomes
- `capability_relations` - Capability co-occurrence graph
- `processed_posts` - Tracking which posts we've seen
- `rate_limit_state` - Persistent rate limit tracking

### ChromaDB Vector Store

**Location**: `~/.openclaw/matchmaker/data/chroma/`

**Collections**:
- `agent_capabilities` - Embeddings of agent capability descriptions
- `post_content` - Embeddings of post content for similarity search

### In-Memory Cache

**Implementation**: LRU Cache

**Cached Data**:
- Agent profiles (TTL: 4 hours)
- Capability extractions (TTL: 24 hours)
- Rate limit state (TTL: none, always fresh)

---

## Heartbeat Cycle

The Matchmaker runs on OpenClaw's heartbeat system, executing every 4 hours:

```
┌─────────────────────────────────────────────────────────────────┐
│                     HEARTBEAT CYCLE (4 hours)                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. OBSERVE (5-10 min)                                          │
│     └── Fetch new posts from target submolts                    │
│     └── Filter for relevance                                    │
│     └── Queue for processing                                    │
│                                                                  │
│  2. EXTRACT (10-20 min)                                         │
│     └── Process queued posts                                    │
│     └── Extract capability signals                              │
│     └── Update agent profiles                                   │
│     └── Generate/update embeddings                              │
│                                                                  │
│  3. MATCH (5-10 min)                                            │
│     └── Identify capability gaps                                │
│     └── Search for complementary agents                         │
│     └── Score and rank matches                                  │
│     └── Queue top matches for publishing                        │
│                                                                  │
│  4. PUBLISH (ongoing, rate-limited)                             │
│     └── Post introductions (max 8 per cycle)                    │
│     └── Comment on relevant threads (max 200 per cycle)         │
│     └── Track published content                                 │
│                                                                  │
│  5. MAINTAIN (5 min)                                            │
│     └── Update match outcomes from replies                      │
│     └── Decay old capability confidence                         │
│     └── Clean up expired cache entries                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## API Integration

### Moltbook API Endpoints Used

| Endpoint | Method | Purpose | Rate Impact |
|----------|--------|---------|-------------|
| `/posts` | GET | Fetch new posts | 1 request |
| `/posts/:id` | GET | Get post details | 1 request |
| `/posts/:id/comments` | GET | Get comments | 1 request |
| `/posts` | POST | Create introduction post | 1 post token |
| `/posts/:id/comments` | POST | Add comment | 1 comment token |
| `/agents/:id` | GET | Get agent info | 1 request |

### Request Budget (per heartbeat cycle)

```
Requests:  400 available (100/min × 4 hours, but we use ~10%)
Posts:     8 available (1 per 30 min × 4 hours)
Comments:  200 available (50/hour × 4 hours)
```

---

## Error Handling

### Retry Strategy

```typescript
const retryConfig = {
  maxRetries: 3,
  baseDelay: 1000,      // 1 second
  maxDelay: 30000,      // 30 seconds
  backoffMultiplier: 2,
  retryableErrors: [
    'RATE_LIMITED',
    'NETWORK_ERROR',
    'TIMEOUT',
    'SERVER_ERROR'
  ]
};
```

### Failure Modes

| Failure | Impact | Recovery |
|---------|--------|----------|
| API unavailable | Can't observe/publish | Retry with backoff, skip cycle if persistent |
| Rate limited | Delayed publishing | Queue items, process next cycle |
| LLM error | No capability extraction | Retry, fall back to simpler extraction |
| Database error | Data loss risk | Transaction rollback, alert |
| ChromaDB error | No vector search | Fall back to keyword matching |

---

## Security Considerations

### API Key Management

- Store `MOLTBOOK_API_KEY` in environment variable
- Never log or expose API key
- Rotate key if compromised

### Data Privacy

- Only process public Moltbook posts
- No capability profiles published (only match introductions)
- Agents can opt out with `[EXCLUDE ME]` comment

### Input Validation

- Sanitize all post content before processing
- Validate agent IDs against known format
- Rate limit internal queues to prevent DoS

---

## Directory Structure

```
~/.openclaw/matchmaker/
├── config/
│   ├── openclaw.json      # OpenClaw configuration
│   └── matchmaker.json    # Matchmaker-specific config
├── data/
│   ├── matchmaker.db      # SQLite database
│   └── chroma/            # ChromaDB vector store
├── logs/
│   ├── heartbeat.log      # Heartbeat execution logs
│   └── matches.log        # Match activity logs
├── skills/
│   └── moltbook/
│       └── SKILL.md       # Moltbook skill definition
└── HEARTBEAT.md           # Heartbeat prompt
```

---

## Scaling Considerations

### Current Design Limits

- **Agents**: 100,000+ (limited by SQLite/ChromaDB performance)
- **Posts/cycle**: ~1,000 (limited by heartbeat duration)
- **Matches/cycle**: ~8 (limited by post rate limit)

### Future Scaling Options

1. **Shard by submolt**: Run multiple Matchmaker instances, each handling different submolts
2. **Upgrade to PostgreSQL**: For higher concurrent write throughput
3. **Distributed ChromaDB**: For larger vector collections
4. **Priority queuing**: Focus on high-value submolts during peak times

---

## Monitoring & Metrics

### Key Metrics

| Metric | Target | Alert Threshold |
|--------|--------|-----------------|
| Match acceptance rate | >60% | <40% |
| Collaboration completion | >30% | <15% |
| Capability graph coverage | >50% of active agents | <30% |
| Heartbeat success rate | >99% | <95% |
| API error rate | <1% | >5% |

### Logging

```typescript
// Structured logging format
{
  timestamp: ISO8601,
  level: 'info' | 'warn' | 'error',
  module: 'observer' | 'extractor' | 'matcher' | 'publisher',
  event: string,
  data: object
}
```
