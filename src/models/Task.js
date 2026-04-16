/**
 * Task Model
 * Handles formal task storage and retrieval
 */

const { dbRun, dbGet, dbAll } = require('../../config/database');
const logger = require('../utils/logger');

// Task status constants
const TaskStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

// Execution mode constants
const ExecutionMode = {
  ADAPTIVE: 'adaptive',      // System decides based on task complexity
  SEQUENTIAL: 'sequential',  // Execute agents one by one
  PARALLEL: 'parallel',      // Execute agents in parallel
  SINGLE: 'single',          // Use single best-fit agent
};

class Task {
  /**
   * Create a new task
   */
  static async create(taskData) {
    try {
      const {
        session_id,
        user_id,
        task_description,
        execution_mode = ExecutionMode.ADAPTIVE,
        assigned_agents = null,
        priority = 'normal',
        metadata = null,
      } = taskData;

      const result = await dbRun(
        `INSERT INTO tasks (session_id, user_id, task_description, execution_mode, assigned_agents, priority, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          session_id,
          user_id,
          task_description,
          execution_mode,
          assigned_agents ? JSON.stringify(assigned_agents) : null,
          priority,
          metadata ? JSON.stringify(metadata) : null,
        ]
      );

      logger.info(`Task created: ${result.lastID}`);
      return await this.findById(result.lastID);
    } catch (error) {
      logger.error('Error creating task:', error);
      throw error;
    }
  }

  /**
   * Find task by ID
   */
  static async findById(id) {
    try {
      const task = await dbGet('SELECT * FROM tasks WHERE id = ?', [id]);
      return task ? this.parseTask(task) : null;
    } catch (error) {
      logger.error('Error finding task:', error);
      throw error;
    }
  }

  /**
   * Find task by ID with user validation
   */
  static async findByIdAndUser(id, userId) {
    try {
      const task = await dbGet(
        'SELECT * FROM tasks WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      return task ? this.parseTask(task) : null;
    } catch (error) {
      logger.error('Error finding task:', error);
      throw error;
    }
  }

  /**
   * Get tasks for a user
   */
  static async findByUser(userId, options = {}) {
    try {
      const {
        sessionId = null,
        status = null,
        limit = 50,
        offset = 0,
        orderBy = 'created_at',
        order = 'DESC',
      } = options;

      let sql = 'SELECT * FROM tasks WHERE user_id = ?';
      const params = [userId];

      if (sessionId) {
        sql += ' AND session_id = ?';
        params.push(sessionId);
      }

      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }

      sql += ` ORDER BY ${orderBy} ${order} LIMIT ? OFFSET ?`;
      params.push(limit, offset);

      const tasks = await dbAll(sql, params);
      return tasks.map(t => this.parseTask(t));
    } catch (error) {
      logger.error('Error finding tasks:', error);
      throw error;
    }
  }

  /**
   * Get tasks for a session
   */
  static async findBySession(sessionId, options = {}) {
    try {
      const { status = null, limit = 50, offset = 0 } = options;

      let sql = 'SELECT * FROM tasks WHERE session_id = ?';
      const params = [sessionId];

      if (status) {
        sql += ' AND status = ?';
        params.push(status);
      }

      sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
      params.push(limit, offset);

      const tasks = await dbAll(sql, params);
      return tasks.map(t => this.parseTask(t));
    } catch (error) {
      logger.error('Error finding tasks by session:', error);
      throw error;
    }
  }

  /**
   * Update task status
   */
  static async updateStatus(id, status, errorMessage = null) {
    try {
      const updates = { status };

      if (status === TaskStatus.RUNNING) {
        updates.started_at = new Date().toISOString();
      } else if (status === TaskStatus.COMPLETED || status === TaskStatus.FAILED) {
        updates.completed_at = new Date().toISOString();
      }

      if (errorMessage) {
        updates.error_message = errorMessage;
      }

      const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
      const values = [...Object.values(updates), id];

      await dbRun(`UPDATE tasks SET ${setClauses} WHERE id = ?`, values);

      logger.info(`Task ${id} status updated to ${status}`);
      return await this.findById(id);
    } catch (error) {
      logger.error('Error updating task status:', error);
      throw error;
    }
  }

  /**
   * Update task
   */
  static async update(id, updates) {
    try {
      const allowedFields = ['task_description', 'execution_mode', 'priority', 'metadata', 'assigned_agents'];
      const updateFields = [];
      const values = [];

      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
          updateFields.push(`${key} = ?`);
          if (key === 'metadata' || key === 'assigned_agents') {
            values.push(value ? JSON.stringify(value) : null);
          } else {
            values.push(value);
          }
        }
      }

      if (updateFields.length === 0) {
        return await this.findById(id);
      }

      values.push(id);
      await dbRun(
        `UPDATE tasks SET ${updateFields.join(', ')} WHERE id = ?`,
        values
      );

      return await this.findById(id);
    } catch (error) {
      logger.error('Error updating task:', error);
      throw error;
    }
  }

  /**
   * Delete task
   */
  static async delete(id) {
    try {
      await dbRun('DELETE FROM tasks WHERE id = ?', [id]);
      logger.info(`Task deleted: ${id}`);
    } catch (error) {
      logger.error('Error deleting task:', error);
      throw error;
    }
  }

  /**
   * Get pending tasks (for background processor)
   */
  static async getPending(limit = 10) {
    try {
      const tasks = await dbAll(
        `SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC LIMIT ?`,
        [TaskStatus.PENDING, limit]
      );
      return tasks.map(t => this.parseTask(t));
    } catch (error) {
      logger.error('Error getting pending tasks:', error);
      throw error;
    }
  }

  /**
   * Count tasks by status for a user
   */
  static async countByStatus(userId) {
    try {
      const results = await dbAll(
        `SELECT status, COUNT(*) as count FROM tasks WHERE user_id = ? GROUP BY status`,
        [userId]
      );

      const counts = {
        pending: 0,
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        total: 0,
      };

      for (const row of results) {
        counts[row.status] = row.count;
        counts.total += row.count;
      }

      return counts;
    } catch (error) {
      logger.error('Error counting tasks:', error);
      throw error;
    }
  }

  /**
   * Parse task JSON fields
   */
  static parseTask(task) {
    if (!task) return null;

    if (task.metadata && typeof task.metadata === 'string') {
      try {
        task.metadata = JSON.parse(task.metadata);
      } catch {
        task.metadata = null;
      }
    }

    if (task.assigned_agents && typeof task.assigned_agents === 'string') {
      try {
        task.assigned_agents = JSON.parse(task.assigned_agents);
      } catch {
        task.assigned_agents = null;
      }
    }

    return task;
  }
}

module.exports = {
  Task,
  TaskStatus,
  ExecutionMode,
};
