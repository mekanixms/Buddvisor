const DeepSeekProvider = require('../../src/providers/DeepSeekProvider');
const LlamaCppProvider = require('../../src/providers/LlamaCppProvider');
const ProviderFactory = require('../../src/providers/ProviderFactory');

const sampleTool = {
  name: 'datetime',
  description: 'Current time',
  input_schema: {
    type: 'object',
    properties: {
      timezone: { type: 'string', description: 'IANA zone', required: false },
    },
    required: ['timezone'],
  },
};

describe('LlamaCppProvider', () => {
  const previousBaseURL = process.env.LLAMACPP_BASE_URL;

  afterEach(() => {
    if (previousBaseURL === undefined) delete process.env.LLAMACPP_BASE_URL;
    else process.env.LLAMACPP_BASE_URL = previousBaseURL;
  });

  it('points the OpenAI client at the configured /v1 base URL', () => {
    const provider = new LlamaCppProvider({
      apiKey: 'secret',
      baseURL: 'http://192.168.1.20:8081',
      model: 'qwen',
    });

    expect(provider.getType()).toBe('llamacpp');
    expect(provider.client.baseURL).toBe('http://192.168.1.20:8081/v1');
    expect(provider.apiKey).toBe('secret');
    expect(provider.model).toBe('qwen');
  });

  it('uses a placeholder key and the default server when both are omitted', () => {
    delete process.env.LLAMACPP_BASE_URL;
    const provider = new LlamaCppProvider({});
    expect(provider.apiKey).toBe('local');
    expect(provider.client.baseURL).toBe('http://localhost:8080/v1');
  });

  it('treats the not-required sentinel as no key and keeps an existing /v1 path', () => {
    const provider = new LlamaCppProvider({
      apiKey: 'not-required',
      baseURL: 'http://127.0.0.1:9000/v1/',
    });
    expect(provider.apiKey).toBe('local');
    expect(provider.client.baseURL).toBe('http://127.0.0.1:9000/v1');
  });

  it('formats a tool call the same way as DeepSeek', () => {
    const llama = new LlamaCppProvider({ apiKey: 'k', baseURL: 'http://localhost:8080/v1' });
    const deepseek = new DeepSeekProvider({ apiKey: 'k' });
    const messages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', name: 'datetime', input: { timezone: 'UTC' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ];

    expect(llama.formatMessages(messages)).toEqual(deepseek.formatMessages(messages));
    expect(llama.formatTools([sampleTool])).toEqual(deepseek.formatTools([sampleTool]));
  });

  it('is registered and does not require an API key', () => {
    delete process.env.LLAMACPP_BASE_URL;
    const info = ProviderFactory.getProviderInfo('llamacpp');
    expect(info.requiresApiKey).toBe(false);
    expect(info.defaultModel).toBe('local');
    expect(info.defaultLlamaCppBaseURL).toBe('http://localhost:8080/v1');

    const created = ProviderFactory.create('llamacpp', { model: 'alias' });
    expect(created.model).toBe('alias');
    expect(created.client.baseURL).toBe('http://localhost:8080/v1');

    expect(ProviderFactory.validateConfig('llamacpp', { baseURL: 'http://localhost:8080/v1' }).valid).toBe(true);
    expect(ProviderFactory.validateConfig('llamacpp', {}).valid).toBe(true);
    expect(ProviderFactory.validateConfig('llamacpp', { baseURL: 5 }).valid).toBe(false);
  });
});
