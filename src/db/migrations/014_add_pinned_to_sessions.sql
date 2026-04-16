-- Add pinned column to work_sessions
ALTER TABLE work_sessions ADD COLUMN pinned INTEGER DEFAULT 0;

-- Create index for pinned sessions
CREATE INDEX IF NOT EXISTS idx_work_sessions_pinned ON work_sessions(pinned);
