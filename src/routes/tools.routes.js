/**
 * Tools API Routes
 * Endpoints for listing and executing MCP tools
 */

const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const { toolRegistry } = require('../services/tools/ToolRegistry');
const { toolExecutor } = require('../services/tools/ToolExecutor');
const logger = require('../utils/logger');

/**
 * Get the set of system-enabled tool names from ENABLED_TOOLS env var.
 * Returns null if not set or empty (meaning "all tools enabled").
 */
function getEnabledToolsSet() {
  const val = process.env.ENABLED_TOOLS;
  if (!val || typeof val !== 'string' || val.trim() === '') {
    return null;
  }
  return new Set(val.split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * Filter tools by ENABLED_TOOLS. If no filter configured, returns tools as-is.
 */
function filterByEnabledTools(tools) {
  const enabled = getEnabledToolsSet();
  if (!enabled) return tools;
  return tools.filter(t => enabled.has(t.name));
}

/**
 * GET /api/tools
 * List all available tools (filtered by ENABLED_TOOLS when set)
 */
router.get('/', authenticate, async (req, res) => {
  try {
    const { category, format } = req.query;

    let tools;
    if (category) {
      tools = toolRegistry.getByCategory(category);
    } else {
      tools = toolRegistry.getAll();
    }
    const filteredTools = filterByEnabledTools(tools);

    // Format for LLM if requested
    let resultTools;
    if (format === 'llm') {
      const allowedNames = filteredTools.map(t => t.name);
      resultTools = allowedNames.length
        ? toolRegistry.getToolDefinitionsForLLM(allowedNames)
        : toolRegistry.getToolDefinitionsForLLM();
    } else if (format === 'openai') {
      const allowedNames = filteredTools.map(t => t.name);
      resultTools = allowedNames.length
        ? toolRegistry.getToolDefinitionsForOpenAI(allowedNames)
        : toolRegistry.getToolDefinitionsForOpenAI();
    } else {
      resultTools = filteredTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        category: tool.category,
        parameters: tool.parameters,
        examples: tool.examples,
        requiresAuth: tool.requiresAuth,
      }));
    }

    const categories = toolRegistry.getCategories();
    const enabledSet = getEnabledToolsSet();
    const categoriesFiltered = enabledSet
      ? categories.filter(cat => filteredTools.some(t => t.category === cat))
      : categories;

    res.json({
      success: true,
      data: {
        tools: resultTools,
        count: Array.isArray(resultTools) ? resultTools.length : 0,
        categories: categoriesFiltered,
      },
    });
  } catch (error) {
    logger.error('Failed to list tools', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to list tools',
    });
  }
});

/**
 * GET /api/tools/categories
 * List all tool categories (filtered by ENABLED_TOOLS when set)
 */
router.get('/categories', authenticate, async (req, res) => {
  try {
    let categories = toolRegistry.getCategories();
    let summary = toolRegistry.getSummary();

    const enabledSet = getEnabledToolsSet();
    if (enabledSet) {
      const filteredTools = filterByEnabledTools(toolRegistry.getAll());
      const enabledCategories = [...new Set(filteredTools.map(t => t.category))];
      categories = categories.filter(c => enabledCategories.includes(c));
      summary = Object.fromEntries(
        Object.entries(summary).filter(([cat]) => enabledCategories.includes(cat))
      );
    }

    res.json({
      success: true,
      data: {
        categories,
        summary,
      },
    });
  } catch (error) {
    logger.error('Failed to list tool categories', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to list tool categories',
    });
  }
});

/**
 * GET /api/tools/search
 * Search tools by query (filtered by ENABLED_TOOLS when set)
 */
router.get('/search', authenticate, async (req, res) => {
  try {
    const { q } = req.query;

    if (!q) {
      return res.status(400).json({
        success: false,
        error: 'Search query required',
      });
    }

    let tools = toolRegistry.search(q);
    tools = filterByEnabledTools(tools);

    res.json({
      success: true,
      data: {
        tools: tools.map(tool => ({
          name: tool.name,
          description: tool.description,
          category: tool.category,
        })),
        count: tools.length,
      },
    });
  } catch (error) {
    logger.error('Failed to search tools', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to search tools',
    });
  }
});

/**
 * GET /api/tools/:name
 * Get tool details by name
 */
router.get('/:name', authenticate, async (req, res) => {
  try {
    const { name } = req.params;
    const tool = toolRegistry.get(name);

    if (!tool) {
      return res.status(404).json({
        success: false,
        error: 'Tool not found',
      });
    }

    res.json({
      success: true,
      data: {
        name: tool.name,
        description: tool.description,
        category: tool.category,
        parameters: tool.parameters,
        examples: tool.examples,
        requiresAuth: tool.requiresAuth,
        registeredAt: tool.registeredAt,
      },
    });
  } catch (error) {
    logger.error('Failed to get tool', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get tool',
    });
  }
});

/**
 * POST /api/tools/:name/execute
 * Execute a tool with parameters
 */
router.post('/:name/execute', authenticate, async (req, res) => {
  try {
    const { name } = req.params;
    const { parameters = {} } = req.body;

    // Build execution context
    const context = {
      userId: req.user.userId,
      sessionId: req.body.sessionId,
      source: 'api',
    };

    const result = await toolExecutor.execute(name, parameters, context);

    res.json({
      success: result.success,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to execute tool', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to execute tool',
    });
  }
});

/**
 * POST /api/tools/execute-sequence
 * Execute multiple tools in sequence
 */
router.post('/execute-sequence', authenticate, async (req, res) => {
  try {
    const { toolCalls } = req.body;

    if (!toolCalls || !Array.isArray(toolCalls)) {
      return res.status(400).json({
        success: false,
        error: 'toolCalls array required',
      });
    }

    const context = {
      userId: req.user.userId,
      sessionId: req.body.sessionId,
      source: 'api',
    };

    const results = await toolExecutor.executeSequence(toolCalls, context);

    res.json({
      success: true,
      data: {
        results,
        totalExecutions: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
      },
    });
  } catch (error) {
    logger.error('Failed to execute tool sequence', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to execute tool sequence',
    });
  }
});

/**
 * POST /api/tools/execute-parallel
 * Execute multiple tools in parallel
 */
router.post('/execute-parallel', authenticate, async (req, res) => {
  try {
    const { toolCalls } = req.body;

    if (!toolCalls || !Array.isArray(toolCalls)) {
      return res.status(400).json({
        success: false,
        error: 'toolCalls array required',
      });
    }

    const context = {
      userId: req.user.userId,
      sessionId: req.body.sessionId,
      source: 'api',
    };

    const results = await toolExecutor.executeParallel(toolCalls, context);

    res.json({
      success: true,
      data: {
        results,
        totalExecutions: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
      },
    });
  } catch (error) {
    logger.error('Failed to execute tools in parallel', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to execute tools in parallel',
    });
  }
});

/**
 * GET /api/tools/stats/executions
 * Get tool execution statistics
 */
router.get('/stats/executions', authenticate, async (req, res) => {
  try {
    const stats = toolExecutor.getStats();
    const recentExecutions = toolExecutor.getRecentExecutions(10);

    res.json({
      success: true,
      data: {
        stats,
        recentExecutions: recentExecutions.map(e => ({
          executionId: e.executionId,
          toolName: e.toolName,
          success: e.result.success,
          executionTime: e.executionTime,
          timestamp: e.timestamp,
        })),
      },
    });
  } catch (error) {
    logger.error('Failed to get execution stats', { error: error.message });
    res.status(500).json({
      success: false,
      error: 'Failed to get execution stats',
    });
  }
});

module.exports = router;
