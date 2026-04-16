const OpenAI = require('openai');
const BaseLLMProvider = require('./BaseLLMProvider');
const logger = require('../utils/logger');

/**
 * DeepSeek LLM provider implementation (OpenAI-compatible)
 * Docs: https://api-docs.deepseek.com/
 */
class DeepSeekProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super(config);

    const baseURL = config.baseURL || 'https://api.deepseek.com/v1';
    this.client = new OpenAI({
      apiKey: this.apiKey,
      timeout: this.timeout,
      baseURL,
    });
  }

  getType() {
    return 'deepseek';
  }

  getDefaultModel() {
    return 'deepseek-chat';
  }

  getAvailableModels() {
    return [
      {
        id: 'deepseek-chat',
        name: 'DeepSeek Chat',
        description: 'General chat model',
      },
      {
        id: 'deepseek-reasoner',
        name: 'DeepSeek Reasoner',
        description: 'Reasoning-focused model',
      },
    ];
  }

  formatMessages(messages) {
    // Same as OpenAIProvider
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
      logger.debug(`DeepSeek request: model=${model}, messages=${formattedMessages.length}, tools=${options.tools?.length || 0}`);
      const response = await this.withRetry(async () => {
        return await this.client.chat.completions.create(requestParams);
      });
      return this.parseResponse(response);
    } catch (error) {
      logger.error('DeepSeek chat error:', error);
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
          logger.warn('Failed to parse DeepSeek tool call arguments');
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
      logger.error('DeepSeek stream error:', error);
      if (onChunk) onChunk({ type: 'error', error: error.message || String(error) });
      throw this.createError(error, 'streamChat');
    }
  }
}

module.exports = DeepSeekProvider;

