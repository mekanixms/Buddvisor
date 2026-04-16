-- Create session_orchestrator_tools table
-- This allows assigning specific tools to the orchestrator within a session.
CREATE TABLE IF NOT EXISTS session_orchestrator_tools (
    session_id INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, tool_name),
    FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_session_orchestrator_tools_session_id ON session_orchestrator_tools(session_id);
CREATE INDEX IF NOT EXISTS idx_session_orchestrator_tools_tool_name ON session_orchestrator_tools(tool_name);
