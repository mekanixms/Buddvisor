/**
 * SessionScheduledJob Model
 * Active-record style model for session_scheduled_jobs (cron / scheduled tasks)
 */

const { dbRun, dbGet, dbAll } = require('../../config/database');
const logger = require('../utils/logger');

class SessionScheduledJob {
  /**
   * Parse JSON columns and ensure consistent types
   */
  static parseJob(row) {
    if (!row) return null;
    if (row.target_agent_ids != null && typeof row.target_agent_ids === 'string') {
      try {
        row.target_agent_ids = JSON.parse(row.target_agent_ids);
      } catch {
        row.target_agent_ids = null;
      }
    }
    if (row.script_args != null && typeof row.script_args === 'string') {
      try {
        row.script_args = JSON.parse(row.script_args);
      } catch {
        row.script_args = null;
      }
    }
    if (row.last_run_result != null && typeof row.last_run_result === 'string') {
      try {
        row.last_run_result = JSON.parse(row.last_run_result);
      } catch {
        row.last_run_result = row.last_run_result;
      }
    }
    return row;
  }

  /**
   * Create a new scheduled job
   */
  static async create(data) {
    const {
      session_id,
      created_by_agent_id = null,
      task_key = null,
      schedule_type,
      schedule_value,
      task_type,
      prompt_text = null,
      script_path = null,
      script_args = null,
      target_agent_ids = null,
      enabled = 1,
      next_run_at,
      last_run_at = null,
      last_run_result = null,
    } = data;

    const result = await dbRun(
      `INSERT INTO session_scheduled_jobs (
        session_id, created_by_agent_id, task_key, schedule_type, schedule_value,
        task_type, prompt_text, script_path, script_args, target_agent_ids,
        enabled, next_run_at, last_run_at, last_run_result, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        session_id,
        created_by_agent_id,
        task_key,
        schedule_type,
        schedule_value,
        task_type,
        prompt_text,
        script_path,
        script_args ? JSON.stringify(script_args) : null,
        target_agent_ids ? JSON.stringify(target_agent_ids) : null,
        enabled ? 1 : 0,
        next_run_at,
        last_run_at,
        last_run_result ? (typeof last_run_result === 'string' ? last_run_result : JSON.stringify(last_run_result)) : null,
      ]
    );

    logger.info(`SessionScheduledJob created: ${result.lastID} (session ${session_id})`);
    return await this.findById(result.lastID);
  }

  /**
   * Find by ID
   */
  static async findById(id) {
    const row = await dbGet('SELECT * FROM session_scheduled_jobs WHERE id = ?', [id]);
    return this.parseJob(row);
  }

  /**
   * Find by session ID (all jobs for a session)
   */
  static async findBySessionId(sessionId, enabledOnly = false) {
    const sql = enabledOnly
      ? 'SELECT * FROM session_scheduled_jobs WHERE session_id = ? AND enabled = 1 ORDER BY next_run_at ASC'
      : 'SELECT * FROM session_scheduled_jobs WHERE session_id = ? ORDER BY next_run_at ASC';
    const rows = await dbAll(sql, [sessionId]);
    return rows.map((r) => this.parseJob(r));
  }

  /**
   * Find by session_id and task_key
   */
  static async findBySessionAndTaskKey(sessionId, taskKey) {
    if (taskKey == null || taskKey === '') return null;
    const row = await dbGet(
      'SELECT * FROM session_scheduled_jobs WHERE session_id = ? AND task_key = ?',
      [sessionId, taskKey]
    );
    return this.parseJob(row);
  }

  /**
   * Find all scheduled jobs for a user, optionally limited to one session (e.g. share mode).
   * Returns jobs with session_name, ordered by session name then next_run_at.
   * @param {number} userId - work_sessions.user_id
   * @param {number|null} limitToSessionId - if set, only return jobs for this session
   */
  static async findAllForUser(userId, limitToSessionId = null) {
    const sql = limitToSessionId != null
      ? `SELECT j.*, w.name AS session_name, a.name AS created_by_agent_name
         FROM session_scheduled_jobs j
         JOIN work_sessions w ON w.id = j.session_id
         LEFT JOIN agents a ON a.id = j.created_by_agent_id
         WHERE w.user_id = ? AND j.session_id = ?
         ORDER BY w.name ASC, j.next_run_at ASC`
      : `SELECT j.*, w.name AS session_name, a.name AS created_by_agent_name
         FROM session_scheduled_jobs j
         JOIN work_sessions w ON w.id = j.session_id
         LEFT JOIN agents a ON a.id = j.created_by_agent_id
         WHERE w.user_id = ?
         ORDER BY w.name ASC, j.next_run_at ASC`;
    const params = limitToSessionId != null ? [userId, limitToSessionId] : [userId];
    const rows = await dbAll(sql, params);
    return rows.map((r) => this.parseJob(r));
  }

  /**
   * Find due jobs (enabled and next_run_at <= now)
   */
  static async findDue(limit = 50, nowIso = null) {
    const now = nowIso || new Date().toISOString();
    const rows = await dbAll(
      `SELECT * FROM session_scheduled_jobs
       WHERE enabled = 1 AND next_run_at <= ?
       ORDER BY next_run_at ASC
       LIMIT ?`,
      [now, limit]
    );
    return rows.map((r) => this.parseJob(r));
  }

  /**
   * Update job
   */
  static async update(id, updates) {
    const allowed = [
      'task_key', 'schedule_type', 'schedule_value', 'task_type',
      'prompt_text', 'script_path', 'script_args', 'target_agent_ids',
      'enabled', 'next_run_at', 'last_run_at', 'last_run_result',
    ];
    const setParts = [];
    const values = [];

    for (const [key, value] of Object.entries(updates)) {
      if (!allowed.includes(key)) continue;
      if (key === 'target_agent_ids' || key === 'script_args') {
        values.push(value != null ? JSON.stringify(value) : null);
      } else if (key === 'last_run_result' && value != null && typeof value !== 'string') {
        values.push(JSON.stringify(value));
      } else if (key === 'enabled') {
        values.push(value ? 1 : 0);
      } else {
        values.push(value);
      }
      setParts.push(`${key} = ?`);
    }

    if (setParts.length === 0) return await this.findById(id);

    setParts.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);

    await dbRun(
      `UPDATE session_scheduled_jobs SET ${setParts.join(', ')} WHERE id = ?`,
      values
    );

    logger.info(`SessionScheduledJob updated: ${id}`);
    return await this.findById(id);
  }

  /**
   * Delete job
   */
  static async delete(id) {
    await dbRun('DELETE FROM session_scheduled_jobs WHERE id = ?', [id]);
    logger.info(`SessionScheduledJob deleted: ${id}`);
  }
}

module.exports = SessionScheduledJob;
