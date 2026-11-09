const OrchestratorAgent = require('../../src/services/chat/OrchestratorAgent');

describe('orchestrator max output tokens', () => {
  test('uses the saved value and otherwise 4096', () => {
    expect(OrchestratorAgent.getOrchestratorMaxTokens({
      orchestrator_provider_config: { maxTokens: 8192 },
    })).toBe(8192);
    expect(OrchestratorAgent.getOrchestratorMaxTokens({})).toBe(4096);
    expect(OrchestratorAgent.getOrchestratorMaxTokens({
      orchestrator_provider_config: { maxTokens: 0 },
    })).toBe(4096);
    expect(OrchestratorAgent.getOrchestratorMaxTokens({
      orchestrator_provider_config: { maxTokens: 200000 },
    })).toBe(4096);
  });
});
