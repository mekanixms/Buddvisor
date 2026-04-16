-- Add tool_config column to session_orchestrator_tools table
-- This allows storing tool-specific configuration (e.g., database_name for sqlite_local_db, folder_name for local_working_folder)
-- tool_config will store JSON, e.g., {"database_name": "my_database"} or {"folder_name": "my_workspace"}

-- Check if column already exists (for idempotency)
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN, so we use a try-catch approach
-- If the column exists, this will fail silently in the migration runner

ALTER TABLE session_orchestrator_tools ADD COLUMN tool_config TEXT;
