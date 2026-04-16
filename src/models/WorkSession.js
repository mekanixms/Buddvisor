const { dbRun, dbGet, dbAll } = require('../../config/database');
const logger = require('../utils/logger');

class WorkSession {
  /**
   * Create a new work session
   * @param {object} sessionData - Session data
   * @returns {Promise<object>} - Created session object
   */
  static async create(sessionData) {
    try {
      const {
        user_id,
        name,
        description = null,
        context_length = 50,
        orchestrator_provider_type = 'claude',
        orchestrator_provider_config = null,
      } = sessionData;

      const result = await dbRun(
        `INSERT INTO work_sessions (
          user_id, name, description, context_length,
          orchestrator_provider_type, orchestrator_provider_config
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        [user_id, name, description, context_length, orchestrator_provider_type, orchestrator_provider_config]
      );

      logger.info(`Work session created: ${name} (ID: ${result.lastID})`);

      return await this.findById(result.lastID);
    } catch (error) {
      logger.error('Error creating work session:', error);
      throw error;
    }
  }

  /**
   * Find session by ID
   * @param {number} id - Session ID
   * @returns {Promise<object|null>} - Session object or null
   */
  static async findById(id) {
    try {
      const session = await dbGet(
        'SELECT * FROM work_sessions WHERE id = ?',
        [id]
      );

      return session || null;
    } catch (error) {
      logger.error('Error finding session by ID:', error);
      throw error;
    }
  }

  /**
   * Find session by share token
   * @param {string} token - Share token
   * @returns {Promise<object|null>} - Session or null
   */
  static async findByShareToken(token) {
    if (!token || typeof token !== 'string') return null;
    try {
      const session = await dbGet(
        'SELECT * FROM work_sessions WHERE share_token = ? AND is_active = 1',
        [token.trim()]
      );
      return session || null;
    } catch (error) {
      logger.error('Error finding session by share token:', error);
      throw error;
    }
  }

  /**
   * Find sessions by name (may return multiple rows)
   * @param {string} name
   * @returns {Promise<Array>}
   */
  static async findByName(name) {
    try {
      return await dbAll(
        'SELECT * FROM work_sessions WHERE name = ? ORDER BY id DESC',
        [name]
      );
    } catch (error) {
      logger.error('Error finding sessions by name:', error);
      throw error;
    }
  }

  /**
   * Find all sessions for a user
   * @param {number} userId - User ID
   * @returns {Promise<Array>} - Array of sessions
   */
  static async findByUserId(userId) {
    try {
      return await dbAll(
        'SELECT * FROM work_sessions WHERE user_id = ? ORDER BY pinned DESC, last_accessed_at DESC',
        [userId]
      );
    } catch (error) {
      logger.error('Error finding sessions by user ID:', error);
      throw error;
    }
  }

  /**
   * Update session
   * @param {number} id - Session ID
   * @param {object} updates - Fields to update
   * @returns {Promise<object>} - Updated session object
   */
  static async update(id, updates) {
    try {
      const allowedFields = [
        'name',
        'description',
        'context_length',
        'orchestrator_provider_type',
        'orchestrator_provider_config',
        'is_active',
        'inbound_webhook_enabled',
        'inbound_webhook_secret_hash',
        'conversation_mode_enabled',
        'conversation_max_rounds',
        'conversation_token_budget',
        'pinned',
        'share_token',
      ];

      const updateFields = [];
      const values = [];

      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
          updateFields.push(`${key} = ?`);
          values.push(value);
        }
      }

      if (updateFields.length === 0) {
        throw new Error('No valid fields to update');
      }

      // Add updated_at
      updateFields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);

      const sql = `UPDATE work_sessions SET ${updateFields.join(', ')} WHERE id = ?`;

      await dbRun(sql, values);

      logger.info(`Work session updated: ${id}`);

      return await this.findById(id);
    } catch (error) {
      logger.error('Error updating work session:', error);
      throw error;
    }
  }

  /**
   * Update last accessed time
   * @param {number} id - Session ID
   */
  static async updateLastAccessed(id) {
    try {
      await dbRun(
        'UPDATE work_sessions SET last_accessed_at = CURRENT_TIMESTAMP WHERE id = ?',
        [id]
      );
    } catch (error) {
      logger.error('Error updating last accessed time:', error);
      throw error;
    }
  }

  /**
   * Delete session
   * @param {number} id - Session ID
   */
  static async delete(id) {
    try {
      await dbRun('DELETE FROM work_sessions WHERE id = ?', [id]);
      logger.info(`Work session deleted: ${id}`);
    } catch (error) {
      logger.error('Error deleting work session:', error);
      throw error;
    }
  }

  /**
   * Get session with assigned agents
   * @param {number} sessionId - Session ID
   * @returns {Promise<object>} - Session with agents
   */
  static async getWithAgents(sessionId) {
    try {
      const session = await this.findById(sessionId);
      if (!session) return null;

      const agents = await dbAll(
        `SELECT a.* FROM agents a
         INNER JOIN session_agents sa ON a.id = sa.agent_id
         WHERE sa.session_id = ?
         ORDER BY a.name`,
        [sessionId]
      );

      return {
        ...session,
        agents,
      };
    } catch (error) {
      logger.error('Error getting session with agents:', error);
      throw error;
    }
  }

  /**
   * Get session with assigned documents
   * @param {number} sessionId - Session ID
   * @returns {Promise<object>} - Session with documents
   */
  static async getWithDocuments(sessionId) {
    try {
      const session = await this.findById(sessionId);
      if (!session) return null;

      const documents = await dbAll(
        `SELECT d.* FROM documents d
         WHERE d.id IN (
           SELECT document_id FROM session_documents WHERE session_id = ?
           UNION
           SELECT document_id FROM session_agent_documents WHERE session_id = ?
         )
         ORDER BY d.filename`,
        [sessionId, sessionId]
      );

      return {
        ...session,
        documents,
      };
    } catch (error) {
      logger.error('Error getting session with documents:', error);
      throw error;
    }
  }

  /**
   * Get complete session details (with agents and documents)
   * @param {number} sessionId - Session ID
   * @returns {Promise<object>} - Complete session object
   */
  static async getComplete(sessionId) {
    try {
      const session = await this.findById(sessionId);
      if (!session) return null;

      const [agents, documents, documentAgentAssignments, toolAgentAssignments] = await Promise.all([
        dbAll(
          `SELECT a.*, sa.session_context
           FROM agents a
           INNER JOIN session_agents sa ON a.id = sa.agent_id
           WHERE sa.session_id = ?
           ORDER BY a.name`,
          [sessionId]
        ),
        dbAll(
          `SELECT d.* FROM documents d
           WHERE d.id IN (
             SELECT document_id FROM session_documents WHERE session_id = ?
             UNION
             SELECT document_id FROM session_agent_documents WHERE session_id = ?
           )
           ORDER BY d.filename`,
          [sessionId, sessionId]
        ),
        dbAll(
          `SELECT agent_id, document_id FROM session_agent_documents
           WHERE session_id = ?`,
          [sessionId]
        ),
        dbAll(
          `SELECT agent_id, tool_name, tool_config FROM session_agent_tools
           WHERE session_id = ?`,
          [sessionId]
        ),
      ]);

      // Parse tool_config JSON strings
      const parsedToolAssignments = (toolAgentAssignments || []).map(assignment => {
        if (assignment.tool_config && typeof assignment.tool_config === 'string') {
          try {
            assignment.tool_config = JSON.parse(assignment.tool_config);
          } catch (e) {
            // If parsing fails, keep as string or set to null
            logger.warn(`Failed to parse tool_config for tool ${assignment.tool_name}:`, e);
            assignment.tool_config = null;
          }
        }
        return assignment;
      });

      return {
        ...session,
        agents,
        documents,
        document_agent_assignments: documentAgentAssignments,
        tool_agent_assignments: parsedToolAssignments,
      };
    } catch (error) {
      logger.error('Error getting complete session:', error);
      throw error;
    }
  }

  /**
   * Replace document↔agent assignments for a session
   * @param {number} sessionId
   * @param {Array<{agent_id:number, document_id:number}>} rows
   */
  static async replaceDocumentAgentAssignments(sessionId, rows) {
    try {
      await dbRun('DELETE FROM session_agent_documents WHERE session_id = ?', [sessionId]);

      if (!rows || rows.length === 0) return;

      for (const row of rows) {
        await dbRun(
          `INSERT OR IGNORE INTO session_agent_documents (session_id, agent_id, document_id)
           VALUES (?, ?, ?)`,
          [sessionId, row.agent_id, row.document_id]
        );
      }
    } catch (error) {
      logger.error('Error replacing document agent assignments:', error);
      throw error;
    }
  }

  /**
   * Remove all document assignments for an agent in a session
   */
  static async removeDocumentAssignmentsForAgent(sessionId, agentId) {
    try {
      await dbRun(
        'DELETE FROM session_agent_documents WHERE session_id = ? AND agent_id = ?',
        [sessionId, agentId]
      );
    } catch (error) {
      logger.error('Error removing document assignments for agent:', error);
      throw error;
    }
  }

  /**
   * Remove all agent assignments for a document in a session
   */
  static async removeAgentAssignmentsForDocument(sessionId, documentId) {
    try {
      await dbRun(
        'DELETE FROM session_agent_documents WHERE session_id = ? AND document_id = ?',
        [sessionId, documentId]
      );
    } catch (error) {
      logger.error('Error removing agent assignments for document:', error);
      throw error;
    }
  }

  /**
   * Replace tool↔agent assignments for a session
   * @param {number} sessionId
   * @param {Array<{agent_id:number, tool_name:string, tool_config?:object|string}>} rows
   */
  static async replaceToolAgentAssignments(sessionId, rows) {
    try {
      await dbRun('DELETE FROM session_agent_tools WHERE session_id = ?', [sessionId]);

      if (!rows || rows.length === 0) return;

      for (const row of rows) {
        // Serialize tool_config to JSON string if provided
        const toolConfigJson = row.tool_config 
          ? (typeof row.tool_config === 'string' ? row.tool_config : JSON.stringify(row.tool_config))
          : null;

        await dbRun(
          `INSERT OR IGNORE INTO session_agent_tools (session_id, agent_id, tool_name, tool_config)
           VALUES (?, ?, ?, ?)`,
          [sessionId, row.agent_id, row.tool_name, toolConfigJson]
        );
      }
    } catch (error) {
      logger.error('Error replacing tool agent assignments:', error);
      throw error;
    }
  }

  /**
   * Remove all tool assignments for an agent in a session
   */
  static async removeToolAssignmentsForAgent(sessionId, agentId) {
    try {
      await dbRun(
        'DELETE FROM session_agent_tools WHERE session_id = ? AND agent_id = ?',
        [sessionId, agentId]
      );
    } catch (error) {
      logger.error('Error removing tool assignments for agent:', error);
      throw error;
    }
  }

  /**
   * Remove all agent assignments for a tool in a session
   */
  static async removeAgentAssignmentsForTool(sessionId, toolName) {
    try {
      await dbRun(
        'DELETE FROM session_agent_tools WHERE session_id = ? AND tool_name = ?',
        [sessionId, toolName]
      );
    } catch (error) {
      logger.error('Error removing agent assignments for tool:', error);
      throw error;
    }
  }

  /**
   * Check whether a session has any per-agent tool assignments configured
   * @param {number} sessionId
   * @returns {Promise<boolean>}
   */
  static async hasToolAssignments(sessionId) {
    try {
      const row = await dbGet(
        'SELECT 1 as ok FROM session_agent_tools WHERE session_id = ? LIMIT 1',
        [sessionId]
      );
      return !!row;
    } catch (error) {
      logger.error('Error checking tool assignments:', error);
      throw error;
    }
  }

  /**
   * Get tool names assigned to a specific agent within a session
   * @param {number} sessionId
   * @param {number} agentId
   * @returns {Promise<string[]>}
   */
  static async getToolNamesBySessionAndAgent(sessionId, agentId) {
    try {
      const rows = await dbAll(
        `SELECT tool_name FROM session_agent_tools
         WHERE session_id = ? AND agent_id = ?
         ORDER BY tool_name`,
        [sessionId, agentId]
      );
      return (rows || []).map(r => r.tool_name).filter(Boolean);
    } catch (error) {
      logger.error('Error getting tool names by session and agent:', error);
      throw error;
    }
  }

  /**
   * Get tool names assigned to the orchestrator for a session
   * @param {number} sessionId
   * @returns {Promise<string[]>}
   */
  static async getOrchestratorToolNames(sessionId) {
    try {
      const rows = await dbAll(
        `SELECT tool_name FROM session_orchestrator_tools
         WHERE session_id = ?
         ORDER BY tool_name`,
        [sessionId]
      );
      return (rows || []).map(r => r.tool_name).filter(Boolean);
    } catch (error) {
      logger.error('Error getting orchestrator tool names:', error);
      throw error;
    }
  }

  /**
   * Get orchestrator tool assignments with configs for a session
   * @param {number} sessionId
   * @returns {Promise<Array<{tool_name:string, tool_config?:object}>>}
   */
  static async getOrchestratorToolAssignments(sessionId) {
    try {
      const rows = await dbAll(
        `SELECT tool_name, tool_config FROM session_orchestrator_tools
         WHERE session_id = ?
         ORDER BY tool_name`,
        [sessionId]
      );
      return (rows || []).map(row => {
        const assignment = { tool_name: row.tool_name };
        if (row.tool_config) {
          try {
            assignment.tool_config = JSON.parse(row.tool_config);
          } catch (e) {
            logger.warn(`Failed to parse tool_config for orchestrator tool ${row.tool_name}:`, e);
            assignment.tool_config = null;
          }
        }
        return assignment;
      });
    } catch (error) {
      logger.error('Error getting orchestrator tool assignments:', error);
      throw error;
    }
  }

  /**
   * Replace orchestrator tool assignments for a session
   * @param {number} sessionId
   * @param {Array<{tool_name:string, tool_config?:object|string}>} assignments - Array of tool assignments with optional configs
   */
  static async replaceOrchestratorToolAssignments(sessionId, assignments) {
    try {
      await dbRun('DELETE FROM session_orchestrator_tools WHERE session_id = ?', [sessionId]);

      if (!assignments || assignments.length === 0) return;

      for (const assignment of assignments) {
        const toolName = typeof assignment === 'string' ? assignment : assignment.tool_name;
        if (!toolName || typeof toolName !== 'string') continue;

        // Serialize tool_config to JSON string if provided
        const toolConfigJson = (typeof assignment === 'object' && assignment.tool_config)
          ? (typeof assignment.tool_config === 'string' ? assignment.tool_config : JSON.stringify(assignment.tool_config))
          : null;

        await dbRun(
          `INSERT OR IGNORE INTO session_orchestrator_tools (session_id, tool_name, tool_config)
           VALUES (?, ?, ?)`,
          [sessionId, toolName.trim(), toolConfigJson]
        );
      }
    } catch (error) {
      logger.error('Error replacing orchestrator tool assignments:', error);
      throw error;
    }
  }

  /**
   * Get agents assigned to a session
   * @param {number} sessionId - Session ID
   * @returns {Promise<Array>} - Array of agents with session_context
   */
  static async getAgents(sessionId) {
    try {
      return await dbAll(
        `SELECT a.*, sa.session_context FROM agents a
         INNER JOIN session_agents sa ON a.id = sa.agent_id
         WHERE sa.session_id = ?
         ORDER BY a.name`,
        [sessionId]
      );
    } catch (error) {
      logger.error('Error getting session agents:', error);
      throw error;
    }
  }

  /**
   * Get agent session context
   * @param {number} sessionId - Session ID
   * @param {number} agentId - Agent ID
   * @returns {Promise<string|null>} - Session context or null
   */
  static async getAgentSessionContext(sessionId, agentId) {
    try {
      const row = await dbGet(
        'SELECT session_context FROM session_agents WHERE session_id = ? AND agent_id = ?',
        [sessionId, agentId]
      );
      return row ? row.session_context : null;
    } catch (error) {
      logger.error('Error getting agent session context:', error);
      throw error;
    }
  }

  /**
   * Set agent session context
   * @param {number} sessionId - Session ID
   * @param {number} agentId - Agent ID
   * @param {string} sessionContext - The session context
   */
  static async setAgentSessionContext(sessionId, agentId, sessionContext) {
    try {
      await dbRun(
        'UPDATE session_agents SET session_context = ? WHERE session_id = ? AND agent_id = ?',
        [sessionContext, sessionId, agentId]
      );
      logger.info(`Agent ${agentId} session context updated in session ${sessionId}`);
    } catch (error) {
      logger.error('Error setting agent session context:', error);
      throw error;
    }
  }

  /**
   * Get documents assigned to a session
   * @param {number} sessionId - Session ID
   * @returns {Promise<Array>} - Array of documents
   */
  static async getDocuments(sessionId) {
    try {
      return await dbAll(
        `SELECT d.* FROM documents d
         INNER JOIN session_documents sd ON d.id = sd.document_id
         WHERE sd.session_id = ?
         ORDER BY d.filename`,
        [sessionId]
      );
    } catch (error) {
      logger.error('Error getting session documents:', error);
      throw error;
    }
  }

  /**
   * Assign agent to session
   * @param {number} sessionId - Session ID
   * @param {number} agentId - Agent ID
   */
  static async assignAgent(sessionId, agentId) {
    try {
      await dbRun(
        'INSERT OR IGNORE INTO session_agents (session_id, agent_id) VALUES (?, ?)',
        [sessionId, agentId]
      );

      logger.info(`Agent ${agentId} assigned to session ${sessionId}`);
    } catch (error) {
      logger.error('Error assigning agent to session:', error);
      throw error;
    }
  }

  /**
   * Remove agent from session
   * @param {number} sessionId - Session ID
   * @param {number} agentId - Agent ID
   */
  static async removeAgent(sessionId, agentId) {
    try {
      await dbRun(
        'DELETE FROM session_agents WHERE session_id = ? AND agent_id = ?',
        [sessionId, agentId]
      );

      logger.info(`Agent ${agentId} removed from session ${sessionId}`);
    } catch (error) {
      logger.error('Error removing agent from session:', error);
      throw error;
    }
  }

  /**
   * Assign document to session
   * @param {number} sessionId - Session ID
   * @param {number} documentId - Document ID
   */
  static async assignDocument(sessionId, documentId) {
    try {
      await dbRun(
        'INSERT OR IGNORE INTO session_documents (session_id, document_id) VALUES (?, ?)',
        [sessionId, documentId]
      );

      logger.info(`Document ${documentId} assigned to session ${sessionId}`);
    } catch (error) {
      logger.error('Error assigning document to session:', error);
      throw error;
    }
  }

  /**
   * Remove document from session
   * @param {number} sessionId - Session ID
   * @param {number} documentId - Document ID
   */
  static async removeDocument(sessionId, documentId) {
    try {
      await dbRun(
        'DELETE FROM session_documents WHERE session_id = ? AND document_id = ?',
        [sessionId, documentId]
      );

      logger.info(`Document ${documentId} removed from session ${sessionId}`);
    } catch (error) {
      logger.error('Error removing document from session:', error);
      throw error;
    }
  }

  /**
   * Get conversation mode settings for a session
   * @param {number} sessionId - Session ID
   * @returns {Promise<object>} - Conversation mode settings
   */
  static async getConversationModeSettings(sessionId) {
    try {
      const session = await dbGet(
        `SELECT conversation_mode_enabled, conversation_max_rounds, conversation_token_budget
         FROM work_sessions WHERE id = ?`,
        [sessionId]
      );

      if (!session) return null;

      return {
        enabled: !!session.conversation_mode_enabled,
        maxRounds: session.conversation_max_rounds || 10,
        tokenBudget: session.conversation_token_budget || 50000,
      };
    } catch (error) {
      logger.error('Error getting conversation mode settings:', error);
      throw error;
    }
  }

  /**
   * Update conversation mode settings for a session
   * @param {number} sessionId - Session ID
   * @param {object} settings - Conversation mode settings
   * @returns {Promise<object>} - Updated settings
   */
  static async updateConversationModeSettings(sessionId, settings) {
    try {
      const { enabled, maxRounds, tokenBudget } = settings;

      await dbRun(
        `UPDATE work_sessions SET
          conversation_mode_enabled = ?,
          conversation_max_rounds = ?,
          conversation_token_budget = ?,
          updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          enabled ? 1 : 0,
          maxRounds || 10,
          tokenBudget || 50000,
          sessionId,
        ]
      );

      logger.info(`Conversation mode settings updated for session ${sessionId}`);

      return await this.getConversationModeSettings(sessionId);
    } catch (error) {
      logger.error('Error updating conversation mode settings:', error);
      throw error;
    }
  }
}

module.exports = WorkSession;
