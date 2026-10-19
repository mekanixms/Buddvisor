const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function loadPage(files) {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'http://localhost/',
    runScripts: 'dangerously',
  });
  const window = dom.window;
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
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  context.showToast = jest.fn();
  context.api = {
    agents: {
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({}),
      getSessions: jest.fn().mockResolvedValue({ data: { sessions: [] } }),
      list: jest.fn().mockResolvedValue({ data: { agents: [] } }),
      getProviders: jest.fn(),
      testProvider: jest.fn(),
    },
    sessions: {
      get: jest.fn(),
      update: jest.fn().mockResolvedValue({ success: true }),
      getOrchestratorTools: jest.fn().mockResolvedValue({ success: true, data: { assignments: [] } }),
      getDefaultPrompt: jest.fn().mockResolvedValue({ success: true, data: { prompt: '' } }),
    },
    tools: {
      list: jest.fn().mockResolvedValue({ success: true, data: { tools: [] } }),
    },
  };
  for (const file of files) {
    const code = fs.readFileSync(path.join(__dirname, '../../public/js/components', file), 'utf8');
    vm.runInContext(code, context);
  }
  return window;
}

const llamaProvider = {
  type: 'llamacpp',
  requiresApiKey: false,
  defaultLlamaCppBaseURL: 'http://localhost:8080/v1',
  availableModels: [{ id: 'local', name: 'Loaded model', description: 'default' }],
};

describe('llama.cpp agent form', () => {
  let window;
  let agentManager;

  beforeEach(() => {
    window = loadPage(['agentManager.js']);
    agentManager = window.agentManager;
    agentManager.roles = [{ id: 'custom', name: 'Custom' }];
    agentManager.providers = [
      llamaProvider,
      {
        type: 'ollama',
        requiresApiKey: false,
        availableModels: [{ id: 'gemma3', name: 'Gemma 3', description: 'local' }],
      },
    ];
  });

  it('names the provider without a local suffix', () => {
    expect(agentManager.providerOptionLabel(llamaProvider)).toBe('llama.cpp');
    expect(agentManager.providerOptionLabel(agentManager.providers[1])).toBe('Ollama (Local)');
  });

  it('hides the model catalog and keeps a blank alias for the default model', () => {
    agentManager.showAgentModal({
      id: 7,
      name: 'Local',
      role: 'custom',
      provider_type: 'llamacpp',
      provider_config: { model: 'local', baseURL: 'http://192.168.1.20:8081/v1' },
    });

    const doc = window.document;
    expect(doc.getElementById('agent-model-group').classList.contains('d-none')).toBe(true);
    expect(doc.getElementById('agent-llamacpp-config').classList.contains('d-none')).toBe(false);
    expect(doc.getElementById('agent-llamacpp-alias').value).toBe('');
    expect(doc.getElementById('agent-llamacpp-address').value).toBe('192.168.1.20');
    expect(doc.getElementById('agent-llamacpp-port').value).toBe('8081');
  });

  it('shows a saved alias and stores a blank alias as no model', async () => {
    agentManager.showAgentModal({
      id: 7,
      name: 'Local',
      role: 'custom',
      provider_type: 'llamacpp',
      provider_config: { model: 'qwen', baseURL: 'http://10.0.0.4:8080/v1' },
    });

    const doc = window.document;
    expect(doc.getElementById('agent-llamacpp-alias').value).toBe('qwen');

    doc.getElementById('agent-llamacpp-alias').value = '';
    await agentManager.saveAgent();
    const saved = window.api.agents.update.mock.calls[0][1];
    expect(saved.provider_type).toBe('llamacpp');
    expect(saved.provider_config.model).toBeNull();
    expect(saved.provider_config.baseURL).toBe('http://10.0.0.4:8080/v1');
  });

  it('fills the alias from a connection test that finds one model', async () => {
    agentManager.showAgentModal({
      id: 7,
      name: 'Local',
      role: 'custom',
      provider_type: 'llamacpp',
      provider_config: { baseURL: 'http://10.0.0.4:8080/v1' },
    });
    window.api.agents.testProvider.mockResolvedValue({
      data: { success: true, latency: 12, model: 'qwen2.5' },
    });

    await agentManager.testProviderFromModal();

    const sent = window.api.agents.testProvider.mock.calls[0][1];
    expect(sent.model).toBeUndefined();
    expect(sent.baseURL).toBe('http://10.0.0.4:8080/v1');
    expect(window.document.getElementById('agent-llamacpp-alias').value).toBe('qwen2.5');
    expect(window.document.getElementById('provider-test-result').textContent).toContain('qwen2.5');
  });
});

describe('llama.cpp orchestrator form', () => {
  let window;
  let sessionConfig;

  beforeEach(() => {
    window = loadPage(['sessionConfig.js']);
    sessionConfig = window.sessionConfig;
    sessionConfig.providers = [llamaProvider];
  });

  it('fills the alias when the server lists one model', async () => {
    window.document.body.innerHTML = `
      <input id="config-llamacpp-address" value="10.0.0.8">
      <input id="config-llamacpp-port" value="8080">
      <input id="config-llamacpp-alias" value="">
      <input id="config-orchestrator-api-key" value="">
      <span id="llamacpp-test-result"></span>
    `;
    window.api.agents.testProvider.mockResolvedValue({
      data: { success: true, latency: 20, model: 'granite' },
    });

    await sessionConfig.testLlamaCppConnection();

    const sent = window.api.agents.testProvider.mock.calls[0];
    expect(sent[0]).toBe('llamacpp');
    expect(sent[1].baseURL).toBe('http://10.0.0.8:8080/v1');
    expect(sent[1].model).toBeUndefined();
    expect(window.document.getElementById('config-llamacpp-alias').value).toBe('granite');
    expect(window.document.getElementById('llamacpp-test-result').textContent).toContain('granite');
  });

  it('keeps a typed alias and does not replace it from the test', async () => {
    window.document.body.innerHTML = `
      <input id="config-llamacpp-address" value="localhost">
      <input id="config-llamacpp-port" value="8080">
      <input id="config-llamacpp-alias" value="mine">
      <input id="config-orchestrator-api-key" value="secret">
      <span id="llamacpp-test-result"></span>
    `;
    window.api.agents.testProvider.mockResolvedValue({
      data: { success: true, latency: 5 },
    });

    await sessionConfig.testLlamaCppConnection();

    expect(window.api.agents.testProvider.mock.calls[0][1]).toMatchObject({
      model: 'mine',
      apiKey: 'secret',
      baseURL: 'http://localhost:8080/v1',
    });
    expect(window.document.getElementById('config-llamacpp-alias').value).toBe('mine');
  });

  it('hides the model catalog on the orchestrator form', async () => {
    window.api.sessions.get.mockResolvedValue({
      data: {
        session: {
          id: 3,
          name: 'Plan',
          description: 'keep',
          context_length: 20,
          orchestration_mode: 'route',
          orchestrator_provider_type: 'llamacpp',
          orchestrator_provider_config: {
            model: 'qwen',
            baseURL: 'http://10.1.1.5:9000/v1',
          },
          agents: [],
          documents: [],
        },
      },
    });

    await sessionConfig.showConfigModal(3);
    sessionConfig.onOrchestratorProviderChange();

    const doc = window.document;
    expect(doc.getElementById('orchestrator-model-group').classList.contains('d-none')).toBe(true);
    expect(doc.getElementById('orchestrator-llamacpp-config').classList.contains('d-none')).toBe(false);
    expect(doc.getElementById('config-llamacpp-alias').value).toBe('qwen');
    expect(doc.getElementById('config-llamacpp-address').value).toBe('10.1.1.5');
    expect(doc.getElementById('config-llamacpp-port').value).toBe('9000');
    expect(doc.getElementById('config-orchestrator-provider').selectedOptions[0].textContent.trim()).toBe('llama.cpp');
  });
});
