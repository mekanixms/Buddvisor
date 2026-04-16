-- Add inbound webhook settings to work_sessions
-- Used to securely accept external HTTP requests (e.g., from n8n) and turn them into chat prompts.

ALTER TABLE work_sessions ADD COLUMN inbound_webhook_enabled BOOLEAN DEFAULT 0;
ALTER TABLE work_sessions ADD COLUMN inbound_webhook_secret_hash TEXT;
