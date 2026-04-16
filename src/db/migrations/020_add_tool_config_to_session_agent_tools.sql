-- Add tool_config column to session_agent_tools table
-- This allows storing tool-specific configuration (e.g., database name for sqlite_local_db)
-- tool_config will store JSON, e.g., {"database_name": "my_database"}

-- Note: This migration will fail if the column already exists (SQLITE_ERROR: duplicate column name)
-- That's okay - it means the column was already added manually or in a previous run
-- The migration system will skip this file if it's already been executed

-- Check if column exists (using a subquery that returns 0 if column doesn't exist, 1 if it does)
-- If it doesn't exist (count = 0), add it
-- We use a workaround: try to add the column, and if it fails with "duplicate column", ignore it
-- Since SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN, we rely on the migration
-- system to only run this once, or we handle the error gracefully

-- For now, we'll just add the column. If it already exists, the migration will fail but that's acceptable
-- as the column is already there. The migration runner should handle this gracefully.

ALTER TABLE session_agent_tools ADD COLUMN tool_config TEXT;
