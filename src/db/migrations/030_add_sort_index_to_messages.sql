-- Conversation order is separate from created_at so a summary can be inserted
-- immediately after an older message without changing that message's timestamp.
ALTER TABLE messages ADD COLUMN sort_index REAL;

UPDATE messages SET sort_index = id WHERE sort_index IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_session_sort ON messages(session_id, sort_index);
