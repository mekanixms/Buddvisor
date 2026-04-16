const OpenAI = require('openai');
const BaseLLMProvider = require('./BaseLLMProvider');
const logger = require('../utils/logger');

/**
 * OpenAI LLM provider implementation
 */
class OpenAIProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super(config);

    this.client = new OpenAI({
      apiKey: this.apiKey,
      timeout: this.timeout,
      baseURL: config.baseURL, // Allows custom endpoints (Azure, local, etc.)
    });
  }

  getType() {
    return 'openai';
  }

  getDefaultModel() {
    return 'gpt-4o';
  }

  getAvailableModels() {
    return [
      {
        id: 'gpt-4o',
        name: 'GPT-4o',
        description: 'Most capable GPT-4 model with vision',
      },
      {
        id: 'gpt-4o-mini',
        name: 'GPT-4o Mini',
        description: 'Smaller, faster, cheaper GPT-4o variant',
      },
      {
        id: 'gpt-4-turbo',
        name: 'GPT-4 Turbo',
        description: 'GPT-4 Turbo with improved performance',
      },
      {
        id: 'gpt-4',
        name: 'GPT-4',
        description: 'Original GPT-4 model',
      },
      {
        id: 'gpt-3.5-turbo',
        name: 'GPT-3.5 Turbo',
        description: 'Fast and cost-effective',
      },
    ];
  }

  /**
   * Check if model uses max_completion_tokens instead of max_tokens
   * Newer models (gpt-4o, gpt-4o-mini, etc.) use max_completion_tokens
   * Older models (gpt-3.5-turbo, gpt-4, gpt-4-turbo) use max_tokens
   */
  usesMaxCompletionTokens(model) {
    // Models that use max_completion_tokens
    const newModels = ['gpt-4o', 'gpt-4o-mini','gpt-5-mini','gpt-5-pro','gpt-5','gpt-5-nano','gpt-5.1','gpt-5.1-nano','gpt-5.1-pro','gpt-5.2','gpt-5.2-chat-latest','gpt-5.2-pro'];

    // Check if model starts with any of the new model prefixes
    return newModels.some(prefix => model.startsWith(prefix));
  }

  /**
   * Format messages from standard format to OpenAI's format
   * OpenAI accepts system messages directly in the messages array
   */
  formatMessages(messages) {
    return messages.map(msg => {
      // Handle tool call messages
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

      // Handle tool result messages
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

  /**
   * Convert tools from Claude format to OpenAI format
   */
  formatTools(tools) {
    if (!tools || tools.length === 0) return undefined;

    return tools.map(tool => {
      // If tool already has input_schema (from getToolDefinitionsForLLM),
      // clean it up by removing 'required' field from each property
      let parameters = tool.input_schema;
      
      if (parameters && parameters.properties) {
        // Clean properties: remove 'required' boolean from each property
        // since OpenAI expects 'required' only as a top-level array
        const cleanedProperties = {};
        for (const [propName, propSchema] of Object.entries(parameters.properties)) {
          const { required, ...cleanedSchema } = propSchema;
          cleanedProperties[propName] = cleanedSchema;
        }
        
        parameters = {
          ...parameters,
          properties: cleanedProperties,
          // Ensure required is an array (already should be from getToolDefinitionsForLLM)
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

  /**
   * Parse OpenAI's response to standardized format
   */
  parseResponse(response) {
    const choice = response.choices?.[0];
    const message = choice?.message;
    const content = message?.content || '';

    // Extract tool calls if present
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
   * Send a chat completion request to OpenAI
   */
  async chat(messages, options = {}) {
    const formattedMessages = this.formatMessages(messages);

    const model = options.model || this.model;
    const requestParams = {
      model: model,
      messages: formattedMessages,
    };

    // Use max_completion_tokens for newer models, max_tokens for older ones
    const maxTokens = options.maxTokens || this.maxTokens;
    if (this.usesMaxCompletionTokens(model)) {
      requestParams.max_completion_tokens = maxTokens;
    } else {
      requestParams.max_tokens = maxTokens;
    }

    // Only set temperature for older models (newer models only support default of 1)
    if (!this.usesMaxCompletionTokens(model)) {
      if (options.temperature !== undefined) {
        requestParams.temperature = options.temperature;
      } else if (this.temperature !== undefined) {
        requestParams.temperature = this.temperature;
      }
    }

    if (options.topP !== undefined) {
      requestParams.top_p = options.topP;
    }

    if (options.stop) {
      requestParams.stop = options.stop;
    }

    if (options.frequencyPenalty !== undefined) {
      requestParams.frequency_penalty = options.frequencyPenalty;
    }

    if (options.presencePenalty !== undefined) {
      requestParams.presence_penalty = options.presencePenalty;
    }

    // Add tools if provided (convert from Claude format to OpenAI format)
    if (options.tools && options.tools.length > 0) {
      requestParams.tools = this.formatTools(options.tools);
    }

    try {
      logger.debug(`OpenAI request: model=${requestParams.model}, messages=${formattedMessages.length}, tools=${options.tools?.length || 0}`);

      const response = await this.withRetry(async () => {
        return await this.client.chat.completions.create(requestParams);
      });

      const parsed = this.parseResponse(response);
      logger.debug(`OpenAI response: tokens=${parsed.usage.input_tokens}/${parsed.usage.output_tokens}, stop_reason=${parsed.stop_reason}`);

      return parsed;
    } catch (error) {
      logger.error('OpenAI chat error:', error);
      throw this.createError(error, 'chat');
    }
  }

  /**
   * Send a streaming chat completion request to OpenAI
   */
  async streamChat(messages, onChunk, options = {}) {
    const formattedMessages = this.formatMessages(messages);

    const model = options.model || this.model;
    const requestParams = {
      model: model,
      messages: formattedMessages,
      stream: true,
      stream_options: { include_usage: true },
    };

    // Use max_completion_tokens for newer models, max_tokens for older ones
    const maxTokens = options.maxTokens || this.maxTokens;
    if (this.usesMaxCompletionTokens(model)) {
      requestParams.max_completion_tokens = maxTokens;
    } else {
      requestParams.max_tokens = maxTokens;
    }

    // Only set temperature for older models (newer models only support default of 1)
    if (!this.usesMaxCompletionTokens(model)) {
      if (options.temperature !== undefined) {
        requestParams.temperature = options.temperature;
      } else if (this.temperature !== undefined) {
        requestParams.temperature = this.temperature;
      }
    }

    // Add tools if provided (convert from Claude format to OpenAI format)
    if (options.tools && options.tools.length > 0) {
      requestParams.tools = this.formatTools(options.tools);
    }

    try {
      logger.debug(`OpenAI stream request: model=${requestParams.model}, tools=${options.tools?.length || 0}`);

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
          if (onChunk) {
            onChunk({ type: 'text', content });
          }
        }

        // Handle tool call deltas
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

        // Check for finish reason
        if (chunk.choices?.[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        // Get usage from final chunk
        if (chunk.usage) {
          inputTokens = chunk.usage.prompt_tokens || 0;
          outputTokens = chunk.usage.completion_tokens || 0;
        }
      }

      // Finalize tool calls
      for (const tc of Object.values(toolCallDeltas)) {
        try {
          toolCalls.push({
            id: tc.id,
            name: tc.name,
            input: JSON.parse(tc.arguments || '{}'),
          });
        } catch (e) {
          logger.warn('Failed to parse tool call arguments');
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

      if (onChunk) {
        onChunk({ type: 'done', result });
      }

      logger.debug(`OpenAI stream complete: tokens=${inputTokens}/${outputTokens}, stop_reason=${finishReason}`);

      return result;
    } catch (error) {
      logger.error('OpenAI stream error:', error);
      if (onChunk) {
        onChunk({ type: 'error', error: error.message || String(error) });
      }
      throw this.createError(error, 'streamChat');
    }
  }

  /**
   * Estimate tokens using OpenAI's approximation
   * OpenAI uses approximately 4 characters per token
   */
  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }
}

module.exports = OpenAIProvider;
