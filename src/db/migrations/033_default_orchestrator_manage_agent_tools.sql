-- Enable manage_agent_tools for the orchestrator of every existing session.
-- It is an ordinary assignment that can be unchecked in Configure Session Tools.
-- New sessions get the same default from SessionService.createSession.
INSERT OR IGNORE INTO session_orchestrator_tools (session_id, tool_name)
SELECT id, 'manage_agent_tools' FROM work_sessions
