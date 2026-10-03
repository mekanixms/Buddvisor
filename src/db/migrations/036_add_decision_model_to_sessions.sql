-- Optional decision model (Nimble / Jev) for Router-mode orchestrator routing.
-- decision_model_config is encrypted JSON: model, baseURL, apiKey, timeout.
ALTER TABLE work_sessions ADD COLUMN decision_model_enabled INTEGER DEFAULT 0;
ALTER TABLE work_sessions ADD COLUMN decision_model_provider TEXT;
ALTER TABLE work_sessions ADD COLUMN decision_model_config TEXT;
