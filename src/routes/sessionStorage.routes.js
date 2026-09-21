const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs').promises;
const express = require('express');
const multer = require('multer');
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validation');
const { AppError } = require('../middleware/errorHandler');
const SessionStorageExplorer = require('../services/sessions/SessionStorageExplorer');
const { MAX_UPLOAD_BYTES, StorageExplorerError } = SessionStorageExplorer;
const logger = require('../utils/logger');

const router = express.Router({ mergeParams: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, os.tmpdir()),
    filename: (_req, _file, cb) => {
      cb(null, `session-storage-${Date.now()}-${crypto.randomBytes(8).toString('hex')}`);
    },
  }),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 20,
  },
});

function blockShareMode(req, res, next) {
  if (req.shareSessionId != null) {
    return next(new AppError('File explorer is not available in share mode', 403, 'SHARE_MODE'));
  }
  next();
}

function handleExplorerError(error, next) {
  if (error instanceof StorageExplorerError || error.statusCode) {
    return next(new AppError(error.message, error.statusCode || 400, error.code || 'STORAGE_ERROR'));
  }
  if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
    return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
  }
  return next(error);
}

function parseSessionId(req) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id)) {
    throw new AppError('Invalid session ID', 400, 'VALIDATION_ERROR');
  }
  return id;
}

function contentDisposition(type, filename) {
  const safe = String(filename || 'file').replace(/["\r\n]/g, '_');
  return `${type}; filename="${safe}"`;
}

router.use(blockShareMode);

/**
 * GET /api/sessions/:id/storage
 * List directory contents. Query: path (relative, default root).
 */
router.get('/', [
  param('id').isInt().withMessage('Invalid session ID'),
  query('path').optional().isString(),
  validate,
], async (req, res, next) => {
  try {
    const sessionId = parseSessionId(req);
    const data = await SessionStorageExplorer.list(sessionId, req.userId, req.query.path || '');
    res.json({ success: true, data });
  } catch (error) {
    handleExplorerError(error, next);
  }
});

/**
 * GET /api/sessions/:id/storage/file
 * View or download a file. Query: path, disposition=inline|attachment
 */
router.get('/file', [
  param('id').isInt().withMessage('Invalid session ID'),
  query('path').isString().withMessage('path is required'),
  query('disposition').optional().isIn(['inline', 'attachment']),
  validate,
], async (req, res, next) => {
  try {
    const sessionId = parseSessionId(req);
    const file = await SessionStorageExplorer.getFile(sessionId, req.userId, req.query.path);
    const inline = (req.query.disposition || 'inline') === 'inline';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'unsafe-inline'; sandbox"
    );
    if (inline) {
      res.setHeader('Content-Type', file.mimeInline);
      res.setHeader('Content-Disposition', contentDisposition('inline', file.name));
    } else {
      res.setHeader('Content-Type', file.mimeDownload);
      res.setHeader('Content-Disposition', contentDisposition('attachment', file.name));
    }
    res.sendFile(path.resolve(file.abs), (err) => {
      if (err) {
        logger.error('Error sending storage file:', err);
        if (!res.headersSent) {
          next(new AppError('Error sending file', 500, 'FILE_SEND_ERROR'));
        }
      }
    });
  } catch (error) {
    handleExplorerError(error, next);
  }
});

/**
 * POST /api/sessions/:id/storage/mkdir
 * Body: { path, name }
 */
router.post('/mkdir', [
  param('id').isInt().withMessage('Invalid session ID'),
  body('path').optional().isString(),
  body('name').isString().trim().isLength({ min: 1, max: 255 }).withMessage('Folder name is required'),
  validate,
], async (req, res, next) => {
  try {
    const sessionId = parseSessionId(req);
    const data = await SessionStorageExplorer.mkdir(sessionId, req.userId, req.body.path || '', req.body.name);
    res.status(201).json({ success: true, data });
  } catch (error) {
    handleExplorerError(error, next);
  }
});

/**
 * POST /api/sessions/:id/storage/upload
 * multipart: path (text), file (one or more)
 */
router.post('/upload', [
  param('id').isInt().withMessage('Invalid session ID'),
  validate,
], (req, res, next) => {
  upload.array('file', 20)(req, res, (err) => {
    if (err) return next(err);
    next();
  });
}, async (req, res, next) => {
  try {
    const sessionId = parseSessionId(req);
    const destPath = (req.body && req.body.path) || '';
    const files = req.files || [];
    if (!files.length) {
      return next(new AppError('No file uploaded', 400, 'NO_FILE'));
    }
    const uploaded = [];
    try {
      for (const file of files) {
        const result = await SessionStorageExplorer.uploadFile(sessionId, req.userId, destPath, file);
        uploaded.push(result);
      }
    } finally {
      for (const file of files) {
        if (file.path) {
          try {
            await fs.unlink(file.path);
          } catch {
            // already moved or missing
          }
        }
      }
    }
    res.status(201).json({ success: true, data: { files: uploaded } });
  } catch (error) {
    handleExplorerError(error, next);
  }
});

/**
 * DELETE /api/sessions/:id/storage
 * Query: path
 */
router.delete('/', [
  param('id').isInt().withMessage('Invalid session ID'),
  query('path').isString().withMessage('path is required'),
  validate,
], async (req, res, next) => {
  try {
    const sessionId = parseSessionId(req);
    const data = await SessionStorageExplorer.remove(sessionId, req.userId, req.query.path);
    res.json({ success: true, data });
  } catch (error) {
    handleExplorerError(error, next);
  }
});

module.exports = router;
