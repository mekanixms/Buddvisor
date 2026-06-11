-- Add orchestration mode to work_sessions
-- Values: 'route' (classic routing to agents with their own history)
--         'orchestrator_led' (orchestrator is lead agent, delegates briefs to agents)
ALTER TABLE work_sessions ADD COLUMN orchestration_mode TEXT DEFAULT 'route';
