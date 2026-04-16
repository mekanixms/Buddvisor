const OpenAI = require('openai');
const BaseLLMProvider = require('./BaseLLMProvider');
const logger = require('../utils/logger');

/**
 * xAI (Grok) LLM provider implementation
 * Uses OpenAI-compatible API
 */
class XAIProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super(config);

    this.client = new OpenAI({
      apiKey: this.apiKey,
      timeout: this.timeout,
      baseURL: config.baseURL || 'https://api.x.ai/v1',
    });
  }

  getType() {
    return 'xai';
  }

  getDefaultModel() {
    return 'grok-beta';
  }

  getAvailableModels() {
    return [
      {
        id: 'grok-beta',
        name: 'Grok Beta',
        description: 'Latest Grok model with enhanced capabilities',
      },
      {
        id: 'grok-2-1212',
        name: 'Grok 2 (Dec 2024)',
        description: 'Grok 2 model from December 2024',
      },
      {
        id: 'grok-2-vision-1212',
        name: 'Grok 2 Vision',
        description: 'Grok 2 with vision capabilities',
      },
    ];
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
   * Send a chat completion request to xAI
   */
  async chat(messages, options = {}) {
    const formattedMessages = this.formatMessages(messages);

    const requestParams = {
      model: options.model || this.model,
      messages: formattedMessages,
      max_tokens: options.maxTokens || this.maxTokens,
    };

    if (options.temperature !== undefined) {
      requestParams.temperature = options.temperature;
    } else if (this.temperature !== undefined) {
      requestParams.temperature = this.temperature;
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

    const requestOptions = {};
    if (options.usePromptCache && options.conversationId) {
      requestOptions.headers = { 'x-grok-conv-id': options.conversationId };
    }

    try {
      logger.debug(`xAI request: model=${requestParams.model}, messages=${formattedMessages.length}, tools=${options.tools?.length || 0}, usePromptCache=${!!options.usePromptCache}`);

      const response = await this.withRetry(async () => {
        return await this.client.chat.completions.create(requestParams, requestOptions);
      });

      const parsed = this.parseResponse(response);
      logger.debug(`xAI response: tokens=${parsed.usage.input_tokens}/${parsed.usage.output_tokens}, stop_reason=${parsed.stop_reason}`);

      return parsed;
    } catch (error) {
      logger.error('xAI chat error:', error);
      throw this.createError(error, 'chat');
    }
  }

  /**
   * Send a streaming chat completion request to xAI
   */
  async streamChat(messages, onChunk, options = {}) {
    const formattedMessages = this.formatMessages(messages);

    const requestParams = {
      model: options.model || this.model,
      messages: formattedMessages,
      max_tokens: options.maxTokens || this.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (options.temperature !== undefined) {
      requestParams.temperature = options.temperature;
    } else if (this.temperature !== undefined) {
      requestParams.temperature = this.temperature;
    }

    // Add tools if provided (convert from Claude format to OpenAI format)
    if (options.tools && options.tools.length > 0) {
      requestParams.tools = this.formatTools(options.tools);
    }

    const requestOptions = {};
    if (options.usePromptCache && options.conversationId) {
      requestOptions.headers = { 'x-grok-conv-id': options.conversationId };
    }

    try {
      logger.debug(`xAI stream request: model=${requestParams.model}, tools=${options.tools?.length || 0}, usePromptCache=${!!options.usePromptCache}`);

      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason = 'unknown';
      const toolCalls = [];
      const toolCallDeltas = {};

      const stream = await this.client.chat.completions.create(requestParams, requestOptions);

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

      logger.debug(`xAI stream complete: tokens=${inputTokens}/${outputTokens}, stop_reason=${finishReason}`);

      return result;
    } catch (error) {
      logger.error('xAI stream error:', error);
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

module.exports = XAIProvider;
