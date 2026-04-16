const express = require('express');
const router = express.Router();
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validation');
const { authenticate, restrictToShareSession } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const SessionService = require('../services/sessions/SessionService');
const ConversationService = require('../services/sessions/ConversationService');
const ContextManager = require('../services/sessions/ContextManager');
const WorkSession = require('../models/WorkSession');
const SessionScheduledJob = require('../models/SessionScheduledJob');
const { getPoolDumpForSession } = require('../services/tools/sessionPoolTool');

// All session routes require authentication
router.use(authenticate);

/**
 * GET /api/sessions/scheduled-jobs
 * List scheduled jobs. Optional query sessionId: filter to that session (must belong to user). Otherwise all sessions (or shared only in share mode).
 */
router.get('/scheduled-jobs', [
  query('sessionId').optional().isInt().withMessage('sessionId must be an integer'),
  validate
], async (req, res, next) => {
  try {
    let limitToSessionId = req.shareSessionId != null ? req.shareSessionId : null;
    const sessionIdParam = req.query.sessionId;
    if (sessionIdParam != null && sessionIdParam !== '') {
      const sid = parseInt(sessionIdParam, 10);
      const session = await WorkSession.findById(sid);
      if (!session || session.user_id !== req.userId) {
        return next(new AppError('Session not found or access denied', 404, 'NOT_FOUND'));
      }
      limitToSessionId = sid;
    }
    const jobs = await SessionScheduledJob.findAllForUser(req.userId, limitToSessionId);
    const bySession = new Map();
    for (const job of jobs) {
      const key = job.session_id;
      if (!bySession.has(key)) {
        bySession.set(key, { sessionId: job.session_id, sessionName: job.session_name || `Session ${job.session_id}`, jobs: [] });
      }
      const { session_name, ...jobWithoutSessionName } = job;
      bySession.get(key).jobs.push(jobWithoutSessionName);
    }
    const groups = Array.from(bySession.values());
    res.json({
      success: true,
      data: { groups },
    });
  } catch (error) {
    next(error);
  }
});

// In share mode, restrict access to the shared session only
router.use('/:id', restrictToShareSession('id'));

/**
 * GET /api/sessions
 * List all sessions for current user. In share mode, returns only the shared session.
 */
router.get('/', async (req, res, next) => {
  try {
    let sessions;
    if (req.shareSessionId != null) {
      const session = await SessionService.getCompleteSession(req.shareSessionId, req.userId);
      sessions = session ? [session] : [];
    } else {
      sessions = await SessionService.listSessions(req.userId);
    }
    res.json({
      success: true,
      data: { sessions },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/sessions
 * Create a new session (not allowed in share mode)
 */
router.post('/', (req, res, next) => {
  if (req.shareSessionId != null) {
    return next(new AppError('Cannot create session in share mode', 403, 'SHARE_MODE'));
  }
  next();
}, [
  body('name')
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Session name must be between 1 and 200 characters'),
  body('description')
    .optional()
    .trim(),
  body('context_length')
    .optional()
    .isInt({ min: 1, max: 200 })
    .withMessage('Context length must be between 1 and 200'),
  body('orchestrator_provider_type')
    .optional()
    .isIn(['claude', 'openai', 'gemini', 'xai', 'deepseek', 'qwen', 'kimi', 'granite', 'ollama'])
    .withMessage('Invalid provider type'),
  body('orchestrator_provider_config')
    .optional()
    .isObject()
    .withMessage('Provider config must be an object'),
  validate
], async (req, res, next) => {
  try {
    const session = await SessionService.createSession(req.userId, req.body);

    res.status(201).json({
      success: true,
      message: 'Session created successfully',
      data: { session },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/sessions/:id/test-ollama
 * Test connectivity to an Ollama server. Uses baseURL from body if provided,
 * otherwise uses the session's saved orchestrator config.
 */
router.post('/:id/test-ollama', [
  param('id').isInt().withMessage('Invalid session ID'),
  body('baseURL').optional().isString().trim(),
  validate
], async (req, res, next) => {
  try {
    const session = await SessionService.getCompleteSession(
      parseInt(req.params.id),
      req.userId
    );
    if (!session) {
      return next(new AppError('Session not found or access denied', 404, 'SESSION_NOT_FOUND'));
    }
    let baseURL = req.body?.baseURL?.trim();
    if (!baseURL) {
      const providerType = session.orchestrator_provider_type || 'claude';
      if (providerType !== 'ollama') {
        return res.json({
          success: false,
          message: `Session orchestrator is ${providerType}, not Ollama. Set Ollama as provider and save, or pass baseURL in the request body.`,
          baseURL: null,
        });
      }
      baseURL = session.orchestrator_provider_config?.baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    }
    const axios = require('axios');
    const testUrl = `${baseURL.replace(/\/$/, '')}/api/tags`;
    try {
      const resp = await axios.get(testUrl, { timeout: 10000 });
      res.json({
        success: true,
        message: 'Connection successful',
        baseURL,
        models: resp.data?.models?.map(m => m.name) || [],
      });
    } catch (err) {
      const msg = err.code === 'ECONNREFUSED'
        ? 'Connection refused. Is Ollama running? Can this server reach the host?'
        : err.code === 'ETIMEDOUT'
          ? 'Connection timed out. Check firewall and network.'
          : err.message || 'Request failed';
      res.json({
        success: false,
        message: msg,
        baseURL,
        error: err.code || err.message,
      });
    }
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/sessions/:id/context-token-estimates
 * Get approximate context token counts for Orchestrator and each agent
 */
router.get('/:id/context-token-estimates', [
  param('id').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const estimates = await SessionService.getContextTokenEstimates(
      parseInt(req.params.id),
      req.userId
    );
    res.json({
      success: true,
      data: estimates,
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/sessions/:id/pool-dump
 * Get session_pool dump for the session (if assigned to any agent). Read-only view for UI.
 */
router.get('/:id/pool-dump', [
  param('id').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.id, 10);
    const session = await WorkSession.findById(sessionId);
    if (!session || session.user_id !== req.userId) {
      return next(new AppError('Session not found or access denied', 404, 'NOT_FOUND'));
    }
    const dump = await getPoolDumpForSession(sessionId);
    if (dump == null) {
      return res.json({
        success: true,
        assigned: false,
        message: 'Session pool is not assigned to any agent in this session',
      });
    }
    return res.json({
      success: true,
      assigned: true,
      data: dump,
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/sessions/:id
 * Get session details with agents and documents
 */
router.get('/:id', [
  param('id').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const session = await SessionService.getCompleteSession(
      parseInt(req.params.id),
      req.userId
    );

    res.json({
      success: true,
      data: { session },
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:id/share-link
 * Generate or return existing share link for the session (owner only).
 * Body: { baseUrl?: string } - optional base URL for full link (e.g. https://example.com)
 */
router.post('/:id/share-link', [
  param('id').isInt().withMessage('Invalid session ID'),
  body('baseUrl').optional().isString().trim(),
  validate
], async (req, res, next) => {
  try {
    const sessionId = parseInt(req.params.id);
    const baseUrl = req.body.baseUrl || '';
    const { link, token } = await SessionService.generateShareLink(sessionId, req.userId, baseUrl);
    res.json({
      success: true,
      data: { link, token },
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * PUT /api/sessions/:id
 * Update session
 */
router.put('/:id', [
  param('id').isInt().withMessage('Invalid session ID'),
  body('name')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Session name must be between 1 and 200 characters'),
  body('description')
    .optional()
    .trim(),
  body('context_length')
    .optional()
    .isInt({ min: 1, max: 200 })
    .withMessage('Context length must be between 1 and 200'),
  body('orchestrator_provider_type')
    .optional()
    .isIn(['claude', 'openai', 'gemini', 'xai', 'deepseek', 'qwen', 'kimi', 'granite', 'ollama'])
    .withMessage('Invalid provider type'),
  body('orchestrator_provider_config')
    .optional()
    .isObject()
    .withMessage('Provider config must be an object'),
  body('is_active')
    .optional()
    .isBoolean()
    .withMessage('is_active must be a boolean'),
  body('conversation_mode_enabled')
    .optional()
    .isInt({ min: 0, max: 1 })
    .withMessage('conversation_mode_enabled must be 0 or 1'),
  body('conversation_max_rounds')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('conversation_max_rounds must be between 1 and 100'),
    body('conversation_token_budget')
      .optional()
      .isInt({ min: 1000, max: 500000 })
      .withMessage('conversation_token_budget must be between 1,000 and 500,000'),
    body('pinned')
      .optional()
      .isInt({ min: 0, max: 1 })
      .withMessage('pinned must be 0 or 1'),
    validate
], async (req, res, next) => {
  try {
    const session = await SessionService.updateSession(
      parseInt(req.params.id),
      req.userId,
      req.body
    );

    res.json({
      success: true,
      message: 'Session updated successfully',
      data: { session },
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * DELETE /api/sessions/:id
 * Delete session
 */
router.delete('/:id', [
  param('id').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    await SessionService.deleteSession(
      parseInt(req.params.id),
      req.userId
    );

    res.json({
      success: true,
      message: 'Session deleted successfully',
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:id/agents
 * Assign agents to session
 */
router.post('/:id/agents', [
  param('id').isInt().withMessage('Invalid session ID'),
  body('agentIds')
    .isArray({ min: 1 })
    .withMessage('agentIds must be a non-empty array'),
  body('agentIds.*')
    .isInt()
    .withMessage('Each agent ID must be an integer'),
  validate
], async (req, res, next) => {
  try {
    await SessionService.assignAgents(
      parseInt(req.params.id),
      req.userId,
      req.body.agentIds
    );

    res.json({
      success: true,
      message: 'Agents assigned successfully',
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * DELETE /api/sessions/:id/agents/:agentId
 * Remove agent from session
 */
router.delete('/:id/agents/:agentId', [
  param('id').isInt().withMessage('Invalid session ID'),
  param('agentId').isInt().withMessage('Invalid agent ID'),
  validate
], async (req, res, next) => {
  try {
    await SessionService.removeAgent(
      parseInt(req.params.id),
      req.userId,
      parseInt(req.params.agentId)
    );

    res.json({
      success: true,
      message: 'Agent removed successfully',
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:id/documents
 * Assign documents to session
 */
router.post('/:id/documents', [
  param('id').isInt().withMessage('Invalid session ID'),
  body('documentIds')
    .isArray({ min: 1 })
    .withMessage('documentIds must be a non-empty array'),
  body('documentIds.*')
    .isInt()
    .withMessage('Each document ID must be an integer'),
  validate
], async (req, res, next) => {
  try {
    await SessionService.assignDocuments(
      parseInt(req.params.id),
      req.userId,
      req.body.documentIds
    );

    res.json({
      success: true,
      message: 'Documents assigned successfully',
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * DELETE /api/sessions/:id/documents/:documentId
 * Remove document from session
 */
router.delete('/:id/documents/:documentId', [
  param('id').isInt().withMessage('Invalid session ID'),
  param('documentId').isInt().withMessage('Invalid document ID'),
  validate
], async (req, res, next) => {
  try {
    await SessionService.removeDocument(
      parseInt(req.params.id),
      req.userId,
      parseInt(req.params.documentId)
    );

    res.json({
      success: true,
      message: 'Document removed successfully',
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:id/document-assignments
 * Replace per-agent document assignments for this session
 *
 * Body:
 * {
 *   "assignments": [
 *     { "documentId": 1, "agentIds": [2,3] },
 *     { "documentId": 2, "agentIds": [] }
 *   ],
 *   "orchestratorDocumentIds": [ 1, 2 ]  // optional: doc IDs for orchestrator-only (session-level)
 * }
 */
router.post('/:id/document-assignments', [
  param('id').isInt().withMessage('Invalid session ID'),
  body('assignments')
    .isArray()
    .withMessage('assignments must be an array'),
  body('assignments.*.documentId')
    .isInt()
    .withMessage('Each documentId must be an integer'),
  body('assignments.*.agentIds')
    .isArray()
    .withMessage('Each agentIds must be an array'),
  body('assignments.*.agentIds.*')
    .isInt()
    .withMessage('Each agent ID must be an integer'),
  body('orchestratorDocumentIds')
    .optional()
    .isArray()
    .withMessage('orchestratorDocumentIds must be an array'),
  body('orchestratorDocumentIds.*')
    .optional()
    .isInt()
    .withMessage('Each orchestrator document ID must be an integer'),
  validate
], async (req, res, next) => {
  try {
    await SessionService.setDocumentAgentAssignments(
      parseInt(req.params.id),
      req.userId,
      req.body.assignments,
      req.body.orchestratorDocumentIds
    );

    res.json({
      success: true,
      message: 'Document assignments updated successfully',
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:id/tool-assignments
 * Replace per-agent tool assignments for this session
 *
 * Body:
 * {
 *   "assignments": [
 *     { "toolName": "web_search", "agentIds": [2,3] },
 *     { "toolName": "calculator", "agentIds": [] }
 *   ]
 * }
 */
router.post('/:id/tool-assignments', [
  param('id').isInt().withMessage('Invalid session ID'),
  body('assignments')
    .isArray()
    .withMessage('assignments must be an array'),
  body('assignments.*.toolName')
    .isString()
    .withMessage('Each toolName must be a string'),
  body('assignments.*.agentIds')
    .isArray()
    .withMessage('Each agentIds must be an array'),
  body('assignments.*.agentIds.*')
    .isInt()
    .withMessage('Each agent ID must be an integer'),
  validate
], async (req, res, next) => {
  try {
    await SessionService.setToolAgentAssignments(
      parseInt(req.params.id),
      req.userId,
      req.body.assignments
    );

    res.json({
      success: true,
      message: 'Tool assignments updated successfully',
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/sessions/:id/orchestrator-tools
 * Get orchestrator tool assignments for this session
 */
router.get('/:id/orchestrator-tools', [
  param('id').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const assignments = await SessionService.getOrchestratorToolAssignments(
      parseInt(req.params.id),
      req.userId
    );

    res.json({
      success: true,
      data: { assignments },
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:id/orchestrator-tools
 * Set orchestrator tool assignments for this session
 */
router.post('/:id/orchestrator-tools', [
  param('id').isInt().withMessage('Invalid session ID'),
  body('assignments')
    .isArray()
    .withMessage('assignments must be an array'),
  body('assignments.*.tool_name')
    .isString()
    .withMessage('Each assignment must have a tool_name string'),
  body('assignments.*.tool_config')
    .optional()
    .custom((value) => {
      // Allow object, string, or null/undefined
      return value === null || value === undefined || typeof value === 'object' || typeof value === 'string';
    })
    .withMessage('tool_config must be an object, string, or null'),
  validate
], async (req, res, next) => {
  try {
    await SessionService.setOrchestratorToolAssignments(
      parseInt(req.params.id),
      req.userId,
      req.body.assignments
    );

    res.json({
      success: true,
      message: 'Orchestrator tool assignments updated successfully',
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/sessions/:id/messages
 * Get conversation messages
 */
router.get('/:id/messages', [
  param('id').isInt().withMessage('Invalid session ID'),
  query('limit').optional().isInt({ min: 1, max: 1000 }).withMessage('Limit must be between 1 and 1000'),
  query('offset').optional().isInt({ min: 0 }).withMessage('Offset must be >= 0'),
  validate
], async (req, res, next) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const offset = parseInt(req.query.offset) || 0;

    const messages = await ConversationService.getMessages(
      parseInt(req.params.id),
      req.userId,
      limit,
      offset
    );

    res.json({
      success: true,
      data: { messages },
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:id/export
 * Export session data
 */
router.post('/:id/export', [
  param('id').isInt().withMessage('Invalid session ID'),
  body('includeMessages').optional().isBoolean(),
  validate
], async (req, res, next) => {
  try {
    const includeMessages = req.body.includeMessages === true;
    const exportData = await SessionService.exportSession(
      parseInt(req.params.id),
      req.userId,
      includeMessages
    );

    res.json({
      success: true,
      data: exportData,
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/import
 * Import session data
 */
router.post('/import', [
  body('data').isObject().withMessage('Import data must be an object'),
  body('name')
    .optional({ nullable: true, checkFalsy: true })
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Session name must be between 1 and 200 characters'),
  validate
], async (req, res, next) => {
  try {
    // Debug logging
    const logger = require('../utils/logger');
    logger.info(`Import request received. Data keys: ${req.body.data ? Object.keys(req.body.data).join(', ') : 'null'}`);
    
    // Use name if provided and not empty, otherwise pass null to use default
    const sessionName = req.body.name && req.body.name.trim() ? req.body.name.trim() : null;
    const session = await SessionService.importSession(req.userId, req.body.data, sessionName);

    res.status(201).json({
      success: true,
      message: 'Session imported successfully',
      data: { session },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /api/sessions/:id/messages
 * Clear all messages from a session
 */
router.delete('/:id/messages', [
  param('id').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    await SessionService.clearMessages(
      parseInt(req.params.id),
      req.userId
    );

    res.json({
      success: true,
      message: 'Session messages cleared successfully',
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:id/pin
 * Toggle pin status of a session
 */
router.post('/:id/pin', [
  param('id').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const session = await SessionService.togglePin(
      parseInt(req.params.id),
      req.userId
    );

    res.json({
      success: true,
      message: `Session ${session.pinned ? 'pinned' : 'unpinned'} successfully`,
      data: { session },
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * POST /api/sessions/:id/duplicate
 * Duplicate a session with all its settings
 */
router.post('/:id/duplicate', [
  param('id').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const session = await SessionService.duplicateSession(
      parseInt(req.params.id),
      req.userId
    );

    res.status(201).json({
      success: true,
      message: 'Session duplicated successfully',
      data: { session },
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/sessions/:id/default-prompt
 * Get the default orchestrator system prompt for this session
 * This returns the built-in prompt with agents, documents, and tools - without user-entered description
 */
router.get('/:id/default-prompt', [
  param('id').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const session = await SessionService.getCompleteSession(
      parseInt(req.params.id),
      req.userId
    );

    const defaultPrompt = ContextManager.buildDefaultSystemPrompt(session);

    res.json({
      success: true,
      data: { prompt: defaultPrompt },
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/sessions/:id/agents/:agentId/context
 * Get the session-specific context for an agent
 */
router.get('/:id/agents/:agentId/context', [
  param('id').isInt().withMessage('Invalid session ID'),
  param('agentId').isInt().withMessage('Invalid agent ID'),
  validate
], async (req, res, next) => {
  try {
    // Verify session access
    await SessionService.getCompleteSession(
      parseInt(req.params.id),
      req.userId
    );

    const context = await WorkSession.getAgentSessionContext(
      parseInt(req.params.id),
      parseInt(req.params.agentId)
    );

    res.json({
      success: true,
      data: { context },
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * PUT /api/sessions/:id/agents/:agentId/context
 * Set the session-specific context for an agent
 */
router.put('/:id/agents/:agentId/context', [
  param('id').isInt().withMessage('Invalid session ID'),
  param('agentId').isInt().withMessage('Invalid agent ID'),
  body('context').optional({ nullable: true }).isString().withMessage('Context must be a string'),
  validate
], async (req, res, next) => {
  try {
    // Verify session access
    await SessionService.getCompleteSession(
      parseInt(req.params.id),
      req.userId
    );

    await WorkSession.setAgentSessionContext(
      parseInt(req.params.id),
      parseInt(req.params.agentId),
      req.body.context || null
    );

    res.json({
      success: true,
      message: 'Agent session context updated successfully',
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/sessions/:id/documents-section
 * Get the "## Your Assigned Documents" section for the orchestrator (all session documents)
 */
router.get('/:id/documents-section', [
  param('id').isInt().withMessage('Invalid session ID'),
  validate
], async (req, res, next) => {
  try {
    const session = await SessionService.getCompleteSession(
      parseInt(req.params.id),
      req.userId
    );

    const section = ContextManager.buildDocumentsSectionForOrchestrator(session);

    res.json({
      success: true,
      data: { section },
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/sessions/:id/agents/:agentId/documents-section
 * Get the "## Your Assigned Documents" section for an agent
 */
router.get('/:id/agents/:agentId/documents-section', [
  param('id').isInt().withMessage('Invalid session ID'),
  param('agentId').isInt().withMessage('Invalid agent ID'),
  validate
], async (req, res, next) => {
  try {
    const session = await SessionService.getCompleteSession(
      parseInt(req.params.id),
      req.userId
    );

    const agent = (session.agents || []).find(a => a.id === parseInt(req.params.agentId));
    if (!agent) {
      return next(new AppError('Agent not found in session', 404, 'AGENT_NOT_FOUND'));
    }

    const section = ContextManager.buildDocumentsSectionForAgent(agent.id, session);

    res.json({
      success: true,
      data: { section },
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/sessions/:id/agents/:agentId/default-prompt
 * Get the default session prompt for an agent (includes team members, tools, documents)
 */
router.get('/:id/agents/:agentId/default-prompt', [
  param('id').isInt().withMessage('Invalid session ID'),
  param('agentId').isInt().withMessage('Invalid agent ID'),
  validate
], async (req, res, next) => {
  try {
    const session = await SessionService.getCompleteSession(
      parseInt(req.params.id),
      req.userId
    );

    // Find the agent in the session
    const agent = (session.agents || []).find(a => a.id === parseInt(req.params.agentId));
    if (!agent) {
      return next(new AppError('Agent not found in session', 404, 'AGENT_NOT_FOUND'));
    }

    const defaultPrompt = ContextManager.buildDefaultAgentSessionPrompt(agent, session);

    res.json({
      success: true,
      data: { prompt: defaultPrompt },
    });
  } catch (error) {
    if (error.message === 'Session not found' || error.message === 'Unauthorized access to session') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

module.exports = router;
