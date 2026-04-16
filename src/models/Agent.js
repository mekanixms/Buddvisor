const { dbRun, dbGet, dbAll } = require('../../config/database');
const logger = require('../utils/logger');

/**
 * Agent model for managing specialized agents in the global library
 */
class Agent {
  /**
   * Create a new agent
   * @param {object} agentData - Agent data
   * @returns {Promise<object>} - Created agent object
   */
  static async create(agentData) {
    try {
      const {
        user_id,
        name,
        role,
        initial_context = null,
        provider_type,
        provider_config,
        hf_model_repo = null,
        openrouter_model_id = null,
        model_capabilities = null,
      } = agentData;

      const result = await dbRun(
        `INSERT INTO agents (
          user_id, name, role, initial_context, provider_type, provider_config,
          hf_model_repo, openrouter_model_id, model_capabilities
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          user_id,
          name,
          role,
          initial_context,
          provider_type,
          provider_config,
          hf_model_repo,
          openrouter_model_id,
          model_capabilities,
        ]
      );

      logger.info(`Agent created: ${name} (ID: ${result.lastID})`);

      return await this.findById(result.lastID);
    } catch (error) {
      logger.error('Error creating agent:', error);
      throw error;
    }
  }

  /**
   * Find agent by ID
   * @param {number} id - Agent ID
   * @returns {Promise<object|null>} - Agent object or null
   */
  static async findById(id) {
    try {
      const agent = await dbGet(
        'SELECT * FROM agents WHERE id = ?',
        [id]
      );

      return agent || null;
    } catch (error) {
      logger.error('Error finding agent by ID:', error);
      throw error;
    }
  }

  /**
   * Find all agents for a user
   * @param {number} userId - User ID
   * @param {object} options - Query options
   * @returns {Promise<Array>} - Array of agents
   */
  static async findByUserId(userId, options = {}) {
    try {
      const { role, isActive = true, orderBy = 'name', order = 'ASC' } = options;

      let sql = 'SELECT * FROM agents WHERE user_id = ?';
      const params = [userId];

      if (role) {
        sql += ' AND role = ?';
        params.push(role);
      }

      if (isActive !== null) {
        sql += ' AND is_active = ?';
        params.push(isActive ? 1 : 0);
      }

      // Validate orderBy to prevent SQL injection
      const validOrderColumns = ['name', 'role', 'created_at', 'updated_at'];
      const safeOrderBy = validOrderColumns.includes(orderBy) ? orderBy : 'name';
      const safeOrder = order.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';

      sql += ` ORDER BY ${safeOrderBy} ${safeOrder}`;

      return await dbAll(sql, params);
    } catch (error) {
      logger.error('Error finding agents by user ID:', error);
      throw error;
    }
  }

  /**
   * Find agents by role
   * @param {number} userId - User ID
   * @param {string} role - Agent role
   * @returns {Promise<Array>} - Array of agents
   */
  static async findByRole(userId, role) {
    try {
      return await dbAll(
        'SELECT * FROM agents WHERE user_id = ? AND role = ? AND is_active = 1 ORDER BY name',
        [userId, role]
      );
    } catch (error) {
      logger.error('Error finding agents by role:', error);
      throw error;
    }
  }

  /**
   * Update agent
   * @param {number} id - Agent ID
   * @param {object} updates - Fields to update
   * @returns {Promise<object>} - Updated agent object
   */
  static async update(id, updates) {
    try {
      const allowedFields = [
        'name',
        'role',
        'initial_context',
        'provider_type',
        'provider_config',
        'hf_model_repo',
        'openrouter_model_id',
        'model_capabilities',
        'is_active',
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

      const sql = `UPDATE agents SET ${updateFields.join(', ')} WHERE id = ?`;

      await dbRun(sql, values);

      logger.info(`Agent updated: ${id}`);

      return await this.findById(id);
    } catch (error) {
      logger.error('Error updating agent:', error);
      throw error;
    }
  }

  /**
   * Delete agent
   * @param {number} id - Agent ID
   */
  static async delete(id) {
    try {
      await dbRun('DELETE FROM agents WHERE id = ?', [id]);
      logger.info(`Agent deleted: ${id}`);
    } catch (error) {
      logger.error('Error deleting agent:', error);
      throw error;
    }
  }

  /**
   * Soft delete agent (deactivate)
   * @param {number} id - Agent ID
   */
  static async deactivate(id) {
    try {
      await dbRun(
        'UPDATE agents SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [id]
      );
      logger.info(`Agent deactivated: ${id}`);
    } catch (error) {
      logger.error('Error deactivating agent:', error);
      throw error;
    }
  }

  /**
   * Reactivate a deactivated agent
   * @param {number} id - Agent ID
   */
  static async activate(id) {
    try {
      await dbRun(
        'UPDATE agents SET is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        [id]
      );
      logger.info(`Agent activated: ${id}`);
    } catch (error) {
      logger.error('Error activating agent:', error);
      throw error;
    }
  }

  /**
   * Get agents assigned to a session
   * @param {number} sessionId - Session ID
   * @returns {Promise<Array>} - Array of agents
   */
  static async getBySession(sessionId) {
    try {
      return await dbAll(
        `SELECT a.* FROM agents a
         INNER JOIN session_agents sa ON a.id = sa.agent_id
         WHERE sa.session_id = ? AND a.is_active = 1
         ORDER BY a.name`,
        [sessionId]
      );
    } catch (error) {
      logger.error('Error getting agents by session:', error);
      throw error;
    }
  }

  /**
   * Get count of agents for a user
   * @param {number} userId - User ID
   * @returns {Promise<number>} - Count of agents
   */
  static async countByUser(userId) {
    try {
      const result = await dbGet(
        'SELECT COUNT(*) as count FROM agents WHERE user_id = ?',
        [userId]
      );
      return result?.count || 0;
    } catch (error) {
      logger.error('Error counting agents:', error);
      throw error;
    }
  }

  /**
   * Search agents by name
   * @param {number} userId - User ID
   * @param {string} searchTerm - Search term
   * @returns {Promise<Array>} - Matching agents
   */
  static async search(userId, searchTerm) {
    try {
      return await dbAll(
        `SELECT * FROM agents
         WHERE user_id = ? AND is_active = 1
         AND (name LIKE ? OR role LIKE ?)
         ORDER BY name`,
        [userId, `%${searchTerm}%`, `%${searchTerm}%`]
      );
    } catch (error) {
      logger.error('Error searching agents:', error);
      throw error;
    }
  }

  /**
   * Get predefined agent roles
   * @returns {Array<{id: string, name: string, description: string}>}
   */
  static getPredefinedRoles() {
    return [
      {
        id: 'legal',
        name: 'Legal Advisor',
        description: 'Provides legal guidance and compliance advice',
      },
      {
        id: 'accounting',
        name: 'Accounting Expert',
        description: 'Handles financial calculations and tax computations',
      },
      {
        id: 'marketing',
        name: 'Marketing Strategist',
        description: 'Develops marketing plans and brand strategies',
      },
      {
        id: 'sales',
        name: 'Sales Consultant',
        description: 'Advises on sales strategies and customer relations',
      },
      {
        id: 'logistics',
        name: 'Logistics Coordinator',
        description: 'Manages supply chain and operational logistics',
      },
      {
        id: 'production',
        name: 'Production Manager',
        description: 'Oversees manufacturing and production processes',
      },
      {
        id: 'hr',
        name: 'HR Specialist',
        description: 'Handles human resources and employment matters',
      },
      {
        id: 'custom',
        name: 'Custom Agent',
        description: 'User-defined specialized agent',
      },
    ];
  }
}

module.exports = Agent;
