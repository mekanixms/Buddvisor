const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');
const { mapApiToCapabilities } = require('../../src/services/integrations/huggingFaceModelService');
const { mapOpenRouterModelToCapabilities } = require('../../src/services/integrations/openRouterModelService');
const { storedCapabilities } = require('../../src/utils/modelCapabilities');

describe('stored model capabilities', () => {
  it('does not invent flags from a missing record', () => {
    expect(storedCapabilities(null)).toEqual({
      text: false,
      vision: false,
      audio: false,
      video: false,
      thinking: false,
      prompt_caching_hint: false,
    });
  });

  it('keeps explicit flags and ignores anything else', () => {
    expect(storedCapabilities({ text: true, vision: false, audio: 'yes' })).toMatchObject({
      text: true,
      vision: false,
      audio: false,
    });
  });
});

describe('catalog capability mapping', () => {
  it('does not mark a model vision from its name alone', () => {
    const caps = mapApiToCapabilities({
      id: 'google/gemma-3-12b-it',
      pipeline_tag: 'text-generation',
      tags: ['text-generation'],
    });
    expect(caps.vision).toBe(false);
    expect(caps.audio).toBe(false);
    expect(caps.text).toBe(true);
  });

  it('checks vision from a Hugging Face vision pipeline', () => {
    const caps = mapApiToCapabilities({
      id: 'Qwen/Qwen2-VL-7B-Instruct',
      pipeline_tag: 'image-text-to-text',
      tags: ['image-text-to-text'],
    });
    expect(caps.vision).toBe(true);
  });

  it('does not mark an OpenRouter model vision from its name alone', () => {
    const { capabilities } = mapOpenRouterModelToCapabilities({
      id: 'google/gemma-3-27b-it',
      name: 'Gemma 3 Vision',
      description: 'multimodal gemma',
      output_modalities: ['text'],
      supported_parameters: ['temperature'],
    });
    expect(capabilities.vision).toBe(false);
    expect(capabilities.text).toBe(true);
    expect(capabilities.thinking).toBe(false);
  });

  it('checks OpenRouter vision and prompt cache from catalog fields', () => {
    const { capabilities } = mapOpenRouterModelToCapabilities({
      id: 'google/gemini-2.5-pro',
      output_modalities: ['text', 'image'],
      supported_parameters: ['images', 'prompt_caching', 'include_reasoning'],
    });
    expect(capabilities).toMatchObject({
      text: true,
      vision: true,
      audio: false,
      thinking: true,
      prompt_caching_hint: true,
    });
  });
});

describe('agent editor capability checkboxes', () => {
  let window;
  let agentManager;

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
    context.api = {
      agents: {
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn(),
        getSessions: jest.fn().mockResolvedValue({ data: { sessions: [] } }),
        list: jest.fn().mockResolvedValue({ data: { agents: [] } }),
      },
    };
    context.showToast = jest.fn();
    const code = fs.readFileSync(
      path.join(__dirname, '../../public/js/components/agentManager.js'),
      'utf8'
    );
    vm.runInContext(code, context);
    agentManager = window.agentManager;
    agentManager.roles = [{ id: 'custom', name: 'Custom' }];
    agentManager.providers = [{
      type: 'ollama',
      requiresApiKey: false,
      availableModels: [{ id: 'gemma3', name: 'Gemma 3', description: 'local' }],
    }];
  });

  it('renders saved flags as checkboxes and does not guess from the model name', () => {
    agentManager.showAgentModal({
      id: 4,
      name: 'Reader',
      role: 'custom',
      provider_type: 'ollama',
      provider_config: { model: 'gemma3' },
      model_capabilities: { text: true, vision: false, audio: true },
    });

    expect(window.document.querySelector('.badge.bg-primary')).toBeNull();
    expect(window.document.getElementById('agent-cap-text').checked).toBe(true);
    expect(window.document.getElementById('agent-cap-vision').checked).toBe(false);
    expect(window.document.getElementById('agent-cap-audio').checked).toBe(true);
    expect(window.document.getElementById('agent-cap-video').checked).toBe(false);
    expect(window.document.getElementById('agent-cap-thinking').checked).toBe(false);
    expect(window.document.getElementById('agent-cap-prompt_caching_hint').checked).toBe(false);
  });

  it('lets a fetch replace the checks and keeps a later manual change', async () => {
    agentManager.showAgentModal({
      id: 4,
      name: 'Reader',
      role: 'custom',
      provider_type: 'ollama',
      provider_config: { model: 'gemma3' },
      model_capabilities: { text: true, vision: false },
    });

    const fetched = {
      text: false,
      vision: true,
      audio: false,
      video: false,
      thinking: false,
      prompt_caching_hint: true,
      repo_id: 'org/vl-model',
      pipeline_tag: 'image-text-to-text',
      source: 'huggingface',
    };
    agentManager._pendingHfCapabilities = fetched;
    agentManager._clearHfMetadata = false;
    agentManager.refreshCapabilitiesAlert(agentManager.flagsFromCapabilities(fetched));

    expect(window.document.getElementById('agent-cap-text').checked).toBe(false);
    expect(window.document.getElementById('agent-cap-vision').checked).toBe(true);
    expect(window.document.getElementById('agent-cap-prompt_caching_hint').checked).toBe(true);
    expect(window.document.body.textContent).toContain('org/vl-model');

    window.document.getElementById('agent-cap-audio').checked = true;
    agentManager.refreshCapabilitiesAlert();
    expect(window.document.getElementById('agent-cap-audio').checked).toBe(true);
    expect(window.document.getElementById('agent-cap-vision').checked).toBe(true);

    await agentManager.saveAgent();
    const saved = window.api.agents.update.mock.calls[0][1].model_capabilities;
    expect(saved).toMatchObject({
      text: false,
      vision: true,
      audio: true,
      video: false,
      thinking: false,
      prompt_caching_hint: true,
      repo_id: 'org/vl-model',
    });
  });
});
