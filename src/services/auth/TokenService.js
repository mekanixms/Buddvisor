const jwt = require('jsonwebtoken');
const { dbRun, dbGet, dbAll } = require('../../../config/database');
const { sha256 } = require('../../utils/crypto');
const logger = require('../../utils/logger');

class TokenService {
  /**
   * Generate JWT token for user
   * @param {object} user - User object with id and username
   * @returns {string} - JWT token
   */
  static generateToken(user) {
    const payload = {
      id: user.id,
      username: user.username,
    };

    const options = {
      expiresIn: process.env.JWT_EXPIRES_IN || '24h',
    };

    return jwt.sign(payload, process.env.JWT_SECRET, options);
  }

  /**
   * Generate a limited JWT for share-link access (same user as session owner, scope limited to one session).
   * @param {object} session - Work session from WorkSession.findByShareToken
   * @returns {string} - JWT token
   */
  static generateShareToken(session) {
    const payload = {
      id: session.user_id,
      username: 'share',
      shareSessionId: session.id,
    };
    const options = { expiresIn: process.env.JWT_EXPIRES_IN || '24h' };
    return jwt.sign(payload, process.env.JWT_SECRET, options);
  }

  /**
   * Verify JWT token
   * @param {string} token - JWT token
   * @returns {object} - Decoded token payload
   */
  static verifyToken(token) {
    try {
      return jwt.verify(token, process.env.JWT_SECRET);
    } catch (error) {
      throw new Error(`Invalid token: ${error.message}`);
    }
  }

  /**
   * Store token hash in database
   * @param {number} userId - User ID
   * @param {string} token - JWT token
   */
  static async storeToken(userId, token) {
    try {
      // Hash token for storage
      const tokenHash = sha256(token);

      // Calculate expiration time
      const decoded = jwt.decode(token);
      const expiresAt = new Date(decoded.exp * 1000).toISOString();

      // Store in database
      await dbRun(
        `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
         VALUES (?, ?, ?)`,
        [userId, tokenHash, expiresAt]
      );

      logger.info(`Token stored for user ${userId}`);
    } catch (error) {
      logger.error('Error storing token:', error);
      throw error;
    }
  }

  /**
   * Check if token is valid (exists and not expired)
   * @param {string} token - JWT token
   * @returns {Promise<boolean>} - True if token is valid
   */
  static async isTokenValid(token) {
    try {
      const tokenHash = sha256(token);
      const now = new Date().toISOString();

      const session = await dbGet(
        `SELECT * FROM auth_sessions
         WHERE token_hash = ? AND expires_at > ?`,
        [tokenHash, now]
      );

      return !!session;
    } catch (error) {
      logger.error('Error checking token validity:', error);
      return false;
    }
  }

  /**
   * Invalidate token (logout)
   * @param {string} token - JWT token
   */
  static async invalidateToken(token) {
    try {
      const tokenHash = sha256(token);

      await dbRun(
        'DELETE FROM auth_sessions WHERE token_hash = ?',
        [tokenHash]
      );

      logger.info('Token invalidated');
    } catch (error) {
      logger.error('Error invalidating token:', error);
      throw error;
    }
  }

  /**
   * Invalidate all tokens for a user
   * @param {number} userId - User ID
   */
  static async invalidateAllUserTokens(userId) {
    try {
      const result = await dbRun(
        'DELETE FROM auth_sessions WHERE user_id = ?',
        [userId]
      );

      logger.info(`Invalidated ${result.changes} tokens for user ${userId}`);
    } catch (error) {
      logger.error('Error invalidating user tokens:', error);
      throw error;
    }
  }

  /**
   * Clean up expired tokens
   */
  static async cleanupExpiredTokens() {
    try {
      const now = new Date().toISOString();

      const result = await dbRun(
        'DELETE FROM auth_sessions WHERE expires_at <= ?',
        [now]
      );

      logger.info(`Cleaned up ${result.changes} expired tokens`);
    } catch (error) {
      logger.error('Error cleaning up tokens:', error);
    }
  }

  /**
   * Get all active sessions for a user
   * @param {number} userId - User ID
   * @returns {Promise<Array>} - Array of active sessions
   */
  static async getUserSessions(userId) {
    try {
      const now = new Date().toISOString();

      return await dbAll(
        `SELECT id, created_at, expires_at FROM auth_sessions
         WHERE user_id = ? AND expires_at > ?
         ORDER BY created_at DESC`,
        [userId, now]
      );
    } catch (error) {
      logger.error('Error getting user sessions:', error);
      throw error;
    }
  }
}

module.exports = TokenService;
