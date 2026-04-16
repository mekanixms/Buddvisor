const crypto = require('crypto');
const WorkSession = require('../../models/WorkSession');
const Document = require('../../models/Document');
const Message = require('../../models/Message');
const ContextManager = require('./ContextManager');
const OrchestratorAgent = require('../chat/OrchestratorAgent');
const { syncSessionStorageLinks } = require('./SessionStorageLinks');
const { toolRegistry } = require('../tools/ToolRegistry');
const { encrypt, decrypt } = require('../../utils/crypto');
const logger = require('../../utils/logger');
const {
  inferModelCapabilities,
  parseStoredCapabilitiesJson,
  mergeWithStored,
} = require('../../utils/modelCapabilities');

class SessionService {
  /**
   * Create a new work session
   * @param {number} userId - User ID
   * @param {object} sessionData - Session data
   * @returns {Promise<object>} - Created session
   */
  static async createSession(userId, sessionData) {
    try {
      const {
        name,
        description,
        context_length = 50,
        orchestrator_provider_type = 'claude',
        orchestrator_provider_config = {},
      } = sessionData;

      // Validate required fields
      if (!name || name.trim().length === 0) {
        throw new Error('Session name is required');
      }

      if (context_length < 1 || context_length > 200) {
        throw new Error('Context length must be between 1 and 200');
      }

      // Encrypt orchestrator config if it contains sensitive data
      let encryptedConfig = null;
      if (orchestrator_provider_config && Object.keys(orchestrator_provider_config).length > 0) {
        encryptedConfig = encrypt(JSON.stringify(orchestrator_provider_config));
      }

      const session = await WorkSession.create({
        user_id: userId,
        name: name.trim(),
        description: description?.trim() || null,
        context_length,
        orchestrator_provider_type,
        orchestrator_provider_config: encryptedConfig,
      });

      logger.info(`Session created: ${name} (User: ${userId})`);

      return session;
    } catch (error) {
      logger.error('Error creating session:', error);
      throw error;
    }
  }

  /**
   * Get session by ID (with permission check)
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @returns {Promise<object>} - Session object
   */
  static async getSession(sessionId, userId) {
    try {
      const session = await WorkSession.findById(sessionId);

      if (!session) {
        throw new Error('Session not found');
      }

      // Check permission
      if (session.user_id !== userId) {
        throw new Error('Unauthorized access to session');
      }

      // Update last accessed time
      await WorkSession.updateLastAccessed(sessionId);

      return session;
    } catch (error) {
      logger.error('Error getting session:', error);
      throw error;
    }
  }

  /**
   * Get complete session details (with agents and documents)
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @returns {Promise<object>} - Complete session object
   */
  static async getCompleteSession(sessionId, userId) {
    try {
      const session = await WorkSession.getComplete(sessionId);

      if (!session) {
        throw new Error('Session not found');
      }

      // Check permission
      if (session.user_id !== userId) {
        throw new Error('Unauthorized access to session');
      }

      // Update last accessed time
      await WorkSession.updateLastAccessed(sessionId);

      // Decrypt orchestrator config if needed
      if (session.orchestrator_provider_config) {
        try {
          session.orchestrator_provider_config = JSON.parse(
            decrypt(session.orchestrator_provider_config)
          );
        } catch (error) {
          logger.warn('Failed to decrypt orchestrator config:', error);
          session.orchestrator_provider_config = null;
        }
      }

      // Sanitize agent provider configs for UI (no API keys)
      if (Array.isArray(session.agents)) {
        session.agents = session.agents.map((a) => {
          let cfg = {};
          try {
            cfg = a.provider_config ? JSON.parse(decrypt(a.provider_config)) : {};
          } catch (e) {
            cfg = {};
          }

          const safeConfig = {
            model: cfg.model,
            maxTokens: cfg.maxTokens,
            temperature: cfg.temperature,
            hasApiKey: !!cfg.apiKey,
            ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
          };

          return {
            ...a,
            provider_config: safeConfig,
            model_capabilities: mergeWithStored(
              parseStoredCapabilitiesJson(a.model_capabilities),
              inferModelCapabilities(a.provider_type, safeConfig.model)
            ),
          };
        });
      }

      // Provide a compact, UI-friendly document→agent assignment map.
      // If no per-agent assignments exist yet, default to "all session documents apply to all session agents"
      // to preserve existing behavior until user customizes it.
      const map = {};
      const raw = Array.isArray(session.document_agent_assignments) ? session.document_agent_assignments : [];
      if (raw.length > 0) {
        for (const row of raw) {
          const docId = row.document_id;
          const agentId = row.agent_id;
          if (docId == null || agentId == null) continue;
          if (!map[docId]) map[docId] = [];
          map[docId].push(agentId);
        }
        for (const docId of Object.keys(map)) {
          map[docId] = Array.from(new Set(map[docId])).sort((a, b) => a - b);
        }
      } else {
        // No per-agent rows: treat all session docs as orchestrator-only (no agent checkboxes)
        for (const doc of (session.documents || [])) {
          map[doc.id] = [];
        }
      }
      session.document_agent_assignment_map = map;

      // Provide a compact, UI-friendly tool→agent assignment map.
      // If no per-agent tool assignments exist yet, default to "no tools enabled"
      // so Tools tab starts unchecked by default.
      const toolMap = {};
      const toolRaw = Array.isArray(session.tool_agent_assignments) ? session.tool_agent_assignments : [];
      if (toolRaw.length > 0) {
        for (const row of toolRaw) {
          const toolName = row.tool_name;
          const agentId = row.agent_id;
          if (!toolName || agentId == null) continue;
          if (!toolMap[toolName]) toolMap[toolName] = [];
          toolMap[toolName].push(agentId);
        }
        for (const toolName of Object.keys(toolMap)) {
          toolMap[toolName] = Array.from(new Set(toolMap[toolName])).sort((a, b) => a - b);
        }
      }
      session.tool_agent_assignment_map = toolMap;

      // Load orchestrator tool assignments with configs
      const orchestratorAssignments = await WorkSession.getOrchestratorToolAssignments(sessionId);
      session.orchestrator_tools = orchestratorAssignments.map(a => a.tool_name);
      session.orchestrator_tool_assignments = orchestratorAssignments;

      return session;
    } catch (error) {
      logger.error('Error getting complete session:', error);
      throw error;
    }
  }

  /**
   * Generate or return existing share link for a session (owner only).
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID (must own session)
   * @param {string} baseUrl - Base URL for the app (e.g. https://example.com)
   * @returns {Promise<{ link: string, token: string }>}
   */
  static async generateShareLink(sessionId, userId, baseUrl = '') {
    const session = await WorkSession.findById(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.user_id !== userId) throw new Error('Unauthorized access to session');

    let token = session.share_token || null;
    if (!token) {
      token = crypto.randomBytes(32).toString('hex');
      await WorkSession.update(sessionId, { share_token: token });
      logger.info(`Share token generated for session ${sessionId}`);
    }

    const base = (baseUrl || '').replace(/\/$/, '');
    const path = `/?share=${token}`;
    const link = base ? `${base}${path}` : path;
    return { link, token };
  }

  /**
   * Get session by share token (for share view). Returns session data without sensitive config.
   * @param {string} token - Share token
   * @returns {Promise<object>} - Session suitable for share UI (no orchestrator API keys)
   */
  static async getSessionForShare(token) {
    const session = await WorkSession.findByShareToken(token);
    if (!session) throw new Error('Invalid or expired share link');

    const full = await WorkSession.getComplete(session.id);
    if (!full) throw new Error('Session not found');

    await WorkSession.updateLastAccessed(session.id);

    if (full.orchestrator_provider_config) {
      try {
        full.orchestrator_provider_config = JSON.parse(decrypt(full.orchestrator_provider_config));
      } catch (e) {
        full.orchestrator_provider_config = null;
      }
    }

    if (Array.isArray(full.agents)) {
      full.agents = full.agents.map((a) => {
        let cfg = {};
        try {
          cfg = a.provider_config ? JSON.parse(decrypt(a.provider_config)) : {};
        } catch (e) {
          cfg = {};
        }
        const safeConfig = {
          model: cfg.model,
          maxTokens: cfg.maxTokens,
          temperature: cfg.temperature,
          hasApiKey: !!cfg.apiKey,
          ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
        };
        return {
          ...a,
          provider_config: safeConfig,
          model_capabilities: mergeWithStored(
            parseStoredCapabilitiesJson(a.model_capabilities),
            inferModelCapabilities(a.provider_type, safeConfig.model)
          ),
        };
      });
    }

    const map = {};
    const raw = Array.isArray(full.document_agent_assignments) ? full.document_agent_assignments : [];
    if (raw.length > 0) {
      for (const row of raw) {
        const docId = row.document_id;
        const agentId = row.agent_id;
        if (docId == null || agentId == null) continue;
        if (!map[docId]) map[docId] = [];
        map[docId].push(agentId);
      }
      for (const docId of Object.keys(map)) {
        map[docId] = Array.from(new Set(map[docId])).sort((a, b) => a - b);
      }
    } else {
      // No per-agent rows: treat all session docs as orchestrator-only
      for (const doc of (full.documents || [])) {
        map[doc.id] = [];
      }
    }
    full.document_agent_assignment_map = map;

    const toolMap = {};
    const toolRaw = Array.isArray(full.tool_agent_assignments) ? full.tool_agent_assignments : [];
    if (toolRaw.length > 0) {
      for (const row of toolRaw) {
        const toolName = row.tool_name;
        const agentId = row.agent_id;
        if (!toolName || agentId == null) continue;
        if (!toolMap[toolName]) toolMap[toolName] = [];
        toolMap[toolName].push(agentId);
      }
      for (const t of Object.keys(toolMap)) {
        toolMap[t] = Array.from(new Set(toolMap[t])).sort((a, b) => a - b);
      }
    }
    full.tool_agent_assignment_map = toolMap;

    const orchestratorAssignments = await WorkSession.getOrchestratorToolAssignments(session.id);
    full.orchestrator_tools = orchestratorAssignments.map(a => a.tool_name);
    full.orchestrator_tool_assignments = orchestratorAssignments;

    full.orchestrator_provider_config = null;
    return full;
  }

  /**
   * Get approximate context token estimates for the Orchestrator and each agent in a session.
   * Used for UI transparency; does not include dynamic document chunks or processed media.
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @returns {Promise<{ orchestrator: { tokens: number, model?: string }, agents: Array<{ agent_id: number, name: string, tokens: number, model?: string }> }>}
   */
  static async getContextTokenEstimates(sessionId, userId) {
    const session = await this.getCompleteSession(sessionId, userId);
    const messages = await Message.getContextMessages(sessionId, session.context_length || 50);
    const formattedMessages = ContextManager.formatMessagesForLLM(messages);
    const placeholderUser = { role: 'user', content: '' };

    const systemPrompt = ContextManager.buildSystemPrompt(session);
    const orchestratorContext = [
      { role: 'system', content: systemPrompt },
      ...formattedMessages,
      placeholderUser,
    ];
    const orchestratorTokens = ContextManager.getContextSize(orchestratorContext);
    const orchestratorModel = session.orchestrator_provider_config?.model;

    const agents = (session.agents || []).map((agent) => {
      const agentSystemPrompt = OrchestratorAgent.buildAgentSystemPrompt(
        agent,
        session.agents || [],
        '',
        null,
        null,
        session
      );
      const agentContext = [
        { role: 'system', content: agentSystemPrompt },
        ...formattedMessages,
        placeholderUser,
      ];
      const tokens = ContextManager.getContextSize(agentContext);
      const model = agent.provider_config?.model;
      return { agent_id: agent.id, name: agent.name, tokens, model };
    });

    return {
      orchestrator: { tokens: orchestratorTokens, model: orchestratorModel },
      agents,
    };
  }

  /**
   * List all sessions for a user
   * @param {number} userId - User ID
   * @returns {Promise<Array>} - Array of sessions
   */
  static async listSessions(userId) {
    try {
      const sessions = await WorkSession.findByUserId(userId);
      return sessions;
    } catch (error) {
      logger.error('Error listing sessions:', error);
      throw error;
    }
  }

  /**
   * Update session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {object} updates - Fields to update
   * @returns {Promise<object>} - Updated session
   */
  static async updateSession(sessionId, userId, updates) {
    try {
      // Check permission
      const session = await this.getSession(sessionId, userId);

      // Prepare updates
      const allowedUpdates = {};

      if (updates.name !== undefined) {
        if (!updates.name || updates.name.trim().length === 0) {
          throw new Error('Session name cannot be empty');
        }
        allowedUpdates.name = updates.name.trim();
      }

      if (updates.description !== undefined) {
        allowedUpdates.description = updates.description?.trim() || null;
      }

      if (updates.context_length !== undefined) {
        if (updates.context_length < 1 || updates.context_length > 200) {
          throw new Error('Context length must be between 1 and 200');
        }
        allowedUpdates.context_length = updates.context_length;
      }

      if (updates.orchestrator_provider_type !== undefined) {
        allowedUpdates.orchestrator_provider_type = updates.orchestrator_provider_type;
      }

      if (updates.orchestrator_provider_config !== undefined) {
        if (updates.orchestrator_provider_config && Object.keys(updates.orchestrator_provider_config).length > 0) {
          allowedUpdates.orchestrator_provider_config = encrypt(
            JSON.stringify(updates.orchestrator_provider_config)
          );
        } else {
          allowedUpdates.orchestrator_provider_config = null;
        }
      }

      if (updates.is_active !== undefined) {
        allowedUpdates.is_active = updates.is_active ? 1 : 0;
      }

      // Conversation mode settings
      if (updates.conversation_mode_enabled !== undefined) {
        allowedUpdates.conversation_mode_enabled = updates.conversation_mode_enabled ? 1 : 0;
      }

      if (updates.conversation_max_rounds !== undefined) {
        const maxRounds = parseInt(updates.conversation_max_rounds);
        if (isNaN(maxRounds) || maxRounds < 1 || maxRounds > 100) {
          throw new Error('Max rounds must be between 1 and 100');
        }
        allowedUpdates.conversation_max_rounds = maxRounds;
      }

      if (updates.conversation_token_budget !== undefined) {
        const tokenBudget = parseInt(updates.conversation_token_budget);
        if (isNaN(tokenBudget) || tokenBudget < 1000 || tokenBudget > 500000) {
          throw new Error('Token budget must be between 1,000 and 500,000');
        }
        allowedUpdates.conversation_token_budget = tokenBudget;
      }

      if (updates.pinned !== undefined) {
        allowedUpdates.pinned = updates.pinned ? 1 : 0;
      }

      if (Object.keys(allowedUpdates).length === 0) {
        throw new Error('No valid fields to update');
      }

      const updatedSession = await WorkSession.update(sessionId, allowedUpdates);

      logger.info(`Session updated: ${sessionId} (User: ${userId})`);

      return updatedSession;
    } catch (error) {
      logger.error('Error updating session:', error);
      throw error;
    }
  }

  /**
   * Delete session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   */
  static async deleteSession(sessionId, userId) {
    try {
      // Check permission
      await this.getSession(sessionId, userId);

      // Delete session (cascade deletes messages, session_agents, session_documents)
      await WorkSession.delete(sessionId);

      logger.info(`Session deleted: ${sessionId} (User: ${userId})`);
    } catch (error) {
      logger.error('Error deleting session:', error);
      throw error;
    }
  }

  /**
   * Assign agents to session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {Array<number>} agentIds - Array of agent IDs
   */
  static async assignAgents(sessionId, userId, agentIds) {
    try {
      // Check permission
      await this.getSession(sessionId, userId);

      // Assign each agent
      for (const agentId of agentIds) {
        await WorkSession.assignAgent(sessionId, agentId);
      }

      logger.info(`Assigned ${agentIds.length} agents to session ${sessionId}`);
    } catch (error) {
      logger.error('Error assigning agents:', error);
      throw error;
    }
  }

  /**
   * Remove agent from session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {number} agentId - Agent ID
   */
  static async removeAgent(sessionId, userId, agentId) {
    try {
      // Check permission
      await this.getSession(sessionId, userId);

      await WorkSession.removeAgent(sessionId, agentId);
      // Remove any per-agent doc mappings for this agent in this session
      await WorkSession.removeDocumentAssignmentsForAgent(sessionId, agentId);
      // Remove any per-agent tool mappings for this agent in this session
      await WorkSession.removeToolAssignmentsForAgent(sessionId, agentId);

      await syncSessionStorageLinks(sessionId);

      logger.info(`Removed agent ${agentId} from session ${sessionId}`);
    } catch (error) {
      logger.error('Error removing agent:', error);
      throw error;
    }
  }

  /**
   * Assign documents to session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {Array<number>} documentIds - Array of document IDs
   */
  static async assignDocuments(sessionId, userId, documentIds) {
    try {
      // Check permission
      await this.getSession(sessionId, userId);

      // Assign each document
      for (const documentId of documentIds) {
        await WorkSession.assignDocument(sessionId, documentId);
      }

      logger.info(`Assigned ${documentIds.length} documents to session ${sessionId}`);
    } catch (error) {
      logger.error('Error assigning documents:', error);
      throw error;
    }
  }

  /**
   * Remove document from session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {number} documentId - Document ID
   */
  static async removeDocument(sessionId, userId, documentId) {
    try {
      // Check permission
      await this.getSession(sessionId, userId);

      await WorkSession.removeDocument(sessionId, documentId);
      // Remove any per-agent mappings for this doc in this session
      await WorkSession.removeAgentAssignmentsForDocument(sessionId, documentId);

      logger.info(`Removed document ${documentId} from session ${sessionId}`);
    } catch (error) {
      logger.error('Error removing document:', error);
      throw error;
    }
  }

  /**
   * Replace document assignments per-agent for a session.
   *
   * Payload shape:
   * - assignments: [ { documentId: 1, agentIds: [2,3] }, ... ]
   * - orchestratorDocumentIds (optional): [ 1, 2 ] — document IDs to keep in session for orchestrator only
   */
  static async setDocumentAgentAssignments(sessionId, userId, assignments, orchestratorDocumentIds = null) {
    try {
      await this.getSession(sessionId, userId);

      const sessionAgents = await WorkSession.getAgents(sessionId);
      const allowedAgentIds = new Set((sessionAgents || []).map(a => a.id));

      const rows = [];
      const docsToKeepInSession = new Set();

      for (const item of assignments || []) {
        const documentId = parseInt(item.documentId);
        if (!Number.isFinite(documentId)) continue;

        // Validate document ownership
        const doc = await Document.findById(documentId);
        if (!doc || doc.user_id !== userId) continue;

        const agentIds = Array.isArray(item.agentIds) ? item.agentIds : [];
        const uniqueAgentIds = Array.from(
          new Set(agentIds.map(a => parseInt(a)).filter(a => Number.isFinite(a)))
        );

        for (const agentId of uniqueAgentIds) {
          if (!allowedAgentIds.has(agentId)) continue;
          rows.push({ agent_id: agentId, document_id: documentId });
          docsToKeepInSession.add(documentId);
        }
      }

      // Add orchestrator-only documents (session-level, no per-agent rows)
      const orchIds = Array.isArray(orchestratorDocumentIds) ? orchestratorDocumentIds : [];
      for (const id of orchIds) {
        const documentId = parseInt(id);
        if (!Number.isFinite(documentId)) continue;
        const doc = await Document.findById(documentId);
        if (doc && doc.user_id === userId) docsToKeepInSession.add(documentId);
      }

      await WorkSession.replaceDocumentAgentAssignments(sessionId, rows);

      // session_documents = union of orchestrator docs and docs assigned to any agent
      const currentDocs = await Document.getBySession(sessionId);
      for (const doc of currentDocs) {
        await WorkSession.removeDocument(sessionId, doc.id);
      }
      for (const documentId of docsToKeepInSession) {
        await WorkSession.assignDocument(sessionId, documentId);
      }

      logger.info(`Updated per-agent document assignments for session ${sessionId}: ${rows.length} mappings`);
    } catch (error) {
      logger.error('Error setting document agent assignments:', error);
      throw error;
    }
  }

  /**
   * Replace tool assignments per-agent for a session.
   *
   * Payload shape (per tool):
   * [
   *   { toolName: "web_search", agentIds: [2,3] },
   *   { toolName: "sqlite_local_db", agentIds: [2,3], toolConfigs: { 2: { database_name: "db1" }, 3: { database_name: "db2" } } }
   * ]
   */
  static async setToolAgentAssignments(sessionId, userId, assignments) {
    try {
      await this.getSession(sessionId, userId);

      const sessionAgents = await WorkSession.getAgents(sessionId);
      const allowedAgentIds = new Set((sessionAgents || []).map(a => a.id));

      const knownTools = new Set((toolRegistry.getAll() || []).map(t => t.name));

      const rows = [];
      for (const item of assignments || []) {
        const toolName = (item.toolName || '').trim();
        if (!toolName) continue;
        // Only allow tools that exist in registry
        if (!knownTools.has(toolName)) continue;

        const agentIds = Array.isArray(item.agentIds) ? item.agentIds : [];
        const uniqueAgentIds = Array.from(
          new Set(agentIds.map(a => parseInt(a)).filter(a => Number.isFinite(a)))
        );

        // Get tool configs if provided (map from agentId to config object)
        const toolConfigs = item.toolConfigs || {};

        for (const agentId of uniqueAgentIds) {
          if (!allowedAgentIds.has(agentId)) continue;
          const toolConfig = toolConfigs[agentId] || toolConfigs[String(agentId)] || null;
          rows.push({ 
            agent_id: agentId, 
            tool_name: toolName,
            tool_config: toolConfig
          });
        }
      }

      await WorkSession.replaceToolAgentAssignments(sessionId, rows);
      logger.info(`Updated per-agent tool assignments for session ${sessionId}: ${rows.length} mappings`);

      await syncSessionStorageLinks(sessionId);
    } catch (error) {
      logger.error('Error setting tool agent assignments:', error);
      throw error;
    }
  }

  /**
   * Get orchestrator tool assignments for a session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @returns {Promise<Array<{tool_name:string, tool_config?:object}>>} - Array of tool assignments with configs
   */
  static async getOrchestratorToolAssignments(sessionId, userId) {
    try {
      await this.getSession(sessionId, userId);
      return await WorkSession.getOrchestratorToolAssignments(sessionId);
    } catch (error) {
      logger.error('Error getting orchestrator tool assignments:', error);
      throw error;
    }
  }

  /**
   * Set orchestrator tool assignments for a session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {Array<{tool_name:string, tool_config?:object|string}>|string[]} assignments - Array of tool assignments (with optional configs) or just tool names
   */
  static async setOrchestratorToolAssignments(sessionId, userId, assignments) {
    try {
      await this.getSession(sessionId, userId);

      const knownTools = new Set((toolRegistry.getAll() || []).map(t => t.name));
      
      // Normalize assignments: if array of strings, convert to array of objects
      const normalizedAssignments = (assignments || []).map(assignment => {
        if (typeof assignment === 'string') {
          return { tool_name: assignment.trim() };
        }
        return {
          tool_name: assignment.tool_name?.trim(),
          tool_config: assignment.tool_config
        };
      }).filter(a => a.tool_name && knownTools.has(a.tool_name));

      await WorkSession.replaceOrchestratorToolAssignments(sessionId, normalizedAssignments);
      logger.info(`Updated orchestrator tool assignments for session ${sessionId}: ${normalizedAssignments.length} tools`);
    } catch (error) {
      logger.error('Error setting orchestrator tool assignments:', error);
      throw error;
    }
  }

  /**
   * Export session data
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {boolean} includeMessages - Whether to include messages in export
   * @returns {Promise<object>} - Exported session data
   */
  static async exportSession(sessionId, userId, includeMessages = false) {
    try {
      // Get complete session with agents and documents
      const session = await this.getCompleteSession(sessionId, userId);

      // Get messages only if requested
      let messages = [];
      if (includeMessages) {
        const Message = require('../../models/Message');
        messages = await Message.findBySessionId(sessionId, 10000, 0);
      }

      // Create export object
      const exportData = {
        version: '1.0',
        exported_at: new Date().toISOString(),
        session: {
          name: session.name,
          description: session.description,
          context_length: session.context_length,
          orchestrator_provider_type: session.orchestrator_provider_type,
          orchestrator_provider_config: session.orchestrator_provider_config,
          conversation_mode_enabled: session.conversation_mode_enabled || false,
          conversation_max_rounds: session.conversation_max_rounds || 10,
          conversation_token_budget: session.conversation_token_budget || 50000,
        },
        agents: session.agents.map(agent => ({
          name: agent.name,
          role: agent.role,
          initial_context: agent.initial_context,
          provider_type: agent.provider_type,
        })),
        documents: session.documents.map(doc => ({
          filename: doc.filename,
          file_type: doc.file_type,
        })),
        tool_assignments: (session.tool_agent_assignments || []).map(assignment => ({
          agent_name: session.agents.find(a => a.id === assignment.agent_id)?.name || null,
          tool_name: assignment.tool_name,
          tool_config: assignment.tool_config || null,
        })),
        document_assignments: (session.document_agent_assignments || []).map(assignment => ({
          agent_name: session.agents.find(a => a.id === assignment.agent_id)?.name || null,
          document_filename: session.documents.find(d => d.id === assignment.document_id)?.filename || null,
        })),
        messages: includeMessages ? messages.map(msg => ({
          role: msg.role,
          content: msg.content,
          created_at: msg.created_at,
        })) : [],
      };

      logger.info(`Session exported: ${sessionId} (messages: ${includeMessages ? 'included' : 'excluded'})`);

      return exportData;
    } catch (error) {
      logger.error('Error exporting session:', error);
      throw error;
    }
  }

  /**
   * Import session data
   * @param {number} userId - User ID
   * @param {object} importData - Session data to import
   * @param {string} newName - Optional new name for imported session
   * @returns {Promise<object>} - Created session
   */
  static async importSession(userId, importData, newName = null) {
    try {
      // Debug log the incoming data
      const receivedKeys = importData ? Object.keys(importData) : [];
      logger.info(`Import session called. Received data keys: ${receivedKeys.join(', ') || 'none'}`);
      
      // Handle different possible data structures
      let data = importData;
      
      // If importData is wrapped in another object (e.g., { data: {...} }), unwrap it
      if (data && data.data && typeof data.data === 'object' && data.data.session) {
        logger.info('Unwrapping nested data structure');
        data = data.data;
      }
      
      // Validate import data - must have session object
      if (!data || !data.session) {
        const dataKeys = data ? Object.keys(data) : [];
        logger.error(`Invalid import data structure. Keys found: ${dataKeys.join(', ') || 'none'}`);
        throw new Error(`Invalid import data: session data is required. Found keys: [${dataKeys.join(', ')}]. Expected JSON with "session" property.`);
      }

      const Agent = require('../../models/Agent');

      // Determine session name: use newName if provided, otherwise use original name + " (Imported)", or fallback
      let sessionName;
      if (newName && newName.trim()) {
        sessionName = newName.trim();
      } else if (data.session.name && data.session.name.trim()) {
        sessionName = data.session.name.trim() + ' (Imported)';
      } else {
        sessionName = 'Imported Session';
      }
      
      // Use the unwrapped data from here
      importData = data;
      const session = await this.createSession(userId, {
        name: sessionName,
        description: importData.session.description,
        context_length: importData.session.context_length || 50,
        orchestrator_provider_type: importData.session.orchestrator_provider_type || 'claude',
        orchestrator_provider_config: importData.session.orchestrator_provider_config || {},
      });

      // Update conversation mode settings if present
      if (importData.session.conversation_mode_enabled !== undefined) {
        await WorkSession.update(session.id, {
          conversation_mode_enabled: importData.session.conversation_mode_enabled ? 1 : 0,
          conversation_max_rounds: importData.session.conversation_max_rounds || 10,
          conversation_token_budget: importData.session.conversation_token_budget || 50000,
        });
      }

      // Match and assign agents by name
      const agentIds = [];
      if (importData.agents && importData.agents.length > 0) {
        const userAgents = await Agent.findByUserId(userId, { isActive: true });
        for (const exportedAgent of importData.agents) {
          // Try to find agent by name (and optionally role/provider_type for better matching)
          const matchedAgent = userAgents.find(a => 
            a.name === exportedAgent.name && 
            a.role === exportedAgent.role &&
            a.provider_type === exportedAgent.provider_type
          ) || userAgents.find(a => a.name === exportedAgent.name);
          
          if (matchedAgent) {
            agentIds.push(matchedAgent.id);
            logger.info(`Matched agent: ${exportedAgent.name} -> ID ${matchedAgent.id}`);
          } else {
            logger.warn(`Agent not found: ${exportedAgent.name} (role: ${exportedAgent.role}, provider: ${exportedAgent.provider_type})`);
          }
        }
        
        if (agentIds.length > 0) {
          await this.assignAgents(session.id, userId, agentIds);
        }
      }

      // Match and assign documents by filename
      const documentIds = [];
      const documentMap = {}; // filename -> document_id for assignments
      if (importData.documents && importData.documents.length > 0) {
        const userDocuments = await Document.findByUserId(userId);
        for (const exportedDoc of importData.documents) {
          const matchedDoc = userDocuments.find(d => d.filename === exportedDoc.filename);
          if (matchedDoc) {
            documentIds.push(matchedDoc.id);
            documentMap[exportedDoc.filename] = matchedDoc.id;
            logger.info(`Matched document: ${exportedDoc.filename} -> ID ${matchedDoc.id}`);
          } else {
            logger.warn(`Document not found: ${exportedDoc.filename}`);
          }
        }
        
        if (documentIds.length > 0) {
          await this.assignDocuments(session.id, userId, documentIds);
        }
      }

      // Get the assigned agents for tool/document assignments
      const sessionAgents = await WorkSession.getAgents(session.id);
      const agentNameToIdMap = {};
      for (const agent of sessionAgents) {
        agentNameToIdMap[agent.name] = agent.id;
      }

      // Set tool assignments
      if (importData.tool_assignments && importData.tool_assignments.length > 0 && agentIds.length > 0) {
        const toolAssignmentsMap = {}; // toolName -> { agentIds: [], toolConfigs: {} }
        
        for (const assignment of importData.tool_assignments) {
          const agentId = agentNameToIdMap[assignment.agent_name];
          if (!agentId) {
            logger.warn(`Agent not found for tool assignment: ${assignment.agent_name}`);
            continue;
          }
          
          if (!toolAssignmentsMap[assignment.tool_name]) {
            toolAssignmentsMap[assignment.tool_name] = {
              agentIds: [],
              toolConfigs: {},
            };
          }
          
          if (!toolAssignmentsMap[assignment.tool_name].agentIds.includes(agentId)) {
            toolAssignmentsMap[assignment.tool_name].agentIds.push(agentId);
          }
          
          if (assignment.tool_config) {
            toolAssignmentsMap[assignment.tool_name].toolConfigs[agentId] = assignment.tool_config;
          }
        }
        
        const toolAssignments = Object.entries(toolAssignmentsMap).map(([toolName, data]) => ({
          toolName,
          agentIds: data.agentIds,
          toolConfigs: data.toolConfigs,
        }));
        
        if (toolAssignments.length > 0) {
          await this.setToolAgentAssignments(session.id, userId, toolAssignments);
        }
      }

      // Set document-agent assignments
      if (importData.document_assignments && importData.document_assignments.length > 0 && agentIds.length > 0 && documentIds.length > 0) {
        const docAssignmentsMap = {}; // documentId -> agentIds[]
        
        for (const assignment of importData.document_assignments) {
          const agentId = agentNameToIdMap[assignment.agent_name];
          const documentId = documentMap[assignment.document_filename];
          
          if (!agentId || !documentId) {
            logger.warn(`Missing agent or document for assignment: agent=${assignment.agent_name}, doc=${assignment.document_filename}`);
            continue;
          }
          
          if (!docAssignmentsMap[documentId]) {
            docAssignmentsMap[documentId] = [];
          }
          
          if (!docAssignmentsMap[documentId].includes(agentId)) {
            docAssignmentsMap[documentId].push(agentId);
          }
        }
        
        const docAssignments = Object.entries(docAssignmentsMap).map(([documentId, agentIds]) => ({
          documentId: parseInt(documentId),
          agentIds,
        }));
        
        if (docAssignments.length > 0) {
          await this.setDocumentAgentAssignments(session.id, userId, docAssignments);
        }
      }

      // Import messages
      if (importData.messages && importData.messages.length > 0) {
        const Message = require('../../models/Message');
        for (const msg of importData.messages) {
          await Message.create({
            session_id: session.id,
            role: msg.role,
            content: msg.content,
            tokens_used: 0,
            created_at: msg.created_at || new Date().toISOString(),
          });
        }
        logger.info(`Imported ${importData.messages.length} messages`);
      }

      logger.info(`Session imported: ${session.id} (User: ${userId}, Agents: ${agentIds.length}, Documents: ${documentIds.length})`);

      // Return complete session
      return await this.getCompleteSession(session.id, userId);
    } catch (error) {
      logger.error('Error importing session:', error);
      throw error;
    }
  }

  /**
   * Clear all messages from a session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   */
  static async clearMessages(sessionId, userId) {
    try {
      // Check permission
      await this.getSession(sessionId, userId);

      // Delete all messages for this session
      const Message = require('../../models/Message');
      await Message.deleteBySessionId(sessionId);

      logger.info(`Messages cleared for session ${sessionId} (User: ${userId})`);
    } catch (error) {
      logger.error('Error clearing session messages:', error);
      throw error;
    }
  }

  /**
   * Duplicate a session with all its settings
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @returns {Promise<object>} - Duplicated session
   */
  static async duplicateSession(sessionId, userId) {
    try {
      // Get complete session with all settings
      const originalSession = await this.getCompleteSession(sessionId, userId);

      // Create new session with same settings but new name
      const newSession = await this.createSession(userId, {
        name: `${originalSession.name} (Copy)`,
        description: originalSession.description,
        context_length: originalSession.context_length,
        orchestrator_provider_type: originalSession.orchestrator_provider_type,
        orchestrator_provider_config: originalSession.orchestrator_provider_config || {},
      });

      // Update conversation mode settings (copy whether enabled or not)
      await WorkSession.update(newSession.id, {
        conversation_mode_enabled: originalSession.conversation_mode_enabled || 0,
        conversation_max_rounds: originalSession.conversation_max_rounds || 10,
        conversation_token_budget: originalSession.conversation_token_budget || 50000,
      });

      // Assign the same agents
      if (originalSession.agents && originalSession.agents.length > 0) {
        const agentIds = originalSession.agents.map(a => a.id);
        logger.info(`Copying ${agentIds.length} agents to new session ${newSession.id}: ${agentIds.join(', ')}`);
        await this.assignAgents(newSession.id, userId, agentIds);
      } else {
        logger.info(`No agents to copy from session ${sessionId}`);
      }

      // Assign the same documents
      if (originalSession.documents && originalSession.documents.length > 0) {
        const documentIds = originalSession.documents.map(d => d.id);
        logger.info(`Copying ${documentIds.length} documents to new session ${newSession.id}: ${documentIds.join(', ')}`);
        await this.assignDocuments(newSession.id, userId, documentIds);
      } else {
        logger.info(`No documents to copy from session ${sessionId}`);
      }

      logger.info(`Session duplicated: ${sessionId} -> ${newSession.id} (User: ${userId})`);

      // Return complete session with agents and documents
      const duplicatedSession = await this.getCompleteSession(newSession.id, userId);
      logger.info(`Duplicated session ${newSession.id} has ${duplicatedSession.agents?.length || 0} agents and ${duplicatedSession.documents?.length || 0} documents`);
      return duplicatedSession;
    } catch (error) {
      logger.error('Error duplicating session:', error);
      throw error;
    }
  }

  /**
   * Toggle pin status of a session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @returns {Promise<object>} - Updated session
   */
  static async togglePin(sessionId, userId) {
    try {
      // Check permission
      const session = await this.getSession(sessionId, userId);

      // Toggle pinned status
      const newPinnedStatus = session.pinned ? 0 : 1;
      const updatedSession = await WorkSession.update(sessionId, {
        pinned: newPinnedStatus,
      });

      logger.info(`Session ${sessionId} ${newPinnedStatus ? 'pinned' : 'unpinned'} (User: ${userId})`);

      return updatedSession;
    } catch (error) {
      logger.error('Error toggling pin status:', error);
      throw error;
    }
  }
}

module.exports = SessionService;
