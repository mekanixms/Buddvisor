/**
 * Tasks Routes
 * API endpoints for formal task management
 */

const express = require('express');
const router = express.Router();
const { body, param, query } = require('express-validator');
const validate = require('../middleware/validation');
const { authenticate } = require('../middleware/auth');
const { AppError } = require('../middleware/errorHandler');
const { TaskService } = require('../services/tasks/TaskService');
const { taskExecutor } = require('../services/tasks/TaskExecutor');
const { ExecutionMode } = require('../models/Task');
const logger = require('../utils/logger');

// All task routes require authentication
router.use(authenticate);

/**
 * GET /api/tasks
 * List tasks for the current user
 */
router.get('/', [
  query('session_id').optional().isInt().withMessage('Invalid session ID'),
  query('status').optional().isIn(['pending', 'running', 'completed', 'failed', 'cancelled']),
  query('limit').optional().isInt({ min: 1, max: 100 }),
  query('offset').optional().isInt({ min: 0 }),
  validate,
], async (req, res, next) => {
  try {
    const options = {
      sessionId: req.query.session_id ? parseInt(req.query.session_id) : null,
      status: req.query.status || null,
      limit: parseInt(req.query.limit) || 50,
      offset: parseInt(req.query.offset) || 0,
    };

    const tasks = await TaskService.listTasks(req.userId, options);

    res.json({
      success: true,
      data: { tasks },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/tasks/stats
 * Get task statistics for the current user
 */
router.get('/stats', async (req, res, next) => {
  try {
    const stats = await TaskService.getStats(req.userId);

    res.json({
      success: true,
      data: { stats },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/tasks
 * Create a new task
 */
router.post('/', [
  body('session_id').isInt().withMessage('Session ID is required'),
  body('task_description')
    .trim()
    .isLength({ min: 10, max: 5000 })
    .withMessage('Task description must be between 10 and 5000 characters'),
  body('execution_mode')
    .optional()
    .isIn(Object.values(ExecutionMode))
    .withMessage('Invalid execution mode'),
  body('assigned_agents')
    .optional()
    .isArray()
    .withMessage('Assigned agents must be an array'),
  body('priority')
    .optional()
    .isIn(['low', 'normal', 'high'])
    .withMessage('Invalid priority'),
  validate,
], async (req, res, next) => {
  try {
    const task = await TaskService.createTask(req.userId, {
      session_id: req.body.session_id,
      task_description: req.body.task_description,
      execution_mode: req.body.execution_mode,
      assigned_agents: req.body.assigned_agents,
      priority: req.body.priority,
    });

    res.status(201).json({
      success: true,
      message: 'Task created and queued for execution',
      data: { task },
    });
  } catch (error) {
    if (error.message === 'Session not found or access denied') {
      return next(new AppError(error.message, 404, 'SESSION_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/tasks/:id
 * Get a specific task
 */
router.get('/:id', [
  param('id').isInt().withMessage('Invalid task ID'),
  validate,
], async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = await TaskService.getTaskWithResults(taskId, req.userId);

    res.json({
      success: true,
      data: { task },
    });
  } catch (error) {
    if (error.message === 'Task not found or access denied') {
      return next(new AppError(error.message, 404, 'TASK_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/tasks/:id/results
 * Get results for a task
 */
router.get('/:id/results', [
  param('id').isInt().withMessage('Invalid task ID'),
  validate,
], async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id);
    const results = await TaskService.getTaskResults(taskId, req.userId);

    res.json({
      success: true,
      data: { results },
    });
  } catch (error) {
    if (error.message === 'Task not found or access denied') {
      return next(new AppError(error.message, 404, 'TASK_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * GET /api/tasks/:id/output
 * Get combined output for a task
 */
router.get('/:id/output', [
  param('id').isInt().withMessage('Invalid task ID'),
  validate,
], async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id);
    const output = await TaskService.getTaskOutput(taskId, req.userId);

    res.json({
      success: true,
      data: { output },
    });
  } catch (error) {
    if (error.message === 'Task not found or access denied') {
      return next(new AppError(error.message, 404, 'TASK_NOT_FOUND'));
    }
    next(error);
  }
});

/**
 * PUT /api/tasks/:id
 * Update a task
 */
router.put('/:id', [
  param('id').isInt().withMessage('Invalid task ID'),
  body('task_description')
    .optional()
    .trim()
    .isLength({ min: 10, max: 5000 }),
  body('execution_mode')
    .optional()
    .isIn(Object.values(ExecutionMode)),
  body('priority')
    .optional()
    .isIn(['low', 'normal', 'high']),
  validate,
], async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id);
    const updates = {};

    if (req.body.task_description) updates.task_description = req.body.task_description;
    if (req.body.execution_mode) updates.execution_mode = req.body.execution_mode;
    if (req.body.priority) updates.priority = req.body.priority;

    const task = await TaskService.updateTask(taskId, req.userId, updates);

    res.json({
      success: true,
      message: 'Task updated successfully',
      data: { task },
    });
  } catch (error) {
    if (error.message === 'Task not found or access denied') {
      return next(new AppError(error.message, 404, 'TASK_NOT_FOUND'));
    }
    if (error.message === 'Cannot update a running task') {
      return next(new AppError(error.message, 400, 'TASK_RUNNING'));
    }
    next(error);
  }
});

/**
 * POST /api/tasks/:id/retry
 * Retry a failed or cancelled task
 */
router.post('/:id/retry', [
  param('id').isInt().withMessage('Invalid task ID'),
  validate,
], async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = await TaskService.retryTask(taskId, req.userId);

    res.json({
      success: true,
      message: 'Task queued for retry',
      data: { task },
    });
  } catch (error) {
    if (error.message === 'Task not found or access denied') {
      return next(new AppError(error.message, 404, 'TASK_NOT_FOUND'));
    }
    if (error.message.includes('Can only retry')) {
      return next(new AppError(error.message, 400, 'INVALID_STATUS'));
    }
    next(error);
  }
});

/**
 * POST /api/tasks/:id/cancel
 * Cancel a pending or running task
 */
router.post('/:id/cancel', [
  param('id').isInt().withMessage('Invalid task ID'),
  validate,
], async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id);
    const task = await TaskService.cancelTask(taskId, req.userId);

    res.json({
      success: true,
      message: 'Task cancelled',
      data: { task },
    });
  } catch (error) {
    if (error.message === 'Task not found or access denied') {
      return next(new AppError(error.message, 404, 'TASK_NOT_FOUND'));
    }
    if (error.message.includes('Cannot cancel')) {
      return next(new AppError(error.message, 400, 'INVALID_STATUS'));
    }
    next(error);
  }
});

/**
 * POST /api/tasks/:id/run
 * Manually trigger task execution (admin/debug)
 */
router.post('/:id/run', [
  param('id').isInt().withMessage('Invalid task ID'),
  validate,
], async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id);

    // Verify access first
    await TaskService.getTask(taskId, req.userId);

    // Run the task
    const task = await taskExecutor.runTask(taskId);

    res.json({
      success: true,
      message: 'Task execution started',
      data: { task },
    });
  } catch (error) {
    if (error.message === 'Task not found or access denied') {
      return next(new AppError(error.message, 404, 'TASK_NOT_FOUND'));
    }
    if (error.message === 'Task is already running') {
      return next(new AppError(error.message, 400, 'TASK_RUNNING'));
    }
    next(error);
  }
});

/**
 * DELETE /api/tasks/:id
 * Delete a task
 */
router.delete('/:id', [
  param('id').isInt().withMessage('Invalid task ID'),
  validate,
], async (req, res, next) => {
  try {
    const taskId = parseInt(req.params.id);
    await TaskService.deleteTask(taskId, req.userId);

    res.json({
      success: true,
      message: 'Task deleted successfully',
    });
  } catch (error) {
    if (error.message === 'Task not found or access denied') {
      return next(new AppError(error.message, 404, 'TASK_NOT_FOUND'));
    }
    if (error.message === 'Cannot delete a running task') {
      return next(new AppError(error.message, 400, 'TASK_RUNNING'));
    }
    next(error);
  }
});

module.exports = router;
