/**
 * TaskResult Model
 * Handles task result storage and retrieval
 */

const { dbRun, dbGet, dbAll } = require('../../config/database');
const logger = require('../utils/logger');

class TaskResult {
  /**
   * Create a new task result
   */
  static async create(resultData) {
    try {
      const {
        task_id,
        agent_id = null,
        agent_name = null,
        result_type = 'response',
        result_text,
        result_data = null,
        execution_time_ms = 0,
        tokens_used = 0,
      } = resultData;

      const result = await dbRun(
        `INSERT INTO task_results (task_id, agent_id, agent_name, result_type, result_text, result_data, execution_time_ms, tokens_used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          task_id,
          agent_id,
          agent_name,
          result_type,
          result_text,
          result_data ? JSON.stringify(result_data) : null,
          execution_time_ms,
          tokens_used,
        ]
      );

      logger.info(`Task result created for task ${task_id}`);
      return await this.findById(result.lastID);
    } catch (error) {
      logger.error('Error creating task result:', error);
      throw error;
    }
  }

  /**
   * Find result by ID
   */
  static async findById(id) {
    try {
      const result = await dbGet('SELECT * FROM task_results WHERE id = ?', [id]);
      return result ? this.parseResult(result) : null;
    } catch (error) {
      logger.error('Error finding task result:', error);
      throw error;
    }
  }

  /**
   * Get all results for a task
   */
  static async findByTask(taskId) {
    try {
      const results = await dbAll(
        'SELECT * FROM task_results WHERE task_id = ? ORDER BY created_at ASC',
        [taskId]
      );
      return results.map(r => this.parseResult(r));
    } catch (error) {
      logger.error('Error finding task results:', error);
      throw error;
    }
  }

  /**
   * Get results by agent for a task
   */
  static async findByTaskAndAgent(taskId, agentId) {
    try {
      const results = await dbAll(
        'SELECT * FROM task_results WHERE task_id = ? AND agent_id = ? ORDER BY created_at ASC',
        [taskId, agentId]
      );
      return results.map(r => this.parseResult(r));
    } catch (error) {
      logger.error('Error finding task results by agent:', error);
      throw error;
    }
  }

  /**
   * Get summary statistics for a task
   */
  static async getTaskSummary(taskId) {
    try {
      const summary = await dbGet(
        `SELECT
          COUNT(*) as result_count,
          SUM(tokens_used) as total_tokens,
          SUM(execution_time_ms) as total_time_ms,
          COUNT(DISTINCT agent_id) as agents_used
         FROM task_results WHERE task_id = ?`,
        [taskId]
      );
      return summary;
    } catch (error) {
      logger.error('Error getting task summary:', error);
      throw error;
    }
  }

  /**
   * Delete all results for a task
   */
  static async deleteByTask(taskId) {
    try {
      const result = await dbRun(
        'DELETE FROM task_results WHERE task_id = ?',
        [taskId]
      );
      logger.info(`Deleted ${result.changes} results for task ${taskId}`);
    } catch (error) {
      logger.error('Error deleting task results:', error);
      throw error;
    }
  }

  /**
   * Get combined text output for a task
   */
  static async getCombinedOutput(taskId) {
    try {
      const results = await this.findByTask(taskId);

      if (results.length === 0) {
        return null;
      }

      if (results.length === 1) {
        return {
          text: results[0].result_text,
          agentName: results[0].agent_name,
          tokensUsed: results[0].tokens_used,
        };
      }

      // Multiple results - combine them
      const combined = results.map(r => {
        const header = r.agent_name ? `## ${r.agent_name}\n\n` : '';
        return header + r.result_text;
      }).join('\n\n---\n\n');

      const totalTokens = results.reduce((sum, r) => sum + (r.tokens_used || 0), 0);

      return {
        text: combined,
        agentName: 'Multiple Agents',
        tokensUsed: totalTokens,
        resultCount: results.length,
      };
    } catch (error) {
      logger.error('Error getting combined output:', error);
      throw error;
    }
  }

  /**
   * Parse result JSON fields
   */
  static parseResult(result) {
    if (!result) return null;

    if (result.result_data && typeof result.result_data === 'string') {
      try {
        result.result_data = JSON.parse(result.result_data);
      } catch {
        result.result_data = null;
      }
    }

    return result;
  }
}

module.exports = { TaskResult };
