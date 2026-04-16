const { GoogleGenerativeAI, FunctionCallingMode } = require('@google/generative-ai');
const BaseLLMProvider = require('./BaseLLMProvider');
const logger = require('../utils/logger');

/**
 * Google Gemini LLM provider implementation
 */
class GeminiProvider extends BaseLLMProvider {
  constructor(config = {}) {
    super(config);

    this.genAI = new GoogleGenerativeAI(this.apiKey);
    this.generationConfig = {
      maxOutputTokens: this.maxTokens,
      temperature: this.temperature,
    };
  }

  getType() {
    return 'gemini';
  }

  getDefaultModel() {
    return 'gemini-1.5-pro';
  }

  getAvailableModels() {
    return [
      {
        id: 'gemini-3-flash-preview',
        name: 'Gemini 3 Flash (Preview)',
        description: 'Gemini 3 Flash preview; requires thought_signature for tool calls',
      },
      {
        id: 'gemini-2.0-flash',
        name: 'Gemini 2.0 Flash',
        description: 'Latest fast and efficient model',
      },
      {
        id: 'gemini-1.5-pro',
        name: 'Gemini 1.5 Pro',
        description: 'Most capable Gemini model',
      },
      {
        id: 'gemini-1.5-flash',
        name: 'Gemini 1.5 Flash',
        description: 'Fast and efficient',
      },
      {
        id: 'gemini-pro',
        name: 'Gemini Pro',
        description: 'Balanced performance',
      },
    ];
  }

  /**
   * Convert JSON Schema type to Gemini type format
   */
  convertTypeToGemini(jsonSchemaType) {
    const typeMap = {
      'string': 'STRING',
      'number': 'NUMBER',
      'integer': 'INTEGER',
      'boolean': 'BOOLEAN',
      'array': 'ARRAY',
      'object': 'OBJECT',
    };
    return typeMap[jsonSchemaType] || 'STRING';
  }

  /**
   * Convert property schema to Gemini format
   */
  convertPropertyToGemini(propSchema) {
    const geminiProp = {
      type: this.convertTypeToGemini(propSchema.type),
      description: propSchema.description || '',
    };

    // Handle enum values
    if (propSchema.enum) {
      geminiProp.enum = propSchema.enum;
    }

    // Handle array items
    if (propSchema.type === 'array' && propSchema.items) {
      geminiProp.items = this.convertPropertyToGemini(propSchema.items);
    }

    // Handle nested objects
    if (propSchema.type === 'object' && propSchema.properties) {
      geminiProp.properties = {};
      for (const [key, value] of Object.entries(propSchema.properties)) {
        geminiProp.properties[key] = this.convertPropertyToGemini(value);
      }
    }

    return geminiProp;
  }

  /**
   * Format tools from standard format to Gemini's functionDeclarations format
   */
  formatTools(tools) {
    if (!tools || tools.length === 0) return undefined;

    const functionDeclarations = tools.map(tool => {
      const schema = tool.input_schema || {};
      const properties = {};

      // Convert each property to Gemini format
      if (schema.properties) {
        for (const [propName, propSchema] of Object.entries(schema.properties)) {
          // Remove 'required' boolean from property (it's at top level in Gemini)
          const { required: _, ...cleanSchema } = propSchema;
          properties[propName] = this.convertPropertyToGemini(cleanSchema);
        }
      }

      return {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'OBJECT',
          properties,
          required: schema.required || [],
        },
      };
    });

    return [{ functionDeclarations }];
  }

  /**
   * Format messages from standard format to Gemini's format
   * Gemini uses a different structure with parts
   */
  formatMessages(messages) {
    const history = [];
    let systemInstruction = null;

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemInstruction = systemInstruction
          ? `${systemInstruction}\n\n${msg.content}`
          : msg.content;
      } else if (msg.role === 'assistant') {
        // Handle assistant messages with potential tool calls
        if (msg.tool_calls && msg.tool_calls.length > 0) {
          const parts = [];
          if (msg.content) {
            parts.push({ text: msg.content });
          }
          // Add function calls; Gemini 3 requires thought_signature on first functionCall per step
          const GEMINI_3_DUMMY_SIGNATURE = 'context_engineering_is_the_way_to_go';
          for (let i = 0; i < msg.tool_calls.length; i++) {
            const toolCall = msg.tool_calls[i];
            const part = {
              functionCall: {
                name: toolCall.name,
                args: toolCall.input,
              },
            };
            const sig = toolCall.thought_signature;
            if (sig != null && sig !== '') {
              part.thoughtSignature = sig;
            } else if (i === 0) {
              part.thoughtSignature = GEMINI_3_DUMMY_SIGNATURE;
            }
            parts.push(part);
          }
          history.push({ role: 'model', parts });
        } else {
          history.push({
            role: 'model',
            parts: [{ text: msg.content || '' }],
          });
        }
      } else if (msg.role === 'tool') {
        // Tool result - add as function response
        history.push({
          role: 'function',
          parts: [{
            functionResponse: {
              name: msg.tool_name || 'unknown',
              response: typeof msg.content === 'string' 
                ? JSON.parse(msg.content) 
                : msg.content,
            },
          }],
        });
      } else {
        // User message
        history.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
      }
    }

    return { history, systemInstruction };
  }

  /**
   * Parse Gemini's response to standardized format
   */
  parseResponse(result) {
    const response = result.response || result;
    const candidate = response.candidates?.[0];
    const content = candidate?.content;
    const usageMetadata = response.usageMetadata || {};

    // Prefer SDK's text() - it handles Gemini 3 / thinking model formats correctly
    let text = '';
    try {
      if (typeof response.text === 'function') {
        text = response.text();
      }
    } catch (_) {
      /* ignore - fallback to manual extraction */
    }

    const parts = Array.isArray(content) ? content : (content?.parts || []);
    if (!text || typeof text !== 'string') {
      const textParts = parts.filter(p => p && (p.text != null || p.thought != null));
      text = textParts.map(p => BaseLLMProvider.extractTextFromContent(p.text ?? p.thought ?? '')).join('');
    } else {
      text = BaseLLMProvider.extractTextFromContent(text);
    }

    // Extract function calls; Gemini 3 returns thoughtSignature on (first) functionCall parts
    const functionCallParts = parts.filter(p => p && p.functionCall);
    const toolCalls = functionCallParts.map((p, index) => {
      const tc = {
        id: `gemini-tool-${Date.now()}-${index}`,
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      };
      if (p.thoughtSignature != null) {
        tc.thought_signature = p.thoughtSignature;
      }
      return tc;
    });

    // Determine stop reason
    let stopReason = candidate?.finishReason || 'STOP';
    if (functionCallParts.length > 0) {
      stopReason = 'tool_use'; // Standardize to match our expected format
    }

    return {
      content: text,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      stop_reason: stopReason,
      usage: {
        input_tokens: usageMetadata.promptTokenCount || 0,
        output_tokens: usageMetadata.candidatesTokenCount || 0,
        total_tokens: (usageMetadata.promptTokenCount || 0) + (usageMetadata.candidatesTokenCount || 0),
      },
      model: response.model,
    };
  }

  /**
   * Send a chat completion request to Gemini
   */
  async chat(messages, options = {}) {
    const { history, systemInstruction } = this.formatMessages(messages);

    try {
      logger.debug(`Gemini request: model=${options.model || this.model}, tools=${options.tools?.length || 0}`);

      const modelConfig = {
        model: options.model || this.model,
      };

      if (systemInstruction) {
        modelConfig.systemInstruction = systemInstruction;
      }

      // Add tools if provided
      if (options.tools && options.tools.length > 0) {
        modelConfig.tools = this.formatTools(options.tools);
        modelConfig.toolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingMode.AUTO,
          },
        };
      }

      const model = this.genAI.getGenerativeModel(modelConfig);

      // Get the last message (the one we will send)
      const lastMessage = history.pop();
      if (!lastMessage) {
        throw new Error('No messages to send');
      }

      // Gemini requires the first content in the conversation to have role 'user'.
      // Strip leading model/function turns so history either is empty or starts with user.
      while (history.length > 0 && history[0].role !== 'user') {
        history.shift();
      }

      const generationConfig = {
        ...this.generationConfig,
        maxOutputTokens: options.maxTokens || this.maxTokens,
      };

      if (options.temperature !== undefined) {
        generationConfig.temperature = options.temperature;
      }

      const chat = model.startChat({
        history,
        generationConfig,
      });

      const result = await this.withRetry(async () => {
        // Send the last message content
        const messageContent = lastMessage.parts.map(p => {
          if (p.text) return p.text;
          if (p.functionResponse) return p;
          return '';
        }).filter(Boolean);
        
        return await chat.sendMessage(messageContent);
      });

      const parsed = this.parseResponse(result);
      logger.debug(`Gemini response: tokens=${parsed.usage.input_tokens}/${parsed.usage.output_tokens}, stop_reason=${parsed.stop_reason}`);

      return parsed;
    } catch (error) {
      logger.error('Gemini chat error:', error.message);
      throw this.createError(error, 'chat');
    }
  }

  /**
   * Send a streaming chat completion request to Gemini
   */
  async streamChat(messages, onChunk, options = {}) {
    const { history, systemInstruction } = this.formatMessages(messages);

    try {
      logger.debug(`Gemini stream request: model=${options.model || this.model}, tools=${options.tools?.length || 0}`);

      const modelConfig = {
        model: options.model || this.model,
      };

      if (systemInstruction) {
        modelConfig.systemInstruction = systemInstruction;
      }

      // Add tools if provided
      if (options.tools && options.tools.length > 0) {
        modelConfig.tools = this.formatTools(options.tools);
        modelConfig.toolConfig = {
          functionCallingConfig: {
            mode: FunctionCallingMode.AUTO,
          },
        };
      }

      const model = this.genAI.getGenerativeModel(modelConfig);

      // Get the last message (the one we will send)
      const lastMessage = history.pop();
      if (!lastMessage) {
        throw new Error('No messages to send');
      }

      // Gemini requires the first content in the conversation to have role 'user'.
      // Strip leading model/function turns so history either is empty or starts with user.
      while (history.length > 0 && history[0].role !== 'user') {
        history.shift();
      }

      const generationConfig = {
        ...this.generationConfig,
        maxOutputTokens: options.maxTokens || this.maxTokens,
      };

      if (options.temperature !== undefined) {
        generationConfig.temperature = options.temperature;
      }

      const chat = model.startChat({
        history,
        generationConfig,
      });

      // Send the last message content
      const messageContent = lastMessage.parts.map(p => {
        if (p.text) return p.text;
        if (p.functionResponse) return p;
        return '';
      }).filter(Boolean);

      const result = await chat.sendMessageStream(messageContent);

      let fullContent = '';
      const toolCalls = [];

      for await (const chunk of result.stream) {
        const rawContent = chunk.candidates?.[0]?.content;
        const parts = Array.isArray(rawContent) ? rawContent : (rawContent?.parts || []);
        
        for (const part of parts) {
          const raw = part?.text ?? part?.thought ?? null;
          if (raw != null) {
            // Gemini 3 / thinking models may return part.text or part.thought in unexpected format
            const text = BaseLLMProvider.extractTextFromContent(raw);
            fullContent += text;
            if (onChunk && text) {
              onChunk({ type: 'text', content: text });
            }
          }
          if (part.functionCall) {
            const tc = {
              id: `gemini-tool-${Date.now()}-${toolCalls.length}`,
              name: part.functionCall.name,
              input: part.functionCall.args || {},
            };
            if (part.thoughtSignature != null) {
              tc.thought_signature = part.thoughtSignature;
            }
            toolCalls.push(tc);
          }
        }
      }

      // Get final response for usage and for thought signatures (may arrive only in final response)
      const finalResponse = await result.response;
      const finalContent = finalResponse.candidates?.[0]?.content;
      const finalParts = Array.isArray(finalContent) ? finalContent : (finalContent?.parts || []);
      const fcParts = finalParts.filter(p => p && p.functionCall);
      fcParts.forEach((p, index) => {
        if (p.thoughtSignature != null && toolCalls[index]) {
          toolCalls[index].thought_signature = p.thoughtSignature;
        }
      });
      const usageMetadata = finalResponse.usageMetadata || {};

      // Determine stop reason
      let stopReason = finalResponse.candidates?.[0]?.finishReason || 'STOP';
      if (toolCalls.length > 0) {
        stopReason = 'tool_use';
      }

      // Prefer SDK text() for final content - handles Gemini 3 / thinking formats
      let finalText = fullContent;
      try {
        if (typeof finalResponse.text === 'function') {
          const sdkText = finalResponse.text();
          if (sdkText && typeof sdkText === 'string') {
            finalText = sdkText;
          }
        }
      } catch (_) {
        /* use fullContent */
      }

      const parsedResult = {
        content: BaseLLMProvider.extractTextFromContent(finalText),
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        stop_reason: stopReason,
        usage: {
          input_tokens: usageMetadata.promptTokenCount || 0,
          output_tokens: usageMetadata.candidatesTokenCount || 0,
          total_tokens: (usageMetadata.promptTokenCount || 0) + (usageMetadata.candidatesTokenCount || 0),
        },
      };

      if (onChunk) {
        onChunk({ type: 'done', result: parsedResult });
      }

      logger.debug(`Gemini stream complete: tokens=${parsedResult.usage.input_tokens}/${parsedResult.usage.output_tokens}`);

      return parsedResult;
    } catch (error) {
      logger.error('Gemini stream error:', error.message);
      if (onChunk) {
        onChunk({ type: 'error', error: error.message });
      }
      throw this.createError(error, 'streamChat');
    }
  }
}

module.exports = GeminiProvider;
