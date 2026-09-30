-- Enable send_to_telegram for the orchestrator of every existing session.
-- It is an ordinary assignment that can be unchecked in Configure Session Tools.
-- New sessions get the same default from SessionService.createSession.
INSERT OR IGNORE INTO session_orchestrator_tools (session_id, tool_name)
SELECT id, 'send_to_telegram' FROM work_sessions
