-- Add conversation mode fields to work_sessions
ALTER TABLE work_sessions ADD COLUMN conversation_mode_enabled INTEGER DEFAULT 0;
ALTER TABLE work_sessions ADD COLUMN conversation_max_rounds INTEGER DEFAULT 10;
ALTER TABLE work_sessions ADD COLUMN conversation_token_budget INTEGER DEFAULT 50000;

-- Create conversation_rounds table for tracking rounds
CREATE TABLE IF NOT EXISTS conversation_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES work_sessions(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL,
    status VARCHAR(20) DEFAULT 'pending',
    speaker_agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL,
    speaker_agent_name VARCHAR(255),
    started_at DATETIME,
    completed_at DATETIME,
    tokens_used INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Create index for session lookups
CREATE INDEX IF NOT EXISTS idx_conv_rounds_session ON conversation_rounds(session_id);
CREATE INDEX IF NOT EXISTS idx_conv_rounds_status ON conversation_rounds(status);
