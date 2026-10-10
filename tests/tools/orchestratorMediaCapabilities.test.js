jest.mock('../../src/models/WorkSession');
jest.mock('../../src/models/Agent');
jest.mock('../../src/models/Document');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const WorkSession = require('../../src/models/WorkSession');
const { getOrchestratorModelInfo } = require('../../src/services/tools/mediaProcessingTool');

describe('process_media orchestrator capabilities', () => {
  it('reads the flags stored on the session', async () => {
    WorkSession.findById.mockResolvedValue({
      id: 3,
      orchestrator_provider_type: 'gemini',
      orchestrator_provider_config: null,
      orchestrator_model_capabilities: JSON.stringify({
        text: true,
        vision: true,
        audio: false,
        video: true,
        thinking: true,
        prompt_caching_hint: false,
      }),
    });

    const info = await getOrchestratorModelInfo(3);

    expect(info).toMatchObject({
      agentId: null,
      agentName: 'Orchestrator',
      providerType: 'gemini',
    });
    expect(info.capabilities).toMatchObject({
      vision: true,
      audio: false,
      video: true,
      thinking: true,
      prompt_caching_hint: false,
    });
  });

  it('keeps every flag off when the session has no capability record', async () => {
    WorkSession.findById.mockResolvedValue({
      id: 4,
      orchestrator_provider_type: 'ollama',
      orchestrator_provider_config: null,
      orchestrator_model_capabilities: null,
    });

    const info = await getOrchestratorModelInfo(4);

    expect(info.capabilities).toMatchObject({
      text: false,
      vision: false,
      audio: false,
      video: false,
      thinking: false,
      prompt_caching_hint: false,
    });
  });
});
