const { dbRun, dbGet, dbAll } = require('../../config/database');
const logger = require('../utils/logger');

/**
 * ConversationRound Model
 * Tracks individual rounds in conversation mode brainstorming sessions
 */
class ConversationRound {
  /**
   * Create a new conversation round
   * @param {object} data - Round data
   * @returns {Promise<object>} - Created round object
   */
  static async create(data) {
    try {
      const {
        session_id,
        round_number,
        status = 'pending',
        speaker_agent_id = null,
        speaker_agent_name = null,
      } = data;

      const result = await dbRun(
        `INSERT INTO conversation_rounds
         (session_id, round_number, status, speaker_agent_id, speaker_agent_name, started_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [session_id, round_number, status, speaker_agent_id, speaker_agent_name]
      );

      logger.debug(`Conversation round ${round_number} created for session ${session_id}`);

      return await this.findById(result.lastID);
    } catch (error) {
      logger.error('Error creating conversation round:', error);
      throw error;
    }
  }

  /**
   * Find round by ID
   * @param {number} id - Round ID
   * @returns {Promise<object|null>} - Round object or null
   */
  static async findById(id) {
    try {
      return await dbGet(
        'SELECT * FROM conversation_rounds WHERE id = ?',
        [id]
      );
    } catch (error) {
      logger.error('Error finding conversation round by ID:', error);
      throw error;
    }
  }

  /**
   * Update round status
   * @param {number} id - Round ID
   * @param {string} status - New status
   * @param {object} additionalData - Additional fields to update
   * @returns {Promise<object>} - Updated round
   */
  static async updateStatus(id, status, additionalData = {}) {
    try {
      const {
        speaker_agent_id,
        speaker_agent_name,
        tokens_used,
      } = additionalData;

      let sql = 'UPDATE conversation_rounds SET status = ?';
      const params = [status];

      if (status === 'completed') {
        sql += ', completed_at = CURRENT_TIMESTAMP';
      }

      if (speaker_agent_id !== undefined) {
        sql += ', speaker_agent_id = ?';
        params.push(speaker_agent_id);
      }

      if (speaker_agent_name !== undefined) {
        sql += ', speaker_agent_name = ?';
        params.push(speaker_agent_name);
      }

      if (tokens_used !== undefined) {
        sql += ', tokens_used = ?';
        params.push(tokens_used);
      }

      sql += ' WHERE id = ?';
      params.push(id);

      await dbRun(sql, params);

      return await this.findById(id);
    } catch (error) {
      logger.error('Error updating conversation round status:', error);
      throw error;
    }
  }

  /**
   * Get current (most recent) round for a session
   * @param {number} sessionId - Session ID
   * @returns {Promise<object|null>} - Current round or null
   */
  static async getCurrentRound(sessionId) {
    try {
      return await dbGet(
        `SELECT * FROM conversation_rounds
         WHERE session_id = ?
         ORDER BY round_number DESC
         LIMIT 1`,
        [sessionId]
      );
    } catch (error) {
      logger.error('Error getting current conversation round:', error);
      throw error;
    }
  }

  /**
   * Get all rounds for a session
   * @param {number} sessionId - Session ID
   * @returns {Promise<Array>} - Array of rounds
   */
  static async getBySession(sessionId) {
    try {
      return await dbAll(
        `SELECT * FROM conversation_rounds
         WHERE session_id = ?
         ORDER BY round_number ASC`,
        [sessionId]
      );
    } catch (error) {
      logger.error('Error getting conversation rounds by session:', error);
      throw error;
    }
  }

  /**
   * Count completed rounds for a session
   * @param {number} sessionId - Session ID
   * @returns {Promise<number>} - Number of completed rounds
   */
  static async countBySession(sessionId) {
    try {
      const result = await dbGet(
        `SELECT COUNT(*) as count FROM conversation_rounds
         WHERE session_id = ? AND status = 'completed'`,
        [sessionId]
      );

      return result.count;
    } catch (error) {
      logger.error('Error counting conversation rounds:', error);
      throw error;
    }
  }

  /**
   * Get total tokens used in a session's conversation rounds
   * @param {number} sessionId - Session ID
   * @returns {Promise<number>} - Total tokens used
   */
  static async getTotalTokens(sessionId) {
    try {
      const result = await dbGet(
        `SELECT SUM(tokens_used) as total FROM conversation_rounds
         WHERE session_id = ?`,
        [sessionId]
      );

      return result.total || 0;
    } catch (error) {
      logger.error('Error getting total tokens for conversation:', error);
      throw error;
    }
  }

  /**
   * Delete all rounds for a session
   * @param {number} sessionId - Session ID
   */
  static async deleteBySession(sessionId) {
    try {
      await dbRun(
        'DELETE FROM conversation_rounds WHERE session_id = ?',
        [sessionId]
      );

      logger.info(`Deleted conversation rounds for session ${sessionId}`);
    } catch (error) {
      logger.error('Error deleting conversation rounds:', error);
      throw error;
    }
  }

  /**
   * Get rounds by status
   * @param {number} sessionId - Session ID
   * @param {string} status - Status to filter by
   * @returns {Promise<Array>} - Array of rounds
   */
  static async getByStatus(sessionId, status) {
    try {
      return await dbAll(
        `SELECT * FROM conversation_rounds
         WHERE session_id = ? AND status = ?
         ORDER BY round_number ASC`,
        [sessionId, status]
      );
    } catch (error) {
      logger.error('Error getting conversation rounds by status:', error);
      throw error;
    }
  }
}

module.exports = ConversationRound;
