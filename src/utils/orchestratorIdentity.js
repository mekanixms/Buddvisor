/**
 * Each session orchestrator has a numeric id, the same kind of value tools
 * already key on for session agents. It is the negation of the session id, so
 * it is stable, unique per session, and cannot collide with agents.id
 * (positive AUTOINCREMENT). Tool config still lives in session_orchestrator_tools.
 * Saved chat messages keep agent_id null for the orchestrator.
 */

function orchestratorAgentId(sessionId) {
  const id = Number(sessionId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return -id;
}

function isOrchestratorAgentId(agentId) {
  const n = Number(agentId);
  return Number.isInteger(n) && n < 0;
}

/**
 * True when this tool call is the session orchestrator.
 * A missing agentId is still the orchestrator, which is how older callers
 * identified it. A negative id is the orchestrator's own id.
 * @param {object} context
 * @returns {boolean}
 */
function isOrchestratorContext(context) {
  if (!context || typeof context !== 'object') return false;
  if (context.isOrchestrator === true) return true;
  if (context.agentId == null || context.agentId === '') return true;
  return isOrchestratorAgentId(context.agentId);
}

/**
 * Agent id to pass into path helpers that treat null as the orchestrator.
 * Keeps existing orchestrator workspaces and databases on their current paths.
 * @param {number|null|undefined} agentId
 * @returns {number|null}
 */
function workspaceAgentId(agentId) {
  if (agentId == null || agentId === '' || isOrchestratorAgentId(agentId)) return null;
  return agentId;
}

/**
 * Tool-execution context for the session orchestrator.
 * @param {object} session
 * @param {object} [extra]
 * @returns {object}
 */
function orchestratorToolContext(session, extra = {}) {
  return {
    ...extra,
    userId: session.user_id,
    sessionId: session.id,
    agentId: orchestratorAgentId(session.id),
    isOrchestrator: true,
  };
}

module.exports = {
  orchestratorAgentId,
  isOrchestratorAgentId,
  isOrchestratorContext,
  workspaceAgentId,
  orchestratorToolContext,
};
