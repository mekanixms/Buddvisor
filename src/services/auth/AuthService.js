const User = require('../../models/User');
const TokenService = require('./TokenService');
const logger = require('../../utils/logger');
const { isSuperuser } = require('../../utils/superuser');

class AuthService {
  /**
   * Register a new user
   * @param {object} userData - User data (username, password)
   * @returns {Promise<object>} - User and token
   */
  static async register(userData) {
    try {
      const { username, password } = userData;

      // Validate input
      if (!username || !password) {
        throw new Error('Username and password are required');
      }

      if (username.length < 3) {
        throw new Error('Username must be at least 3 characters');
      }

      if (password.length < 6) {
        throw new Error('Password must be at least 6 characters');
      }

      // Create user (inactive by default)
      const user = await User.create({ username, password });

      logger.info(`User registered successfully: ${username} (awaiting activation)`);

      // Don't generate token for inactive users
      // Return user without token - they need to wait for activation
      return {
        user,
        token: null,
        message: 'Registration successful. Your account is pending activation by an administrator.',
      };
    } catch (error) {
      logger.error('Registration error:', error);
      throw error;
    }
  }

  /**
   * Login user
   * @param {object} credentials - Login credentials (username, password)
   * @returns {Promise<object>} - User and token
   */
  static async login(credentials) {
    try {
      const { username, password } = credentials;

      // Validate input
      if (!username || !password) {
        throw new Error('Username and password are required');
      }

      // Verify password
      const user = await User.verifyPassword(username, password);

      if (!user) {
        throw new Error('Invalid username or password');
      }

      // Check if account is active
      if (!user.is_active) {
        throw new Error('Account is not activated. Please contact an administrator.');
      }

      // Generate token
      const token = TokenService.generateToken(user);

      // Store token
      await TokenService.storeToken(user.id, token);

      logger.info(`User logged in: ${username}`);

      return {
        user,
        token,
      };
    } catch (error) {
      logger.error('Login error:', error);
      throw error;
    }
  }

  /**
   * Logout user
   * @param {string} token - JWT token
   */
  static async logout(token) {
    try {
      await TokenService.invalidateToken(token);
      logger.info('User logged out');
    } catch (error) {
      logger.error('Logout error:', error);
      throw error;
    }
  }

  /**
   * Get current user from token
   * @param {string} token - JWT token
   * @returns {Promise<object>} - User object with isSuperuser flag
   */
  static async getCurrentUser(token) {
    try {
      // Verify token
      const decoded = TokenService.verifyToken(token);

      // Share-link JWT: not stored in auth_sessions; return minimal user
      if (decoded.username === 'share' && decoded.shareSessionId != null) {
        return {
          id: decoded.id,
          username: 'share',
          isSuperuser: false,
          isShareMode: true,
          shareSessionId: decoded.shareSessionId,
        };
      }

      // Check if token is valid in database
      const isValid = await TokenService.isTokenValid(token);

      if (!isValid) {
        throw new Error('Token is no longer valid');
      }

      // Get user
      const user = await User.findById(decoded.id);

      if (!user) {
        throw new Error('User not found');
      }

      // Add superuser flag
      return {
        ...user,
        isSuperuser: isSuperuser(user.username),
      };
    } catch (error) {
      logger.error('Get current user error:', error);
      throw error;
    }
  }

  /**
   * Change user password
   * @param {number} userId - User ID
   * @param {string} oldPassword - Current password
   * @param {string} newPassword - New password
   */
  static async changePassword(userId, oldPassword, newPassword) {
    try {
      // Get user
      const user = await User.findById(userId);

      if (!user) {
        throw new Error('User not found');
      }

      // Verify old password
      const verified = await User.verifyPassword(user.username, oldPassword);

      if (!verified) {
        throw new Error('Current password is incorrect');
      }

      // Validate new password
      if (newPassword.length < 6) {
        throw new Error('New password must be at least 6 characters');
      }

      // Update password
      await User.update(userId, { password: newPassword });

      // Invalidate all existing tokens
      await TokenService.invalidateAllUserTokens(userId);

      logger.info(`Password changed for user ${userId}`);
    } catch (error) {
      logger.error('Change password error:', error);
      throw error;
    }
  }

  /**
   * Get user sessions
   * @param {number} userId - User ID
   * @returns {Promise<Array>} - Array of active sessions
   */
  static async getUserSessions(userId) {
    try {
      return await TokenService.getUserSessions(userId);
    } catch (error) {
      logger.error('Get user sessions error:', error);
      throw error;
    }
  }

  /**
   * Clean up expired tokens (run periodically)
   */
  static async cleanupExpiredTokens() {
    try {
      await TokenService.cleanupExpiredTokens();
    } catch (error) {
      logger.error('Cleanup error:', error);
    }
  }

  /**
   * Get all users (superuser only)
   * @returns {Promise<Array>} - Array of all users
   */
  static async getAllUsers() {
    try {
      const users = await User.findAll();
      return users.map(user => ({
        ...user,
        isSuperuser: isSuperuser(user.username),
      }));
    } catch (error) {
      logger.error('Get all users error:', error);
      throw error;
    }
  }

  /**
   * Delete a user (superuser only)
   * @param {number} userId - User ID to delete
   * @param {string} requestingUsername - Username of the user making the request
   */
  static async deleteUser(userId, requestingUsername) {
    try {
      // Check if requesting user is superuser
      if (!isSuperuser(requestingUsername)) {
        throw new Error('Superuser access required');
      }

      // Get user to delete
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Prevent deleting self
      if (user.username === requestingUsername) {
        throw new Error('Cannot delete your own account');
      }

      // Delete user
      await User.delete(userId);

      // Invalidate all tokens for deleted user
      await TokenService.invalidateAllUserTokens(userId);

      logger.info(`User deleted by ${requestingUsername}: ${userId}`);
    } catch (error) {
      logger.error('Delete user error:', error);
      throw error;
    }
  }

  /**
   * Reset a user's password (superuser only)
   * @param {number} userId - User ID
   * @param {string} newPassword - New password
   * @param {string} requestingUsername - Username of the user making the request
   */
  static async resetUserPassword(userId, newPassword, requestingUsername) {
    try {
      // Check if requesting user is superuser
      if (!isSuperuser(requestingUsername)) {
        throw new Error('Superuser access required');
      }

      // Get user
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Validate new password
      if (newPassword.length < 6) {
        throw new Error('New password must be at least 6 characters');
      }

      // Update password
      await User.update(userId, { password: newPassword });

      // Invalidate all existing tokens for the user
      await TokenService.invalidateAllUserTokens(userId);

      logger.info(`Password reset for user ${userId} by ${requestingUsername}`);
    } catch (error) {
      logger.error('Reset user password error:', error);
      throw error;
    }
  }

  /**
   * Activate or deactivate a user (superuser only)
   * @param {number} userId - User ID
   * @param {boolean} isActive - Active status
   * @param {string} requestingUsername - Username of the user making the request
   */
  static async setUserActiveStatus(userId, isActive, requestingUsername) {
    try {
      // Check if requesting user is superuser
      if (!isSuperuser(requestingUsername)) {
        throw new Error('Superuser access required');
      }

      // Get user
      const user = await User.findById(userId);
      if (!user) {
        throw new Error('User not found');
      }

      // Prevent deactivating self
      if (user.username === requestingUsername && !isActive) {
        throw new Error('Cannot deactivate your own account');
      }

      // Update active status
      await User.update(userId, { is_active: isActive ? 1 : 0 });

      // If deactivating, invalidate all tokens
      if (!isActive) {
        await TokenService.invalidateAllUserTokens(userId);
      }

      logger.info(`User ${userId} ${isActive ? 'activated' : 'deactivated'} by ${requestingUsername}`);
    } catch (error) {
      logger.error('Set user active status error:', error);
      throw error;
    }
  }
}

// Schedule token cleanup every hour
setInterval(() => {
  AuthService.cleanupExpiredTokens();
}, 60 * 60 * 1000);

module.exports = AuthService;
