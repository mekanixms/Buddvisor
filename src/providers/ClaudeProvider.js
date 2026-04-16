const Anthropic = require('@anthropic-ai/sdk');
const BaseLLMProvider = require('./BaseLLMProvider');
const logger = require('../utils/logger');

/**
 * Claude/Anthropic LLM provider implementation
 */
class ClaudeProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super(config);

    if (!this.apiKey) {
      throw new Error('API key is required for Claude provider');
    }

    try {
      this.client = new Anthropic({
        apiKey: this.apiKey,
        timeout: this.timeout,
      });

      // Validate that the client was created properly
      if (!this.client) {
        throw new Error('Failed to initialize Anthropic client');
      }

      // Validate that messages API exists
      if (!this.client.messages) {
        const clientKeys = this.client ? Object.keys(this.client) : [];
        logger.error('Anthropic client structure:', {
          hasClient: !!this.client,
          clientKeys,
          clientType: typeof this.client,
          apiKeyLength: this.apiKey ? this.apiKey.length : 0,
        });
        throw new Error(`Anthropic client does not have messages API. Client keys: ${clientKeys.join(', ')}. Please check SDK version compatibility.`);
      }
    } catch (error) {
      logger.error('Failed to initialize Claude provider:', error);
      throw new Error(`Claude provider initialization failed: ${error.message}`);
    }

    this.systemMessage = config.systemMessage || null;
  }

  getType() {
    return 'claude';
  }

  getDefaultModel() {
    return 'claude-3-5-sonnet-20241022';
  }

  getAvailableModels() {
    return [
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        description: 'Best balance of intelligence and speed',
      },
      {
        id: 'claude-3-opus-20240229',
        name: 'Claude 3 Opus',
        description: 'Most powerful model for complex tasks',
      },
      {
        id: 'claude-3-sonnet-20240229',
        name: 'Claude 3 Sonnet',
        description: 'Balanced performance and cost',
      },
      {
        id: 'claude-3-haiku-20240307',
        name: 'Claude 3 Haiku',
        description: 'Fastest and most compact',
      },
    ];
  }

  /**
   * Format messages from standard format to Claude's format
   * Claude uses a separate system parameter, not a system message in the array
   */
  formatMessages(messages) {
    const formattedMessages = [];
    let systemMessage = this.systemMessage;

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Accumulate system messages
        systemMessage = systemMessage
          ? `${systemMessage}\n\n${msg.content}`
          : msg.content;
      } else if (msg.role === 'assistant') {
        // Handle assistant messages with potential tool_calls
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          // Convert to Claude's format with tool_use blocks
          const content = [];
          if (msg.content) {
            content.push({ type: 'text', text: msg.content });
          }
          for (const toolCall of msg.tool_calls) {
            content.push({
              type: 'tool_use',
              id: toolCall.id,
              name: toolCall.name,
              input: toolCall.input,
            });
          }
          formattedMessages.push({
            role: 'assistant',
            content,
          });
        } else {
          formattedMessages.push({
            role: 'assistant',
            content: msg.content,
          });
        }
      } else if (msg.role === 'tool') {
        // Tool result message
        formattedMessages.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.tool_call_id,
              content: msg.content,
            },
          ],
        });
      } else {
        formattedMessages.push({
          role: 'user',
          content: msg.content,
        });
      }
    }

    return { messages: formattedMessages, system: systemMessage };
  }

  /**
   * Parse Claude's response to standardized format
   */
  parseResponse(response) {
    const textBlocks = response.content.filter(block => block.type === 'text');
    const toolUseBlocks = response.content.filter(block => block.type === 'tool_use');

    const content = textBlocks.map(block => block.text).join('\n');

    // Extract tool calls
    const toolCalls = toolUseBlocks.map(block => ({
      id: block.id,
      name: block.name,
      input: block.input,
    }));

    return {
      content,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      stop_reason: response.stop_reason || 'unknown',
      usage: {
        input_tokens: response.usage?.input_tokens || 0,
        output_tokens: response.usage?.output_tokens || 0,
        total_tokens: (response.usage?.input_tokens || 0) + (response.usage?.output_tokens || 0),
      },
      model: response.model,
    };
  }

  /**
   * Send a chat completion request to Claude
   */
  async chat(messages, options = {}) {
    const { messages: formattedMessages, system } = this.formatMessages(messages);

    const requestParams = {
      model: options.model || this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      messages: formattedMessages,
    };

    if (system) {
      if (options.usePromptCache) {
        requestParams.system = [
          { type: 'text', text: system },
          { type: 'text', text: '', cache_control: { type: 'ephemeral' } },
        ];
      } else {
        requestParams.system = system;
      }
    }

    if (options.temperature !== undefined) {
      requestParams.temperature = options.temperature;
    } else if (this.temperature !== undefined) {
      requestParams.temperature = this.temperature;
    }

    if (options.stopSequences) {
      requestParams.stop_sequences = options.stopSequences;
    }

    // Add tools if provided
    if (options.tools && options.tools.length > 0) {
      requestParams.tools = options.tools;
    }

    try {
      // Validate client before making request
      if (!this.client || !this.client.messages) {
        throw new Error('Claude client is not properly initialized. Please check your API key and SDK installation.');
      }

      logger.debug(`Claude request: model=${requestParams.model}, messages=${formattedMessages.length}, tools=${options.tools?.length || 0}, usePromptCache=${!!options.usePromptCache}`);

      const response = await this.withRetry(async () => {
        return await this.client.messages.create(requestParams);
      });

      const parsed = this.parseResponse(response);
      logger.debug(`Claude response: tokens=${parsed.usage.input_tokens}/${parsed.usage.output_tokens}, stop_reason=${parsed.stop_reason}`);

      return parsed;
    } catch (error) {
      logger.error('Claude chat error:', error.message);
      logger.error('Claude client state:', {
        hasClient: !!this.client,
        hasMessages: !!(this.client && this.client.messages),
        clientType: this.client ? typeof this.client : 'undefined',
        apiKeyPresent: !!this.apiKey,
        apiKeyLength: this.apiKey ? this.apiKey.length : 0,
      });
      throw this.createError(error, 'chat');
    }
  }

  /**
   * Send a streaming chat completion request to Claude
   */
  async streamChat(messages, onChunk, options = {}) {
    const { messages: formattedMessages, system } = this.formatMessages(messages);

    const requestParams = {
      model: options.model || this.model,
      max_tokens: options.maxTokens || this.maxTokens,
      messages: formattedMessages,
      stream: true,
    };

    if (system) {
      if (options.usePromptCache) {
        requestParams.system = [
          { type: 'text', text: system },
          { type: 'text', text: '', cache_control: { type: 'ephemeral' } },
        ];
      } else {
        requestParams.system = system;
      }
    }

    if (options.temperature !== undefined) {
      requestParams.temperature = options.temperature;
    } else if (this.temperature !== undefined) {
      requestParams.temperature = this.temperature;
    }

    // Add tools if provided
    if (options.tools && options.tools.length > 0) {
      requestParams.tools = options.tools;
    }

    try {
      // Validate client before making request
      if (!this.client || !this.client.messages) {
        throw new Error('Claude client is not properly initialized. Please check your API key and SDK installation.');
      }

      logger.debug(`Claude stream request: model=${requestParams.model}, tools=${options.tools?.length || 0}, usePromptCache=${!!options.usePromptCache}`);

      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let finishReason = 'unknown';
      const toolCalls = [];
      let currentToolUse = null;

      const stream = await this.client.messages.stream(requestParams);

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block?.type === 'tool_use') {
            currentToolUse = {
              id: event.content_block.id,
              name: event.content_block.name,
              input: '',
            };
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta') {
            const text = event.delta.text || '';
            fullContent += text;
            if (onChunk) {
              onChunk({ type: 'text', content: text });
            }
          } else if (event.delta?.type === 'input_json_delta' && currentToolUse) {
            currentToolUse.input += event.delta.partial_json || '';
          }
        } else if (event.type === 'content_block_stop') {
          if (currentToolUse) {
            try {
              currentToolUse.input = JSON.parse(currentToolUse.input);
            } catch (e) {
              logger.warn('Failed to parse tool input JSON');
            }
            toolCalls.push(currentToolUse);
            currentToolUse = null;
          }
        } else if (event.type === 'message_start') {
          inputTokens = event.message?.usage?.input_tokens || 0;
        } else if (event.type === 'message_delta') {
          outputTokens = event.usage?.output_tokens || 0;
          finishReason = event.delta?.stop_reason || finishReason;
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

      logger.debug(`Claude stream complete: tokens=${inputTokens}/${outputTokens}, stop_reason=${finishReason}`);

      return result;
    } catch (error) {
      logger.error('Claude stream error:', error.message);
      if (onChunk) {
        onChunk({ type: 'error', error: error.message });
      }
      throw this.createError(error, 'streamChat');
    }
  }

  /**
   * Estimate tokens using Claude's approximation
   * Claude uses approximately 3.5-4 characters per token
   */
  estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / 3.5);
  }
}

module.exports = ClaudeProvider;
