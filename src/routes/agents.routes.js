const express = require('express');
const router = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const { authenticate } = require('../middleware/auth');
const AgentService = require('../services/agents/AgentService');
const { ProviderFactory } = require('../providers');
const OrchestratorAgent = require('../services/chat/OrchestratorAgent');
const { fetchModelCapabilities } = require('../services/integrations/huggingFaceModelService');
const { fetchOpenRouterModelCapabilities } = require('../services/integrations/openRouterModelService');

// All agent routes require authentication
router.use(authenticate);

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
 * GET /api/agents
 * List all agents for the current user
 */
router.get('/',
  [
    query('role').optional().isString(),
    query('active').optional().isBoolean(),
    query('orderBy').optional().isIn(['name', 'role', 'created_at', 'updated_at']),
    query('order').optional().isIn(['asc', 'desc', 'ASC', 'DESC']),
  ],
  validate,
  async (req, res, next) => {
    try {
      const options = {
        role: req.query.role,
        isActive: req.query.active === undefined ? true : req.query.active === 'true',
        orderBy: req.query.orderBy || 'name',
        order: req.query.order || 'ASC',
      };

      const agents = await AgentService.listAgents(req.userId, options);

      res.json({
        success: true,
        data: {
          agents,
          count: agents.length,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/agents
 * Create a new agent
 */
router.post('/',
  [
    body('name').trim().notEmpty().withMessage('Name is required').isLength({ max: 100 }),
    body('role').trim().notEmpty().withMessage('Role is required').isLength({ max: 50 }),
    body('initial_context').optional().isString(),
    body('provider_type').notEmpty().withMessage('Provider type is required'),
    body('provider_config').isObject().withMessage('Provider config must be an object'),
    body('provider_config.apiKey').optional().isString(),
    body('provider_config.model').optional().isString(),
    body('provider_config.maxTokens').optional().isInt({ min: 1 }),
    body('provider_config.temperature').optional().isFloat({ min: 0, max: 2 }),
    body('provider_config.timeout').optional().isInt({ min: 1000, max: 600000 }),
    body('provider_config.baseURL').optional().isString().isURL({ require_tld: false }),
    body('hf_model_repo').optional({ nullable: true }).isString().isLength({ max: 240 }),
    body('sync_hf_repo').optional({ nullable: true }).isString().isLength({ max: 240 }),
    body('model_capabilities').optional({ nullable: true }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const agent = await AgentService.createAgent(req.userId, req.body);

      res.status(201).json({
        success: true,
        data: { agent },
        message: 'Agent created successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/agents/roles
 * Get predefined agent roles
 */
router.get('/roles', async (req, res) => {
  const roles = AgentService.getPredefinedRoles();
  res.json({
    success: true,
    data: { roles },
  });
});

/**
 * GET /api/agents/default-prompt
 * Get the default system prompt for an agent role
 * Query params:
 *   - role: The agent role (e.g., 'accounting', 'legal', 'marketing', etc.)
 */
router.get('/default-prompt',
  [
    query('role').optional().isString().withMessage('Role must be a string'),
  ],
  validate,
  async (req, res) => {
    const role = req.query.role || 'custom';
    const defaultPrompt = OrchestratorAgent.getDefaultSystemPrompt(role);
    
    res.json({
      success: true,
      data: { 
        prompt: defaultPrompt,
        role: role,
      },
    });
  }
);

/**
 * GET /api/agents/providers
 * Get available LLM providers
 */
router.get('/providers', async (req, res) => {
  const providers = AgentService.getAvailableProviders();
  res.json({
    success: true,
    data: { providers },
  });
});

/**
 * GET /api/agents/huggingface/model?repo_id=org/model
 * Public HF Hub metadata → capability flags (for Create/Edit Agent UI).
 */
router.get('/huggingface/model',
  [
    query('repo_id').trim().notEmpty().withMessage('repo_id is required').isLength({ max: 240 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { capabilities, hf } = await fetchModelCapabilities(req.query.repo_id);
      res.json({
        success: true,
        data: { capabilities, hf },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/agents/openrouter/model?model_id=author/slug
 * OpenRouter catalog metadata → capability flags (for Create/Edit Agent UI).
 */
router.get('/openrouter/model',
  [
    query('model_id').trim().notEmpty().withMessage('model_id is required').isLength({ max: 240 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { capabilities, openrouter } = await fetchOpenRouterModelCapabilities(req.query.model_id);
      res.json({
        success: true,
        data: { capabilities, openrouter },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/agents/:id/sessions
 * Get sessions that use this agent
 * NOTE: This route must come before /:id to avoid route conflicts
 */
router.get('/:id/sessions',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid agent ID'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const sessions = await AgentService.getAgentSessions(
        parseInt(req.params.id),
        req.userId
      );

      res.json({
        success: true,
        data: { sessions },
      });
    } catch (error) {
      if (error.message === 'Agent not found' || error.message.includes('Not authorized')) {
        return res.status(403).json({ success: false, error: error.message });
      }
      next(error);
    }
  }
);

/**
 * GET /api/agents/:id
 * Get a specific agent
 */
router.get('/:id',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid agent ID'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const agent = await AgentService.getAgent(
        parseInt(req.params.id),
        req.userId
      );

      res.json({
        success: true,
        data: { agent },
      });
    } catch (error) {
      if (error.message === 'Agent not found') {
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
 * PUT /api/agents/:id
 * Update an agent
 */
router.put('/:id',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid agent ID'),
    body('name').optional().trim().notEmpty().isLength({ max: 100 }),
    body('role').optional().trim().notEmpty().isLength({ max: 50 }),
    body('initial_context').optional(),
    body('provider_type').optional(),
    body('provider_config').optional().isObject(),
    body('is_active').optional().isBoolean(),
    body('hf_model_repo').optional({ nullable: true }).isString().isLength({ max: 240 }),
    body('sync_hf_repo').optional({ nullable: true }).isString().isLength({ max: 240 }),
    body('model_capabilities').optional({ nullable: true }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const agent = await AgentService.updateAgent(
        parseInt(req.params.id),
        req.userId,
        req.body
      );

      res.json({
        success: true,
        data: { agent },
        message: 'Agent updated successfully',
      });
    } catch (error) {
      if (error.message === 'Agent not found') {
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
 * DELETE /api/agents/:id
 * Delete an agent (soft delete by default)
 */
router.delete('/:id',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid agent ID'),
    query('hard').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const hard = req.query.hard === 'true';

      await AgentService.deleteAgent(
        parseInt(req.params.id),
        req.userId,
        hard
      );

      res.json({
        success: true,
        message: hard ? 'Agent deleted permanently' : 'Agent deactivated',
      });
    } catch (error) {
      if (error.message === 'Agent not found') {
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
 * POST /api/agents/:id/test
 * Test agent provider connectivity
 */
router.post('/:id/test',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid agent ID'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const result = await AgentService.testAgent(
        parseInt(req.params.id),
        req.userId
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      if (error.message === 'Agent not found') {
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
 * POST /api/agents/:id/duplicate
 * Duplicate an agent
 */
router.post('/:id/duplicate',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid agent ID'),
    body('name').optional().trim().isLength({ max: 100 }),
  ],
  validate,
  async (req, res, next) => {
    try {
      const agent = await AgentService.duplicateAgent(
        parseInt(req.params.id),
        req.userId,
        req.body.name
      );

      res.status(201).json({
        success: true,
        data: { agent },
        message: 'Agent duplicated successfully',
      });
    } catch (error) {
      if (error.message === 'Agent not found') {
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
 * POST /api/agents/:id/activate
 * Activate a deactivated agent
 */
router.post('/:id/activate',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid agent ID'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const Agent = require('../models/Agent');
      const agent = await Agent.findById(parseInt(req.params.id));

      if (!agent) {
        return res.status(404).json({ success: false, error: 'Agent not found' });
      }

      if (agent.user_id !== req.userId) {
        return res.status(403).json({ success: false, error: 'Not authorized' });
      }

      await Agent.activate(parseInt(req.params.id));

      res.json({
        success: true,
        message: 'Agent activated successfully',
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * POST /api/agents/test-provider
 * Test a provider configuration without creating an agent
 */
router.post('/test-provider',
  [
    body('provider_type').notEmpty().withMessage('Provider type is required'),
    body('provider_config').isObject().withMessage('Provider config must be an object'),
  ],
  validate,
  async (req, res, next) => {
    try {
      const { provider_type, provider_config } = req.body;

      const result = await ProviderFactory.testProvider(provider_type, provider_config);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * GET /api/agents/:id/export
 * Export agent settings as JSON (optionally includes API key)
 */
router.get('/:id/export',
  [
    param('id').isInt({ min: 1 }).withMessage('Invalid agent ID'),
    query('includeApiKey').optional().isBoolean(),
  ],
  validate,
  async (req, res, next) => {
    try {
      const includeApiKey = req.query.includeApiKey === 'true';
      const agentData = await AgentService.getAgentForExport(
        parseInt(req.params.id),
        req.userId,
        includeApiKey
      );

      res.json({
        success: true,
        data: agentData,
      });
    } catch (error) {
      if (error.message === 'Agent not found') {
        return res.status(404).json({ success: false, error: error.message });
      }
      if (error.message.includes('Not authorized')) {
        return res.status(403).json({ success: false, error: error.message });
      }
      next(error);
    }
  }
);

module.exports = router;
