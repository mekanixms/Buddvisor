-- Add OpenRouter model id for unified model catalog metadata.
-- This is optional and can be used alongside HF metadata.

ALTER TABLE agents ADD COLUMN openrouter_model_id TEXT;

