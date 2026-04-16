/**
 * Tool Executor
 * Safely executes registered tools with validation and error handling
 */

const { toolRegistry } = require('./ToolRegistry');
const logger = require('../../utils/logger');

class ToolExecutor {
  constructor() {
    this.executionTimeout = 30000; // 30 seconds default timeout
    this.executionHistory = [];
    this.maxHistorySize = 100;
  }

  /**
   * Execute a tool by name
   * @param {string} toolName - Name of the tool to execute
   * @param {object} parameters - Tool parameters
   * @param {object} context - Execution context (userId, sessionId, etc.)
   * @returns {object} - Execution result
   */
  async execute(toolName, parameters = {}, context = {}) {
    const startTime = Date.now();
    const executionId = this.generateExecutionId();

    try {
      // Get tool from registry
      const tool = toolRegistry.get(toolName);
      if (!tool) {
        throw new Error(`Tool not found: ${toolName}`);
      }

      // Check authentication if required
      if (tool.requiresAuth && !context.userId) {
        throw new Error(`Tool ${toolName} requires authentication`);
      }

      // Validate parameters
      const validationResult = this.validateParameters(tool.parameters, parameters);
      if (!validationResult.valid) {
        throw new Error(`Invalid parameters: ${validationResult.errors.join(', ')}`);
      }

      // Execute with timeout (use tool-specific timeout if set, else default)
      const timeout = tool.executionTimeout != null ? tool.executionTimeout : this.executionTimeout;
      const result = await this.executeWithTimeout(
        tool.handler,
        parameters,
        context,
        timeout
      );

      const executionTime = Date.now() - startTime;

      // Log execution
      this.logExecution({
        executionId,
        toolName,
        parameters,
        context: { userId: context.userId, sessionId: context.sessionId },
        result: { success: true },
        executionTime,
      });

      logger.info(`Tool executed: ${toolName} (${executionTime}ms)`);

      return {
        success: true,
        toolName,
        result,
        executionTime,
        executionId,
      };
    } catch (error) {
      const executionTime = Date.now() - startTime;

      // Log failed execution
      this.logExecution({
        executionId,
        toolName,
        parameters,
        context: { userId: context.userId, sessionId: context.sessionId },
        result: { success: false, error: error.message },
        executionTime,
      });

      logger.error(`Tool execution failed: ${toolName}`, { error: error.message });

      return {
        success: false,
        toolName,
        error: error.message,
        executionTime,
        executionId,
      };
    }
  }

  /**
   * Execute multiple tools in sequence
   */
  async executeSequence(toolCalls, context = {}) {
    const results = [];

    for (const call of toolCalls) {
      const result = await this.execute(call.name, call.parameters, context);
      results.push(result);

      // Stop on first error if specified
      if (!result.success && call.stopOnError !== false) {
        break;
      }
    }

    return results;
  }

  /**
   * Execute multiple tools in parallel
   */
  async executeParallel(toolCalls, context = {}) {
    const promises = toolCalls.map(call =>
      this.execute(call.name, call.parameters, context)
    );

    return Promise.all(promises);
  }

  /**
   * Execute with timeout
   */
  async executeWithTimeout(handler, parameters, context, timeout) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error('Tool execution timed out'));
      }, timeout);

      Promise.resolve(handler(parameters, context))
        .then(result => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch(error => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Validate parameters against schema
   */
  validateParameters(schema, parameters) {
    const errors = [];

    // Check required parameters
    for (const [name, definition] of Object.entries(schema)) {
      if (definition.required && (parameters[name] === undefined || parameters[name] === null)) {
        errors.push(`Missing required parameter: ${name}`);
        continue;
      }

      if (parameters[name] !== undefined) {
        // Type validation
        const value = parameters[name];
        const expectedType = definition.type;

        if (expectedType === 'number' && typeof value !== 'number') {
          errors.push(`Parameter ${name} must be a number`);
        } else if (expectedType === 'string' && typeof value !== 'string') {
          errors.push(`Parameter ${name} must be a string`);
        } else if (expectedType === 'boolean' && typeof value !== 'boolean') {
          errors.push(`Parameter ${name} must be a boolean`);
        } else if (expectedType === 'array' && !Array.isArray(value)) {
          errors.push(`Parameter ${name} must be an array`);
        } else if (expectedType === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
          errors.push(`Parameter ${name} must be an object`);
        }

        // Enum validation
        if (definition.enum && !definition.enum.includes(value)) {
          errors.push(`Parameter ${name} must be one of: ${definition.enum.join(', ')}`);
        }

        // Range validation for numbers
        if (expectedType === 'number') {
          if (definition.minimum !== undefined && value < definition.minimum) {
            errors.push(`Parameter ${name} must be >= ${definition.minimum}`);
          }
          if (definition.maximum !== undefined && value > definition.maximum) {
            errors.push(`Parameter ${name} must be <= ${definition.maximum}`);
          }
        }

        // Length validation for strings
        if (expectedType === 'string') {
          if (definition.minLength !== undefined && value.length < definition.minLength) {
            errors.push(`Parameter ${name} must be at least ${definition.minLength} characters`);
          }
          if (definition.maxLength !== undefined && value.length > definition.maxLength) {
            errors.push(`Parameter ${name} must be at most ${definition.maxLength} characters`);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Log execution to history
   */
  logExecution(execution) {
    execution.timestamp = new Date().toISOString();
    this.executionHistory.unshift(execution);

    // Trim history if needed
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory = this.executionHistory.slice(0, this.maxHistorySize);
    }
  }

  /**
   * Get recent executions
   */
  getRecentExecutions(limit = 10) {
    return this.executionHistory.slice(0, limit);
  }

  /**
   * Get executions by tool name
   */
  getExecutionsByTool(toolName, limit = 10) {
    return this.executionHistory
      .filter(e => e.toolName === toolName)
      .slice(0, limit);
  }

  /**
   * Generate execution ID
   */
  generateExecutionId() {
    return `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Set execution timeout
   */
  setTimeout(timeout) {
    this.executionTimeout = timeout;
  }

  /**
   * Get execution statistics
   */
  getStats() {
    const totalExecutions = this.executionHistory.length;
    const successfulExecutions = this.executionHistory.filter(e => e.result.success).length;
    const failedExecutions = totalExecutions - successfulExecutions;

    const avgExecutionTime = totalExecutions > 0
      ? this.executionHistory.reduce((sum, e) => sum + e.executionTime, 0) / totalExecutions
      : 0;

    const toolUsage = {};
    for (const execution of this.executionHistory) {
      toolUsage[execution.toolName] = (toolUsage[execution.toolName] || 0) + 1;
    }

    return {
      totalExecutions,
      successfulExecutions,
      failedExecutions,
      successRate: totalExecutions > 0 ? (successfulExecutions / totalExecutions * 100).toFixed(1) : 0,
      avgExecutionTime: Math.round(avgExecutionTime),
      toolUsage,
    };
  }
}

// Create singleton instance
const toolExecutor = new ToolExecutor();

module.exports = { ToolExecutor, toolExecutor };
