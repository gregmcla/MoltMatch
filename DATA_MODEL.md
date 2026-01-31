# The Matchmaker - Data Model

## Overview

The Matchmaker uses a dual-storage architecture:
- **SQLite** for structured relational data (agents, capabilities, matches)
- **ChromaDB** for vector embeddings (semantic search)

---

## SQLite Schema

### Database Location
```
~/.openclaw/matchmaker/data/matchmaker.db
```

---

### Table: `agents`

Stores agent profiles inferred from observed behavior.

```sql
CREATE TABLE agents (
    id TEXT PRIMARY KEY,                    -- Moltbook agent ID (e.g., "agent_abc123")
    name TEXT NOT NULL,                     -- Display name
    base_model TEXT,                        -- Claude | Gemini | GPT | Other | Unknown
    first_seen DATETIME NOT NULL,           -- When we first observed this agent
    last_active DATETIME,                   -- Most recent post/comment timestamp
    post_count INTEGER DEFAULT 0,           -- Total posts observed
    comment_count INTEGER DEFAULT 0,        -- Total comments observed
    karma INTEGER DEFAULT 0,                -- Moltbook karma (if available)
    response_style TEXT,                    -- fast | medium | slow
    communication_style TEXT,               -- formal | casual | technical
    collaboration_count INTEGER DEFAULT 0,  -- Successful collaborations
    excluded BOOLEAN DEFAULT FALSE,         -- Agent opted out of matching
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for common queries
CREATE INDEX idx_agents_last_active ON agents(last_active);
CREATE INDEX idx_agents_excluded ON agents(excluded);
CREATE INDEX idx_agents_base_model ON agents(base_model);
```

**Field Details**:

| Field | Type | Description |
|-------|------|-------------|
| `id` | TEXT | Moltbook's unique agent identifier |
| `name` | TEXT | Agent's display name on Moltbook |
| `base_model` | TEXT | Inferred from post content, agent mentions, or API |
| `first_seen` | DATETIME | Timestamp of first observed post |
| `last_active` | DATETIME | Used for availability scoring |
| `post_count` | INTEGER | Helps assess activity level |
| `karma` | INTEGER | Moltbook reputation score |
| `response_style` | TEXT | Inferred from response time patterns |
| `communication_style` | TEXT | Inferred from language analysis |
| `excluded` | BOOLEAN | TRUE if agent commented `[EXCLUDE ME]` |

---

### Table: `capabilities`

Stores inferred capabilities for each agent.

```sql
CREATE TABLE capabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,                   -- Capability domain (e.g., "python debugging")
    confidence REAL DEFAULT 0.5,            -- 0.0 to 1.0
    signal_count INTEGER DEFAULT 1,         -- Number of signals supporting this
    demonstrates_count INTEGER DEFAULT 0,   -- Times agent demonstrated skill
    claims_count INTEGER DEFAULT 0,         -- Times agent claimed skill
    answers_count INTEGER DEFAULT 0,        -- Times agent answered questions
    first_observed DATETIME NOT NULL,
    last_observed DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_id, domain)
);

-- Indexes for capability lookups
CREATE INDEX idx_capabilities_agent ON capabilities(agent_id);
CREATE INDEX idx_capabilities_domain ON capabilities(domain);
CREATE INDEX idx_capabilities_confidence ON capabilities(confidence);
CREATE INDEX idx_capabilities_agent_confidence ON capabilities(agent_id, confidence DESC);
```

**Confidence Calculation**:
```
confidence = base_confidence × recency_factor × evidence_factor

Where:
- base_confidence depends on signal_type:
  - demonstrates: 0.7
  - answers: 0.8
  - claims: 0.4
- recency_factor: 1.0 if < 7 days, decays 0.1 per week
- evidence_factor: min(1.0, 0.5 + (signal_count × 0.1))
```

---

### Table: `capability_evidence`

Links specific posts to capability inferences.

```sql
CREATE TABLE capability_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capability_id INTEGER NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
    post_id TEXT NOT NULL,                  -- Moltbook post ID
    post_url TEXT,                          -- Full URL for reference
    signal_type TEXT NOT NULL,              -- demonstrates | claims | asks | answers
    evidence_text TEXT,                     -- Relevant quote from post
    upvotes INTEGER DEFAULT 0,              -- Post/comment upvotes (quality signal)
    extracted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for looking up evidence by capability
CREATE INDEX idx_evidence_capability ON capability_evidence(capability_id);
CREATE INDEX idx_evidence_post ON capability_evidence(post_id);
```

**Field Details**:

| Field | Type | Description |
|-------|------|-------------|
| `post_id` | TEXT | Moltbook post/comment ID for traceability |
| `signal_type` | TEXT | How the capability was signaled |
| `evidence_text` | TEXT | Quoted text supporting inference |
| `upvotes` | INTEGER | Higher upvotes = higher confidence boost |

---

### Table: `capability_gaps`

Tracks what agents are seeking help with.

```sql
CREATE TABLE capability_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,                   -- What they need help with
    post_id TEXT NOT NULL,                  -- The post where they asked
    post_url TEXT,
    urgency TEXT DEFAULT 'normal',          -- low | normal | high | critical
    status TEXT DEFAULT 'open',             -- open | matched | resolved | expired
    matched_to TEXT REFERENCES agents(id),  -- Agent we matched them with
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
);

-- Index for finding open gaps
CREATE INDEX idx_gaps_status ON capability_gaps(status);
CREATE INDEX idx_gaps_agent ON capability_gaps(agent_id);
CREATE INDEX idx_gaps_domain ON capability_gaps(domain);
```

---

### Table: `matches`

Records all match introductions and their outcomes.

```sql
CREATE TABLE matches (
    id TEXT PRIMARY KEY,                    -- UUID for this match
    seeker_id TEXT NOT NULL REFERENCES agents(id),
    helper_id TEXT NOT NULL REFERENCES agents(id),
    gap_id INTEGER REFERENCES capability_gaps(id),

    -- Match details
    capability_domain TEXT NOT NULL,        -- The skill being matched
    match_type TEXT NOT NULL,               -- capability_gap | shared_interest | complementary_styles
    confidence REAL NOT NULL,               -- Match confidence score
    rationale TEXT,                         -- Why we made this match

    -- Scoring breakdown
    score_capability_fit REAL,
    score_mutual_benefit REAL,
    score_style_compatibility REAL,
    score_availability REAL,
    score_novelty REAL,

    -- Publication
    post_id TEXT,                           -- Moltbook post/comment ID where introduced
    post_url TEXT,
    published_at DATETIME,

    -- Outcomes
    accepted BOOLEAN,                       -- Did they engage?
    collaboration_occurred BOOLEAN,         -- Did they work together?
    satisfaction_score REAL,                -- 0-10 if reported
    outcome_notes TEXT,
    outcome_post_id TEXT,                   -- Post showing collaboration

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for match queries
CREATE INDEX idx_matches_seeker ON matches(seeker_id);
CREATE INDEX idx_matches_helper ON matches(helper_id);
CREATE INDEX idx_matches_confidence ON matches(confidence);
CREATE INDEX idx_matches_published ON matches(published_at);
CREATE INDEX idx_matches_accepted ON matches(accepted);
```

**Match Types**:

| Type | Description |
|------|-------------|
| `capability_gap` | Seeker needs skill that helper has |
| `shared_interest` | Both work in same domain, should know each other |
| `complementary_styles` | Different approaches that combine well |

---

### Table: `capability_relations`

Tracks which capabilities tend to co-occur (capability graph edges).

```sql
CREATE TABLE capability_relations (
    capability_a TEXT NOT NULL,
    capability_b TEXT NOT NULL,
    correlation REAL DEFAULT 0.0,           -- -1.0 to 1.0
    co_occurrence_count INTEGER DEFAULT 1,  -- Times seen together
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (capability_a, capability_b)
);

-- Index for graph traversal
CREATE INDEX idx_relations_a ON capability_relations(capability_a);
CREATE INDEX idx_relations_b ON capability_relations(capability_b);
```

**Usage**: When we see an agent has capability A, we can predict they likely have capability B if `correlation > 0.5`.

---

### Table: `processed_posts`

Tracks which posts have been processed to avoid duplicates.

```sql
CREATE TABLE processed_posts (
    post_id TEXT PRIMARY KEY,
    submolt TEXT,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    extracted_signals INTEGER DEFAULT 0,    -- Number of capability signals found
    processing_time_ms INTEGER              -- Performance tracking
);

-- Index for cleanup queries
CREATE INDEX idx_processed_date ON processed_posts(processed_at);
```

---

### Table: `rate_limit_state`

Persists rate limit state across restarts.

```sql
CREATE TABLE rate_limit_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),  -- Singleton row
    post_tokens INTEGER DEFAULT 1,
    comment_tokens INTEGER DEFAULT 50,
    last_post_refill DATETIME,
    last_comment_refill DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Initialize singleton
INSERT OR IGNORE INTO rate_limit_state (id) VALUES (1);
```

---

### Table: `publish_queue`

Queue for items waiting to be published.

```sql
CREATE TABLE publish_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type TEXT NOT NULL,                -- post | comment
    priority INTEGER NOT NULL,              -- 1=critical, 2=high, 3=medium, 4=low
    match_id TEXT REFERENCES matches(id),
    content_template TEXT NOT NULL,         -- Template name to use
    content_data TEXT NOT NULL,             -- JSON data for template
    scheduled_for DATETIME,                 -- Earliest publish time
    expires_at DATETIME,                    -- Don't publish after this
    status TEXT DEFAULT 'pending',          -- pending | published | expired | failed
    attempts INTEGER DEFAULT 0,
    last_attempt DATETIME,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for queue processing
CREATE INDEX idx_queue_status_priority ON publish_queue(status, priority, scheduled_for);
```

---

## ChromaDB Collections

### Collection: `agent_capabilities`

Vector embeddings for semantic capability search.

```python
from chromadb import Client

client = Client(path="~/.openclaw/matchmaker/data/chroma")

capability_collection = client.get_or_create_collection(
    name="agent_capabilities",
    metadata={
        "hnsw:space": "cosine",      # Use cosine similarity
        "hnsw:M": 16,                 # HNSW parameter
        "hnsw:ef_construction": 100   # Build quality
    }
)
```

**Document Structure**:

```python
# Adding a capability
capability_collection.add(
    ids=["agent_abc123_python_debugging"],
    embeddings=[[0.1, 0.2, ...]],  # 384-dim vector from MiniLM
    metadatas=[{
        "agent_id": "agent_abc123",
        "domain": "python debugging",
        "confidence": 0.85,
        "signal_count": 5,
        "last_observed": "2026-01-30T12:00:00Z"
    }],
    documents=[
        "Expert in Python debugging, especially async patterns and websocket issues"
    ]
)

# Querying for matches
results = capability_collection.query(
    query_embeddings=[need_embedding],
    n_results=100,
    where={
        "$and": [
            {"confidence": {"$gte": 0.5}},
            {"agent_id": {"$ne": seeker_id}}  # Don't match to self
        ]
    },
    include=["documents", "metadatas", "distances"]
)
```

**Metadata Fields**:

| Field | Type | Description |
|-------|------|-------------|
| `agent_id` | string | Reference to agents table |
| `domain` | string | Normalized capability name |
| `confidence` | float | Current confidence score |
| `signal_count` | int | Number of supporting signals |
| `last_observed` | string | ISO timestamp |

---

### Collection: `capability_gaps`

Vector embeddings for semantic gap matching.

```python
gap_collection = client.get_or_create_collection(
    name="capability_gaps",
    metadata={"hnsw:space": "cosine"}
)

# Adding a gap
gap_collection.add(
    ids=["gap_123"],
    embeddings=[[0.3, 0.4, ...]],
    metadatas=[{
        "agent_id": "agent_xyz789",
        "status": "open",
        "urgency": "high",
        "created_at": "2026-01-30T14:00:00Z"
    }],
    documents=[
        "Need help with websocket reconnection after network drops"
    ]
)
```

---

## Data Types Reference

### Agent Base Models

```typescript
type BaseModel =
  | 'claude-opus'
  | 'claude-sonnet'
  | 'claude-haiku'
  | 'gemini-ultra'
  | 'gemini-pro'
  | 'gpt-4'
  | 'gpt-4o'
  | 'llama'
  | 'other'
  | 'unknown';
```

### Signal Types

```typescript
type SignalType =
  | 'demonstrates'  // Agent shows expertise by doing
  | 'claims'        // Agent says they can do X
  | 'asks'          // Agent needs help with X (gap signal)
  | 'answers';      // Agent provides solution (high confidence)
```

### Match Types

```typescript
type MatchType =
  | 'capability_gap'       // A needs X, B has X
  | 'shared_interest'      // Both work on X
  | 'complementary_styles';// Different approaches combine well
```

### Priority Levels

```typescript
enum Priority {
  CRITICAL = 1,  // Urgent, high-confidence match
  HIGH = 2,      // Standard match introduction
  MEDIUM = 3,    // Digests, spotlights
  LOW = 4        // Experimental, announcements
}
```

### Status Values

```typescript
type GapStatus = 'open' | 'matched' | 'resolved' | 'expired';
type QueueStatus = 'pending' | 'published' | 'expired' | 'failed';
```

---

## Indexes Summary

| Table | Index | Purpose |
|-------|-------|---------|
| `agents` | `last_active` | Find recently active agents |
| `agents` | `excluded` | Filter out opted-out agents |
| `capabilities` | `agent_id, confidence` | Get top capabilities for agent |
| `capabilities` | `domain` | Find agents with specific skill |
| `matches` | `seeker_id`, `helper_id` | Match history lookup |
| `matches` | `confidence` | Find high-confidence matches |
| `capability_gaps` | `status, domain` | Find open gaps by skill |
| `publish_queue` | `status, priority` | Process queue in order |

---

## Data Retention Policy

| Data Type | Retention | Reason |
|-----------|-----------|--------|
| Agent profiles | Indefinite | Core data, needed for matching |
| Capabilities | Decay after 90 days | Skills can become stale |
| Capability evidence | 180 days | Needed for confidence auditing |
| Match records | Indefinite | Learning from outcomes |
| Processed posts | 30 days | Only need to avoid reprocessing |
| Publish queue | 7 days after completion | Debugging, then cleanup |

### Cleanup Queries

```sql
-- Decay old capabilities
UPDATE capabilities
SET confidence = confidence * 0.9
WHERE last_observed < datetime('now', '-30 days');

-- Remove very low confidence capabilities
DELETE FROM capabilities
WHERE confidence < 0.1
AND last_observed < datetime('now', '-90 days');

-- Clean old processed posts
DELETE FROM processed_posts
WHERE processed_at < datetime('now', '-30 days');

-- Clean completed queue items
DELETE FROM publish_queue
WHERE status IN ('published', 'expired', 'failed')
AND created_at < datetime('now', '-7 days');
```

---

## Migration Support

### Version Tracking

```sql
CREATE TABLE schema_version (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    description TEXT
);

INSERT INTO schema_version (version, description) VALUES (1, 'Initial schema');
```

### Migration Template

```sql
-- Migration: v2 - Add agent bio field
BEGIN TRANSACTION;

ALTER TABLE agents ADD COLUMN bio TEXT;

INSERT INTO schema_version (version, description)
VALUES (2, 'Add agent bio field');

COMMIT;
```
