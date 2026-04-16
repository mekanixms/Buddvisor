const { dbRun, dbGet, dbAll } = require('../../config/database');
const { hashPassword, comparePasswords } = require('../utils/crypto');
const logger = require('../utils/logger');

class User {
  /**
   * Create a new user
   * @param {object} userData - User data (username, password)
   * @returns {Promise<object>} - Created user object
   */
  static async create(userData) {
    try {
      const { username, password } = userData;

      // Check if user already exists
      const existingUser = await this.findByUsername(username);
      if (existingUser) {
        throw new Error('Username already exists');
      }

      // Hash password
      const passwordHash = await hashPassword(password);

      // Insert user (inactive by default, requires superuser activation)
      const result = await dbRun(
        `INSERT INTO users (username, password_hash, is_active)
         VALUES (?, ?, 0)`,
        [username, passwordHash]
      );

      logger.info(`User created: ${username} (ID: ${result.lastID})`);

      // Return user without password
      return {
        id: result.lastID,
        username,
        created_at: new Date().toISOString(),
      };
    } catch (error) {
      logger.error('Error creating user:', error);
      throw error;
    }
  }

  /**
   * Find user by ID
   * @param {number} id - User ID
   * @returns {Promise<object|null>} - User object or null
   */
  static async findById(id) {
    try {
      const user = await dbGet(
        'SELECT id, username, is_active, created_at, updated_at FROM users WHERE id = ?',
        [id]
      );

      return user || null;
    } catch (error) {
      logger.error('Error finding user by ID:', error);
      throw error;
    }
  }

  /**
   * Find user by username
   * @param {string} username - Username
   * @returns {Promise<object|null>} - User object or null
   */
  static async findByUsername(username) {
    try {
      const user = await dbGet(
        'SELECT id, username, is_active, created_at, updated_at FROM users WHERE username = ?',
        [username]
      );

      return user || null;
    } catch (error) {
      logger.error('Error finding user by username:', error);
      throw error;
    }
  }

  /**
   * Find user by username with password (for authentication)
   * @param {string} username - Username
   * @returns {Promise<object|null>} - User object with password_hash or null
   */
  static async findByUsernameWithPassword(username) {
    try {
      const user = await dbGet(
        'SELECT id, username, password_hash, is_active, created_at, updated_at FROM users WHERE username = ?',
        [username]
      );

      return user || null;
    } catch (error) {
      logger.error('Error finding user with password:', error);
      throw error;
    }
  }

  /**
   * Verify user password
   * @param {string} username - Username
   * @param {string} password - Plain text password
   * @returns {Promise<object|null>} - User object if valid, null otherwise
   */
  static async verifyPassword(username, password) {
    try {
      const user = await this.findByUsernameWithPassword(username);

      if (!user) {
        return null;
      }

      const isValid = await comparePasswords(password, user.password_hash);

      if (!isValid) {
        return null;
      }

      // Return user without password
      const { password_hash, ...userWithoutPassword } = user;
      return userWithoutPassword;
    } catch (error) {
      logger.error('Error verifying password:', error);
      throw error;
    }
  }

  /**
   * Update user
   * @param {number} id - User ID
   * @param {object} updates - Fields to update
   * @returns {Promise<object>} - Updated user object
   */
  static async update(id, updates) {
    try {
      const allowedFields = ['username', 'password', 'is_active'];
      const updateFields = [];
      const values = [];

      for (const [key, value] of Object.entries(updates)) {
        if (allowedFields.includes(key)) {
          if (key === 'password') {
            updateFields.push('password_hash = ?');
            values.push(await hashPassword(value));
          } else {
            updateFields.push(`${key} = ?`);
            values.push(value);
          }
        }
      }

      if (updateFields.length === 0) {
        throw new Error('No valid fields to update');
      }

      // Add updated_at
      updateFields.push('updated_at = CURRENT_TIMESTAMP');
      values.push(id);

      const sql = `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`;

      await dbRun(sql, values);

      logger.info(`User updated: ${id}`);

      return await this.findById(id);
    } catch (error) {
      logger.error('Error updating user:', error);
      throw error;
    }
  }

  /**
   * Delete user
   * @param {number} id - User ID
   */
  static async delete(id) {
    try {
      await dbRun('DELETE FROM users WHERE id = ?', [id]);
      logger.info(`User deleted: ${id}`);
    } catch (error) {
      logger.error('Error deleting user:', error);
      throw error;
    }
  }

  /**
   * Get all users (admin function)
   * @returns {Promise<Array>} - Array of users
   */
  static async findAll() {
    try {
      return await dbAll(
        'SELECT id, username, is_active, created_at, updated_at FROM users ORDER BY created_at DESC'
      );
    } catch (error) {
      logger.error('Error finding all users:', error);
      throw error;
    }
  }
}

module.exports = User;
