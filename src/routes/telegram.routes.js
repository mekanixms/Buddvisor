/**
 * Telegram Routes
 * Owner-only management of a session's Telegram bot and linked chats.
 */

const express = require('express');
const router = express.Router();
const { body, param } = require('express-validator');
const validate = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const TelegramService = require('../services/telegram/TelegramService');

router.use(authenticate);

// Shared-view tokens may chat, but must never manage the bot connection
router.use((req, res, next) => {
  if (req.shareSessionId != null) {
    return next(new AppError('Not available in shared view', 403, 'SHARE_SESSION_RESTRICTED'));
  }
  next();
});

const sessionIdParam = param('sessionId').isInt().withMessage('Invalid session ID');

/**
 * GET /api/telegram/:sessionId
 * Bot status, masked token and linked chats
 */
router.get('/:sessionId', [sessionIdParam, validate], async (req, res, next) => {
  try {
    const data = await TelegramService.getStatus(parseInt(req.params.sessionId, 10), req.userId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * PUT /api/telegram/:sessionId
 * Connect (or replace) the session's bot. Body: { token }
 */
router.put('/:sessionId', [
  sessionIdParam,
  body('token').isString().trim().isLength({ min: 20, max: 200 }).withMessage('Bot token is required'),
  validate,
], async (req, res, next) => {
  try {
    const data = await TelegramService.saveConfig(
      parseInt(req.params.sessionId, 10),
      req.userId,
      req.body.token
    );
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/telegram/:sessionId
 * Disconnect the bot and remove all linked chats
 */
router.delete('/:sessionId', [sessionIdParam, validate], async (req, res, next) => {
  try {
    await TelegramService.disconnect(parseInt(req.params.sessionId, 10), req.userId);
    res.json({ success: true, message: 'Telegram bot disconnected' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/telegram/:sessionId/pairing
 * Create a one-time link code. Returns QR data URL plus t.me and tg:// links.
 */
router.post('/:sessionId/pairing', [sessionIdParam, validate], async (req, res, next) => {
  try {
    const data = await TelegramService.createPairing(parseInt(req.params.sessionId, 10), req.userId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/telegram/:sessionId/chats/:id
 * Revoke one linked chat
 */
router.delete('/:sessionId/chats/:id', [
  sessionIdParam,
  param('id').isInt().withMessage('Invalid chat ID'),
  validate,
], async (req, res, next) => {
  try {
    await TelegramService.revokeChat(
      parseInt(req.params.sessionId, 10),
      req.userId,
      parseInt(req.params.id, 10)
    );
    res.json({ success: true, message: 'Chat unlinked' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
