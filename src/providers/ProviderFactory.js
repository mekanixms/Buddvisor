const ClaudeProvider = require('./ClaudeProvider');
const OpenAIProvider = require('./OpenAIProvider');
const GeminiProvider = require('./GeminiProvider');
const OllamaProvider = require('./OllamaProvider');
const XAIProvider = require('./XAIProvider');
const DeepSeekProvider = require('./DeepSeekProvider');
const QwenProvider = require('./QwenProvider');
const KimiProvider = require('./KimiProvider');
const logger = require('../utils/logger');

/**
 * Factory for creating LLM provider instances
 * Supports multiple provider types with unified configuration
 */
class ProviderFactory {
  /**
   * Map of provider types to their classes
   */
  static providers = {
    claude: ClaudeProvider,
    openai: OpenAIProvider,
    gemini: GeminiProvider,
    xai: XAIProvider,
    ollama: OllamaProvider,
    deepseek: DeepSeekProvider,
    qwen: QwenProvider,
    kimi: KimiProvider,
  };

  /**
   * Create a provider instance
   * @param {string} type - Provider type (claude, openai, gemini, ollama)
   * @param {object} config - Provider configuration
   * @returns {BaseLLMProvider} - Provider instance
   */
  static create(type, config = {}) {
    const normalizedType = type?.toLowerCase();

    if (!normalizedType || !this.providers[normalizedType]) {
      const available = Object.keys(this.providers).join(', ');
      throw new Error(`Unknown provider type: ${type}. Available types: ${available}`);
    }

    const ProviderClass = this.providers[normalizedType];

    try {
      const provider = new ProviderClass(config);
      logger.debug(`Created ${normalizedType} provider with model: ${provider.model}`);
      return provider;
    } catch (error) {
      logger.error(`Failed to create ${normalizedType} provider:`, error.message);
      throw error;
    }
  }

  /**
   * Create a provider from encrypted configuration
   * @param {string} type - Provider type
   * @param {string} encryptedConfig - Encrypted configuration JSON
   * @param {function} decryptFn - Decryption function
   * @returns {BaseLLMProvider} - Provider instance
   */
  static createFromEncrypted(type, encryptedConfig, decryptFn) {
    try {
      const decrypted = decryptFn(encryptedConfig);
      const config = JSON.parse(decrypted);
      return this.create(type, config);
    } catch (error) {
      logger.error('Failed to create provider from encrypted config:', error.message);
      throw new Error('Invalid or corrupted provider configuration');
    }
  }

  /**
   * Get list of available provider types
   * @returns {Array<string>} - Available provider types
   */
  static getAvailableTypes() {
    return Object.keys(this.providers);
  }

  /**
   * Get provider info including available models
   * @param {string} type - Provider type (optional, returns all if not specified)
   * @returns {object|Array<object>} - Provider information
   */
  static getProviderInfo(type = null) {
    if (type) {
      const normalizedType = type.toLowerCase();
      if (!this.providers[normalizedType]) {
        return null;
      }

      // Create a temporary instance to get model info
      // For Ollama, we don't need an API key
      const config = normalizedType === 'ollama'
        ? {}
        : { apiKey: 'temp' }; // Temporary key just to get models

      try {
        const tempProvider = new this.providers[normalizedType](config);
        const providerInfo = {
          type: normalizedType,
          defaultModel: tempProvider.getDefaultModel(),
          availableModels: tempProvider.getAvailableModels(),
          requiresApiKey: normalizedType !== 'ollama',
        };
        
        // Add default Ollama base URL if Ollama provider
        if (normalizedType === 'ollama') {
          providerInfo.defaultOllamaBaseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
        }
        
        return providerInfo;
      } catch (error) {
        // If we can't create a temp provider, return basic info
        const basicInfo = {
          type: normalizedType,
          requiresApiKey: normalizedType !== 'ollama',
        };
        
        // Add default Ollama base URL if Ollama provider
        if (normalizedType === 'ollama') {
          basicInfo.defaultOllamaBaseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
        }
        
        return basicInfo;
      }
    }

    // Return info for all providers
    const allInfo = [];
    for (const providerType of Object.keys(this.providers)) {
      const info = this.getProviderInfo(providerType);
      if (info) {
        allInfo.push(info);
      }
    }
    return allInfo;
  }

  /**
   * Validate provider configuration without creating instance
   * @param {string} type - Provider type
   * @param {object} config - Configuration to validate
   * @returns {{valid: boolean, errors: Array<string>}} - Validation result
   */
  static validateConfig(type, config) {
    const errors = [];
    const normalizedType = type?.toLowerCase();

    if (!normalizedType) {
      errors.push('Provider type is required');
      return { valid: false, errors };
    }

    if (!this.providers[normalizedType]) {
      errors.push(`Unknown provider type: ${type}`);
      return { valid: false, errors };
    }

    // Ollama doesn't require API key
    if (normalizedType !== 'ollama') {
      // Allow empty API key or placeholder (can be added later or use env vars)
      // Check for placeholder value used in exports
      if (config.apiKey === 'NO_KEY_SHOULD_BE_PROVIDED') {
        // This is a placeholder from export, treat as no key (allowed)
      } else if (!config.apiKey || config.apiKey.trim() === '') {
        // Empty API key is allowed (can use env vars or be added later via edit)
      }
    } else {
      // For Ollama, baseURL is optional (will use default from env if not provided)
      if (config.baseURL && typeof config.baseURL !== 'string') {
        errors.push('baseURL must be a string');
      }
    }

    // For xAI, baseURL is optional (will use default if not provided)
    if (normalizedType === 'xai' && config.baseURL && typeof config.baseURL !== 'string') {
      errors.push('baseURL must be a string');
    }

    // For OpenAI-compatible providers, baseURL is optional
    if (['deepseek', 'qwen', 'kimi'].includes(normalizedType) && config.baseURL && typeof config.baseURL !== 'string') {
      errors.push('baseURL must be a string');
    }

    // Validate model if specified
    if (config.model) {
      const providerInfo = this.getProviderInfo(normalizedType);
      if (providerInfo && providerInfo.availableModels) {
        const validModels = providerInfo.availableModels.map(m => m.id);
        if (!validModels.includes(config.model)) {
          // Warning, not error - custom models are allowed
          logger.warn(`Model ${config.model} not in standard list for ${normalizedType}`);
        }
      }
    }

    // Validate temperature
    if (config.temperature !== undefined) {
      if (typeof config.temperature !== 'number' || config.temperature < 0 || config.temperature > 2) {
        errors.push('Temperature must be a number between 0 and 2');
      }
    }

    // Validate maxTokens
    if (config.maxTokens !== undefined) {
      if (typeof config.maxTokens !== 'number' || config.maxTokens < 1) {
        errors.push('maxTokens must be a positive number');
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Register a custom provider
   * @param {string} type - Provider type identifier
   * @param {class} providerClass - Provider class (must extend BaseLLMProvider)
   */
  static registerProvider(type, providerClass) {
    const BaseLLMProvider = require('./BaseLLMProvider');

    if (!(providerClass.prototype instanceof BaseLLMProvider)) {
      throw new Error('Provider class must extend BaseLLMProvider');
    }

    const normalizedType = type.toLowerCase();
    this.providers[normalizedType] = providerClass;
    logger.info(`Registered custom provider: ${normalizedType}`);
  }

  /**
   * Test a provider configuration by making a simple request
   * @param {string} type - Provider type
   * @param {object} config - Provider configuration
   * @returns {Promise<{success: boolean, message: string, latency?: number}>}
   */
  static async testProvider(type, config) {
    const startTime = Date.now();

    try {
      const provider = this.create(type, config);
      const healthy = await provider.healthCheck();

      if (healthy) {
        return {
          success: true,
          message: `${type} provider is working correctly`,
          latency: Date.now() - startTime,
        };
      } else {
        return {
          success: false,
          message: `${type} provider health check failed`,
        };
      }
    } catch (error) {
      return {
        success: false,
        message: error.message,
      };
    }
  }
}

module.exports = ProviderFactory;
