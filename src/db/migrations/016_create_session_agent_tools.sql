-- Create session_agent_tools junction table
-- This allows assigning specific tools to specific agents within a session.
CREATE TABLE IF NOT EXISTS session_agent_tools (
    session_id INTEGER NOT NULL,
    agent_id INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, agent_id, tool_name),
    FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_session_agent_tools_session_id ON session_agent_tools(session_id);
CREATE INDEX IF NOT EXISTS idx_session_agent_tools_agent_id ON session_agent_tools(agent_id);
CREATE INDEX IF NOT EXISTS idx_session_agent_tools_tool_name ON session_agent_tools(tool_name);
