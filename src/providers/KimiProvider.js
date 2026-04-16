const OpenAI = require('openai');
const BaseLLMProvider = require('./BaseLLMProvider');
const logger = require('../utils/logger');

/**
 * Kimi (Moonshot AI) provider implementation (OpenAI-compatible)
 * Docs: https://api.moonshot.cn/ (region-specific; compatible with OpenAI-style SDKs)
 */
class KimiProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super(config);

    // Priority: config.baseURL > KIMI_BASE_URL > MOONSHOT_BASE_URL > default (China)
    const baseURL = config.baseURL ||
      process.env.KIMI_BASE_URL ||
      process.env.MOONSHOT_BASE_URL ||
      'https://api.moonshot.cn/v1';
    this.client = new OpenAI({
      apiKey: this.apiKey,
      timeout: this.timeout,
      baseURL,
    });
  }

  getType() {
    return 'kimi';
  }

  getDefaultModel() {
    return 'kimi-k2-instruct';
  }

  getAvailableModels() {
    return [
      { id: 'kimi-k2.5', name: 'Kimi K2.5', description: 'Kimi K2.5 multimodal model with thinking' },
      { id: 'kimi-k2-instruct', name: 'Kimi K2 Instruct', description: 'Non-thinking instruction-following model' },
      { id: 'kimi-k2-thinking', name: 'Kimi K2 Thinking', description: 'Reasoning-focused model with thinking' },
      { id: 'kimi-k2-thinking-turbo', name: 'Kimi K2 Thinking Turbo', description: 'Faster reasoning model with thinking' },
      { id: 'kimi-k2-turbo-preview', name: 'Kimi K2 Turbo Preview', description: 'Fast preview model (availability varies)' },
      { id: 'kimi-k2-0711-preview', name: 'Kimi K2 0711 Preview', description: 'Kimi K2 preview (July 2025)' },
    ];
  }

  formatMessages(messages) {
    return messages.map(msg => {
      if (msg.role === 'assistant' && msg.tool_calls) {
        const out = {
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
        // Kimi thinking models require reasoning_content on assistant tool-call messages
        const rc = msg.reasoning_content;
        if (rc !== undefined && rc !== null) {
          out.reasoning_content = typeof rc === 'string' ? rc : String(rc);
        } else {
          out.reasoning_content = '';
        }
        return out;
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
      reasoning_content: message?.reasoning_content ?? '',
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
   * Check if model is a thinking-capable model
   */
  isThinkingModel(model) {
    const thinkingModels = ['kimi-k2.5', 'kimi-k2-thinking', 'kimi-k2-thinking-turbo'];
    return thinkingModels.some(m => model?.toLowerCase().includes(m.toLowerCase()));
  }

  async chat(messages, options = {}) {
    const formattedMessages = this.formatMessages(messages);
    const model = options.model || this.model;

    const requestParams = {
      model,
      messages: formattedMessages,
      max_tokens: options.maxTokens || this.maxTokens,
    };

    // Kimi API only allows temperature = 1 for this model; ignore config/options to avoid 400
    requestParams.temperature = 1;

    if (options.tools && options.tools.length > 0) {
      requestParams.tools = this.formatTools(options.tools);
    }

    // Prompt caching: K2 models support automatic context caching; pass conversation ID header for cache affinity when enabled
    const requestOptions = {};
    if (options.usePromptCache && options.conversationId) {
      requestOptions.headers = { 'X-Conversation-Id': options.conversationId };
    }

    try {
      logger.debug(`Kimi request: model=${model}, messages=${formattedMessages.length}, tools=${options.tools?.length || 0}, usePromptCache=${!!options.usePromptCache}`);
      const response = await this.withRetry(async () => {
        return await this.client.chat.completions.create(requestParams, requestOptions);
      });
      return this.parseResponse(response);
    } catch (error) {
      logger.error('Kimi chat error:', error);
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

    // Kimi API only allows temperature = 1 for this model; ignore config/options to avoid 400
    requestParams.temperature = 1;

    if (options.tools && options.tools.length > 0) {
      requestParams.tools = this.formatTools(options.tools);
    }

    // Prompt caching: K2 models support automatic context caching; pass conversation ID header for cache affinity when enabled
    const requestOptions = {};
    if (options.usePromptCache && options.conversationId) {
      requestOptions.headers = { 'X-Conversation-Id': options.conversationId };
    }

    try {
      let fullContent = '';
      let reasoningContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason = 'unknown';
      const toolCalls = [];
      const toolCallDeltas = {};

      const stream = await this.client.chat.completions.create(requestParams, requestOptions);

      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        const content = delta?.content || '';
        const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning_delta ?? '';

        if (content) {
          fullContent += content;
          if (onChunk) onChunk({ type: 'text', content });
        }
        if (reasoningDelta) {
          reasoningContent += reasoningDelta;
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
          logger.warn('Failed to parse Kimi tool call arguments');
        }
      }

      const result = {
        content: fullContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        reasoning_content: reasoningContent,
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
      logger.error('Kimi stream error:', error);
      if (onChunk) onChunk({ type: 'error', error: error.message || String(error) });
      throw this.createError(error, 'streamChat');
    }
  }
}

module.exports = KimiProvider;

