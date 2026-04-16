-- Create session_agent_documents junction table
-- This allows assigning specific documents to specific agents within a session.
CREATE TABLE IF NOT EXISTS session_agent_documents (
    session_id INTEGER NOT NULL,
    agent_id INTEGER NOT NULL,
    document_id INTEGER NOT NULL,
    assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (session_id, agent_id, document_id),
    FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_session_agent_documents_session_id ON session_agent_documents(session_id);
CREATE INDEX IF NOT EXISTS idx_session_agent_documents_agent_id ON session_agent_documents(agent_id);
CREATE INDEX IF NOT EXISTS idx_session_agent_documents_document_id ON session_agent_documents(document_id);
