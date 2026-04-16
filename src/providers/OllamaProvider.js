const { Ollama } = require('ollama');
const BaseLLMProvider = require('./BaseLLMProvider');
const logger = require('../utils/logger');

/** Default max request body size for Ollama (bytes). Large payloads can trigger server-side parse errors. */
const DEFAULT_OLLAMA_MAX_REQUEST_BYTES = 40000;

class OllamaProvider extends BaseLLMProvider {
  constructor(config = {}) {
    config.apiKey = config.apiKey || 'local';
    super(config);

    this.baseURL = config.baseURL || 'http://localhost:11434';
    this.client = new Ollama({ host: this.baseURL });
    const envMax = process.env.OLLAMA_MAX_REQUEST_BYTES;
    this.maxRequestBytes = envMax ? parseInt(envMax, 10) : (config.maxRequestBytes ?? DEFAULT_OLLAMA_MAX_REQUEST_BYTES);
    if (!Number.isFinite(this.maxRequestBytes) || this.maxRequestBytes < 4096) {
      this.maxRequestBytes = DEFAULT_OLLAMA_MAX_REQUEST_BYTES;
    }
  }

  getType() {
    return 'ollama';
  }

  getDefaultModel() {
    return 'llama3.1';
  }

  getAvailableModels() {
    return [
      {
        id: 'llama3.1',
        name: 'Llama 3.1 [Tools]',
        description: 'Meta Llama 3.1 (8B) - Supports tool calling',
      },
      {
        id: 'llama3.1:70b',
        name: 'Llama 3.1 70B [Tools]',
        description: 'Meta Llama 3.1 (70B) - Supports tool calling',
      },
      {
        id: 'llama3.2',
        name: 'Llama 3.2 [Tools]',
        description: 'Meta Llama 3.2 (3B) - Supports tool calling',
      },
      {
        id: 'mistral',
        name: 'Mistral [Tools]',
        description: 'Mistral 7B - Supports tool calling',
      },
      {
        id: 'mixtral',
        name: 'Mixtral [Tools]',
        description: 'Mixtral 8x7B MoE - Supports tool calling',
      },
      {
        id: 'qwen2.5',
        name: 'Qwen 2.5 [Tools]',
        description: 'Alibaba Qwen 2.5 - Supports tool calling',
      },
      {
        id: 'qwen2.5:72b',
        name: 'Qwen 2.5 72B [Tools]',
        description: 'Alibaba Qwen 2.5 (72B) - Supports tool calling',
      },
      {
        id: 'qwq',
        name: 'QwQ [Tools]',
        description: 'Alibaba QwQ reasoning model - Supports tool calling',
      },
      {
        id: 'granite3.1-dense',
        name: 'Granite 3.1 Dense [Tools]',
        description: 'IBM Granite 3.1 Dense - Supports tool calling',
      },
      {
        id: 'granite3.1-moe',
        name: 'Granite 3.1 MoE [Tools]',
        description: 'IBM Granite 3.1 MoE - Supports tool calling',
      },
      {
        id: 'granite3-dense',
        name: 'Granite 3 Dense [Tools]',
        description: 'IBM Granite 3 Dense - Supports tool calling',
      },
      {
        id: 'deepseek-r1',
        name: 'DeepSeek R1 [Tools]',
        description: 'DeepSeek R1 reasoning model - Supports tool calling',
      },
      {
        id: 'deepseek-v3',
        name: 'DeepSeek V3 [Tools]',
        description: 'DeepSeek V3 - Supports tool calling',
      },
      {
        id: 'deepseek-coder-v2',
        name: 'DeepSeek Coder V2 [Tools]',
        description: 'DeepSeek Coder V2 - Supports tool calling',
      },
      {
        id: 'codellama',
        name: 'Code Llama',
        description: 'Code-specialized Llama',
      },
      {
        id: 'phi3',
        name: 'Phi-3 [Tools]',
        description: 'Microsoft Phi-3 - Supports tool calling',
      },
      {
        id: 'command-r',
        name: 'Command R [Tools]',
        description: 'Cohere Command R - Supports tool calling',
      },
    ];
  }

  /**
   * Override validation - Ollama doesn't need API key
   */
  validateConfig() {
    // No validation needed for Ollama
  }

  /**
   * Best-effort check for whether this Ollama model supports tool calling.
   * Many vision/VL models return 400 if you include `tools`.
   */
  supportsTools(model = null) {
    const m = String(model || this.model || '')
      .trim()
      .toLowerCase();
    const looksLikeGemma = m.startsWith('gemma') || /(^|[/_.-])gemma/.test(m);
    return (
      m.startsWith('llama3') ||
      m.startsWith('mistral') ||
      m.startsWith('mixtral') ||
      m.startsWith('qwen2.5') ||
      m.startsWith('qwen3') ||
      looksLikeGemma ||
      m.startsWith('qwq') ||
      m.startsWith('granite') ||
      m.startsWith('deepseek') ||
      m.startsWith('kimi') ||
      m.startsWith('phi3') ||
      m.startsWith('command-r')
    );
  }

  /**
   * Trim the request body so its JSON serialization stays under maxBytes.
   *
   * Strategy (executed in order until size fits):
   *   Phase 0 – Hard-cap every individual message content length.
   *   Phase 1 – Drop oldest conversation messages (keep system + last few).
   *   Phase 2 – Progressively truncate the largest remaining message content.
   *   Phase 3 – Shorten tool descriptions, then drop tools entirely.
   */
  trimMessagesToFitRequestSize(requestBody, maxBytes) {
    const msgs = requestBody.messages;
    if (!msgs || msgs.length === 0) return requestBody;

    const measure = () => JSON.stringify(requestBody).length;
    let size = measure();
    if (size <= maxBytes) return requestBody;

    const origMsgCount = msgs.length;

    const maxSingleMsg = Math.max(4000, Math.floor(maxBytes * 0.6));
    for (const m of requestBody.messages) {
      if (typeof m.content === 'string' && m.content.length > maxSingleMsg) {
        m.content = m.content.slice(0, maxSingleMsg) + '\n[… context trimmed …]';
      }
    }
    size = measure();
    if (size <= maxBytes) {
      logger.warn(`Ollama trim: Phase 0 sufficient (${size} bytes, max ${maxBytes}, capped msgs to ${maxSingleMsg} chars)`);
      return requestBody;
    }

    const keepFromEnd = Math.min(3, requestBody.messages.length - 1);
    while (size > maxBytes && requestBody.messages.length > keepFromEnd + 1) {
      const hasSystem = requestBody.messages[0]?.role === 'system';
      const dropIdx = hasSystem ? 1 : 0;
      requestBody.messages.splice(dropIdx, 1);
      size = measure();
    }
    if (requestBody.messages.length < origMsgCount) {
      logger.warn(`Ollama trim: Phase 1 dropped to ${requestBody.messages.length}/${origMsgCount} messages (${size} bytes)`);
    }
    if (size <= maxBytes) return requestBody;

    const minContent = 150;
    let iterations = 0;
    while (size > maxBytes && iterations < 20) {
      iterations++;
      let bestIdx = -1, bestLen = 0;
      for (let i = 0; i < requestBody.messages.length; i++) {
        const len = typeof requestBody.messages[i].content === 'string' ? requestBody.messages[i].content.length : 0;
        if (len > bestLen && len > minContent) { bestLen = len; bestIdx = i; }
      }
      if (bestIdx < 0) break;
      const m = requestBody.messages[bestIdx];
      const keep = Math.max(minContent, Math.floor(m.content.length * 0.4));
      m.content = m.content.slice(0, keep) + '\n[… trimmed …]';
      size = measure();
    }
    if (size <= maxBytes) {
      logger.warn(`Ollama trim: Phase 2 done (${size} bytes after ${iterations} rounds)`);
      return requestBody;
    }

    if (requestBody.tools && requestBody.tools.length > 0) {
      for (const t of requestBody.tools) {
        if (t.function?.description?.length > 80) t.function.description = t.function.description.slice(0, 80) + '…';
        const props = t.function?.parameters?.properties;
        if (props) for (const p of Object.values(props)) {
          if (p?.description?.length > 40) p.description = p.description.slice(0, 40) + '…';
        }
      }
      size = measure();
      if (size > maxBytes) {
        logger.warn(`Ollama trim: Phase 3 dropping tools (${size} bytes)`);
        delete requestBody.tools;
        size = measure();
      }
    }

    if (size > maxBytes) {
      logger.warn(`Ollama trim: request still ${size} bytes after all phases (max ${maxBytes}); sending anyway`);
    }
    return requestBody;
  }

  /**
   * Format tools from standard format to Ollama's OpenAI-compatible format
   */
  formatTools(tools) {
    if (!tools || tools.length === 0) return undefined;

    return tools.map(tool => {
      const schema = tool.input_schema || {};

      const cleanedProperties = {};
      if (schema.properties) {
        for (const [propName, propSchema] of Object.entries(schema.properties)) {
          const { required, ...cleanedSchema } = propSchema;
          cleanedProperties[propName] = cleanedSchema;
        }
      }

      return {
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: 'object',
            properties: cleanedProperties,
            required: schema.required || [],
          },
        },
      };
    });
  }

  /**
   * Flatten a tool_calls assistant message to plain text.
   */
  _flattenToolCallsMessage(msg) {
    const rawContent = msg.content;
    const contentStr = typeof rawContent === 'string' ? rawContent : (rawContent != null ? JSON.stringify(rawContent) : '');
    const callSummaries = (msg.tool_calls || []).map(tc => {
      const name = tc.name || tc.function?.name || 'unknown';
      let argsPreview;
      try {
        const raw = tc.input ?? tc.function?.arguments;
        const obj = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
        argsPreview = this._jsonToPlainText(obj);
      } catch { argsPreview = String(tc.input ?? tc.function?.arguments ?? '(none)'); }
      if (argsPreview.length > 200) argsPreview = argsPreview.slice(0, 200) + '…';
      return `[Called tool: ${name} with ${argsPreview}]`;
    }).join('\n');
    const parts = [contentStr, callSummaries].filter(Boolean);
    return { role: 'assistant', content: parts.join('\n') };
  }

  /**
   * Flatten a tool-result message to plain text.
   */
  _flattenToolResultMessage(msg) {
    const toolName = msg.tool_name || msg.name || '';
    let contentStr = this._safeToolContent(msg.content);
    const maxLen = 4000;
    if (contentStr.length > maxLen) contentStr = contentStr.slice(0, maxLen) + '… [trimmed]';
    const label = toolName ? `[Tool result (${toolName}): ${contentStr}]` : `[Tool result: ${contentStr}]`;
    return { role: 'assistant', content: label };
  }

  /**
   * Convert tool content to a safe plain-text string. If the content is/contains
   * JSON with braces, parse it and render it as readable key=value text.
   */
  _safeToolContent(content) {
    if (content == null) return '';
    let str = typeof content === 'string' ? content : JSON.stringify(content);
    if (str.startsWith('{') || str.startsWith('[')) {
      try {
        const parsed = JSON.parse(str);
        str = this._jsonToPlainText(parsed);
      } catch { /* keep as-is */ }
    }
    return str;
  }

  /**
   * Recursively render a JSON value as flat, brace-free text.
   */
  _jsonToPlainText(val, depth = 0) {
    if (val === null || val === undefined) return 'null';
    if (typeof val === 'boolean' || typeof val === 'number') return String(val);
    if (typeof val === 'string') return val;
    if (Array.isArray(val)) {
      if (val.length === 0) return '(empty list)';
      if (val.length > 20) {
        const head = val.slice(0, 10).map(v => this._jsonToPlainText(v, depth + 1));
        return head.join(' | ') + ` | ... (${val.length} items total)`;
      }
      return val.map(v => this._jsonToPlainText(v, depth + 1)).join(' | ');
    }
    if (typeof val === 'object') {
      const entries = Object.entries(val);
      if (entries.length === 0) return '(empty)';
      return entries.map(([k, v]) => `${k}: ${this._jsonToPlainText(v, depth + 1)}`).join(', ');
    }
    return String(val);
  }

  /**
   * Format messages from standard format to Ollama's format.
   * Tool_calls and tool-result messages are flattened to plain text to keep
   * the request payload simple and avoid deeply nested JSON.
   */
  formatMessages(messages) {
    return messages.map(msg => {
      if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
        return this._flattenToolCallsMessage(msg);
      }

      if (msg.role === 'tool') {
        return this._flattenToolResultMessage(msg);
      }

      const content = msg.content;
      const contentStr = typeof content === 'string' ? content : (content != null ? JSON.stringify(content) : '');
      return {
        role: msg.role,
        content: contentStr,
      };
    });
  }

  /**
   * Parse the ollama-js ChatResponse to our standardized format.
   * The library returns parsed objects so tool_call arguments are already objects.
   */
  parseResponse(response) {
    const message = response.message || {};
    const rawContent = message.content ?? '';
    const content = BaseLLMProvider.extractTextFromContent(rawContent);

    let toolCalls = undefined;
    if (message.tool_calls && message.tool_calls.length > 0) {
      toolCalls = message.tool_calls.map(tc => {
        const args = tc.function?.arguments;
        const input = (args != null && typeof args === 'object') ? args : {};
        return {
          id: `ollama-tool-${Date.now()}`,
          name: tc.function?.name,
          input,
        };
      });
    }

    let stopReason = response.done ? 'stop' : 'unknown';
    if (toolCalls && toolCalls.length > 0) {
      stopReason = 'tool_calls';
    }

    return {
      content,
      tool_calls: toolCalls,
      stop_reason: stopReason,
      usage: {
        input_tokens: response.prompt_eval_count || 0,
        output_tokens: response.eval_count || 0,
        total_tokens: (response.prompt_eval_count || 0) + (response.eval_count || 0),
      },
      model: response.model,
    };
  }

  /**
   * Get list of locally available models
   */
  async getLocalModels() {
    try {
      const response = await this.client.list();
      return response.models || [];
    } catch (error) {
      logger.error('Failed to get Ollama models:', error.message);
      return [];
    }
  }

  /**
   * Check if Ollama server is running
   */
  async healthCheck() {
    try {
      await this.client.list();
      return true;
    } catch (error) {
      logger.error('Ollama health check failed:', error.message);
      return false;
    }
  }

  /**
   * Send a chat completion request to Ollama
   */
  async chat(messages, options = {}) {
    const formattedMessages = this.formatMessages(messages);
    const model = options.model || this.model;

    const requestBody = {
      model,
      messages: formattedMessages,
      options: {
        num_predict: options.maxTokens || this.maxTokens,
      },
    };

    if (options.temperature !== undefined || this.temperature !== undefined) {
      requestBody.options.temperature = options.temperature ?? this.temperature;
    }

    if (options.topP !== undefined) {
      requestBody.options.top_p = options.topP;
    }

    if (options.topK !== undefined) {
      requestBody.options.top_k = options.topK;
    }

    if (options.tools && options.tools.length > 0 && this.supportsTools(model)) {
      requestBody.tools = this.formatTools(options.tools);
    }

    this.trimMessagesToFitRequestSize(requestBody, this.maxRequestBytes);

    try {
      const bodySize = JSON.stringify(requestBody).length;
      logger.info(`Ollama chat: model=${model}, msgs=${requestBody.messages.length}, tools=${requestBody.tools?.length || 0}, body=${bodySize}B, max=${this.maxRequestBytes}B`);

      const response = await this.withRetry(async () => {
        return await this.client.chat({ ...requestBody, stream: false });
      });

      const parsed = this.parseResponse(response);
      logger.debug(`Ollama response: tokens=${parsed.usage.input_tokens}/${parsed.usage.output_tokens}, stop_reason=${parsed.stop_reason}`);

      return parsed;
    } catch (error) {
      const msg = error.message || 'Ollama chat failed';
      logger.error('Ollama chat error:', msg);
      throw this.createError(error, 'chat');
    }
  }

  /**
   * Send a streaming chat completion request to Ollama
   */
  async streamChat(messages, onChunk, options = {}) {
    const formattedMessages = this.formatMessages(messages);
    const model = options.model || this.model;

    const requestBody = {
      model,
      messages: formattedMessages,
      options: {
        num_predict: options.maxTokens || this.maxTokens,
      },
    };

    if (options.temperature !== undefined || this.temperature !== undefined) {
      requestBody.options.temperature = options.temperature ?? this.temperature;
    }

    if (options.tools && options.tools.length > 0 && this.supportsTools(model)) {
      requestBody.tools = this.formatTools(options.tools);
    }

    this.trimMessagesToFitRequestSize(requestBody, this.maxRequestBytes);

    try {
      const bodySize = JSON.stringify(requestBody).length;
      logger.info(`Ollama stream: model=${model}, msgs=${requestBody.messages.length}, tools=${requestBody.tools?.length || 0}, body=${bodySize}B, max=${this.maxRequestBytes}B`);

      const stream = await this.client.chat({ ...requestBody, stream: true });

      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      const toolCallsById = new Map();

      for await (const part of stream) {
        if (part.message?.content != null) {
          const text = BaseLLMProvider.extractTextFromContent(part.message.content);
          fullContent += text;
          if (onChunk && text) {
            onChunk({ type: 'text', content: text });
          }
        }

        if (part.message?.tool_calls) {
          for (const tc of part.message.tool_calls) {
            const id = `ollama-tool-${Date.now()}-${toolCallsById.size}`;
            const name = tc.function?.name;
            const args = tc.function?.arguments;
            const input = (args != null && typeof args === 'object') ? args : {};
            toolCallsById.set(id, { id, name, input });
          }
        }

        if (part.done) {
          inputTokens = part.prompt_eval_count || 0;
          outputTokens = part.eval_count || 0;
        }
      }

      const toolCalls = Array.from(toolCallsById.values());

      let stopReason = 'stop';
      if (toolCalls.length > 0) {
        stopReason = 'tool_calls';
      }

      const result = {
        content: fullContent,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        stop_reason: stopReason,
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
        },
      };

      if (onChunk) {
        onChunk({ type: 'done', result });
      }

      logger.debug(`Ollama stream complete: tokens=${inputTokens}/${outputTokens}`);

      return result;
    } catch (error) {
      const msg = error.message || 'Ollama stream failed';
      logger.error('Ollama stream error:', msg);
      if (onChunk) {
        onChunk({ type: 'error', error: msg });
      }
      throw this.createError(error, 'streamChat');
    }
  }

  /**
   * Pull a model from Ollama registry
   */
  async pullModel(modelName) {
    try {
      logger.info(`Pulling Ollama model: ${modelName}`);
      await this.client.pull({ model: modelName });
      logger.info(`Successfully pulled model: ${modelName}`);
      return true;
    } catch (error) {
      logger.error('Failed to pull Ollama model:', error.message);
      return false;
    }
  }
}

module.exports = OllamaProvider;
