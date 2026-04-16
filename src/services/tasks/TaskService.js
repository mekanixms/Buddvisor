/**
 * Task Service
 * Handles business logic for formal task management
 */

const { Task, TaskStatus, ExecutionMode } = require('../../models/Task');
const { TaskResult } = require('../../models/TaskResult');
const WorkSession = require('../../models/WorkSession');
const Message = require('../../models/Message');
const Agent = require('../../models/Agent');
const logger = require('../../utils/logger');

class TaskService {
  /**
   * Create a new task
   */
  static async createTask(userId, taskData) {
    const {
      session_id,
      task_description,
      execution_mode = ExecutionMode.ADAPTIVE,
      assigned_agents = null,
      priority = 'normal',
    } = taskData;

    // Verify session access
    const session = await WorkSession.findById(session_id);
    if (!session || session.user_id !== userId) {
      throw new Error('Session not found or access denied');
    }

    // Get session agents if not specified
    let agentIds = assigned_agents;
    let agents = [];
    if (!agentIds) {
      const sessionAgents = await WorkSession.getAgents(session_id);
      agentIds = sessionAgents.map(a => a.id);
      agents = sessionAgents;
    } else {
      // Get agent details for assigned agents
      for (const agentId of agentIds) {
        const agent = await Agent.findById(agentId);
        if (agent) {
          agents.push(agent);
        }
      }
    }

    // Create the task
    const task = await Task.create({
      session_id,
      user_id: userId,
      task_description,
      execution_mode,
      assigned_agents: agentIds,
      priority,
      metadata: {
        session_name: session.name,
        created_from: 'api',
      },
    });

    // Format agent names for message
    const agentNames = agents.map(a => a.name).join(', ');
    const agentText = agentNames || 'agents';

    // Also create a message in the session for tracking
    await Message.create({
      session_id,
      role: 'system',
      content: `Task created for ${agentText}: ${task_description}`,
      metadata: { task_id: task.id },
    });

    logger.info(`Task ${task.id} created for session ${session_id}`);

    return task;
  }

  /**
   * Get task by ID with access check
   */
  static async getTask(taskId, userId) {
    const task = await Task.findByIdAndUser(taskId, userId);
    if (!task) {
      throw new Error('Task not found or access denied');
    }
    return task;
  }

  /**
   * Get task with full details including results
   */
  static async getTaskWithResults(taskId, userId) {
    const task = await this.getTask(taskId, userId);
    const results = await TaskResult.findByTask(taskId);
    const summary = await TaskResult.getTaskSummary(taskId);

    return {
      ...task,
      results,
      summary,
    };
  }

  /**
   * List tasks for a user
   */
  static async listTasks(userId, options = {}) {
    const tasks = await Task.findByUser(userId, options);
    return tasks;
  }

  /**
   * List tasks for a session
   */
  static async listSessionTasks(sessionId, userId, options = {}) {
    // Verify session access
    const session = await WorkSession.findById(sessionId);
    if (!session || session.user_id !== userId) {
      throw new Error('Session not found or access denied');
    }

    return await Task.findBySession(sessionId, options);
  }

  /**
   * Get task results
   */
  static async getTaskResults(taskId, userId) {
    await this.getTask(taskId, userId); // Access check
    return await TaskResult.findByTask(taskId);
  }

  /**
   * Get combined task output
   */
  static async getTaskOutput(taskId, userId) {
    await this.getTask(taskId, userId); // Access check
    return await TaskResult.getCombinedOutput(taskId);
  }

  /**
   * Cancel a task
   */
  static async cancelTask(taskId, userId) {
    const task = await this.getTask(taskId, userId);

    if (task.status === TaskStatus.COMPLETED || task.status === TaskStatus.FAILED) {
      throw new Error('Cannot cancel a completed or failed task');
    }

    await Task.updateStatus(taskId, TaskStatus.CANCELLED);
    logger.info(`Task ${taskId} cancelled`);

    return await Task.findById(taskId);
  }

  /**
   * Retry a failed task
   */
  static async retryTask(taskId, userId) {
    const task = await this.getTask(taskId, userId);

    if (task.status !== TaskStatus.FAILED && task.status !== TaskStatus.CANCELLED) {
      throw new Error('Can only retry failed or cancelled tasks');
    }

    // Clear old results
    await TaskResult.deleteByTask(taskId);

    // Reset task status
    await Task.updateStatus(taskId, TaskStatus.PENDING);

    logger.info(`Task ${taskId} queued for retry`);

    return await Task.findById(taskId);
  }

  /**
   * Delete a task
   */
  static async deleteTask(taskId, userId) {
    const task = await this.getTask(taskId, userId);

    if (task.status === TaskStatus.RUNNING) {
      throw new Error('Cannot delete a running task');
    }

    await Task.delete(taskId);
    logger.info(`Task ${taskId} deleted`);
  }

  /**
   * Get task statistics for a user
   */
  static async getStats(userId) {
    const counts = await Task.countByStatus(userId);
    return counts;
  }

  /**
   * Update task (description, priority, etc.)
   */
  static async updateTask(taskId, userId, updates) {
    const task = await this.getTask(taskId, userId);

    if (task.status === TaskStatus.RUNNING) {
      throw new Error('Cannot update a running task');
    }

    return await Task.update(taskId, updates);
  }

  /**
   * Determine execution mode based on task complexity
   */
  static analyzeTaskComplexity(taskDescription, agents) {
    // Simple heuristics for execution mode selection
    const description = taskDescription.toLowerCase();

    // Check for multi-domain keywords
    const domainKeywords = {
      legal: ['legal', 'law', 'compliance', 'regulation', 'contract'],
      accounting: ['tax', 'accounting', 'financial', 'budget', 'expense'],
      marketing: ['marketing', 'brand', 'advertising', 'campaign', 'promotion'],
      sales: ['sales', 'revenue', 'customer', 'pricing', 'deal'],
      logistics: ['logistics', 'shipping', 'inventory', 'supply chain', 'warehouse'],
      production: ['production', 'manufacturing', 'quality', 'process'],
      hr: ['hr', 'hiring', 'employee', 'recruitment', 'salary'],
    };

    const matchedDomains = new Set();
    for (const [domain, keywords] of Object.entries(domainKeywords)) {
      if (keywords.some(kw => description.includes(kw))) {
        matchedDomains.add(domain);
      }
    }

    // Determine execution mode
    if (matchedDomains.size === 0) {
      return ExecutionMode.SINGLE;
    } else if (matchedDomains.size === 1) {
      return ExecutionMode.SINGLE;
    } else if (matchedDomains.size <= 2) {
      return ExecutionMode.SEQUENTIAL;
    } else {
      return ExecutionMode.PARALLEL;
    }
  }

  /**
   * Select best agent for a single-agent task
   */
  static selectBestAgent(taskDescription, agents) {
    const description = taskDescription.toLowerCase();

    // Score each agent based on relevance
    const scores = agents.map(agent => {
      let score = 0;
      const roleKeywords = {
        legal: ['legal', 'law', 'compliance', 'contract', 'liability'],
        accounting: ['tax', 'accounting', 'financial', 'expense', 'budget', 'deduction'],
        marketing: ['marketing', 'brand', 'advertising', 'social media', 'promotion'],
        sales: ['sales', 'revenue', 'customer', 'pricing', 'close'],
        logistics: ['logistics', 'shipping', 'inventory', 'supply', 'delivery'],
        production: ['production', 'manufacturing', 'quality', 'assembly'],
        hr: ['hr', 'hiring', 'employee', 'recruitment', 'payroll'],
      };

      const keywords = roleKeywords[agent.role] || [];
      for (const keyword of keywords) {
        if (description.includes(keyword)) {
          score += 1;
        }
      }

      return { agent, score };
    });

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    // Return best match (or first agent if no matches)
    return scores[0]?.agent || agents[0];
  }
}

module.exports = { TaskService };
