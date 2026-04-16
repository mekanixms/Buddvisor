const { dbRun, dbGet, dbAll } = require('../../config/database');
const logger = require('../utils/logger');

class Message {
  /**
   * Create a new message
   * @param {object} messageData - Message data
   * @returns {Promise<object>} - Created message object
   */
  static async create(messageData) {
    try {
      const {
        session_id,
        role,
        content,
        task_id = null,
        tokens_used = 0,
        agent_id = null,
        agent_name = null,
        metadata = null,
      } = messageData;

      const result = await dbRun(
        `INSERT INTO messages (session_id, role, content, task_id, tokens_used, agent_id, agent_name, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [session_id, role, content, task_id, tokens_used, agent_id, agent_name, metadata ? JSON.stringify(metadata) : null]
      );

      logger.info(`Message created in session ${session_id} (ID: ${result.lastID})`);

      return await this.findById(result.lastID);
    } catch (error) {
      logger.error('Error creating message:', error);
      throw error;
    }
  }

  /**
   * Find message by ID
   * @param {number} id - Message ID
   * @returns {Promise<object|null>} - Message object or null
   */
  static async findById(id) {
    try {
      const message = await dbGet(
        'SELECT * FROM messages WHERE id = ?',
        [id]
      );

      return message ? this.parseMessage(message) : null;
    } catch (error) {
      logger.error('Error finding message by ID:', error);
      throw error;
    }
  }

  /**
   * Parse message metadata from JSON string
   */
  static parseMessage(message) {
    if (message && message.metadata && typeof message.metadata === 'string') {
      try {
        message.metadata = JSON.parse(message.metadata);
      } catch {
        message.metadata = null;
      }
    }
    return message;
  }

  /**
   * Find all messages for a session
   * @param {number} sessionId - Session ID
   * @param {number} limit - Maximum number of messages to return
   * @param {number} offset - Number of messages to skip
   * @returns {Promise<Array>} - Array of messages
   */
  static async findBySessionId(sessionId, limit = 50, offset = 0) {
    try {
      return await dbAll(
        `SELECT * FROM messages
         WHERE session_id = ?
         ORDER BY created_at ASC
         LIMIT ? OFFSET ?`,
        [sessionId, limit, offset]
      );
    } catch (error) {
      logger.error('Error finding messages by session ID:', error);
      throw error;
    }
  }

  /**
   * Get recent messages for a session
   * @param {number} sessionId - Session ID
   * @param {number} limit - Number of recent messages
   * @returns {Promise<Array>} - Array of recent messages
   */
  static async getRecentMessages(sessionId, limit = 50) {
    try {
      return await dbAll(
        `SELECT * FROM messages
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [sessionId, limit]
      );
    } catch (error) {
      logger.error('Error getting recent messages:', error);
      throw error;
    }
  }

  /**
   * Count messages in a session
   * @param {number} sessionId - Session ID
   * @returns {Promise<number>} - Message count
   */
  static async countBySessionId(sessionId) {
    try {
      const result = await dbGet(
        'SELECT COUNT(*) as count FROM messages WHERE session_id = ?',
        [sessionId]
      );

      return result.count;
    } catch (error) {
      logger.error('Error counting messages:', error);
      throw error;
    }
  }

  /**
   * Get messages for context window
   * @param {number} sessionId - Session ID
   * @param {number} contextLength - Maximum number of messages to include
   * @returns {Promise<Array>} - Array of messages for context
   */
  static async getContextMessages(sessionId, contextLength = 50) {
    try {
      // Get the most recent messages up to contextLength
      const messages = await dbAll(
        `SELECT * FROM messages
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [sessionId, contextLength]
      );

      // Return in chronological order (oldest first)
      return messages.reverse();
    } catch (error) {
      logger.error('Error getting context messages:', error);
      throw error;
    }
  }

  /**
   * Update message
   * @param {number} id - Message ID
   * @param {object} updates - Fields to update
   * @returns {Promise<object>} - Updated message object
   */
  static async update(id, updates) {
    try {
      const allowedFields = ['content', 'tokens_used'];
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

      values.push(id);
      const sql = `UPDATE messages SET ${updateFields.join(', ')} WHERE id = ?`;

      await dbRun(sql, values);

      logger.info(`Message updated: ${id}`);

      return await this.findById(id);
    } catch (error) {
      logger.error('Error updating message:', error);
      throw error;
    }
  }

  /**
   * Delete message
   * @param {number} id - Message ID
   */
  static async delete(id) {
    try {
      await dbRun('DELETE FROM messages WHERE id = ?', [id]);
      logger.info(`Message deleted: ${id}`);
    } catch (error) {
      logger.error('Error deleting message:', error);
      throw error;
    }
  }

  /**
   * Delete all messages in a session
   * @param {number} sessionId - Session ID
   */
  static async deleteBySessionId(sessionId) {
    try {
      const result = await dbRun(
        'DELETE FROM messages WHERE session_id = ?',
        [sessionId]
      );

      logger.info(`Deleted ${result.changes} messages from session ${sessionId}`);
    } catch (error) {
      logger.error('Error deleting messages by session ID:', error);
      throw error;
    }
  }

  /**
   * Get total token usage for a session
   * @param {number} sessionId - Session ID
   * @returns {Promise<number>} - Total tokens used
   */
  static async getTotalTokens(sessionId) {
    try {
      const result = await dbGet(
        'SELECT SUM(tokens_used) as total FROM messages WHERE session_id = ?',
        [sessionId]
      );

      return result.total || 0;
    } catch (error) {
      logger.error('Error getting total tokens:', error);
      throw error;
    }
  }

  /**
   * Get messages by task ID
   * @param {number} taskId - Task ID
   * @returns {Promise<Array>} - Array of messages
   */
  static async findByTaskId(taskId) {
    try {
      const messages = await dbAll(
        'SELECT * FROM messages WHERE task_id = ? ORDER BY created_at ASC',
        [taskId]
      );
      return messages.map(m => this.parseMessage(m));
    } catch (error) {
      logger.error('Error finding messages by task ID:', error);
      throw error;
    }
  }

  /**
   * Get messages by agent ID in a session
   */
  static async findByAgentId(sessionId, agentId) {
    try {
      const messages = await dbAll(
        'SELECT * FROM messages WHERE session_id = ? AND agent_id = ? ORDER BY created_at ASC',
        [sessionId, agentId]
      );
      return messages.map(m => this.parseMessage(m));
    } catch (error) {
      logger.error('Error finding messages by agent ID:', error);
      throw error;
    }
  }

  /**
   * Format messages for LLM API calls
   * Converts database messages to the format expected by LLM providers
   */
  static formatForLLM(messages) {
    return messages.map(m => {
      const formatted = {
        role: m.role,
        content: m.content,
      };

      // Add agent name for multi-agent context
      if (m.agent_name && m.role === 'assistant') {
        formatted.content = `[${m.agent_name}]: ${m.content}`;
      }

      return formatted;
    });
  }

  /**
   * Format messages for orchestrator with agent context
   */
  static formatForOrchestrator(messages, agents) {
    const agentMap = new Map(agents.map(a => [a.id, a]));

    return messages.map(m => {
      const formatted = {
        role: m.role,
        content: m.content,
      };

      if (m.agent_id && agentMap.has(m.agent_id)) {
        const agent = agentMap.get(m.agent_id);
        formatted.agentRole = agent.role;
        formatted.agentName = agent.name;
      }

      return formatted;
    });
  }

  /**
   * Get context messages for conversation mode (includes agent info)
   * Returns messages in chronological order with agent_id and agent_name
   * @param {number} sessionId - Session ID
   * @param {number} limit - Maximum number of messages
   * @returns {Promise<Array>} - Array of messages with agent info
   */
  static async getContextForAgents(sessionId, limit = process.env.DEFAULT_MESSAGE_LIMIT_CONTEXT_LENGTH || 10) {
    try {
      const messages = await dbAll(
        `SELECT id, session_id, role, content, agent_id, agent_name, tokens_used, created_at
         FROM messages
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
        [sessionId, limit]
      );

      // Return in chronological order (oldest first) and parse each message
      return messages.reverse().map(m => this.parseMessage(m));
    } catch (error) {
      logger.error('Error getting context for agents:', error);
      throw error;
    }
  }

  /**
   * Get context messages for a specific agent (user messages + agent's own messages only)
   * Returns messages in chronological order
   * @param {number} sessionId - Session ID
   * @param {number} agentId - Agent ID
   * @param {number} limit - Maximum number of messages
   * @returns {Promise<Array>} - Array of messages for this agent's context
   */
  static async getContextForAgent(sessionId, agentId, limit = process.env.DEFAULT_MESSAGE_LIMIT_CONTEXT_LENGTH || 10) {
    try {
      // Get all user messages (agent_id is NULL) and this agent's messages
      const messages = await dbAll(
        `SELECT id, session_id, role, content, agent_id, agent_name, tokens_used, created_at
         FROM messages
         WHERE session_id = ? AND (agent_id IS NULL OR agent_id = ?)
         ORDER BY created_at DESC
         LIMIT ?`,
        [sessionId, agentId, limit]
      );

      // Return in chronological order (oldest first) and parse each message
      return messages.reverse().map(m => this.parseMessage(m));
    } catch (error) {
      logger.error('Error getting context for agent:', error);
      throw error;
    }
  }
}

module.exports = Message;
