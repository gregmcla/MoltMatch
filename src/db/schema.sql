-- The Matchmaker Database Schema
-- Version: 1

-- ============================================================================
-- Schema Version Tracking
-- ============================================================================

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    description TEXT
);

INSERT OR IGNORE INTO schema_version (version, description)
VALUES (1, 'Initial schema');

-- ============================================================================
-- Agent Profiles
-- ============================================================================

CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_model TEXT DEFAULT 'unknown',
    first_seen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active DATETIME,
    post_count INTEGER DEFAULT 0,
    comment_count INTEGER DEFAULT 0,
    karma INTEGER DEFAULT 0,
    response_style TEXT,
    communication_style TEXT,
    collaboration_count INTEGER DEFAULT 0,
    excluded BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agents_last_active ON agents(last_active);
CREATE INDEX IF NOT EXISTS idx_agents_excluded ON agents(excluded);
CREATE INDEX IF NOT EXISTS idx_agents_base_model ON agents(base_model);

-- ============================================================================
-- Capabilities (Inferred Skills)
-- ============================================================================

CREATE TABLE IF NOT EXISTS capabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    confidence REAL DEFAULT 0.5,
    signal_count INTEGER DEFAULT 1,
    demonstrates_count INTEGER DEFAULT 0,
    claims_count INTEGER DEFAULT 0,
    answers_count INTEGER DEFAULT 0,
    first_observed DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_observed DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_capabilities_agent ON capabilities(agent_id);
CREATE INDEX IF NOT EXISTS idx_capabilities_domain ON capabilities(domain);
CREATE INDEX IF NOT EXISTS idx_capabilities_confidence ON capabilities(confidence);
CREATE INDEX IF NOT EXISTS idx_capabilities_agent_confidence ON capabilities(agent_id, confidence DESC);

-- ============================================================================
-- Capability Evidence (Links Posts to Capabilities)
-- ============================================================================

CREATE TABLE IF NOT EXISTS capability_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capability_id INTEGER NOT NULL REFERENCES capabilities(id) ON DELETE CASCADE,
    post_id TEXT NOT NULL,
    post_url TEXT,
    signal_type TEXT NOT NULL,
    evidence_text TEXT,
    upvotes INTEGER DEFAULT 0,
    extracted_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_evidence_capability ON capability_evidence(capability_id);
CREATE INDEX IF NOT EXISTS idx_evidence_post ON capability_evidence(post_id);

-- ============================================================================
-- Capability Gaps (What Agents Need Help With)
-- ============================================================================

CREATE TABLE IF NOT EXISTS capability_gaps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    domain TEXT NOT NULL,
    post_id TEXT NOT NULL,
    post_url TEXT,
    urgency TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'open',
    matched_to TEXT REFERENCES agents(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolved_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_gaps_status ON capability_gaps(status);
CREATE INDEX IF NOT EXISTS idx_gaps_agent ON capability_gaps(agent_id);
CREATE INDEX IF NOT EXISTS idx_gaps_domain ON capability_gaps(domain);

-- ============================================================================
-- Matches (Introduction Records)
-- ============================================================================

CREATE TABLE IF NOT EXISTS matches (
    id TEXT PRIMARY KEY,
    seeker_id TEXT NOT NULL REFERENCES agents(id),
    helper_id TEXT NOT NULL REFERENCES agents(id),
    gap_id INTEGER REFERENCES capability_gaps(id),
    capability_domain TEXT NOT NULL,
    match_type TEXT NOT NULL,
    confidence REAL NOT NULL,
    rationale TEXT,
    score_capability_fit REAL,
    score_mutual_benefit REAL,
    score_style_compatibility REAL,
    score_availability REAL,
    score_novelty REAL,
    post_id TEXT,
    post_url TEXT,
    published_at DATETIME,
    accepted BOOLEAN,
    collaboration_occurred BOOLEAN,
    satisfaction_score REAL,
    outcome_notes TEXT,
    outcome_post_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_matches_seeker ON matches(seeker_id);
CREATE INDEX IF NOT EXISTS idx_matches_helper ON matches(helper_id);
CREATE INDEX IF NOT EXISTS idx_matches_confidence ON matches(confidence);
CREATE INDEX IF NOT EXISTS idx_matches_published ON matches(published_at);
CREATE INDEX IF NOT EXISTS idx_matches_accepted ON matches(accepted);

-- ============================================================================
-- Capability Relations (Co-occurrence Graph)
-- ============================================================================

CREATE TABLE IF NOT EXISTS capability_relations (
    capability_a TEXT NOT NULL,
    capability_b TEXT NOT NULL,
    correlation REAL DEFAULT 0.0,
    co_occurrence_count INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (capability_a, capability_b)
);

CREATE INDEX IF NOT EXISTS idx_relations_a ON capability_relations(capability_a);
CREATE INDEX IF NOT EXISTS idx_relations_b ON capability_relations(capability_b);

-- ============================================================================
-- Processed Posts (Deduplication)
-- ============================================================================

CREATE TABLE IF NOT EXISTS processed_posts (
    post_id TEXT PRIMARY KEY,
    submolt TEXT,
    processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    extracted_signals INTEGER DEFAULT 0,
    processing_time_ms INTEGER
);

CREATE INDEX IF NOT EXISTS idx_processed_date ON processed_posts(processed_at);

-- ============================================================================
-- Rate Limit State (Persistent)
-- ============================================================================

CREATE TABLE IF NOT EXISTS rate_limit_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    post_tokens INTEGER DEFAULT 1,
    comment_tokens INTEGER DEFAULT 50,
    last_post_refill DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_comment_refill DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO rate_limit_state (id) VALUES (1);

-- ============================================================================
-- Publish Queue
-- ============================================================================

CREATE TABLE IF NOT EXISTS publish_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_type TEXT NOT NULL,
    priority INTEGER NOT NULL,
    match_id TEXT REFERENCES matches(id),
    template_id TEXT NOT NULL,
    template_data TEXT NOT NULL,
    target_post_id TEXT,
    scheduled_for DATETIME,
    expires_at DATETIME,
    status TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    last_attempt DATETIME,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_queue_status_priority ON publish_queue(status, priority, scheduled_for);

-- ============================================================================
-- Learning: Reflections
-- ============================================================================

CREATE TABLE IF NOT EXISTS reflections (
    id TEXT PRIMARY KEY,
    timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    trigger TEXT NOT NULL,
    heartbeat_id TEXT,
    summary TEXT NOT NULL,
    what_worked_well TEXT,      -- JSON array
    what_surprised TEXT,         -- JSON array
    what_would_do_differently TEXT, -- JSON array
    pattern_observations TEXT,   -- JSON array
    match_assessments TEXT,      -- JSON array
    extraction_notes TEXT,       -- JSON array
    confidence REAL DEFAULT 0.7,
    tags TEXT,                   -- JSON array
    file_path TEXT,              -- Path to YAML file
    consolidated_into TEXT,      -- Links to insight that consumed this
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_reflections_timestamp ON reflections(timestamp);
CREATE INDEX IF NOT EXISTS idx_reflections_trigger ON reflections(trigger);
CREATE INDEX IF NOT EXISTS idx_reflections_consolidated ON reflections(consolidated_into);

-- ============================================================================
-- Learning: Pattern Observations (extracted from reflections)
-- ============================================================================

CREATE TABLE IF NOT EXISTS pattern_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reflection_id TEXT NOT NULL REFERENCES reflections(id) ON DELETE CASCADE,
    pattern TEXT NOT NULL,
    frequency TEXT NOT NULL,
    domain TEXT,
    actionable BOOLEAN DEFAULT FALSE,
    suggested_action TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_patterns_domain ON pattern_observations(domain);
CREATE INDEX IF NOT EXISTS idx_patterns_actionable ON pattern_observations(actionable);

-- ============================================================================
-- Learning: Insights (consolidated from reflections)
-- ============================================================================

CREATE TABLE IF NOT EXISTS insights (
    id TEXT PRIMARY KEY,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source_reflection_ids TEXT NOT NULL,  -- JSON array
    category TEXT NOT NULL,               -- 'matching', 'extraction', 'patterns', 'publishing', 'quality'
    insight_text TEXT NOT NULL,
    strength REAL DEFAULT 0.5,
    action_taken BOOLEAN DEFAULT FALSE,
    promoted_to_principle BOOLEAN DEFAULT FALSE,
    last_referenced DATETIME
);

CREATE INDEX IF NOT EXISTS idx_insights_category ON insights(category);
CREATE INDEX IF NOT EXISTS idx_insights_strength ON insights(strength);
CREATE INDEX IF NOT EXISTS idx_insights_promoted ON insights(promoted_to_principle);

-- ============================================================================
-- Learning: Principles (promoted from insights)
-- ============================================================================

CREATE TABLE IF NOT EXISTS principles (
    id TEXT PRIMARY KEY,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    source_insight_ids TEXT NOT NULL,     -- JSON array
    category TEXT NOT NULL,               -- 'matching', 'extraction', 'publishing', 'general'
    principle_text TEXT NOT NULL,
    weight REAL DEFAULT 1.0,
    active BOOLEAN DEFAULT TRUE,
    validation_count INTEGER DEFAULT 0,
    invalidation_count INTEGER DEFAULT 0,
    last_validated DATETIME
);

CREATE INDEX IF NOT EXISTS idx_principles_category ON principles(category);
CREATE INDEX IF NOT EXISTS idx_principles_active ON principles(active);
CREATE INDEX IF NOT EXISTS idx_principles_weight ON principles(weight DESC);

-- ============================================================================
-- Learning: Heartbeat Counter (for milestone reflections)
-- ============================================================================

CREATE TABLE IF NOT EXISTS learning_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    heartbeat_count INTEGER DEFAULT 0,
    last_consolidation DATETIME,
    last_reflection DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO learning_state (id) VALUES (1);

-- ============================================================================
-- Triggers for updated_at
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS agents_updated_at
    AFTER UPDATE ON agents
    BEGIN
        UPDATE agents SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS capabilities_updated_at
    AFTER UPDATE ON capabilities
    BEGIN
        UPDATE capabilities SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS matches_updated_at
    AFTER UPDATE ON matches
    BEGIN
        UPDATE matches SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS capability_relations_updated_at
    AFTER UPDATE ON capability_relations
    BEGIN
        UPDATE capability_relations SET updated_at = CURRENT_TIMESTAMP
        WHERE capability_a = NEW.capability_a AND capability_b = NEW.capability_b;
    END;

CREATE TRIGGER IF NOT EXISTS rate_limit_state_updated_at
    AFTER UPDATE ON rate_limit_state
    BEGIN
        UPDATE rate_limit_state SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS principles_updated_at
    AFTER UPDATE ON principles
    BEGIN
        UPDATE principles SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

CREATE TRIGGER IF NOT EXISTS learning_state_updated_at
    AFTER UPDATE ON learning_state
    BEGIN
        UPDATE learning_state SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
    END;

-- ============================================================================
-- Local Vector Store (SQLite-based embeddings)
-- ============================================================================

CREATE TABLE IF NOT EXISTS capability_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    capability_id INTEGER REFERENCES capabilities(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(agent_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_embeddings_agent ON capability_embeddings(agent_id);
CREATE INDEX IF NOT EXISTS idx_embeddings_domain ON capability_embeddings(domain);

CREATE TABLE IF NOT EXISTS gap_embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    gap_id INTEGER NOT NULL REFERENCES capability_gaps(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL,
    domain TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(gap_id)
);

CREATE INDEX IF NOT EXISTS idx_gap_embeddings_gap ON gap_embeddings(gap_id);

-- ============================================================================
-- Match Interactions (for Feedback Loop)
-- ============================================================================

CREATE TABLE IF NOT EXISTS match_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
    interaction_type TEXT NOT NULL,  -- 'reply', 'upvote', 'mention', 'collaboration_signal'
    actor_id TEXT NOT NULL,          -- Who performed the interaction
    post_id TEXT,                    -- Related post if applicable
    comment_id TEXT,                 -- Related comment if applicable
    sentiment TEXT,                  -- 'positive', 'neutral', 'negative'
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_interactions_match ON match_interactions(match_id);
CREATE INDEX IF NOT EXISTS idx_interactions_actor ON match_interactions(actor_id);
CREATE INDEX IF NOT EXISTS idx_interactions_type ON match_interactions(interaction_type);

-- ============================================================================
-- Match Requests (for Request-a-Match feature)
-- ============================================================================

CREATE TABLE IF NOT EXISTS match_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requester_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    comment_id TEXT,
    request_text TEXT NOT NULL,
    parsed_domain TEXT,              -- Extracted skill/domain they're seeking
    priority TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'pending',   -- 'pending', 'processed', 'fulfilled', 'expired'
    response_post_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    processed_at DATETIME
);

CREATE INDEX IF NOT EXISTS idx_requests_status ON match_requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_requester ON match_requests(requester_id);

-- ============================================================================
-- Own Posts Tracking (for engagement notifications)
-- ============================================================================

CREATE TABLE IF NOT EXISTS own_posts (
    post_id TEXT PRIMARY KEY,
    post_type TEXT NOT NULL,            -- 'match_introduction', 'fallback_post', 'introduction', etc.
    title TEXT,
    submolt TEXT,
    last_known_comment_count INTEGER DEFAULT 0,
    last_known_upvotes INTEGER DEFAULT 0,
    last_checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_own_posts_type ON own_posts(post_type);
CREATE INDEX IF NOT EXISTS idx_own_posts_created ON own_posts(created_at DESC);

-- ============================================================================
-- Seen Comments (to avoid duplicate notifications)
-- ============================================================================

CREATE TABLE IF NOT EXISTS seen_comments (
    comment_id TEXT PRIMARY KEY,
    post_id TEXT NOT NULL,
    author_id TEXT NOT NULL,
    author_name TEXT,
    content TEXT,
    seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_seen_comments_post ON seen_comments(post_id);

-- ============================================================================
-- Karma Tracking
-- ============================================================================

CREATE TABLE IF NOT EXISTS karma_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    karma INTEGER NOT NULL,
    recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_karma_recorded ON karma_history(recorded_at DESC);
