-- Create session_agents junction table
CREATE TABLE IF NOT EXISTS session_agents (
    session_id INTEGER NOT NULL,
    agent_id INTEGER NOT NULL,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, agent_id),
    FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_session_agents_session_id ON session_agents(session_id);
CREATE INDEX IF NOT EXISTS idx_session_agents_agent_id ON session_agents(agent_id);
