-- Hugging Face model metadata + derived capabilities (JSON) for agents
ALTER TABLE agents ADD COLUMN hf_model_repo TEXT;
ALTER TABLE agents ADD COLUMN model_capabilities TEXT;
