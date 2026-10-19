const OpenAI = require('openai');
const BaseLLMProvider = require('./BaseLLMProvider');
const logger = require('../utils/logger');

const DEFAULT_BASE_URL = 'http://localhost:8080/v1';
const PLACEHOLDER_API_KEY = 'local';

/**
 * llama-server base URL must end at /v1 so the OpenAI client posts to /v1/chat/completions.
 * A host:port value (no /v1) is accepted and normalized.
 * @param {string} [raw]
 * @returns {string}
 */
function normalizeLlamaCppBaseURL(raw) {
  const fallback = process.env.LLAMACPP_BASE_URL || DEFAULT_BASE_URL;
  let url = String(raw || fallback).trim();
  if (!url) url = DEFAULT_BASE_URL;
  url = url.replace(/\/+$/, '');
  if (!/\/v1$/i.test(url)) url += '/v1';
  return url;
}

/**
 * Blank and the Ollama-style "not-required" sentinel become a placeholder.
 * llama-server ignores Authorization when started without --api-key.
 * @param {string} [key]
 * @returns {string}
 */
function resolveApiKey(key) {
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!trimmed || trimmed === 'not-required' || trimmed === 'NO_KEY_SHOULD_BE_PROVIDED') {
    return PLACEHOLDER_API_KEY;
  }
  return trimmed;
}

/**
 * Drop a blank alias so chat uses the default model name (`local`).
 * A non-empty alias is trimmed and kept (including the literal `local`).
 * @param {object} config
 * @returns {object}
 */
function applyLlamaCppAlias(config) {
  if (!config || typeof config !== 'object') return config;
  const alias = typeof config.model === 'string' ? config.model.trim() : '';
  if (!alias) delete config.model;
  else config.model = alias;
  return config;
}

/**
 * llama.cpp server provider (OpenAI-compatible /v1/chat/completions).
 * One llama-server process usually serves one GGUF. The model name sent on
 * each request is an optional alias; blank means `local`. Tool calls require
 * the server to be started with --jinja.
 */
class LlamaCppProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super({
      ...config,
      apiKey: resolveApiKey(config.apiKey),
    });

    this.baseURL = normalizeLlamaCppBaseURL(config.baseURL);
    this.client = new OpenAI({
      apiKey: this.apiKey,
      timeout: this.timeout,
      baseURL: this.baseURL,
    });
  }

  getType() {
    return 'llamacpp';
  }

  getDefaultModel() {
    return 'local';
  }

  getAvailableModels() {
    return [
      {
        id: 'local',
        name: 'Loaded model',
        description: 'Sent when no alias is set. Override with the -a name or a GET /v1/models id.',
      },
    ];
  }

  /**
   * Model ids advertised by this server (GET /v1/models).
   * @returns {Promise<string[]>}
   */
  async listModelIds() {
    const page = await this.client.models.list();
    const rows = Array.isArray(page?.data) ? page.data : [];
    return rows
      .map((row) => (row && typeof row.id === 'string' ? row.id.trim() : ''))
      .filter(Boolean);
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

  async chat(messages, options = {}) {
    const formattedMessages = this.formatMessages(messages);
    const model = options.model || this.model;

    const requestParams = {
      model,
      messages: formattedMessages,
      max_tokens: options.maxTokens || this.maxTokens,
    };

    if (options.temperature !== undefined) {
      requestParams.temperature = options.temperature;
    } else if (this.temperature !== undefined) {
      requestParams.temperature = this.temperature;
    }

    if (options.tools && options.tools.length > 0) {
      requestParams.tools = this.formatTools(options.tools);
    }

    try {
      logger.debug(`llama.cpp request: model=${model}, messages=${formattedMessages.length}, tools=${options.tools?.length || 0}`);
      const response = await this.withRetry(async () => {
        return await this.client.chat.completions.create(requestParams);
      });
      return this.parseResponse(response);
    } catch (error) {
      logger.error('llama.cpp chat error:', error);
      throw this.createError(error, 'chat');
    }
  }

  async streamChat(messages, onChunk, options = {}) {
    const formattedMessages = this.formatMessages(messages);
    const model = options.model || this.model;

    const requestParams = {
      model,
      messages: formattedMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: options.maxTokens || this.maxTokens,
    };

    if (options.temperature !== undefined) {
      requestParams.temperature = options.temperature;
    } else if (this.temperature !== undefined) {
      requestParams.temperature = this.temperature;
    }

    if (options.tools && options.tools.length > 0) {
      requestParams.tools = this.formatTools(options.tools);
    }

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
          logger.warn('Failed to parse llama.cpp tool call arguments');
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
      logger.error('llama.cpp stream error:', error);
      if (onChunk) onChunk({ type: 'error', error: error.message || String(error) });
      throw this.createError(error, 'streamChat');
    }
  }
}

LlamaCppProvider.normalizeLlamaCppBaseURL = normalizeLlamaCppBaseURL;
LlamaCppProvider.applyAlias = applyLlamaCppAlias;
LlamaCppProvider.DEFAULT_BASE_URL = DEFAULT_BASE_URL;
LlamaCppProvider.DEFAULT_MODEL = 'local';
module.exports = LlamaCppProvider;
