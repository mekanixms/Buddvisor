const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

describe('orchestrator capability checkboxes', () => {
  let window;
  let sessionConfig;

  const session = {
    id: 9,
    name: 'Main',
    description: '',
    context_length: 50,
    orchestrator_provider_type: 'ollama',
    orchestrator_provider_config: { model: 'qwen3-vl', baseURL: 'http://localhost:11434' },
    orchestration_mode: 'route',
    conversation_mode_enabled: 0,
    conversation_max_rounds: 10,
    conversation_token_budget: 50000,
    decision_model_enabled: 0,
    agents: [],
    documents: [],
    orchestrator_hf_model_repo: 'Qwen/Qwen2-VL-7B-Instruct',
    orchestrator_openrouter_model_id: null,
    orchestrator_model_capabilities: {
      text: true,
      vision: true,
      audio: false,
      video: false,
      thinking: false,
      prompt_caching_hint: false,
      repo_id: 'Qwen/Qwen2-VL-7B-Instruct',
      pipeline_tag: 'image-text-to-text',
      source: 'huggingface',
    },
  };

  beforeEach(() => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'http://localhost/',
      runScripts: 'dangerously',
    });
    window = dom.window;
    const context = dom.getInternalVMContext();
    context.bootstrap = {
      Modal: class {
        show() {}
        static getInstance() {
          return { hide() {} };
        }
      },
    };
    context.escapeHtml = (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    context.showToast = jest.fn();
    context.api = {
      agents: {
        getProviders: jest.fn().mockResolvedValue({
          data: {
            providers: [{
              type: 'ollama',
              name: 'Ollama',
              requiresApiKey: false,
              availableModels: [{ id: 'qwen3-vl', name: 'Qwen VL', description: 'vision' }],
            }],
          },
        }),
      },
      tools: {
        list: jest.fn().mockResolvedValue({ success: true, data: { tools: [] } }),
      },
      sessions: {
        get: jest.fn().mockResolvedValue({ data: { session } }),
        getDefaultPrompt: jest.fn().mockResolvedValue({ data: { prompt: '' } }),
        getOrchestratorTools: jest.fn().mockResolvedValue({ success: true, data: { assignments: [] } }),
        update: jest.fn().mockResolvedValue({}),
        setOrchestratorTools: jest.fn().mockResolvedValue({}),
      },
    };
    context.agentManager = { getAgents: () => [] };
    const code = fs.readFileSync(
      path.join(__dirname, '../../public/js/components/sessionConfig.js'),
      'utf8'
    );
    vm.runInContext(code, context);
    sessionConfig = window.sessionConfig;
    window.sessionManager = {
      loadSessions: jest.fn().mockResolvedValue(),
      selectSession: jest.fn().mockResolvedValue(),
    };
  });

  it('renders saved orchestrator flags and saves a manual change', async () => {
    await sessionConfig.showConfigModal(9);

    expect(window.document.getElementById('orch-cap-text').checked).toBe(true);
    expect(window.document.getElementById('orch-cap-vision').checked).toBe(true);
    expect(window.document.getElementById('orch-cap-audio').checked).toBe(false);
    expect(window.document.getElementById('orch-cap-video').checked).toBe(false);
    expect(window.document.getElementById('orch-cap-thinking').checked).toBe(false);
    expect(window.document.getElementById('orch-cap-prompt_caching_hint').checked).toBe(false);
    expect(window.document.getElementById('orch-hf-repo').value).toBe('Qwen/Qwen2-VL-7B-Instruct');
    expect(window.document.body.textContent).toContain('image-text-to-text');

    window.document.getElementById('orch-cap-vision').checked = false;
    window.document.getElementById('orch-cap-audio').checked = true;
    window.document.getElementById('orch-cap-thinking').checked = true;

    await sessionConfig.saveConfig();

    const saved = window.api.sessions.update.mock.calls[0][1];
    expect(saved.orchestrator_model_capabilities).toMatchObject({
      text: true,
      vision: false,
      audio: true,
      video: false,
      thinking: true,
      prompt_caching_hint: false,
      repo_id: 'Qwen/Qwen2-VL-7B-Instruct',
    });
    expect(saved.orchestrator_hf_model_repo).toBe('Qwen/Qwen2-VL-7B-Instruct');
  });
});
