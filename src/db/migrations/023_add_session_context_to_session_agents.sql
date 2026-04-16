-- Add session_context column to session_agents for per-session agent prompts
-- This allows users to customize agent context for each session, including
-- team members, tools, and documents specific to that session

ALTER TABLE session_agents ADD COLUMN session_context TEXT;
