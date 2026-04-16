const WorkSession = require('../../models/WorkSession');
const logger = require('../../utils/logger');

class AutoSaveService {
  /**
   * Update session last accessed time
   * @param {number} sessionId - Session ID
   */
  static async touchSession(sessionId) {
    try {
      await WorkSession.updateLastAccessed(sessionId);
      logger.debug(`Session ${sessionId} last accessed time updated`);
    } catch (error) {
      logger.error('Error touching session:', error);
      // Don't throw - this is a non-critical operation
    }
  }

  /**
   * Auto-save session after user interaction
   * @param {number} sessionId - Session ID
   * @param {string} interactionType - Type of interaction (message, config_update, etc.)
   */
  static async autoSave(sessionId, interactionType = 'message') {
    try {
      await this.touchSession(sessionId);

      logger.debug(`Auto-saved session ${sessionId} after ${interactionType}`);
    } catch (error) {
      logger.error('Error auto-saving session:', error);
      // Don't throw - this is a non-critical operation
    }
  }

  /**
   * Batch update last accessed times for multiple sessions
   * @param {Array<number>} sessionIds - Array of session IDs
   */
  static async batchTouch(sessionIds) {
    try {
      await Promise.all(
        sessionIds.map(id => this.touchSession(id))
      );

      logger.debug(`Batch updated ${sessionIds.length} sessions`);
    } catch (error) {
      logger.error('Error batch touching sessions:', error);
    }
  }

  /**
   * Clean up inactive sessions (mark as inactive after X days)
   * @param {number} daysInactive - Number of days of inactivity
   */
  static async cleanupInactiveSessions(daysInactive = 90) {
    try {
      const { dbRun } = require('../../../config/database');

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysInactive);

      const result = await dbRun(
        `UPDATE work_sessions
         SET is_active = 0
         WHERE last_accessed_at < ? AND is_active = 1`,
        [cutoffDate.toISOString()]
      );

      if (result.changes > 0) {
        logger.info(`Marked ${result.changes} sessions as inactive after ${daysInactive} days of inactivity`);
      }

      return result.changes;
    } catch (error) {
      logger.error('Error cleaning up inactive sessions:', error);
      throw error;
    }
  }

  /**
   * Get sessions that need attention (inactive but not marked)
   * @param {number} daysInactive - Number of days of inactivity
   * @returns {Promise<Array>} - Array of session IDs
   */
  static async getInactiveSessions(daysInactive = 30) {
    try {
      const { dbAll } = require('../../../config/database');

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - daysInactive);

      const sessions = await dbAll(
        `SELECT id, name, user_id, last_accessed_at
         FROM work_sessions
         WHERE last_accessed_at < ? AND is_active = 1
         ORDER BY last_accessed_at ASC`,
        [cutoffDate.toISOString()]
      );

      return sessions;
    } catch (error) {
      logger.error('Error getting inactive sessions:', error);
      throw error;
    }
  }

  /**
   * Create automatic backup of session
   * @param {number} sessionId - Session ID
   * @returns {Promise<object>} - Backup metadata
   */
  static async createBackup(sessionId) {
    try {
      const SessionService = require('./SessionService');

      // Get session with full details
      const session = await WorkSession.getComplete(sessionId);

      if (!session) {
        throw new Error('Session not found');
      }

      // Export session data
      const exportData = await SessionService.exportSession(sessionId, session.user_id);

      // Store backup info (could save to file or database)
      const backupInfo = {
        session_id: sessionId,
        session_name: session.name,
        backup_date: new Date().toISOString(),
        message_count: exportData.messages.length,
        agent_count: exportData.agents.length,
        document_count: exportData.documents.length,
      };

      logger.info(`Created backup for session ${sessionId}`);

      return {
        backup_info: backupInfo,
        data: exportData,
      };
    } catch (error) {
      logger.error('Error creating backup:', error);
      throw error;
    }
  }

  /**
   * Schedule automatic cleanup (call this on server start)
   */
  static scheduleCleanup() {
    // Run cleanup daily at 2 AM
    const runCleanup = async () => {
      try {
        logger.info('Running scheduled session cleanup...');
        const inactiveCount = await this.cleanupInactiveSessions(90);
        logger.info(`Cleanup complete. ${inactiveCount} sessions marked as inactive.`);
      } catch (error) {
        logger.error('Scheduled cleanup failed:', error);
      }
    };

    // Calculate time until next 2 AM
    const now = new Date();
    const next2AM = new Date();
    next2AM.setHours(2, 0, 0, 0);

    if (next2AM <= now) {
      next2AM.setDate(next2AM.getDate() + 1);
    }

    const timeUntil2AM = next2AM - now;

    // Schedule first run
    setTimeout(() => {
      runCleanup();
      // Then run daily
      setInterval(runCleanup, 24 * 60 * 60 * 1000);
    }, timeUntil2AM);

    logger.info('Scheduled automatic session cleanup for 2 AM daily');
  }
}

// Start scheduled cleanup when module is loaded
if (process.env.NODE_ENV !== 'test') {
  AutoSaveService.scheduleCleanup();
}

module.exports = AutoSaveService;
