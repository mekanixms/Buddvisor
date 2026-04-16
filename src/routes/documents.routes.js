const express = require('express');
const router = express.Router();
const multer = require('multer');
const { body, param, query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const DocumentService = require('../services/documents/DocumentService');
const DocumentProcessor = require('../services/documents/DocumentProcessor');
const logger = require('../utils/logger');

// All document routes require authentication
router.use(authenticate);

/**
 * Multer configuration for file uploads
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: DocumentProcessor.getMaxFileSize(),
  },
  fileFilter: (req, file, cb) => {
    if (DocumentProcessor.isSupported(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`), false);
    }
  },
});

/**
 * Validation middleware
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

/**
 * GET /api/documents
 * List all documents for the current user
 */
router.get('/',
  [
    query('fileType').optional().isString(),
    query('orderBy').optional().isIn(['filename', 'file_type', 'file_size', 'uploaded_at', 'chunk_count']),
    query('order').optional().isIn(['asc', 'desc', 'ASC', 'DESC']),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('offset').optional().isInt({ min: 0 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const options = {
        fileType: req.query.fileType,
        orderBy: req.query.orderBy || 'uploaded_at',
        order: req.query.order || 'DESC',
        limit: req.query.limit ? parseInt(req.query.limit) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset) : undefined,
      };

      const documents = await DocumentService.listDocuments(req.userId, options);

      res.json({
        success: true,
        data: {
          documents,
          count: documents.length,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/documents/stats
 * Get document statistics for the current user
 */
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await DocumentService.getStatistics(req.userId);

    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/documents/supported-types
 * Get list of supported file types
 */
router.get('/supported-types', (req, res) => {
  const supportedTypes = DocumentService.getSupportedFileTypes();
  res.json({
    success: true,
    data: {
      supportedTypes,
      maxFileSize: DocumentProcessor.getMaxFileSize(),
      maxFileSizeFormatted: `${DocumentProcessor.getMaxFileSize() / 1024 / 1024}MB`,
    },
  });
});

/**
 * POST /api/documents
 * Upload a new document
 */
router.post('/',
  upload.single('file'),
  [
    body('generateEmbeddings').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'No file uploaded',
        });
      }

      const options = {
        generateEmbeddings: req.body.generateEmbeddings !== 'false',
      };

      const result = await DocumentService.uploadDocument(req.userId, req.file, options);

      res.status(201).json({
        success: true,
        data: result,
        message: result.message,
      });
    } catch (error) {
      // Handle specific errors
      if (error.message.includes('Duplicate document')) {
        return res.status(409).json({
          success: false,
          error: error.message,
        });
      }
      if (error.message.includes('Unsupported file type')) {
        return res.status(415).json({
          success: false,
          error: error.message,
        });
      }
      if (error.message.includes('File too large')) {
        return res.status(413).json({
          success: false,
          error: error.message,
        });
      }
      next(error);
    }
  }
);

/**
 * GET /api/documents/:id
 * Get a specific document
 */
router.get('/:id',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid document ID'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const document = await DocumentService.getDocument(
        parseInt(req.params.id),
        req.userId
      );

      res.json({
        success: true,
        data: { document },
      });
    } catch (error) {
      if (error.message === 'Document not found') {
        return res.status(404).json({ success: false, error: error.message });
      }
      if (error.message.includes('Not authorized')) {
        return res.status(403).json({ success: false, error: error.message });
      }
      next(error);
    }
  }
);

/**
 * DELETE /api/documents/:id
 * Delete a document
 */
router.delete('/:id',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid document ID'),
  ],
  validate,
  async (req, res, next) => {
    try {
      await DocumentService.deleteDocument(
        parseInt(req.params.id),
        req.userId
      );

      res.json({
        success: true,
        message: 'Document deleted successfully',
      });
    } catch (error) {
      if (error.message === 'Document not found') {
        return res.status(404).json({ success: false, error: error.message });
      }
      if (error.message.includes('Not authorized')) {
        return res.status(403).json({ success: false, error: error.message });
      }
      next(error);
    }
  }
);

/**
 * POST /api/documents/:id/reprocess
 * Reprocess a document (regenerate embeddings)
 */
router.post('/:id/reprocess',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid document ID'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const result = await DocumentService.reprocessDocument(
        parseInt(req.params.id),
        req.userId,
        req.body
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      if (error.message === 'Document not found') {
        return res.status(404).json({ success: false, error: error.message });
      }
      if (error.message.includes('Not authorized')) {
        return res.status(403).json({ success: false, error: error.message });
      }
      next(error);
    }
  }
);

/**
 * POST /api/documents/search
 * Search documents by semantic query
 */
router.post('/search',
  [
    body('query').trim().notEmpty().withMessage('Query is required'),
    body('topK').optional().isInt({ min: 1, max: 20 }),
    body('documentIds').optional().isArray(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { query, topK, documentIds } = req.body;

      const results = await DocumentService.searchDocuments(req.userId, query, {
        topK: topK || 5,
        documentIds,
      });

      res.json({
        success: true,
        data: {
          query,
          results,
          resultCount: results.length,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/documents/:id/download
 * Download a document file
 */
router.get('/:id/download',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid document ID'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const document = await DocumentService.getDocument(
        parseInt(req.params.id),
        req.userId
      );

      res.download(document.file_path, document.filename, (err) => {
        if (err) {
          logger.error('Error downloading file:', err);
          if (!res.headersSent) {
            res.status(500).json({
              success: false,
              error: 'Error downloading file',
            });
          }
        }
      });
    } catch (error) {
      if (error.message === 'Document not found') {
        return res.status(404).json({ success: false, error: error.message });
      }
      if (error.message.includes('Not authorized')) {
        return res.status(403).json({ success: false, error: error.message });
      }
      next(error);
    }
  }
);

/**
 * Error handling for multer
 */
router.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: `File too large. Maximum size is ${DocumentProcessor.getMaxFileSize() / 1024 / 1024}MB`,
      });
    }
    return res.status(400).json({
      success: false,
      error: error.message,
    });
  }
  next(error);
});

module.exports = router;
