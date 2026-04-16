const jwt = require('jsonwebtoken');
const { AppError } = require('./errorHandler');
const logger = require('../utils/logger');
const { isSuperuser } = require('../utils/superuser');

// Verify JWT token and attach user to request
const authenticate = async (req, res, next) => {
  try {
    // Get token from header or query param (for SSE/EventSource)
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.query.token) {
      // Support token in query param for EventSource connections
      token = req.query.token;
    }

    // Check if token exists
    if (!token) {
      return next(new AppError('Not authorized to access this route', 401, 'NO_TOKEN'));
    }

    try {
      // Verify token
      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Add user info to request
      req.user = {
        id: decoded.id,
        username: decoded.username,
      };

      // Add user ID for easy access
      req.userId = decoded.id;

      // Share-link JWT: restrict access to a single session
      if (decoded.shareSessionId != null) {
        req.shareSessionId = decoded.shareSessionId;
      }

      next();
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        return next(new AppError('Token expired. Please log in again', 401, 'TOKEN_EXPIRED'));
      }
      return next(new AppError('Invalid token', 401, 'INVALID_TOKEN'));
    }
  } catch (error) {
    next(error);
  }
};

// Optional authentication (doesn't fail if no token)
const optionalAuthenticate = async (req, res, next) => {
  try {
    let token;

    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    }

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = {
          id: decoded.id,
          username: decoded.username,
        };
        req.userId = decoded.id;
      } catch (error) {
        // Silently fail for optional auth
        logger.debug('Optional auth failed:', error.message);
      }
    }

    next();
  } catch (error) {
    next(error);
  }
};

// Middleware to check if user is superuser
const requireSuperuser = async (req, res, next) => {
  try {
    // First ensure user is authenticated
    if (!req.user || !req.user.username) {
      return next(new AppError('Authentication required', 401, 'NO_TOKEN'));
    }

    // Check if user is superuser
    if (!isSuperuser(req.user.username)) {
      return next(new AppError('Superuser access required', 403, 'FORBIDDEN'));
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * If request is share-scoped, require the session param to match shareSessionId.
 * @param {string} paramName - Route param name (e.g. 'id' or 'sessionId')
 */
const restrictToShareSession = (paramName) => (req, res, next) => {
  if (req.shareSessionId == null) return next();
  const paramVal = req.params[paramName];
  const sessionId = paramVal != null ? parseInt(paramVal, 10) : NaN;
  if (sessionId !== req.shareSessionId) {
    return next(new AppError('Access limited to the shared session', 403, 'SHARE_SESSION_RESTRICTED'));
  }
  next();
};

module.exports = {
  authenticate,
  optionalAuthenticate,
  requireSuperuser,
  restrictToShareSession,
};
