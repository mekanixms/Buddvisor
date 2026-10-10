-- Orchestrator model capability flags and optional catalog ids.
-- Same shape as agents.hf_model_repo / openrouter_model_id / model_capabilities.
ALTER TABLE work_sessions ADD COLUMN orchestrator_hf_model_repo TEXT;
ALTER TABLE work_sessions ADD COLUMN orchestrator_openrouter_model_id TEXT;
ALTER TABLE work_sessions ADD COLUMN orchestrator_model_capabilities TEXT;
