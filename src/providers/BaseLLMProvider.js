const logger = require('../utils/logger');

/**
 * Extract plain text from content that may be string, array of blocks, or object.
 * Some APIs (e.g. Ollama multimodal) return content as array of {type, text} blocks.
 * @param {*} content - Raw content from API
 * @returns {string}
 */
function extractTextFromContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object') return String(c.text ?? c.content ?? '');
      return String(c ?? '');
    }).join('');
  }
  if (typeof content === 'object') return String(content.text ?? content.content ?? '');
  return String(content);
}

/**
 * Abstract base class for all LLM providers.
 * Defines the unified interface that all providers must implement.
 */
class BaseLLMProvider {
  /**
   * @param {object} config - Provider configuration
   * @param {string} config.apiKey - API key for the provider
   * @param {string} config.model - Model identifier
   * @param {number} config.maxTokens - Maximum tokens for responses
   * @param {number} config.temperature - Temperature for sampling
   */
  constructor(config = {}) {
    if (new.target === BaseLLMProvider) {
      throw new Error('BaseLLMProvider is an abstract class and cannot be instantiated directly');
    }

    this.apiKey = config.apiKey;
    this.model = config.model || this.getDefaultModel();
    this.maxTokens = config.maxTokens || 4096;
    this.temperature = config.temperature ?? 0.7;
    this.timeout = config.timeout || 60000;

    this.validateConfig();
  }

  /**
   * Get the provider type identifier
   * @returns {string} - Provider type (e.g., 'claude', 'openai', 'gemini')
   */
  getType() {
    throw new Error('getType() must be implemented by subclass');
  }

  /**
   * Get the default model for this provider
   * @returns {string} - Default model identifier
   */
  getDefaultModel() {
    throw new Error('getDefaultModel() must be implemented by subclass');
  }

  /**
   * Get available models for this provider
   * @returns {Array<{id: string, name: string, description: string}>} - List of available models
   */
  getAvailableModels() {
    throw new Error('getAvailableModels() must be implemented by subclass');
  }

  /**
   * Validate the configuration
   * @throws {Error} - If configuration is invalid
   */
  validateConfig() {
    if (!this.apiKey) {
      throw new Error(`API key is required for ${this.getType()} provider`);
    }
  }

  /**
   * Format messages to the provider's expected format
   * @param {Array<{role: string, content: string}>} messages - Standardized messages
   * @returns {Array} - Provider-specific message format
   */
  formatMessages(messages) {
    throw new Error('formatMessages() must be implemented by subclass');
  }

  /**
   * Parse the provider's response to a standardized format
   * @param {object} response - Provider-specific response
   * @returns {{content: string, tokensUsed: {input: number, output: number}, finishReason: string}}
   */
  parseResponse(response) {
    throw new Error('parseResponse() must be implemented by subclass');
  }

  /**
   * Send a chat completion request
   * @param {Array<{role: string, content: string}>} messages - Messages to send
   * @param {object} options - Additional options
   * @returns {Promise<{content: string, tokensUsed: {input: number, output: number}, finishReason: string}>}
   */
  async chat(messages, options = {}) {
    throw new Error('chat() must be implemented by subclass');
  }

  /**
   * Send a streaming chat completion request
   * @param {Array<{role: string, content: string}>} messages - Messages to send
   * @param {function} onChunk - Callback for each chunk
   * @param {object} options - Additional options
   * @returns {Promise<{content: string, tokensUsed: {input: number, output: number}, finishReason: string}>}
   */
  async streamChat(messages, onChunk, options = {}) {
    throw new Error('streamChat() must be implemented by subclass');
  }

  /**
   * Estimate token count for a text
   * This is a rough estimate; providers may have different tokenizers
   * @param {string} text - Text to estimate tokens for
   * @returns {number} - Estimated token count
   */
  estimateTokens(text) {
    // Rough estimate: ~4 characters per token for English text
    // This is a fallback; subclasses can override with provider-specific tokenizers
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Estimate tokens for an array of messages
   * @param {Array<{role: string, content: string}>} messages - Messages to estimate
   * @returns {number} - Total estimated tokens
   */
  estimateMessagesTokens(messages) {
    let total = 0;
    for (const msg of messages) {
      // Account for role overhead (~4 tokens per message)
      total += 4;
      total += this.estimateTokens(msg.content);
    }
    return total;
  }

  /**
   * Check if the provider is healthy/reachable
   * @returns {Promise<boolean>}
   */
  async healthCheck() {
    try {
      await this.chat([{ role: 'user', content: 'Hello' }], { maxTokens: 5 });
      return true;
    } catch (error) {
      logger.error(`Health check failed for ${this.getType()}:`, error.message);
      return false;
    }
  }

  /**
   * Create a standardized error response
   * @param {Error} error - The error that occurred
   * @param {string} context - Context of where the error occurred
   * @returns {object} - Standardized error object
   */
  createError(error, context) {
    const isRateLimit = error.status === 429 || error.message?.includes('rate limit');
    const isAuthError = error.status === 401 || error.status === 403;
    const isTimeout = error.code === 'ETIMEDOUT' || error.message?.includes('timeout');

    return {
      provider: this.getType(),
      context,
      message: error.message,
      code: error.code || error.status,
      isRateLimit,
      isAuthError,
      isTimeout,
      isRetryable: isRateLimit || isTimeout,
      originalError: error,
    };
  }

  /**
   * Retry a function with exponential backoff
   * @param {function} fn - Function to retry
   * @param {number} maxRetries - Maximum number of retries
   * @param {number} baseDelay - Base delay in ms
   * @returns {Promise<any>}
   */
  async withRetry(fn, maxRetries = 3, baseDelay = 1000) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const standardError = this.createError(error, 'retry');

        if (!standardError.isRetryable || attempt === maxRetries) {
          throw error;
        }

        const delay = baseDelay * Math.pow(2, attempt);
        logger.warn(`${this.getType()} request failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}

BaseLLMProvider.extractTextFromContent = extractTextFromContent;
module.exports = BaseLLMProvider;
