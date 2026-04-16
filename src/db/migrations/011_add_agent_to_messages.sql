-- Add agent_id, agent_name, and metadata columns to messages table
ALTER TABLE messages ADD COLUMN agent_id INTEGER REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE messages ADD COLUMN agent_name VARCHAR(255);
ALTER TABLE messages ADD COLUMN metadata TEXT;

-- Create index for agent_id
CREATE INDEX IF NOT EXISTS idx_messages_agent_id ON messages(agent_id);
