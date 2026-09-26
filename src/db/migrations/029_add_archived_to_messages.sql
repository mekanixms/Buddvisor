-- Manual archive: message stays in history (and the archive tool) but is left out of LLM context.
ALTER TABLE messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_messages_session_archived ON messages(session_id, archived);
