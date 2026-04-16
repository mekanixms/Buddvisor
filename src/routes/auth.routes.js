const express = require('express');
const router = express.Router();
const { body } = require('express-validator');
const validate = require('../middleware/validation');
const { authenticate, requireSuperuser } = require('../middleware/auth');
const AuthService = require('../services/auth/AuthService');
const TokenService = require('../services/auth/TokenService');
const WorkSession = require('../models/WorkSession');
const SessionService = require('../services/sessions/SessionService');
const { AppError } = require('../middleware/errorHandler');

/**
 * POST /api/auth/register
 * Register a new user
 */
router.post('/register', [
  body('username')
    .trim()
    .isLength({ min: 3 })
    .withMessage('Username must be at least 3 characters')
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage('Username can only contain letters, numbers, and underscores'),
  body('password')
    .isLength({ min: 6 })
    .withMessage('Password must be at least 6 characters'),
  validate
], async (req, res, next) => {
  try {
    const { username, password } = req.body;

    const result = await AuthService.register({ username, password });

    res.status(201).json({
      success: true,
      message: result.message || 'User registered successfully. Your account is pending activation by an administrator.',
      data: {
        user: result.user,
        token: result.token, // Will be null for inactive accounts
      },
    });
  } catch (error) {
    if (error.message === 'Username already exists') {
      return next(new AppError(error.message, 400, 'USERNAME_EXISTS'));
    }
    next(error);
  }
});

/**
 * POST /api/auth/login
 * Login user
 */
router.post('/login', [
  body('username')
    .trim()
    .notEmpty()
    .withMessage('Username is required'),
  body('password')
    .notEmpty()
    .withMessage('Password is required'),
  validate
], async (req, res, next) => {
  try {
    const { username, password } = req.body;

    const result = await AuthService.login({ username, password });

    res.json({
      success: true,
      message: 'Login successful',
      data: {
        user: result.user,
        token: result.token,
      },
    });
  } catch (error) {
    if (error.message === 'Invalid username or password') {
      return next(new AppError(error.message, 401, 'INVALID_CREDENTIALS'));
    }
    if (error.message.includes('not activated')) {
      return next(new AppError(error.message, 403, 'ACCOUNT_NOT_ACTIVATED'));
    }
    next(error);
  }
});

/**
 * POST /api/auth/share-exchange
 * Exchange a session share token for a limited JWT (no auth required).
 * The JWT grants access only to that session; use existing API with this token.
 */
router.post('/share-exchange', [
  body('token').trim().notEmpty().withMessage('Share token is required'),
  validate
], async (req, res, next) => {
  try {
    const session = await WorkSession.findByShareToken(req.body.token.trim());
    if (!session) {
      return next(new AppError('Invalid or expired share link', 401, 'INVALID_SHARE_TOKEN'));
    }
    const jwtToken = TokenService.generateShareToken(session);
    const fullSession = await SessionService.getCompleteSession(session.id, session.user_id);
    res.json({
      success: true,
      data: {
        token: jwtToken,
        shareSessionId: session.id,
        session: fullSession,
        isShareMode: true,
      },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/auth/logout
 * Logout user (requires authentication)
 */
router.post('/logout', authenticate, async (req, res, next) => {
  try {
    // Get token from header
    const token = req.headers.authorization.split(' ')[1];

    await AuthService.logout(token);

    res.json({
      success: true,
      message: 'Logout successful',
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/auth/me
 * Get current user (requires authentication)
 */
router.get('/me', authenticate, async (req, res, next) => {
  try {
    // Get token from header
    const token = req.headers.authorization.split(' ')[1];

    const user = await AuthService.getCurrentUser(token);

    res.json({
      success: true,
      data: { user },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/auth/password
 * Change password (requires authentication)
 */
router.put('/password', [
  authenticate,
  body('oldPassword')
    .notEmpty()
    .withMessage('Current password is required'),
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters'),
  validate
], async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body;

    await AuthService.changePassword(req.userId, oldPassword, newPassword);

    res.json({
      success: true,
      message: 'Password changed successfully. Please log in again.',
    });
  } catch (error) {
    if (error.message === 'Current password is incorrect') {
      return next(new AppError(error.message, 400, 'INCORRECT_PASSWORD'));
    }
    next(error);
  }
});

/**
 * GET /api/auth/sessions
 * Get active sessions for current user (requires authentication)
 */
router.get('/sessions', authenticate, async (req, res, next) => {
  try {
    const sessions = await AuthService.getUserSessions(req.userId);

    res.json({
      success: true,
      data: { sessions },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/auth/users
 * Get all users (superuser only)
 */
router.get('/users', authenticate, requireSuperuser, async (req, res, next) => {
  try {
    const users = await AuthService.getAllUsers();

    res.json({
      success: true,
      data: { users },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/auth/users/:id
 * Delete a user (superuser only)
 */
router.delete('/users/:id', authenticate, requireSuperuser, async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);

    if (isNaN(userId)) {
      return next(new AppError('Invalid user ID', 400, 'INVALID_USER_ID'));
    }

    await AuthService.deleteUser(userId, req.user.username);

    res.json({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (error) {
    if (error.message === 'User not found') {
      return next(new AppError(error.message, 404, 'USER_NOT_FOUND'));
    }
    if (error.message === 'Cannot delete your own account') {
      return next(new AppError(error.message, 400, 'CANNOT_DELETE_SELF'));
    }
    next(error);
  }
});

/**
 * PUT /api/auth/users/:id/reset-password
 * Reset a user's password (superuser only)
 */
router.put('/users/:id/reset-password', [
  authenticate,
  requireSuperuser,
  body('newPassword')
    .isLength({ min: 6 })
    .withMessage('New password must be at least 6 characters'),
  validate
], async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { newPassword } = req.body;

    if (isNaN(userId)) {
      return next(new AppError('Invalid user ID', 400, 'INVALID_USER_ID'));
    }

    await AuthService.resetUserPassword(userId, newPassword, req.user.username);

    res.json({
      success: true,
      message: 'Password reset successfully',
    });
  } catch (error) {
    if (error.message === 'User not found') {
      return next(new AppError(error.message, 404, 'USER_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * PUT /api/auth/users/:id/activate
 * Activate or deactivate a user (superuser only)
 */
router.put('/users/:id/activate', [
  authenticate,
  requireSuperuser,
  body('isActive')
    .isBoolean()
    .withMessage('isActive must be a boolean'),
  validate
], async (req, res, next) => {
  try {
    const userId = parseInt(req.params.id);
    const { isActive } = req.body;

    if (isNaN(userId)) {
      return next(new AppError('Invalid user ID', 400, 'INVALID_USER_ID'));
    }

    await AuthService.setUserActiveStatus(userId, isActive, req.user.username);

    res.json({
      success: true,
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
    });
  } catch (error) {
    if (error.message === 'User not found') {
      return next(new AppError(error.message, 404, 'USER_NOT_FOUND'));
    }
    if (error.message === 'Cannot deactivate your own account') {
      return next(new AppError(error.message, 400, 'CANNOT_DEACTIVATE_SELF'));
    }
    next(error);
  }
});

module.exports = router;
