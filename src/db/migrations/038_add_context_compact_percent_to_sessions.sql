-- Session-wide limit for automatic context compaction.
-- Before a prompt is sent, its estimated size is compared with this percentage
-- of that model's context length. Over the limit, the same model summarizes
-- the prior context and the summary replaces the context-window messages.
ALTER TABLE work_sessions ADD COLUMN context_compact_percent INTEGER DEFAULT 70;
