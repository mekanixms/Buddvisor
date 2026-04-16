-- Add new columns to tasks table
ALTER TABLE tasks ADD COLUMN assigned_agents TEXT;
ALTER TABLE tasks ADD COLUMN priority VARCHAR(20) DEFAULT 'normal';
ALTER TABLE tasks ADD COLUMN metadata TEXT;

-- Add new columns to task_results table
ALTER TABLE task_results ADD COLUMN result_type VARCHAR(50) DEFAULT 'response';
ALTER TABLE task_results ADD COLUMN result_data TEXT;

-- Create index for priority
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
