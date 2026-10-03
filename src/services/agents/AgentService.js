const Agent = require('../../models/Agent');
const { ProviderFactory } = require('../../providers');
const OpenRouterProvider = require('../../providers/OpenRouterProvider');
const { encrypt, decrypt } = require('../../utils/crypto');
const logger = require('../../utils/logger');
const { fetchModelCapabilities, normalizeRepoId } = require('../integrations/huggingFaceModelService');
const {
  fetchOpenRouterModelCapabilities,
  normalizeOpenRouterModelId,
} = require('../integrations/openRouterModelService');

/**
 * Service for managing agents with business logic
 */
class AgentService {
  /**
   * Create a new agent
   * @param {number} userId - User ID
   * @param {object} agentData - Agent data
   * @returns {Promise<object>} - Created agent (with decrypted config for response)
   */
  static async createAgent(userId, agentData) {
    const {
      name,
      role,
      initial_context,
      provider_type,
      provider_config,
      hf_model_repo,
      openrouter_model_id,
      model_capabilities,
      sync_hf_repo,
      sync_openrouter_model,
    } = agentData;

    // Validate required fields
    if (!name || name.trim().length === 0) {
      throw new Error('Agent name is required');
    }

    if (!role || role.trim().length === 0) {
      throw new Error('Agent role is required');
    }

    if (!provider_type) {
      throw new Error('Provider type is required');
    }

    // Validate provider type
    const availableTypes = ProviderFactory.getAvailableTypes();
    if (!availableTypes.includes(provider_type.toLowerCase())) {
      throw new Error(`Invalid provider type. Available types: ${availableTypes.join(', ')}`);
    }

    // Validate provider config
    if (!provider_config) {
      throw new Error('Provider configuration is required');
    }

    // Remove placeholder API key if present (from exports without API key)
    const cleanConfig = { ...provider_config };
    if (cleanConfig.apiKey === 'NO_KEY_SHOULD_BE_PROVIDED') {
      delete cleanConfig.apiKey;
    }
    AgentService.normalizeOpenRouterSort(cleanConfig);

    const validation = ProviderFactory.validateConfig(provider_type, cleanConfig);
    if (!validation.valid) {
      throw new Error(`Invalid provider configuration: ${validation.errors.join(', ')}`);
    }

    // Encrypt provider config before storage
    const encryptedConfig = encrypt(JSON.stringify(cleanConfig));

    let hfRepo = hf_model_repo != null && String(hf_model_repo).trim() !== '' ? String(hf_model_repo).trim() : null;
    let openRouterId =
      openrouter_model_id != null && String(openrouter_model_id).trim() !== ''
        ? String(openrouter_model_id).trim()
        : null;
    let capabilitiesJson = null;

    if (sync_openrouter_model != null && String(sync_openrouter_model).trim() !== '') {
      const { capabilities } = await fetchOpenRouterModelCapabilities(sync_openrouter_model);
      openRouterId = normalizeOpenRouterModelId(sync_openrouter_model);
      capabilitiesJson = JSON.stringify(capabilities);
    } else if (sync_hf_repo != null && String(sync_hf_repo).trim() !== '') {
      const { capabilities } = await fetchModelCapabilities(sync_hf_repo);
      hfRepo = normalizeRepoId(sync_hf_repo);
      capabilitiesJson = JSON.stringify(capabilities);
    } else if (model_capabilities != null) {
      if (typeof model_capabilities === 'string') {
        JSON.parse(model_capabilities);
        capabilitiesJson = model_capabilities;
      } else if (typeof model_capabilities === 'object') {
        capabilitiesJson = JSON.stringify(model_capabilities);
      }
    }
    if (capabilitiesJson && capabilitiesJson.length > 32768) {
      throw new Error('model_capabilities JSON is too large');
    }

    const catalog = await AgentService.lookupOpenRouterChatModel(provider_type, cleanConfig.model);
    if (catalog.openrouter_model_id) openRouterId = catalog.openrouter_model_id;
    if (catalog.model_capabilities) capabilitiesJson = catalog.model_capabilities;

    // Create agent
    const agent = await Agent.create({
      user_id: userId,
      name: name.trim(),
      role: role.trim().toLowerCase(),
      initial_context: initial_context?.trim() || null,
      provider_type: provider_type.toLowerCase(),
      provider_config: encryptedConfig,
      hf_model_repo: hfRepo,
      openrouter_model_id: openRouterId,
      model_capabilities: capabilitiesJson,
    });

    logger.info(`Agent created by user ${userId}: ${agent.name} (${agent.role})`);

    // Return agent with safe config (no API key)
    return this.sanitizeAgent(agent, cleanConfig);
  }

  /**
   * Get agent by ID (with permission check)
   * @param {number} agentId - Agent ID
   * @param {number} userId - User ID
   * @returns {Promise<object>} - Agent with decrypted config info
   */
  static async getAgent(agentId, userId) {
    const agent = await Agent.findById(agentId);

    if (!agent) {
      throw new Error('Agent not found');
    }

    if (agent.user_id !== userId) {
      throw new Error('Not authorized to access this agent');
    }

    // Decrypt config for response
    let config = {};
    try {
      config = JSON.parse(decrypt(agent.provider_config));
    } catch (error) {
      logger.error('Failed to decrypt agent config:', error.message);
    }

    return this.sanitizeAgent(agent, config);
  }

  /**
   * Get sessions that use this agent
   * @param {number} agentId - Agent ID
   * @param {number} userId - User ID
   * @returns {Promise<Array>} - Array of session objects with id and name
   */
  static async getAgentSessions(agentId, userId) {
    const agent = await Agent.findById(agentId);

    if (!agent) {
      throw new Error('Agent not found');
    }

    if (agent.user_id !== userId) {
      throw new Error('Not authorized to access this agent');
    }

    const { dbAll } = require('../../../config/database');
    
    try {
      const sessions = await dbAll(
        `SELECT ws.id, ws.name, ws.user_id
         FROM work_sessions ws
         INNER JOIN session_agents sa ON ws.id = sa.session_id
         WHERE sa.agent_id = ? AND ws.user_id = ?
         ORDER BY ws.name`,
        [agentId, userId]
      );

      return sessions || [];
    } catch (error) {
      logger.error('Error getting agent sessions:', error);
      throw error;
    }
  }

  /**
   * List all agents for a user
   * @param {number} userId - User ID
   * @param {object} options - Query options
   * @returns {Promise<Array>} - List of agents
   */
  static async listAgents(userId, options = {}) {
    const agents = await Agent.findByUserId(userId, options);

    // Sanitize all agents (no API keys in response)
    return agents.map(agent => {
      let config = {};
      try {
        config = JSON.parse(decrypt(agent.provider_config));
      } catch (error) {
        // Config decryption failed, return empty
      }
      return this.sanitizeAgent(agent, config);
    });
  }

  /**
   * Update agent
   * @param {number} agentId - Agent ID
   * @param {number} userId - User ID
   * @param {object} updates - Updates to apply
   * @returns {Promise<object>} - Updated agent
   */
  static async updateAgent(agentId, userId, updates) {
    const agent = await Agent.findById(agentId);

    if (!agent) {
      throw new Error('Agent not found');
    }

    if (agent.user_id !== userId) {
      throw new Error('Not authorized to update this agent');
    }

    const updateData = {};

    if (updates.name !== undefined) {
      if (!updates.name.trim()) {
        throw new Error('Agent name cannot be empty');
      }
      updateData.name = updates.name.trim();
    }

    if (updates.role !== undefined) {
      if (!updates.role.trim()) {
        throw new Error('Agent role cannot be empty');
      }
      updateData.role = updates.role.trim().toLowerCase();
    }

    if (updates.initial_context !== undefined) {
      updateData.initial_context = updates.initial_context?.trim() || null;
    }

    if (updates.provider_type !== undefined) {
      const availableTypes = ProviderFactory.getAvailableTypes();
      if (!availableTypes.includes(updates.provider_type.toLowerCase())) {
        throw new Error(`Invalid provider type. Available types: ${availableTypes.join(', ')}`);
      }
      updateData.provider_type = updates.provider_type.toLowerCase();
    }

    let chatModel = null;
    if (updates.provider_config !== undefined) {
      const providerType = updateData.provider_type || agent.provider_type;
      
      // For updates, merge with existing config to preserve fields not being updated
      let mergedConfig = updates.provider_config;
      try {
        const existingConfig = JSON.parse(decrypt(agent.provider_config));
        // Merge: new values override existing, but preserve existing if not provided
        mergedConfig = {
          ...existingConfig,
          ...updates.provider_config,
          // Preserve API key if not provided in update (empty string means keep existing)
          apiKey: updates.provider_config.apiKey !== undefined && updates.provider_config.apiKey !== ''
            ? updates.provider_config.apiKey 
            : existingConfig.apiKey,
        };
      } catch (error) {
        // If decryption fails, use new config as-is
        logger.warn('Failed to merge existing config:', error.message);
      }

      AgentService.normalizeOpenRouterSort(mergedConfig);
      
      const validation = ProviderFactory.validateConfig(providerType, mergedConfig);
      if (!validation.valid) {
        throw new Error(`Invalid provider configuration: ${validation.errors.join(', ')}`);
      }
      updateData.provider_config = encrypt(JSON.stringify(mergedConfig));
      chatModel = mergedConfig.model;
    } else {
      try {
        chatModel = JSON.parse(decrypt(agent.provider_config)).model;
      } catch (error) {
        chatModel = null;
      }
    }

    if (updates.is_active !== undefined) {
      updateData.is_active = updates.is_active ? 1 : 0;
    }

    if (updates.sync_hf_repo != null && String(updates.sync_hf_repo).trim() !== '') {
      const { capabilities } = await fetchModelCapabilities(updates.sync_hf_repo);
      updateData.hf_model_repo = normalizeRepoId(updates.sync_hf_repo);
      updateData.model_capabilities = JSON.stringify(capabilities);
    } else if (updates.sync_openrouter_model != null && String(updates.sync_openrouter_model).trim() !== '') {
      const { capabilities } = await fetchOpenRouterModelCapabilities(updates.sync_openrouter_model);
      updateData.openrouter_model_id = normalizeOpenRouterModelId(updates.sync_openrouter_model);
      updateData.model_capabilities = JSON.stringify(capabilities);
    } else {
      if (updates.hf_model_repo !== undefined) {
        const v = updates.hf_model_repo;
        updateData.hf_model_repo =
          v === null || v === '' ? null : String(v).trim();
      }
      if (updates.openrouter_model_id !== undefined) {
        const v = updates.openrouter_model_id;
        updateData.openrouter_model_id = v === null || v === '' ? null : String(v).trim();
      }
      if (updates.model_capabilities !== undefined) {
        if (updates.model_capabilities === null) {
          updateData.model_capabilities = null;
        } else if (typeof updates.model_capabilities === 'string') {
          JSON.parse(updates.model_capabilities);
          if (updates.model_capabilities.length > 32768) {
            throw new Error('model_capabilities JSON is too large');
          }
          updateData.model_capabilities = updates.model_capabilities;
        } else if (typeof updates.model_capabilities === 'object') {
          const s = JSON.stringify(updates.model_capabilities);
          if (s.length > 32768) {
            throw new Error('model_capabilities JSON is too large');
          }
          updateData.model_capabilities = s;
        }
      }
    }

    const catalog = await AgentService.lookupOpenRouterChatModel(
      updateData.provider_type || agent.provider_type,
      chatModel
    );
    if (catalog.openrouter_model_id) updateData.openrouter_model_id = catalog.openrouter_model_id;
    if (catalog.model_capabilities) updateData.model_capabilities = catalog.model_capabilities;

    // Perform update
    const updatedAgent = await Agent.update(agentId, updateData);

    logger.info(`Agent updated by user ${userId}: ${updatedAgent.name}`);

    // Get config for response
    let config = {};
    try {
      config = JSON.parse(decrypt(updatedAgent.provider_config));
    } catch (error) {
      // Decryption failed
    }

    return this.sanitizeAgent(updatedAgent, config);
  }

  /**
   * Delete agent
   * @param {number} agentId - Agent ID
   * @param {number} userId - User ID
   * @param {boolean} hard - Hard delete (default: false = soft delete)
   */
  static async deleteAgent(agentId, userId, hard = false) {
    const agent = await Agent.findById(agentId);

    if (!agent) {
      throw new Error('Agent not found');
    }

    if (agent.user_id !== userId) {
      throw new Error('Not authorized to delete this agent');
    }

    if (hard) {
      await Agent.delete(agentId);
      logger.info(`Agent hard deleted by user ${userId}: ${agent.name}`);
    } else {
      await Agent.deactivate(agentId);
      logger.info(`Agent deactivated by user ${userId}: ${agent.name}`);
    }
  }

  /**
   * Get agent provider instance
   * @param {number} agentId - Agent ID
   * @param {number} userId - User ID
   * @returns {Promise<BaseLLMProvider>} - Provider instance
   */
  static async getAgentProvider(agentId, userId, overrides = {}) {
    const agent = await Agent.findById(agentId);

    if (!agent) {
      throw new Error('Agent not found');
    }

    if (agent.user_id !== userId) {
      throw new Error('Not authorized to access this agent');
    }

    if (!agent.is_active) {
      throw new Error('Agent is not active');
    }

    // Decrypt config
    const config = JSON.parse(decrypt(agent.provider_config));

    // Debug log (mask API key)
    logger.debug(`Agent provider config for ${agent.name}: model=${config.model}, hasApiKey=${!!config.apiKey}`);

    // Fallback to environment API keys if not set in agent config
    if (!config.apiKey || config.apiKey === '') {
      const envKeys = {
        claude: process.env.ANTHROPIC_API_KEY,
        openai: process.env.OPENAI_API_KEY,
        gemini: process.env.GOOGLE_API_KEY,
        xai: process.env.XAI_API_KEY,
        deepseek: process.env.DEEPSEEK_API_KEY,
        qwen: process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY,
        kimi: process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY,
        llamacpp: process.env.LLAMACPP_API_KEY,
        openrouter: process.env.OPENROUTER_API_KEY,
      };

      if (envKeys[agent.provider_type]) {
        config.apiKey = envKeys[agent.provider_type];
        logger.debug(`Using environment API key for ${agent.provider_type} provider`);
      }
    }

    // For Ollama, ensure baseURL is set (use default if not in config)
    if (agent.provider_type === 'ollama' && !config.baseURL) {
      config.baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    }

    if (agent.provider_type === 'llamacpp' && !config.baseURL) {
      config.baseURL = process.env.LLAMACPP_BASE_URL || 'http://localhost:8080/v1';
    }

    // overrides apply to this call only (not saved). minTimeout raises the wait
    // without shortening a longer timeout already stored on the agent.
    const merged = { ...config, ...overrides };
    if (overrides.minTimeout != null) {
      merged.timeout = Math.max(Number(config.timeout) || 0, Number(overrides.minTimeout) || 0);
      delete merged.minTimeout;
    }
    return ProviderFactory.create(agent.provider_type, merged);
  }

  /**
   * Test agent provider connectivity
   * @param {number} agentId - Agent ID
   * @param {number} userId - User ID
   * @returns {Promise<object>} - Test result
   */
  static async testAgent(agentId, userId) {
    const agent = await Agent.findById(agentId);

    if (!agent) {
      throw new Error('Agent not found');
    }

    if (agent.user_id !== userId) {
      throw new Error('Not authorized to access this agent');
    }

    // Decrypt config
    const config = JSON.parse(decrypt(agent.provider_config));

    // Test provider
    const result = await ProviderFactory.testProvider(agent.provider_type, config);

    return {
      agentId,
      agentName: agent.name,
      ...result,
    };
  }

  /**
   * Get agents for a session with their providers
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @returns {Promise<Array<{agent: object, provider: BaseLLMProvider}>>}
   */
  static async getSessionAgentsWithProviders(sessionId, userId) {
    const agents = await Agent.getBySession(sessionId);
    const result = [];

    for (const agent of agents) {
      if (agent.user_id !== userId) {
        continue; // Skip agents that don't belong to user
      }

      try {
        const config = JSON.parse(decrypt(agent.provider_config));
        const provider = ProviderFactory.create(agent.provider_type, config);
        result.push({
          agent: this.sanitizeAgent(agent, config),
          provider,
        });
      } catch (error) {
        logger.error(`Failed to create provider for agent ${agent.id}:`, error.message);
        // Include agent but without provider
        result.push({
          agent: this.sanitizeAgent(agent, {}),
          provider: null,
          error: error.message,
        });
      }
    }

    return result;
  }

  /**
   * Get predefined roles
   * @returns {Array} - List of predefined roles
   */
  static getPredefinedRoles() {
    return Agent.getPredefinedRoles();
  }

  /**
   * Get available providers
   * @returns {Array} - List of available providers
   */
  static getAvailableProviders() {
    return ProviderFactory.getProviderInfo();
  }

  /**
   * Drop a blank OpenRouter routing preference. Leave an invalid value for validateConfig.
   * @param {object} config
   */
  static normalizeOpenRouterSort(config) {
    if (!config || typeof config !== 'object' || config.openrouterSort == null) return;
    const raw = String(config.openrouterSort).trim().toLowerCase();
    if (!raw) {
      delete config.openrouterSort;
      return;
    }
    config.openrouterSort = raw;
  }

  /**
   * When the chat provider is OpenRouter, store the model id and refresh catalog capabilities.
   * A failed catalog lookup does not block the save.
   * @param {string} providerType
   * @param {string} model
   * @returns {Promise<{openrouter_model_id?: string, model_capabilities?: string}>}
   */
  static async lookupOpenRouterChatModel(providerType, model) {
    if (String(providerType || '').toLowerCase() !== 'openrouter') return {};
    let modelId;
    try {
      modelId = normalizeOpenRouterModelId(model);
    } catch {
      return {};
    }
    const result = { openrouter_model_id: modelId };
    try {
      const { capabilities } = await fetchOpenRouterModelCapabilities(modelId);
      const json = JSON.stringify(capabilities);
      if (json.length <= 32768) result.model_capabilities = json;
    } catch (error) {
      logger.warn(`OpenRouter catalog lookup failed for ${modelId}: ${error.message}`);
    }
    return result;
  }

  /**
   * Sanitize agent for response (remove sensitive data)
   * @param {object} agent - Agent from database
   * @param {object} config - Decrypted config
   * @returns {object} - Sanitized agent
   */
  static sanitizeAgent(agent, config = {}) {
    // Create safe config without API key
    const safeConfig = {
      model: config.model,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      timeout: config.timeout,
      enablePromptCache: !!config.enablePromptCache,
      hasApiKey: !!config.apiKey,
    };
    if (config.openrouterSort) {
      safeConfig.openrouterSort = config.openrouterSort;
    }
    
    // Include baseURL for Ollama (it's not sensitive)
    if (config.baseURL) {
      safeConfig.baseURL = config.baseURL;
    }

    let modelCapabilities = null;
    if (agent.model_capabilities) {
      try {
        modelCapabilities = JSON.parse(agent.model_capabilities);
      } catch {
        modelCapabilities = null;
      }
    }

    return {
      id: agent.id,
      user_id: agent.user_id,
      name: agent.name,
      role: agent.role,
      initial_context: agent.initial_context,
      provider_type: agent.provider_type,
      provider_config: safeConfig,
      hf_model_repo: agent.hf_model_repo || null,
      openrouter_model_id: agent.openrouter_model_id || null,
      model_capabilities: modelCapabilities,
      is_active: !!agent.is_active,
      created_at: agent.created_at,
      updated_at: agent.updated_at,
    };
  }

  /**
   * Duplicate an existing agent
   * @param {number} agentId - Agent ID to duplicate
   * @param {number} userId - User ID
   * @param {string} newName - New name for duplicated agent
   * @returns {Promise<object>} - New agent
   */
  static async duplicateAgent(agentId, userId, newName = null) {
    const agent = await Agent.findById(agentId);

    if (!agent) {
      throw new Error('Agent not found');
    }

    if (agent.user_id !== userId) {
      throw new Error('Not authorized to access this agent');
    }

    // Create new agent with same settings
    const duplicated = await Agent.create({
      user_id: userId,
      name: newName || `${agent.name} (Copy)`,
      role: agent.role,
      initial_context: agent.initial_context,
      provider_type: agent.provider_type,
      provider_config: agent.provider_config, // Already encrypted
      hf_model_repo: agent.hf_model_repo || null,
      openrouter_model_id: agent.openrouter_model_id || null,
      model_capabilities: agent.model_capabilities || null,
    });

    logger.info(`Agent duplicated by user ${userId}: ${duplicated.name} from ${agent.name}`);

    let config = {};
    try {
      config = JSON.parse(decrypt(duplicated.provider_config));
    } catch (error) {
      // Decryption failed
    }

    return this.sanitizeAgent(duplicated, config);
  }

  /**
   * Get agent data for export (optionally includes API key)
   * @param {number} agentId - Agent ID
   * @param {number} userId - User ID
   * @param {boolean} includeApiKey - Whether to include API key in export
   * @returns {Promise<object>} - Agent data for export
   */
  static async getAgentForExport(agentId, userId, includeApiKey = false) {
    const agent = await Agent.findById(agentId);

    if (!agent) {
      throw new Error('Agent not found');
    }

    if (agent.user_id !== userId) {
      throw new Error('Not authorized to access this agent');
    }

    // Decrypt config for export
    let config = {};
    try {
      config = JSON.parse(decrypt(agent.provider_config));
    } catch (error) {
      logger.error('Failed to decrypt agent config for export:', error.message);
      throw new Error('Failed to decrypt agent configuration');
    }

    // Create export config (optionally exclude API key)
    const exportConfig = { ...config };
    if (!includeApiKey && exportConfig.apiKey) {
      // Use placeholder to indicate API key was excluded
      exportConfig.apiKey = 'NO_KEY_SHOULD_BE_PROVIDED';
      exportConfig.hasApiKey = true; // Indicate that API key was present but excluded
    }

    // Return agent data for export
    let modelCapabilities = null;
    if (agent.model_capabilities) {
      try {
        modelCapabilities = JSON.parse(agent.model_capabilities);
      } catch {
        modelCapabilities = null;
      }
    }

    return {
      name: agent.name,
      role: agent.role,
      initial_context: agent.initial_context,
      provider_type: agent.provider_type,
      provider_config: exportConfig,
      hf_model_repo: agent.hf_model_repo || null,
      openrouter_model_id: agent.openrouter_model_id || null,
      model_capabilities: modelCapabilities,
      // Include metadata
      exported_at: new Date().toISOString(),
      exported_by: userId,
      includeApiKey: includeApiKey,
    };
  }
}

module.exports = AgentService;
