const DeepSeekProvider = require('../../src/providers/DeepSeekProvider');
const BaseLLMProvider = require('../../src/providers/BaseLLMProvider');
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

describe('llama.cpp alias', () => {
  const previousKey = process.env.LLAMACPP_API_KEY;

  afterEach(() => {
    jest.restoreAllMocks();
    if (previousKey === undefined) delete process.env.LLAMACPP_API_KEY;
    else process.env.LLAMACPP_API_KEY = previousKey;
  });

  it('drops a blank alias and keeps a typed one', () => {
    const blank = { model: '  ', baseURL: 'http://localhost:8080/v1' };
    LlamaCppProvider.applyAlias(blank);
    expect(blank.model).toBeUndefined();
    expect(blank.baseURL).toBe('http://localhost:8080/v1');

    const named = { model: '  qwen  ' };
    LlamaCppProvider.applyAlias(named);
    expect(named.model).toBe('qwen');
  });

  it('reads ids from the models list', async () => {
    const provider = new LlamaCppProvider({ baseURL: 'http://127.0.0.1:8080/v1' });
    provider.client = {
      models: {
        list: jest.fn().mockResolvedValue({ data: [{ id: 'qwen' }, { id: ' ' }, {}] }),
      },
    };
    await expect(provider.listModelIds()).resolves.toEqual(['qwen']);
  });

  it('uses the single advertised model when the alias is blank', async () => {
    delete process.env.LLAMACPP_API_KEY;
    jest.spyOn(LlamaCppProvider.prototype, 'listModelIds').mockResolvedValue(['qwen2.5']);
    let seen = null;
    jest.spyOn(BaseLLMProvider.prototype, 'healthCheck').mockImplementation(async function health() {
      seen = this.model;
      return true;
    });

    const result = await ProviderFactory.testProvider('llamacpp', {
      baseURL: 'http://127.0.0.1:8080/v1',
    });

    expect(result.success).toBe(true);
    expect(result.model).toBe('qwen2.5');
    expect(seen).toBe('qwen2.5');
  });

  it('asks for an alias when the server lists several models', async () => {
    jest.spyOn(LlamaCppProvider.prototype, 'listModelIds').mockResolvedValue(['a', 'b']);
    const health = jest.spyOn(BaseLLMProvider.prototype, 'healthCheck').mockResolvedValue(true);

    const result = await ProviderFactory.testProvider('llamacpp', {});

    expect(result.success).toBe(false);
    expect(result.models).toEqual(['a', 'b']);
    expect(result.message).toMatch(/Enter the alias/);
    expect(health).not.toHaveBeenCalled();
  });

  it('falls back to local when the model list cannot be read', async () => {
    jest.spyOn(LlamaCppProvider.prototype, 'listModelIds').mockRejectedValue(new Error('offline'));
    let seen = null;
    jest.spyOn(BaseLLMProvider.prototype, 'healthCheck').mockImplementation(async function health() {
      seen = this.model;
      return true;
    });

    const result = await ProviderFactory.testProvider('llamacpp', { model: '' });
    expect(result.success).toBe(true);
    expect(result.model).toBeUndefined();
    expect(seen).toBe('local');
  });

  it('does not list models when an alias is already set', async () => {
    const list = jest.spyOn(LlamaCppProvider.prototype, 'listModelIds').mockResolvedValue(['other']);
    jest.spyOn(BaseLLMProvider.prototype, 'healthCheck').mockResolvedValue(true);

    const result = await ProviderFactory.testProvider('llamacpp', { model: 'alias' });
    expect(result.success).toBe(true);
    expect(result.model).toBeUndefined();
    expect(list).not.toHaveBeenCalled();
  });
});
