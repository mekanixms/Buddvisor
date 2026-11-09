const {
  orchestratorAgentId,
  isOrchestratorAgentId,
  isOrchestratorContext,
  workspaceAgentId,
  orchestratorToolContext,
} = require('../../src/utils/orchestratorIdentity');
const { getWorkspacePath } = require('../../src/services/tools/localWorkingFolderTool');

describe('orchestrator identity', () => {
  test('gives each session a stable id that cannot collide with an agent id', () => {
    expect(orchestratorAgentId(4)).toBe(-4);
    expect(orchestratorAgentId(4)).toBe(-4);
    expect(orchestratorAgentId(9)).not.toBe(orchestratorAgentId(4));
    expect(isOrchestratorAgentId(-4)).toBe(true);
    expect(isOrchestratorAgentId(4)).toBe(false);
    expect(orchestratorAgentId(0)).toBeNull();
  });

  test('treats a missing id and the orchestrator id as the orchestrator', () => {
    expect(isOrchestratorContext({ agentId: null })).toBe(true);
    expect(isOrchestratorContext({ sessionId: 4, agentId: -4 })).toBe(true);
    expect(isOrchestratorContext({ agentId: 9 })).toBe(false);
    expect(workspaceAgentId(-4)).toBeNull();
    expect(workspaceAgentId(9)).toBe(9);
  });

  test('keeps the orchestrator workspace path when the caller carries the orchestrator id', () => {
    const legacy = getWorkspacePath('books', 4, null, true);
    const identified = getWorkspacePath('books', 4, orchestratorAgentId(4), true);
    const agent = getWorkspacePath('books', 4, 9, true);
    expect(identified).toBe(legacy);
    expect(agent).not.toBe(legacy);
  });

  test('builds a tool context with that id', () => {
    expect(orchestratorToolContext({ id: 12, user_id: 3 })).toEqual({
      userId: 3,
      sessionId: 12,
      agentId: -12,
      isOrchestrator: true,
    });
  });
});
