const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validation');
const { authenticate, restrictToShareSession } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { ChatService } = require('../services/chat/ChatService');
const ConversationService = require('../services/sessions/ConversationService');
const AutoSaveService = require('../services/sessions/AutoSaveService');
const { streamingSessionManager } = require('../services/chat/StreamingSessionManager');
const User = require('../models/User');
const logger = require('../utils/logger');

// All chat routes require authentication
router.use(authenticate);

// In share mode, restrict to the shared session
router.use('/:sessionId', restrictToShareSession('sessionId'));

/**
 * POST /api/chat/:sessionId
 * Send a message to the main agent
 * 
 * If the request body contains a "context" key (with any value), the message
 * will be added to the conversation history without processing through agents.
 * This is useful for sensor data or other context that should be stored but
 * not trigger agent processing (saves tokens).
 * 
 * Examples:
 * - {"message": "sensor data", "context": "true"} -> adds to context only
 * - {"message": "user prompt"} -> processes through agents normally
 */
router.post('/:sessionId', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  body('message')
    .trim()
    .isLength({ min: 1, max: 10000 })
    .withMessage('Message must be between 1 and 10000 characters'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const userMessage = req.body.message;
    const isContextOnly = req.body.context !== undefined && req.body.context !== null;
    const isAliasPresent = req.body.alias !== undefined && req.body.alias !== null;

    // If alias is present (for remote HTTP requests with context only), validate the alias user
    if (isAliasPresent && isContextOnly) {
      const aliasUserId = parseInt(req.body.alias);
      
      if (isNaN(aliasUserId) || aliasUserId <= 0) {
        return next(new AppError('Alias must be a valid user ID', 400, 'INVALID_ALIAS'));
      }

      // Check if alias user exists
      const aliasUser = await User.findById(aliasUserId);
      
      if (!aliasUser) {
        return next(new AppError(`User with ID ${aliasUserId} not found`, 404, 'ALIAS_USER_NOT_FOUND'));
      }

      // Check if alias user is activated
      if (!aliasUser.is_active) {
        return next(new AppError(`User with ID ${aliasUserId} is not activated`, 403, 'ALIAS_USER_NOT_ACTIVATED'));
      }

      // Verify that the logged-in user has access to the session
      // Then post on behalf of the alias user
      const result = await ChatService.addContextMessage(
        sessionId,
        req.userId, // Session owner (for access check)
        userMessage,
        aliasUser.id // Author user (for alias posting)
      );

      // Auto-save session
      await AutoSaveService.autoSave(sessionId, 'message');

      res.json({
        success: true,
        data: {
          message: 'Message added to context',
          contextOnly: true,
          aliasUserId: aliasUser.id,
        },
      });
      return;
    }

    // If "context" key is present (without alias), just add to context without processing
    if (isContextOnly) {
      const result = await ChatService.addContextMessage(
        sessionId,
        req.userId,
        userMessage
      );

      // Auto-save session
      await AutoSaveService.autoSave(sessionId, 'message');

      res.json({
        success: true,
        data: {
          message: 'Message added to context',
          contextOnly: true,
        },
      });
      return;
    }

    // Otherwise, process message through ChatService normally
    const attachedDocumentsInfo = req.body.attachedDocumentsInfo || null;
    const result = await ChatService.processMessage(
      sessionId,
      req.userId,
      userMessage,
      { stream: false, attachedDocumentsInfo }
    );

    // Auto-save session
    await AutoSaveService.autoSave(sessionId, 'message');

    res.json({
      success: true,
      data: {
        message: result.message,
        agentName: result.agentName,
        routedTo: result.routedTo,
        tokensUsed: result.tokensUsed,
      },
    });
  } catch (error) {
    logger.error('Chat error:', error);
    if (error.message === 'Session not found or access denied') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * POST /api/chat/:sessionId/stream
 * Stream a response from the main agent (SSE)
 * 
 * Note: Context-only mode (with "context" key) is not supported for streaming.
 * Use the non-streaming endpoint for context-only messages.
 */
router.post('/:sessionId/stream', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  body('message')
    .trim()
    .isLength({ min: 1, max: 10000 })
    .withMessage('Message must be between 1 and 10000 characters'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const userMessage = req.body.message;
    const isContextOnly = req.body.context !== undefined && req.body.context !== null;

    // Context-only mode not supported for streaming - fall back to non-streaming behavior
    if (isContextOnly) {
      const result = await ChatService.addContextMessage(
        sessionId,
        req.userId,
        userMessage
      );

      // Auto-save session
      await AutoSaveService.autoSave(sessionId, 'message');

      // Send completion event
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'done',
        message: 'Message added to context',
        contextOnly: true,
      })}\n\n`);
      res.end();
      return;
    }

    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Start tracking this streaming session for reconnection
    streamingSessionManager.startStreaming(sessionId, userMessage);

    const attachedDocumentsInfo = req.body.attachedDocumentsInfo || null;
    // Process message with streaming
    const result = await ChatService.processMessage(
      sessionId,
      req.userId,
      userMessage,
      {
        stream: true,
        attachedDocumentsInfo,
        onChunk: (chunk) => {
          // Extract text content from chunk object if needed; ensure string to avoid [object Object]
          let text = typeof chunk === 'string' ? chunk : (chunk && typeof chunk === 'object' ? (chunk.content ?? chunk.text ?? '') : '');
          if (typeof text !== 'string') text = String(text ?? '');
          if (text) {
            // Send to this response
            res.write(`data: ${JSON.stringify({ type: 'chunk', content: text })}\n\n`);
            // Buffer for reconnecting clients
            streamingSessionManager.addChunk(sessionId, text);
          }
        },
      }
    );

    // Mark streaming as complete
    streamingSessionManager.completeStreaming(sessionId, result);

    // Send completion event with metadata
    res.write(`data: ${JSON.stringify({
      type: 'done',
      agentName: result.agentName,
      routedTo: result.routedTo,
      tokensUsed: result.tokensUsed,
    })}\n\n`);

    // Auto-save session
    await AutoSaveService.autoSave(sessionId, 'message');

    res.end();
  } catch (error) {
    logger.error('Stream chat error:', error);
    const rawMessage = error && (error.message || error.error?.message);
    let message = typeof rawMessage === 'string' ? rawMessage : 'An error occurred while processing your message.';
    // Provider auth failures (401/403): hint to check API keys
    const isAuthFailure = error?.isAuthError === true ||
      /401|403|invalid authentication|invalid api key|incorrect api key/i.test(message);
    if (isAuthFailure) {
      const provider = error?.provider || 'LLM';
      const hint = provider === 'kimi'
        ? ' Check MOONSHOT_API_KEY or KIMI_API_KEY in .env; use a valid key from https://platform.moonshot.ai and ensure the correct base URL (api.moonshot.ai vs api.moonshot.cn) for your region.'
        : ' Check the API key for this provider in Configure Session or .env.';
      message = message + hint;
    }
    streamingSessionManager.errorStreaming(parseInt(req.params.sessionId), message);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
      res.end();
    } catch {
      next(error);
    }
  }
});

/**
 * GET /api/chat/:sessionId/stream/status
 * Check if there's an active streaming session
 */
router.get('/:sessionId/stream/status', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    
    const state = streamingSessionManager.getStreamingState(sessionId);
    
    res.json({
      success: true,
      data: {
        isStreaming: state !== null && state.status === 'streaming',
        state: state,
      },
    });
  } catch (error) {
    logger.error('Stream status error:', error);
    next(error);
  }
});

/**
 * GET /api/chat/:sessionId/stream/reconnect
 * Reconnect to an active streaming session (SSE)
 */
router.get('/:sessionId/stream/reconnect', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    
    // Set up SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    // Try to subscribe to the active stream
    const subscribed = streamingSessionManager.subscribe(sessionId, res);
    
    if (!subscribed) {
      // No active stream - send not found
      res.write(`data: ${JSON.stringify({ type: 'not_found', message: 'No active stream for this session' })}\n\n`);
      res.end();
      return;
    }

    // Handle client disconnect
    req.on('close', () => {
      streamingSessionManager.unsubscribe(sessionId, res);
      logger.debug(`Client disconnected from stream reconnect ${sessionId}`);
    });
  } catch (error) {
    logger.error('Stream reconnect error:', error);
    try {
      res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
      res.end();
    } catch {
      next(error);
    }
  }
});

/**
 * DELETE /api/chat/:sessionId/messages/:messageId
 * Delete a specific message
 */
router.delete('/:sessionId/messages/:messageId', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  param('messageId').isInt().withMessage('Invalid message ID'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const messageId = parseInt(req.params.messageId);

    await ConversationService.deleteMessage(
      sessionId,
      req.userId,
      messageId
    );

    res.json({
      success: true,
      message: 'Message deleted successfully',
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    if (error.message === 'Message not found in this session') {
      return next(new AppError(error.message, 404, 'MESSAGE_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/chat/:sessionId/history
 * Get conversation history
 */
router.get('/:sessionId/history', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const result = await ChatService.getHistory(
      sessionId,
      req.userId,
      { limit, offset }
    );

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    if (error.message === 'Session not found or access denied') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * POST /api/chat/:sessionId/clear
 * Clear conversation history
 */
router.post('/:sessionId/clear', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);

    await ChatService.clearHistory(sessionId, req.userId);

    res.json({
      success: true,
      message: 'Conversation history cleared successfully',
    });
  } catch (error) {
    if (error.message === 'Session not found or access denied') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/chat/:sessionId/statistics
 * Get conversation statistics including token usage
 */
router.get('/:sessionId/statistics', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);

    const tokenUsage = await ChatService.getTokenUsage(
      sessionId,
      req.userId
    );

    res.json({
      success: true,
      data: { statistics: tokenUsage },
    });
  } catch (error) {
    if (error.message === 'Session not found or access denied') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

module.exports = router;
