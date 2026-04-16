-- Session scheduled jobs (cron) for prompt injection or script execution per session
CREATE TABLE IF NOT EXISTS session_scheduled_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL,
    created_by_agent_id INTEGER NULL,
    task_key TEXT NULL,
    schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'interval')),
    schedule_value TEXT NOT NULL,
    task_type TEXT NOT NULL CHECK (task_type IN ('prompt', 'script')),
    prompt_text TEXT NULL,
    script_path TEXT NULL,
    script_args TEXT NULL,
    target_agent_ids TEXT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    next_run_at TEXT NOT NULL,
    last_run_at TEXT NULL,
    last_run_result TEXT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (session_id) REFERENCES work_sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by_agent_id) REFERENCES agents(id) ON DELETE SET NULL,
    UNIQUE (session_id, task_key)
);

CREATE INDEX IF NOT EXISTS idx_session_scheduled_jobs_session_id ON session_scheduled_jobs(session_id);
CREATE INDEX IF NOT EXISTS idx_session_scheduled_jobs_next_run_at ON session_scheduled_jobs(next_run_at);
CREATE INDEX IF NOT EXISTS idx_session_scheduled_jobs_session_task_key ON session_scheduled_jobs(session_id, task_key);
