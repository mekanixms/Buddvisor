const OpenAI = require('openai');
const BaseLLMProvider = require('./BaseLLMProvider');
const logger = require('../utils/logger');

/**
 * OpenRouter chat provider (OpenAI-compatible).
 * Model ids are author/slug, for example google/gemini-2.5-flash.
 * Docs: https://openrouter.ai/docs/api/reference/overview
 */
class OpenRouterProvider extends BaseLLMProvider {
  static DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
  static DEFAULT_MODEL = 'google/gemini-2.5-flash';
  static SORTS = ['price', 'throughput'];

  constructor(config = {}) {
    super(config);

    const baseURL = OpenRouterProvider.resolveBaseURL(config.baseURL);
    const defaultHeaders = {
      'X-Title': process.env.OPENROUTER_APP_NAME || 'Badvisor',
    };
    const referer = process.env.OPENROUTER_HTTP_REFERER;
    if (referer && String(referer).trim()) {
      defaultHeaders['HTTP-Referer'] = String(referer).trim();
    }

    this.openrouterSort = OpenRouterProvider.normalizeSort(config.openrouterSort);
    this.client = new OpenAI({
      apiKey: this.apiKey,
      timeout: this.timeout,
      baseURL,
      defaultHeaders,
    });
  }

  /**
   * @param {string} [baseURL]
   * @returns {string}
   */
  static resolveBaseURL(baseURL) {
    const raw = (baseURL && String(baseURL).trim())
      || (process.env.OPENROUTER_BASE_URL && String(process.env.OPENROUTER_BASE_URL).trim())
      || OpenRouterProvider.DEFAULT_BASE_URL;
    return raw.replace(/\/+$/, '');
  }

  /**
   * @param {*} value
   * @returns {string} price, throughput, or ''
   */
  static normalizeSort(value) {
    const sort = String(value || '').trim().toLowerCase();
    return OpenRouterProvider.SORTS.includes(sort) ? sort : '';
  }

  /**
   * Fields copied from a saved agent or orchestrator config onto a provider config.
   * @param {object} source
   * @returns {object}
   */
  static runtimeFields(source) {
    if (!source || typeof source !== 'object') return {};
    const fields = {};
    const sort = OpenRouterProvider.normalizeSort(source.openrouterSort);
    if (sort) fields.openrouterSort = sort;
    if (typeof source.baseURL === 'string' && source.baseURL.trim()) {
      fields.baseURL = source.baseURL.trim();
    }
    return fields;
  }

  getType() {
    return 'openrouter';
  }

  getDefaultModel() {
    return OpenRouterProvider.DEFAULT_MODEL;
  }

  getAvailableModels() {
    return [
      {
        id: 'google/gemini-2.5-flash',
        name: 'Gemini 2.5 Flash',
        description: 'Fast, lower-cost Gemini via OpenRouter',
      },
      {
        id: 'google/gemini-2.5-flash-lite',
        name: 'Gemini 2.5 Flash Lite',
        description: 'Smaller Gemini model via OpenRouter',
      },
      {
        id: 'openai/gpt-4o-mini',
        name: 'GPT-4o mini',
        description: 'Small OpenAI model via OpenRouter',
      },
      {
        id: 'deepseek/deepseek-chat',
        name: 'DeepSeek Chat',
        description: 'DeepSeek chat via OpenRouter',
      },
      {
        id: 'anthropic/claude-sonnet-4',
        name: 'Claude Sonnet 4',
        description: 'Claude Sonnet via OpenRouter',
      },
    ];
  }

  formatMessages(messages) {
    return messages.map(msg => {
      if (msg.role === 'assistant' && msg.tool_calls) {
        return {
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
            },
          })),
        };
      }

      if (msg.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: msg.tool_call_id,
          content: msg.content,
        };
      }

      return {
        role: msg.role,
        content: msg.content,
      };
    });
  }

  formatTools(tools) {
    if (!tools || tools.length === 0) return undefined;

    return tools.map(tool => {
      let parameters = tool.input_schema;

      if (parameters && parameters.properties) {
        const cleanedProperties = {};
        for (const [propName, propSchema] of Object.entries(parameters.properties)) {
          const { required, ...cleanedSchema } = propSchema;
          cleanedProperties[propName] = cleanedSchema;
        }

        parameters = {
          ...parameters,
          properties: cleanedProperties,
          required: parameters.required || [],
        };
      }

      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters,
        },
      };
    });
  }

  parseResponse(response) {
    const choice = response.choices?.[0];
    const message = choice?.message;
    const content = message?.content || '';

    const toolCalls = message?.tool_calls?.map(tc => ({
      id: tc.id,
      name: tc.function?.name,
      input: JSON.parse(tc.function?.arguments || '{}'),
    }));

    return {
      content,
      tool_calls: toolCalls?.length > 0 ? toolCalls : undefined,
      stop_reason: choice?.finish_reason || 'unknown',
      usage: {
        input_tokens: response.usage?.prompt_tokens || 0,
        output_tokens: response.usage?.completion_tokens || 0,
        total_tokens: response.usage?.total_tokens || 0,
      },
      model: response.model,
    };
  }

  /**
   * @param {Array} formattedMessages
   * @param {object} options
   * @param {boolean} stream
   */
  buildRequestParams(formattedMessages, options, stream) {
    const model = options.model || this.model;
    const requestParams = {
      model,
      messages: formattedMessages,
      max_tokens: options.maxTokens || this.maxTokens,
    };

    if (stream) {
      requestParams.stream = true;
      requestParams.stream_options = { include_usage: true };
    }

    if (options.temperature !== undefined) {
      requestParams.temperature = options.temperature;
    } else if (this.temperature !== undefined) {
      requestParams.temperature = this.temperature;
    }

    if (options.tools && options.tools.length > 0) {
      requestParams.tools = this.formatTools(options.tools);
    }

    const sort = OpenRouterProvider.normalizeSort(options.openrouterSort || this.openrouterSort);
    if (sort) {
      requestParams.provider = { sort };
    }

    return requestParams;
  }

  async chat(messages, options = {}) {
    const formattedMessages = this.formatMessages(messages);
    const requestParams = this.buildRequestParams(formattedMessages, options, false);

    try {
      logger.debug(`OpenRouter request: model=${requestParams.model}, messages=${formattedMessages.length}, tools=${options.tools?.length || 0}, sort=${requestParams.provider?.sort || 'default'}`);
      const response = await this.withRetry(async () => {
        return await this.client.chat.completions.create(requestParams);
      });
      return this.parseResponse(response);
    } catch (error) {
      logger.error('OpenRouter chat error:', error);
      throw this.createError(error, 'chat');
    }
  }

  async streamChat(messages, onChunk, options = {}) {
    const formattedMessages = this.formatMessages(messages);
    const requestParams = this.buildRequestParams(formattedMessages, options, true);

    try {
      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason = 'unknown';
      const toolCalls = [];
      const toolCallDeltas = {};

      const stream = await this.client.chat.completions.create(requestParams);

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        const content = delta?.content || '';

        if (content) {
          fullContent += content;
          if (onChunk) onChunk({ type: 'text', content });
        }

        if (delta?.tool_calls) {
          for (const tc of delta.tool_calls) {
            const index = tc.index;
            if (!toolCallDeltas[index]) {
              toolCallDeltas[index] = {
                id: tc.id || '',
                name: tc.function?.name || '',
                arguments: '',
              };
            }
            if (tc.id) toolCallDeltas[index].id = tc.id;
            if (tc.function?.name) toolCallDeltas[index].name = tc.function.name;
            if (tc.function?.arguments) toolCallDeltas[index].arguments += tc.function.arguments;
          }
        }

        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || 0;
          outputTokens = chunk.usage.completion_tokens || 0;
        }
      }

      for (const tc of Object.values(toolCallDeltas)) {
        try {
          toolCalls.push({
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.arguments || '{}'),
          });
        } catch (e) {
          logger.warn('Failed to parse OpenRouter tool call arguments');
        }
      }

      const result = {
        content: fullContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        stop_reason: finishReason,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      };

      if (onChunk) onChunk({ type: 'done', result });
      return result;
    } catch (error) {
      logger.error('OpenRouter stream error:', error);
      if (onChunk) onChunk({ type: 'error', error: error.message || String(error) });
      throw this.createError(error, 'streamChat');
    }
  }
}

module.exports = OpenRouterProvider;
