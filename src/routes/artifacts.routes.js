const express = require('express');
const router = express.Router();
const ArtifactService = require('../services/artifacts/ArtifactService');
const logger = require('../utils/logger');
const helmet = require('helmet');

// Set permissive CSP for artifact routes to allow external scripts, inline scripts, etc.
// Artifacts are user-generated content that may need to load external libraries
router.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'", // Allow inline scripts in artifacts
        "'unsafe-eval'", // Allow eval() for some libraries
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com",
        "https://unpkg.com",
        "https://code.jquery.com",
        "https://ajax.googleapis.com",
        "blob:",
        "data:"
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'", // Allow inline styles in artifacts
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com",
        "https://fonts.googleapis.com"
      ],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      fontSrc: [
        "'self'",
        "https://cdn.jsdelivr.net",
        "https://cdnjs.cloudflare.com",
        "https://fonts.googleapis.com",
        "https://fonts.gstatic.com",
        "data:"
      ],
      connectSrc: ["'self'", "https:", "wss:", "ws:"],
      frameSrc: ["'self'", "blob:"],
      frameAncestors: ["'self'"], // Allow artifacts to be embedded
      objectSrc: ["'none'"],
      mediaSrc: ["'self'", "blob:", "data:", "https:"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

/**
 * POST /api/artifacts
 * Create a new artifact HTML file
 */
router.post('/', async (req, res, next) => {
  try {
    const { content } = req.body;

    if (!content || typeof content !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Content is required and must be a string'
      });
    }

    const result = await ArtifactService.createArtifact(content);

    res.json({
      success: true,
      artifactId: result.artifactId,
      url: result.url
    });
  } catch (error) {
    logger.error('Error creating artifact:', error);
    next(error);
  }
});

/**
 * GET /api/artifacts/:id
 * Serve an artifact HTML file
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    const content = await ArtifactService.getArtifact(id);

    // Set appropriate headers
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    
    res.send(content);
  } catch (error) {
    if (error.message === 'Artifact not found') {
      return res.status(404).json({
        success: false,
        error: 'Artifact not found'
      });
    }
    logger.error('Error serving artifact:', error);
    next(error);
  }
});

/**
 * DELETE /api/artifacts/:id
 * Delete an artifact file (optional cleanup)
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    await ArtifactService.deleteArtifact(id);

    res.json({
      success: true,
      message: 'Artifact deleted'
    });
  } catch (error) {
    logger.error('Error deleting artifact:', error);
    next(error);
  }
});

module.exports = router;
