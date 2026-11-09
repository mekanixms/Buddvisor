-- Token context size used by compaction. Null means "not set".
-- Session value is the default. Orchestrator and each assigned agent can override it.

ALTER TABLE work_sessions ADD COLUMN context_tokens INTEGER;
ALTER TABLE work_sessions ADD COLUMN orchestrator_context_tokens INTEGER;
ALTER TABLE session_agents ADD COLUMN context_tokens INTEGER;
