/**
 * Task Executor
 * Handles background execution of formal tasks
 */

const { Task, TaskStatus, ExecutionMode } = require('../../models/Task');
const { TaskResult } = require('../../models/TaskResult');
const AgentService = require('../agents/AgentService');
const DocumentService = require('../documents/DocumentService');
const { TaskService } = require('./TaskService');
const WorkSession = require('../../models/WorkSession');
const Message = require('../../models/Message');
const logger = require('../../utils/logger');

class TaskExecutor {
  constructor() {
    this.isRunning = false;
    this.pollingInterval = null;
    this.pollIntervalMs = 5000; // Check for new tasks every 5 seconds
    this.maxConcurrent = 3;
    this.runningTasks = new Set();
  }

  /**
   * Start the task executor
   */
  start() {
    if (this.isRunning) {
      logger.warn('Task executor already running');
      return;
    }

    this.isRunning = true;
    logger.info('Task executor started');

    this.pollingInterval = setInterval(() => {
      this.processPendingTasks();
    }, this.pollIntervalMs);

    // Process immediately on start
    this.processPendingTasks();
  }

  /**
   * Stop the task executor
   */
  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    logger.info('Task executor stopped');
  }

  /**
   * Process pending tasks
   */
  async processPendingTasks() {
    if (this.runningTasks.size >= this.maxConcurrent) {
      return; // At capacity
    }

    try {
      const availableSlots = this.maxConcurrent - this.runningTasks.size;
      const pendingTasks = await Task.getPending(availableSlots);

      for (const task of pendingTasks) {
        if (!this.runningTasks.has(task.id)) {
          this.executeTask(task); // Don't await - run in background
        }
      }
    } catch (error) {
      logger.error('Error processing pending tasks:', error);
    }
  }

  /**
   * Execute a single task
   */
  async executeTask(task) {
    this.runningTasks.add(task.id);
    const startTime = Date.now();

    try {
      logger.info(`Starting execution of task ${task.id}`);

      // Update status to running
      await Task.updateStatus(task.id, TaskStatus.RUNNING);

      // Get session and agents
      const session = await WorkSession.findById(task.session_id);
      const allAgents = await WorkSession.getAgents(task.session_id);

      // Filter to assigned agents if specified
      let agents = allAgents;
      if (task.assigned_agents && task.assigned_agents.length > 0) {
        agents = allAgents.filter(a => task.assigned_agents.includes(a.id));
      }

      if (agents.length === 0) {
        throw new Error('No agents available for task execution');
      }

      // Get relevant document context
      let documentContext = '';
      const documents = await WorkSession.getDocuments(task.session_id);
      if (documents.length > 0) {
        try {
          const relevantChunks = await DocumentService.getSessionDocumentContext(
            task.session_id,
            task.task_description,
            5
          );
          if (relevantChunks.length > 0) {
            documentContext = this.formatDocumentContext(relevantChunks);
          }
        } catch (error) {
          logger.warn('Could not get document context:', error.message);
        }
      }

      // Determine execution mode
      let executionMode = task.execution_mode;
      if (executionMode === ExecutionMode.ADAPTIVE) {
        executionMode = TaskService.analyzeTaskComplexity(task.task_description, agents);
      }

      // Execute based on mode
      let results;
      switch (executionMode) {
        case ExecutionMode.SINGLE:
          results = await this.executeSingle(task, agents, documentContext, session);
          break;
        case ExecutionMode.SEQUENTIAL:
          results = await this.executeSequential(task, agents, documentContext, session);
          break;
        case ExecutionMode.PARALLEL:
          results = await this.executeParallel(task, agents, documentContext, session);
          break;
        default:
          results = await this.executeSingle(task, agents, documentContext, session);
      }

      // Store results
      for (const result of results) {
        await TaskResult.create({
          task_id: task.id,
          agent_id: result.agentId,
          agent_name: result.agentName,
          result_type: 'response',
          result_text: result.content,
          execution_time_ms: result.executionTime,
          tokens_used: result.tokensUsed || 0,
        });
      }

      // Update task status to completed
      await Task.updateStatus(task.id, TaskStatus.COMPLETED);

      // Format agent names for message
      const agentNames = results.map(r => r.agentName).filter(Boolean);
      const agentText = agentNames.length > 0 ? agentNames.join(', ') : 'agents';

      // Add completion message to session
      const combinedOutput = await TaskResult.getCombinedOutput(task.id);
      await Message.create({
        session_id: task.session_id,
        role: 'assistant',
        content: `Task completed by ${agentText}: ${task.task_description}\n\n${combinedOutput?.text || 'No output generated'}`,
        metadata: { task_id: task.id, is_task_result: true },
      });

      const totalTime = Date.now() - startTime;
      logger.info(`Task ${task.id} completed in ${totalTime}ms`);
    } catch (error) {
      logger.error(`Task ${task.id} failed:`, error);
      await Task.updateStatus(task.id, TaskStatus.FAILED, error.message);

      // Add failure message to session
      await Message.create({
        session_id: task.session_id,
        role: 'system',
        content: `Task failed: ${task.task_description}\nError: ${error.message}`,
        metadata: { task_id: task.id, is_task_error: true },
      });
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  /**
   * Execute with a single best-fit agent
   */
  async executeSingle(task, agents, documentContext, session) {
    const agent = TaskService.selectBestAgent(task.task_description, agents);
    const startTime = Date.now();

    try {
      const provider = await AgentService.getAgentProvider(agent.id, task.user_id);
      const systemPrompt = this.buildTaskPrompt(agent, task, documentContext);

      const response = await provider.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: task.task_description },
      ]);

      return [{
        agentId: agent.id,
        agentName: agent.name,
        content: response.content,
        executionTime: Date.now() - startTime,
        tokensUsed: response.usage?.total_tokens || 0,
      }];
    } catch (error) {
      logger.error(`Agent ${agent.name} failed:`, error);
      throw error;
    }
  }

  /**
   * Execute with multiple agents sequentially
   */
  async executeSequential(task, agents, documentContext, session) {
    const results = [];
    let previousResults = '';

    for (const agent of agents) {
      const startTime = Date.now();

      try {
        const provider = await AgentService.getAgentProvider(agent.id, task.user_id);

        // Include previous results in context
        let contextAddition = '';
        if (previousResults) {
          contextAddition = `\n\nPrevious analysis from other specialists:\n${previousResults}`;
        }

        const systemPrompt = this.buildTaskPrompt(agent, task, documentContext + contextAddition);

        const response = await provider.chat([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: task.task_description },
        ]);

        results.push({
          agentId: agent.id,
          agentName: agent.name,
          content: response.content,
          executionTime: Date.now() - startTime,
          tokensUsed: response.usage?.total_tokens || 0,
        });

        // Add to context for next agent
        previousResults += `\n\n[${agent.name}]: ${response.content}`;
      } catch (error) {
        logger.error(`Agent ${agent.name} failed in sequential execution:`, error);
        results.push({
          agentId: agent.id,
          agentName: agent.name,
          content: `Error: ${error.message}`,
          executionTime: Date.now() - startTime,
          tokensUsed: 0,
        });
      }
    }

    return results;
  }

  /**
   * Execute with multiple agents in parallel
   */
  async executeParallel(task, agents, documentContext, session) {
    const promises = agents.map(async (agent) => {
      const startTime = Date.now();

      try {
        const provider = await AgentService.getAgentProvider(agent.id, task.user_id);
        const systemPrompt = this.buildTaskPrompt(agent, task, documentContext);

        const response = await provider.chat([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: task.task_description },
        ]);

        return {
          agentId: agent.id,
          agentName: agent.name,
          content: response.content,
          executionTime: Date.now() - startTime,
          tokensUsed: response.usage?.total_tokens || 0,
        };
      } catch (error) {
        logger.error(`Agent ${agent.name} failed in parallel execution:`, error);
        return {
          agentId: agent.id,
          agentName: agent.name,
          content: `Error: ${error.message}`,
          executionTime: Date.now() - startTime,
          tokensUsed: 0,
        };
      }
    });

    return await Promise.all(promises);
  }

  /**
   * Build task prompt for an agent
   */
  buildTaskPrompt(agent, task, documentContext) {
    const roleDescription = this.getRoleDescription(agent.role);
    const basePrompt = agent.system_prompt || this.getDefaultSystemPrompt(agent.role);

    return `${basePrompt}

--- Your Identity ---
Your name is: ${agent.name}
Your role is: ${agent.role}

When you see messages in the conversation history, messages from you will be labeled with your name "${agent.name}". When the user refers to you by name "${agent.name}", they are addressing you directly.

--- CRITICAL: When to Respond ---
You MUST ONLY answer when:
1. The question is addressed to you specifically by name "${agent.name}" or "@${agent.name}"
2. The question is addressed to "the team" or "@team"

Otherwise, you MUST NEVER answer. If a question is not addressed to you or the team, remain silent and do not respond.

You are working on a formal task that requires a comprehensive, well-structured response.

${documentContext ? `\n--- Relevant Document Context ---\n${documentContext}\n--- End Document Context ---\n` : ''}

Please provide a thorough analysis and recommendations for the following task. Structure your response with clear sections and actionable items where appropriate.`;
  }

  /**
   * Format document context
   */
  formatDocumentContext(chunks) {
    return chunks.map((chunk, idx) => {
      return `[Document: ${chunk.filename}]\n${chunk.text}`;
    }).join('\n\n');
  }

  /**
   * Get role description
   */
  getRoleDescription(role) {
    const descriptions = {
      legal: 'Legal compliance and regulations specialist',
      accounting: 'Financial accounting and tax expert',
      marketing: 'Marketing strategy specialist',
      sales: 'Sales and revenue consultant',
      logistics: 'Supply chain and operations expert',
      production: 'Manufacturing and production specialist',
      hr: 'Human resources specialist',
      custom: 'Business advisor',
    };
    return descriptions[role] || 'Business advisor';
  }

  /**
   * Get default system prompt for a role
   */
  getDefaultSystemPrompt(role) {
    const prompts = {
      legal: `You are a legal advisor specializing in small business law. Provide detailed analysis of legal requirements, compliance obligations, and risk mitigation strategies. Always recommend consulting with a licensed attorney for specific legal advice.`,
      accounting: `You are an accounting expert for small businesses. Provide detailed financial analysis, tax planning strategies, and accounting best practices. Always recommend consulting with a CPA for specific tax advice.`,
      marketing: `You are a marketing strategist. Provide comprehensive marketing recommendations including target audience analysis, channel strategies, and campaign ideas with measurable goals.`,
      sales: `You are a sales consultant. Provide detailed sales process recommendations, pricing strategies, and customer acquisition tactics with clear action items.`,
      logistics: `You are a logistics coordinator. Provide comprehensive supply chain analysis, inventory optimization strategies, and operational efficiency recommendations.`,
      production: `You are a production manager. Provide detailed manufacturing process analysis, quality control recommendations, and production optimization strategies.`,
      hr: `You are an HR specialist. Provide comprehensive human resources recommendations including hiring processes, policies, and compliance requirements.`,
      custom: `You are a knowledgeable business advisor. Provide helpful, accurate, and actionable information.`,
    };
    return prompts[role] || prompts.custom;
  }

  /**
   * Manually trigger task execution (for testing/debugging)
   */
  async runTask(taskId) {
    const task = await Task.findById(taskId);
    if (!task) {
      throw new Error('Task not found');
    }
    if (task.status === TaskStatus.RUNNING) {
      throw new Error('Task is already running');
    }
    await this.executeTask(task);
    return await Task.findById(taskId);
  }
}

// Create singleton instance
const taskExecutor = new TaskExecutor();

module.exports = { TaskExecutor, taskExecutor };
