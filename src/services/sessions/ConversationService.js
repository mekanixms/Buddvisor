const Message = require('../../models/Message');
const WorkSession = require('../../models/WorkSession');
const logger = require('../../utils/logger');

class ConversationService {
  /**
   * Add a message to the conversation
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {string} role - Message role (user, assistant, system, tool)
   * @param {string} content - Message content
   * @param {number} tokensUsed - Tokens used (optional)
   * @param {number} taskId - Task ID (optional)
   * @returns {Promise<object>} - Created message
   */
  static async addMessage(sessionId, userId, role, content, tokensUsed = 0, taskId = null) {
    try {
      // Verify session belongs to user
      const session = await WorkSession.findById(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      if (session.user_id !== userId) {
        throw new Error('Unauthorized access to session');
      }

      // Create message
      const message = await Message.create({
        session_id: sessionId,
        role,
        content,
        task_id: taskId,
        tokens_used: tokensUsed,
      });

      // Update session last accessed time
      await WorkSession.updateLastAccessed(sessionId);

      logger.info(`Message added to session ${sessionId}`);

      return message;
    } catch (error) {
      logger.error('Error adding message:', error);
      throw error;
    }
  }

  /**
   * Get messages for a session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {number} limit - Maximum number of messages
   * @param {number} offset - Offset for pagination
   * @returns {Promise<Array>} - Array of messages
   */
  static async getMessages(sessionId, userId, limit = 50, offset = 0) {
    try {
      // Verify session belongs to user
      const session = await WorkSession.findById(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      if (session.user_id !== userId) {
        throw new Error('Unauthorized access to session');
      }

      const messages = await Message.findBySessionId(sessionId, limit, offset);
      return messages;
    } catch (error) {
      logger.error('Error getting messages:', error);
      throw error;
    }
  }

  /**
   * Get recent messages for a session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {number} limit - Number of recent messages
   * @returns {Promise<Array>} - Array of recent messages
   */
  static async getRecentMessages(sessionId, userId, limit = 50) {
    try {
      // Verify session belongs to user
      const session = await WorkSession.findById(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      if (session.user_id !== userId) {
        throw new Error('Unauthorized access to session');
      }

      let messages = await Message.getRecentMessages(sessionId, limit);

      // Reverse to get chronological order (oldest first)
      return messages.reverse();
    } catch (error) {
      logger.error('Error getting recent messages:', error);
      throw error;
    }
  }

  /**
   * Count messages in a session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @returns {Promise<number>} - Message count
   */
  static async countMessages(sessionId, userId) {
    try {
      // Verify session belongs to user
      const session = await WorkSession.findById(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      if (session.user_id !== userId) {
        throw new Error('Unauthorized access to session');
      }

      return await Message.countBySessionId(sessionId);
    } catch (error) {
      logger.error('Error counting messages:', error);
      throw error;
    }
  }

  /**
   * Delete a specific message
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {number} messageId - Message ID
   */
  static async deleteMessage(sessionId, userId, messageId) {
    try {
      // Verify session belongs to user
      const session = await WorkSession.findById(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      if (session.user_id !== userId) {
        throw new Error('Unauthorized access to session');
      }

      // Verify message belongs to session
      const message = await Message.findById(messageId);
      if (!message || message.session_id !== sessionId) {
        throw new Error('Message not found in this session');
      }

      await Message.delete(messageId);

      logger.info(`Message ${messageId} deleted from session ${sessionId}`);
    } catch (error) {
      logger.error('Error deleting message:', error);
      throw error;
    }
  }

  /**
   * Clear conversation history (delete all messages)
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   */
  static async clearHistory(sessionId, userId) {
    try {
      // Verify session belongs to user
      const session = await WorkSession.findById(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      if (session.user_id !== userId) {
        throw new Error('Unauthorized access to session');
      }

      await Message.deleteBySessionId(sessionId);

      logger.info(`Conversation history cleared for session ${sessionId}`);
    } catch (error) {
      logger.error('Error clearing history:', error);
      throw error;
    }
  }

  /**
   * Get total token usage for a session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @returns {Promise<number>} - Total tokens used
   */
  static async getTotalTokenUsage(sessionId, userId) {
    try {
      // Verify session belongs to user
      const session = await WorkSession.findById(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      if (session.user_id !== userId) {
        throw new Error('Unauthorized access to session');
      }

      return await Message.getTotalTokens(sessionId);
    } catch (error) {
      logger.error('Error getting total token usage:', error);
      throw error;
    }
  }

  /**
   * Get conversation statistics
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @returns {Promise<object>} - Statistics object
   */
  static async getStatistics(sessionId, userId) {
    try {
      // Verify session belongs to user
      const session = await WorkSession.findById(sessionId);
      if (!session) {
        throw new Error('Session not found');
      }

      if (session.user_id !== userId) {
        throw new Error('Unauthorized access to session');
      }

      const [messageCount, totalTokens] = await Promise.all([
        Message.countBySessionId(sessionId),
        Message.getTotalTokens(sessionId),
      ]);

      return {
        message_count: messageCount,
        total_tokens: totalTokens,
        session_created: session.created_at,
        last_accessed: session.last_accessed_at,
      };
    } catch (error) {
      logger.error('Error getting statistics:', error);
      throw error;
    }
  }

  /**
   * Format messages for LLM API
   * @param {Array} messages - Array of message objects
   * @returns {Array} - Formatted messages for LLM
   */
  static formatMessagesForLLM(messages) {
    return messages.map(msg => ({
      role: msg.role,
      content: msg.content,
    }));
  }

  /**
   * Add user and assistant message pair
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {string} userMessage - User message content
   * @param {string} assistantMessage - Assistant message content
   * @param {number} userTokens - Tokens used by user message
   * @param {number} assistantTokens - Tokens used by assistant message
   * @returns {Promise<object>} - Both messages
   */
  static async addMessagePair(
    sessionId,
    userId,
    userMessage,
    assistantMessage,
    userTokens = 0,
    assistantTokens = 0
  ) {
    try {
      const [user, assistant] = await Promise.all([
        this.addMessage(sessionId, userId, 'user', userMessage, userTokens),
        this.addMessage(sessionId, userId, 'assistant', assistantMessage, assistantTokens),
      ]);

      return { user, assistant };
    } catch (error) {
      logger.error('Error adding message pair:', error);
      throw error;
    }
  }
}

module.exports = ConversationService;
