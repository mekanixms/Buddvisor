process.env.ENCRYPTION_KEY = 'k'.repeat(40);

jest.mock('../../src/models/WorkSession');
jest.mock('../../src/models/Document');
jest.mock('../../src/models/Message');
jest.mock('../../src/services/sessions/SessionStorageLinks', () => ({
  syncSessionStorageLinks: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../../src/services/agents/AgentService', () => ({
  lookupOpenRouterChatModel: jest.fn().mockResolvedValue({}),
}));

const WorkSession = require('../../src/models/WorkSession');
const AgentService = require('../../src/services/agents/AgentService');
const SessionService = require('../../src/services/sessions/SessionService');

describe('orchestrator model capabilities', () => {
  const sessionRow = {
    id: 1,
    user_id: 5,
    name: 'Desk',
    orchestrator_provider_type: 'ollama',
    orchestrator_provider_config: null,
    orchestrator_model_capabilities: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    AgentService.lookupOpenRouterChatModel.mockResolvedValue({});
    WorkSession.findById.mockResolvedValue({ ...sessionRow });
    WorkSession.updateLastAccessed.mockResolvedValue();
    WorkSession.update.mockImplementation(async (id, updates) => ({
      ...sessionRow,
      ...updates,
    }));
  });

  it('stores the checkbox flags and returns them as an object', async () => {
    const saved = await SessionService.updateSession(1, 5, {
      orchestrator_hf_model_repo: 'Qwen/Qwen2-VL-7B-Instruct',
      orchestrator_model_capabilities: {
        text: true,
        vision: false,
        audio: true,
        video: false,
        thinking: true,
        prompt_caching_hint: true,
        source: 'manual',
      },
    });

    const written = JSON.parse(WorkSession.update.mock.calls[0][1].orchestrator_model_capabilities);
    expect(written).toMatchObject({
      vision: false,
      audio: true,
      thinking: true,
      prompt_caching_hint: true,
    });
    expect(WorkSession.update.mock.calls[0][1].orchestrator_hf_model_repo).toBe('Qwen/Qwen2-VL-7B-Instruct');
    expect(saved.orchestrator_model_capabilities).toMatchObject({
      audio: true,
      thinking: true,
      prompt_caching_hint: true,
    });
    expect(AgentService.lookupOpenRouterChatModel).toHaveBeenCalledWith('ollama', null);
  });

  it('leaves stored flags alone when the update does not touch the orchestrator model', async () => {
    await SessionService.updateSession(1, 5, { pinned: 1 });

    expect(AgentService.lookupOpenRouterChatModel).not.toHaveBeenCalled();
    expect(WorkSession.update.mock.calls[0][1]).toEqual({ pinned: 1 });
  });

  it('fills OpenRouter catalog flags when the save does not send any', async () => {
    AgentService.lookupOpenRouterChatModel.mockResolvedValue({
      openrouter_model_id: 'google/gemini-2.5-flash',
      model_capabilities: JSON.stringify({
        text: true,
        vision: true,
        audio: false,
        video: false,
        thinking: false,
        prompt_caching_hint: false,
        source: 'openrouter',
      }),
    });

    await SessionService.updateSession(1, 5, {
      orchestrator_provider_type: 'openrouter',
      orchestrator_provider_config: { model: 'google/gemini-2.5-flash' },
    });

    const updates = WorkSession.update.mock.calls[0][1];
    expect(updates.orchestrator_openrouter_model_id).toBe('google/gemini-2.5-flash');
    expect(JSON.parse(updates.orchestrator_model_capabilities).vision).toBe(true);
    expect(typeof updates.orchestrator_provider_config).toBe('string');
  });

  it('keeps explicit flags when the OpenRouter catalog disagrees', async () => {
    AgentService.lookupOpenRouterChatModel.mockResolvedValue({
      openrouter_model_id: 'google/gemini-2.5-flash',
      model_capabilities: JSON.stringify({ text: true, vision: true }),
    });

    await SessionService.updateSession(1, 5, {
      orchestrator_provider_type: 'openrouter',
      orchestrator_provider_config: { model: 'google/gemini-2.5-flash' },
      orchestrator_model_capabilities: {
        text: true,
        vision: false,
        audio: false,
        video: false,
        thinking: false,
        prompt_caching_hint: true,
        source: 'manual',
      },
    });

    const updates = WorkSession.update.mock.calls[0][1];
    expect(JSON.parse(updates.orchestrator_model_capabilities)).toMatchObject({
      vision: false,
      prompt_caching_hint: true,
    });
    expect(updates.orchestrator_openrouter_model_id).toBe('google/gemini-2.5-flash');
  });

  it('rejects an oversized capability payload', async () => {
    await expect(SessionService.updateSession(1, 5, {
      orchestrator_model_capabilities: { blob: 'x'.repeat(40000) },
    })).rejects.toThrow(/too large/);
    expect(WorkSession.update).not.toHaveBeenCalled();
  });
});
