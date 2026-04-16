-- Add share_token to work_sessions for shareable session links
ALTER TABLE work_sessions ADD COLUMN share_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_sessions_share_token ON work_sessions(share_token) WHERE share_token IS NOT NULL;
