/**
 * Per-actor input/output token accounting for a single answer.
 * Providers report usage.input_tokens and usage.output_tokens; these helpers
 * keep that split through tool loops, routing, and delegation.
 */

function zeroUsage() {
  return { inputTokens: 0, outputTokens: 0, tokensUsed: 0 };
}

/**
 * Read a normalized provider response usage block.
 * @param {object} response
 * @returns {{ inputTokens: number, outputTokens: number, tokensUsed: number }}
 */
function usageFromResponse(response) {
  let inputTokens = response?.usage?.input_tokens || 0;
  let outputTokens = response?.usage?.output_tokens || 0;
  const tokensUsed = response?.usage?.total_tokens || (inputTokens + outputTokens);
  if (inputTokens === 0 && outputTokens === 0 && tokensUsed > 0) {
    outputTokens = tokensUsed;
  }
  return { inputTokens, outputTokens, tokensUsed };
}

/**
 * One actor's tokens for a prompt (orchestrator when agentId is null).
 * Accepts either camelCase tool-loop totals or already-normalized rows.
 */
function tokenRow(agentId, agentName, usage = {}) {
  const src = usage || {};
  return {
    agent_id: agentId == null ? null : agentId,
    agent_name: agentName || (agentId == null ? 'Orchestrator' : 'Agent'),
    input_tokens: src.inputTokens ?? src.input_tokens ?? 0,
    output_tokens: src.outputTokens ?? src.output_tokens ?? 0,
  };
}

/**
 * Sum rows that belong to the same actor. Drops actors with no recorded tokens.
 * Orchestrator rows (agent_id null) collapse together; each agent id collapses together.
 * @param {Array<object>} rows
 * @returns {Array<{ agent_id: number|null, agent_name: string, input_tokens: number, output_tokens: number }>}
 */
function mergeTokenRows(rows) {
  const map = new Map();
  for (const row of rows || []) {
    if (!row) continue;
    const key = row.agent_id == null ? 'orch' : `agent:${row.agent_id}`;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, {
        agent_id: row.agent_id == null ? null : row.agent_id,
        agent_name: row.agent_name || (row.agent_id == null ? 'Orchestrator' : 'Agent'),
        input_tokens: row.input_tokens || 0,
        output_tokens: row.output_tokens || 0,
      });
    } else {
      existing.input_tokens += row.input_tokens || 0;
      existing.output_tokens += row.output_tokens || 0;
      if (row.agent_name) existing.agent_name = row.agent_name;
    }
  }
  return [...map.values()].filter((row) => row.input_tokens > 0 || row.output_tokens > 0);
}

module.exports = {
  zeroUsage,
  usageFromResponse,
  tokenRow,
  mergeTokenRows,
};
