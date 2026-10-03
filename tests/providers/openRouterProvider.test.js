const DeepSeekProvider = require('../../src/providers/DeepSeekProvider');
const OpenRouterProvider = require('../../src/providers/OpenRouterProvider');
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

function completionResponse(model) {
  return {
    choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    model,
  };
}

describe('OpenRouterProvider', () => {
  const envKeys = ['OPENROUTER_BASE_URL', 'OPENROUTER_HTTP_REFERER', 'OPENROUTER_APP_NAME'];
  const previous = {};

  beforeEach(() => {
    for (const key of envKeys) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  it('registers with the factory and uses the default model', () => {
    expect(ProviderFactory.getAvailableTypes()).toContain('openrouter');
    const info = ProviderFactory.getProviderInfo('openrouter');
    expect(info.requiresApiKey).toBe(true);
    expect(info.defaultModel).toBe('google/gemini-2.5-flash');
    expect(info.availableModels.some((m) => m.id === 'openai/gpt-4o-mini')).toBe(true);

    const created = ProviderFactory.create('openrouter', { apiKey: 'sk-or-test' });
    expect(created.getType()).toBe('openrouter');
    expect(created.model).toBe('google/gemini-2.5-flash');
  });

  it('points the client at the OpenRouter base URL and attribution headers', () => {
    process.env.OPENROUTER_HTTP_REFERER = 'https://example.com';
    process.env.OPENROUTER_APP_NAME = 'Badvisor Test';
    const provider = new OpenRouterProvider({
      apiKey: 'sk-or-test',
      baseURL: 'https://openrouter.ai/api/v1/',
      model: 'google/gemini-2.5-flash',
    });

    expect(provider.client.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(provider.client._options.defaultHeaders['HTTP-Referer']).toBe('https://example.com');
    expect(provider.client._options.defaultHeaders['X-Title']).toBe('Badvisor Test');
  });

  it('uses OPENROUTER_BASE_URL and a default app name when the config omits them', () => {
    process.env.OPENROUTER_BASE_URL = 'https://proxy.example/v1';
    const provider = new OpenRouterProvider({ apiKey: 'sk-or-test' });
    expect(provider.client.baseURL).toBe('https://proxy.example/v1');
    expect(provider.client._options.defaultHeaders['X-Title']).toBe('Badvisor');
    expect(provider.client._options.defaultHeaders['HTTP-Referer']).toBeUndefined();
  });

  it('formats tools and messages the same way as DeepSeek', () => {
    const openrouter = new OpenRouterProvider({ apiKey: 'k' });
    const deepseek = new DeepSeekProvider({ apiKey: 'k' });
    const messages = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', name: 'datetime', input: { timezone: 'UTC' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
      { role: 'user', content: 'hi' },
    ];
    expect(openrouter.formatMessages(messages)).toEqual(deepseek.formatMessages(messages));
    expect(openrouter.formatTools([sampleTool])).toEqual(deepseek.formatTools([sampleTool]));
  });

  it('sends provider.sort price and omits it when routing is left at the default', async () => {
    const priced = new OpenRouterProvider({
      apiKey: 'k',
      model: 'google/gemini-2.5-flash',
      openrouterSort: 'price',
    });
    const calls = [];
    priced.client = {
      chat: {
        completions: {
          create: async (params) => {
            calls.push(params);
            return completionResponse(params.model);
          },
        },
      },
    };

    const result = await priced.chat([{ role: 'user', content: 'hi' }]);
    expect(result.content).toBe('ok');
    expect(calls[0].model).toBe('google/gemini-2.5-flash');
    expect(calls[0].provider).toEqual({ sort: 'price' });
    expect(calls[0].max_tokens).toBe(4096);

    const plain = new OpenRouterProvider({ apiKey: 'k', openrouterSort: '' });
    const plainCalls = [];
    plain.client = {
      chat: {
        completions: {
          create: async (params) => {
            plainCalls.push(params);
            return completionResponse(params.model);
          },
        },
      },
    };
    await plain.chat([{ role: 'user', content: 'hi' }]);
    expect(plainCalls[0].provider).toBeUndefined();
  });

  it('accepts a custom model id and rejects a bad routing value', () => {
    expect(ProviderFactory.validateConfig('openrouter', {
      apiKey: 'k',
      model: 'custom/not-in-the-list',
      openrouterSort: 'price',
    }).valid).toBe(true);
    expect(ProviderFactory.validateConfig('openrouter', { baseURL: 5 }).valid).toBe(false);
    expect(ProviderFactory.validateConfig('openrouter', { openrouterSort: 'latency' }).valid).toBe(false);
    expect(OpenRouterProvider.runtimeFields({
      openrouterSort: 'throughput',
      baseURL: ' https://openrouter.ai/api/v1 ',
    })).toEqual({
      openrouterSort: 'throughput',
      baseURL: 'https://openrouter.ai/api/v1',
    });
  });
});
