const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validation');
const { authenticate, restrictToShareSession } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const conversationModeService = require('../services/chat/ConversationModeService');
const WorkSession = require('../models/WorkSession');
const logger = require('../utils/logger');

// All conversation routes require authentication
router.use(authenticate);

// In share mode, restrict to the shared session
router.use('/:sessionId', restrictToShareSession('sessionId'));

/**
 * POST /api/conversation/:sessionId/start
 * Start a conversation mode brainstorming session
 */
router.post('/:sessionId/start', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  body('prompt')
    .trim()
    .isLength({ min: 1, max: 10000 })
    .withMessage('Prompt must be between 1 and 10000 characters'),
  body('maxRounds')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('maxRounds must be between 1 and 100'),
  body('tokenBudget')
    .optional()
    .isInt({ min: 1000, max: 500000 })
    .withMessage('tokenBudget must be between 1000 and 500000'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const { prompt, maxRounds, tokenBudget } = req.body;

    const state = await conversationModeService.startConversation(
      sessionId,
      req.userId,
      prompt,
      { maxRounds, tokenBudget }
    );

    res.json({
      success: true,
      data: {
        sessionId: state.sessionId,
        status: state.status,
        currentRound: state.currentRound,
        maxRounds: state.maxRounds,
        tokenBudget: state.tokenBudget,
        agentCount: state.agents.length,
      },
    });
  } catch (error) {
    logger.error('Error starting conversation:', error);
    if (error.message.includes('not found') || error.message.includes('access denied')) {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    if (error.message.includes('already running')) {
      return next(new AppError(error.message, 409, 'CONVERSATION_ALREADY_RUNNING'));
    }
    next(error);
  }
});

/**
 * GET /api/conversation/:sessionId/stream
 * Stream conversation mode output (SSE)
 */
router.get('/:sessionId/stream', [
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

    // Send initial connection event
    res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

    // Run the conversation loop
    const runConversation = async () => {
      while (true) {
        const state = conversationModeService.getConversationState(sessionId);

        if (!state) {
          res.write(`data: ${JSON.stringify({ type: 'done', reason: 'not_found' })}\n\n`);
          break;
        }

        if (state.status !== 'running') {
          res.write(`data: ${JSON.stringify({ type: 'done', reason: state.status })}\n\n`);
          break;
        }

        // Execute next round with streaming
        const result = await conversationModeService.executeNextRound(
          sessionId,
          ({ agent, chunk }) => {
            res.write(`data: ${JSON.stringify({ type: 'chunk', agent, content: chunk })}\n\n`);
          }
        );

        if (result.done) {
          res.write(`data: ${JSON.stringify({
            type: 'done',
            reason: result.reason,
            conclusion: result.conclusion,
          })}\n\n`);
          break;
        } else if (result.error) {
          res.write(`data: ${JSON.stringify({
            type: 'round_error',
            round: result.round,
            error: result.error,
          })}\n\n`);
          // Continue despite error
        } else {
          res.write(`data: ${JSON.stringify({
            type: 'round_complete',
            round: result.round,
            speaker: result.speaker?.name,
            tokensUsed: result.tokensUsed,
          })}\n\n`);
        }

        // Small delay between rounds
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    };

    runConversation()
      .catch(err => {
        logger.error('Conversation stream error:', err);
        res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
      })
      .finally(() => {
        res.end();
      });

    // Handle client disconnect
    req.on('close', () => {
      logger.debug(`Client disconnected from conversation stream ${sessionId}`);
      // Optionally pause the conversation
    });
  } catch (error) {
    logger.error('Stream setup error:', error);
    next(error);
  }
});

/**
 * POST /api/conversation/:sessionId/interjection
 * Add a user message during the conversation
 */
router.post('/:sessionId/interjection', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  body('message')
    .trim()
    .isLength({ min: 1, max: 10000 })
    .withMessage('Message must be between 1 and 10000 characters'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const { message } = req.body;

    const result = await conversationModeService.handleInterjection(
      sessionId,
      req.userId,
      message
    );

    res.json({
      success: true,
      data: {
        message: 'Interjection recorded',
        status: result.state?.status,
        currentRound: result.state?.currentRound,
      },
    });
  } catch (error) {
    logger.error('Interjection error:', error);
    if (error.message.includes('No active conversation')) {
      return next(new AppError(error.message, 404, 'NO_ACTIVE_CONVERSATION'));
    }
    next(error);
  }
});

/**
 * POST /api/conversation/:sessionId/stop
 * Stop the conversation
 */
router.post('/:sessionId/stop', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);

    const result = await conversationModeService.stopConversation(sessionId);

    res.json({
      success: true,
      message: 'Conversation stopped',
    });
  } catch (error) {
    logger.error('Stop conversation error:', error);
    next(error);
  }
});

/**
 * POST /api/conversation/:sessionId/pause
 * Pause the conversation
 */
router.post('/:sessionId/pause', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);

    const result = await conversationModeService.pauseConversation(sessionId);

    res.json({
      success: true,
      message: 'Conversation paused',
    });
  } catch (error) {
    logger.error('Pause conversation error:', error);
    next(error);
  }
});

/**
 * POST /api/conversation/:sessionId/resume
 * Resume a paused conversation
 */
router.post('/:sessionId/resume', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);

    const result = await conversationModeService.resumeConversation(sessionId);

    res.json({
      success: true,
      message: 'Conversation resumed',
    });
  } catch (error) {
    logger.error('Resume conversation error:', error);
    next(error);
  }
});

/**
 * GET /api/conversation/:sessionId/state
 * Get current conversation state
 */
router.get('/:sessionId/state', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);

    const state = conversationModeService.getConversationState(sessionId);

    if (!state) {
      // Check if session exists and get settings
      const session = await WorkSession.findById(sessionId);
      if (!session || session.user_id !== req.userId) {
        return next(new AppError('Session not found', 404, 'SESSION_NOT_FOUND'));
      }

      const settings = await WorkSession.getConversationModeSettings(sessionId);

      res.json({
        success: true,
        data: {
          active: false,
          settings,
        },
      });
    } else {
      res.json({
        success: true,
        data: {
          active: true,
          status: state.status,
          currentRound: state.currentRound,
          maxRounds: state.maxRounds,
          tokenBudget: state.tokenBudget,
          tokensUsed: state.tokensUsed,
          agentCount: state.agents?.length,
          initialPrompt: state.initialPrompt,
        },
      });
    }
  } catch (error) {
    logger.error('Get state error:', error);
    next(error);
  }
});

/**
 * PUT /api/conversation/:sessionId/settings
 * Update conversation mode settings for a session
 */
router.put('/:sessionId/settings', [
  param('sessionId').isInt().withMessage('Invalid session ID'),
  body('enabled').optional().isBoolean().withMessage('enabled must be a boolean'),
  body('maxRounds')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('maxRounds must be between 1 and 100'),
  body('tokenBudget')
    .optional()
    .isInt({ min: 1000, max: 500000 })
    .withMessage('tokenBudget must be between 1000 and 500000'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.sessionId);
    const { enabled, maxRounds, tokenBudget } = req.body;

    // Verify session ownership
    const session = await WorkSession.findById(sessionId);
    if (!session || session.user_id !== req.userId) {
      return next(new AppError('Session not found', 404, 'SESSION_NOT_FOUND'));
    }

    const settings = await WorkSession.updateConversationModeSettings(sessionId, {
      enabled,
      maxRounds,
      tokenBudget,
    });

    res.json({
      success: true,
      data: settings,
    });
  } catch (error) {
    logger.error('Update settings error:', error);
    next(error);
  }
});

module.exports = router;
