const Message = require('../../models/Message');
const WorkSession = require('../../models/WorkSession');
const { toolRegistry } = require('../tools/ToolRegistry');
const logger = require('../../utils/logger');
const promptsLogger = logger.promptsLogger;

class ContextManager {
  /**
   * Build conversation context for LLM
   * @param {number} sessionId - Session ID
   * @param {string} newUserMessage - New user message (not yet saved)
   * @returns {Promise<Array>} - Array of formatted messages for LLM
   */
  static async buildContext(sessionId, newUserMessage = null) {
    try {
      // Get session with agents and documents
      const session = await WorkSession.getComplete(sessionId);

      if (!session) {
        throw new Error('Session not found');
      }

      // Get context messages based on context_length
      const messages = await Message.getContextMessages(sessionId, session.context_length);

      const messageCount = messages.length;

      // Build system prompt
      const systemPrompt = this.buildSystemPrompt(session);

      // Check if we need to summarize older messages
      if (messageCount >= session.context_length) {
        // Summarize older messages (first half)
        const splitIndex = Math.floor(messageCount / 2);
        const oldMessages = messages.slice(0, splitIndex);
        const recentMessages = messages.slice(splitIndex);

        const summary = this.summarizeMessages(oldMessages);

        // Build context with summary
        const context = [
          { role: 'system', content: systemPrompt },
          { role: 'system', content: `Previous conversation summary:\n${summary}` },
          ...this.formatMessagesForLLM(recentMessages),
        ];

        if (newUserMessage) {
          context.push({ role: 'user', content: newUserMessage });
        }

        return context;
      }

      // Build context with full history
      const context = [
        { role: 'system', content: systemPrompt },
        ...this.formatMessagesForLLM(messages),
      ];

      if (newUserMessage) {
        context.push({ role: 'user', content: newUserMessage });
      }

      return context;
    } catch (error) {
      logger.error('Error building context:', error);
      throw error;
    }
  }

  /**
   * Build system prompt for the main agent
   * @param {object} session - Session object with agents and documents
   * @returns {string} - System prompt
   */
  static buildSystemPrompt(session) {
    let prompt = `You are a project manager and user's assistant. The users or agents (if any in your team) will refer / address you as @Orchestrator or @Assistant, to ask you  to do something and you will respond directly to them.`
     prompt += `\nYou are helping with: ${session.name}\n`;
    
    if (session.description) {
      prompt += `\nContext: ${session.description}\n`;
    }

    prompt += 'You should drive the conversation to be productive for the project. You will keep track of the tasks for the project and each agent and will look for ways to measure the progress of the project.'
    prompt += 'You can and should ask the user for more information to help you help the user.'
    prompt += 'You will keep the user informed with the progress and extend the number of rounds if needed.'
    prompt += 'If you do not have the information you need, you can and should ask the user to provide answers and will pause the conversation waiting for clarifications and move on once you have what you need.'
    prompt += `You will answer to all user's demands and questions related to the work session, resources (tools, files, etc.), plans/tasks you have, status of the project, etc. \n\n`;
    // Add information about available agents
    if (session.agents && session.agents.length > 0) {
      prompt += '\n## Available Specialized Agents\n\n';
      prompt += 'You can delegate tasks to these specialized agents when their expertise is needed:\n\n';
      session.agents.forEach((agent, index) => {
        prompt += `${index + 1}. **${agent.name}** (${agent.role})\n`;
        if (agent.initial_context) {
          prompt += `   - ${agent.initial_context.substring(0, 150)}${agent.initial_context.length > 150 ? '...' : ''}\n`;
        }
        const agentToolNames = this.getAgentTools(agent.id, session);
        prompt += `   - assigned tools for this agent: ${agentToolNames.length ? agentToolNames.join(', ') : 'none'}\n`;
      });

      prompt += '\n';
    }

    // Documents list is not in system prompt; it is appended to each user message at runtime

    // Add information about available tools (only assigned ones)
    const orchestratorToolNames = session.orchestrator_tools || [];
    if (orchestratorToolNames.length > 0) {
      prompt += '## Available Tools\n\n';
      prompt += 'You have access to the following tools to work with in the project:\n\n';
      
      const allTools = toolRegistry.getAll();
      orchestratorToolNames.forEach((toolName, index) => {
        const tool = allTools.find(t => t.name === toolName);
        if (tool) {
          prompt += `${index + 1}. **${tool.name}**: ${tool.description || 'Tool for data operations'}\n\n`;
        }
      });
    }
    prompt += 'You resolve the disagreements, challenge the team and avoid converging to quickly to an opinion before all leads are followed\n\n\n';
    prompt += `Use these tools to improve your project management and user's experience and satisfaction\n\n`;

    // Add capabilities and instructions
    prompt += `## Your Capabilities\n\n`;
    prompt += `You can and should:\n`;
    prompt += `1. Answer questions directly using your knowledge and tools\n`;
    prompt += `2. Delegate tasks to specialized agents when their expertise is needed\n`;
    prompt += `3. Reference uploaded documents when answering questions\n`;
    prompt += `4. Use available tools for data management, file operations, web searches, and external integrations\n`;
    prompt += `5. Provide comprehensive project management advice\n\n`;

    prompt += `## Instructions\n\n`;
    prompt += `- Be professional, accurate, and helpful\n`;
    prompt += `- When uncertain, acknowledge limitations and suggest consulting a specialist\n`;
    prompt += `- For complex questions, consider delegating to specialized agents\n`;
    prompt += `- Reference specific documents when they contain relevant information\n`;
    prompt += `- Maintain conversation context and remember previous discussion points\n`;
    prompt += `- Use the tools you have to save the state of the project every time you see a task completed; `

    logger.info('ContextManager: built system prompt');
    promptsLogger.info('\n\n=== CONTEXT MANAGER SYSTEM PROMPT ===\n' + prompt);
    return prompt;
  }

  /**
   * Build the default system prompt for UI display (without user-entered description)
   * This is used to populate the "Orchestrator Initial Context" textarea when empty
   * @param {object} session - Session object with agents and documents
   * @returns {string} - Default system prompt
   */
  static buildDefaultSystemPrompt(session) {
    let prompt = `You are a project manager and user's assistant. Will respond directly to all users calls such as @Orchestrator,`;
    prompt += `\nYou are helping with: ${session.name}\n`;
    
    // Note: We do NOT include session.description here - that's what the user will edit

    prompt += 'You should drive the conversation to be productive for the project. You will keep track of the tasks for the project and each agent and will look for ways to measure the progress of the project.';
    prompt += 'You can and should ask the user for more information to help you help the user.';
    prompt += 'You will keep the user informed with the progress and extend the number of rounds if needed.';
    prompt += 'If you do not have the information you need, you can and should ask the user to provide answers and will pause the conversation waiting for clarifications and move on once you have what you need.';
    prompt += `You will answer to all user's demands and questions related to the work session, resources (tools, files, etc.), plans/tasks you have, status of the project, etc. \n\n`;
    
    // Add information about available agents
    if (session.agents && session.agents.length > 0) {
      prompt += '\n## Available Specialized Agents\n\n';
      prompt += 'You can delegate tasks to these specialized agents when their expertise is needed:\n\n';
      session.agents.forEach((agent, index) => {
        prompt += `${index + 1}. **${agent.name}** (${agent.role})\n`;
        if (agent.initial_context) {
          prompt += `   - ${agent.initial_context.substring(0, 150)}${agent.initial_context.length > 150 ? '...' : ''}\n`;
        }
        const agentToolNames = this.getAgentTools(agent.id, session);
        prompt += `   - assigned tools for this agent: ${agentToolNames.length ? agentToolNames.join(', ') : 'none'}\n`;
      });

      prompt += '\n';
    }
    prompt += 'You resolve the disagreements, challenge the team and avoid converging to quickly to an opinion before all leads are followed\n';
    // Documents list is not in system prompt; it is appended to each user message at runtime

    // Add information about available tools (only assigned ones)
    const orchestratorToolNames = session.orchestrator_tools || [];
    if (orchestratorToolNames.length > 0) {
      prompt += '## Available Tools\n\n';
      prompt += 'You have access to the following tools to work with in the project:\n\n';
      
      const allTools = toolRegistry.getAll();
      orchestratorToolNames.forEach((toolName, index) => {
        const tool = allTools.find(t => t.name === toolName);
        if (tool) {
          prompt += `${index + 1}. **${tool.name}**: ${tool.description || 'Tool for data operations'}\n\n`;
        }
      });
    }
    prompt += `Use these tools to improve your project management and user's experience and satisfaction\n\n`;

    // Add capabilities and instructions
    prompt += `## Your Capabilities\n\n`;
    prompt += `You can and should:\n`;
    prompt += `1. Answer questions directly using your knowledge and tools\n`;
    prompt += `2. Delegate tasks to specialized agents when their expertise is needed\n`;
    prompt += `3. Reference uploaded documents when answering questions\n`;
    prompt += `4. Use available tools for data management, file operations, web searches, and external integrations\n`;
    prompt += `5. Provide comprehensive project management advice\n\n`;

    prompt += `## Instructions\n\n`;
    prompt += `- Be professional, accurate, and helpful\n`;
    prompt += `- When uncertain, acknowledge limitations and suggest consulting a specialist\n`;
    prompt += `- For complex questions, consider delegating to specialized agents\n`;
    prompt += `- Reference specific documents when they contain relevant information\n`;
    prompt += `- Maintain conversation context and remember previous discussion points\n`;
    prompt += `- Use the tools you have to save the state of the project every time you see a task completed; `;

    return prompt;
  }

  /**
   * Build the default session prompt for an agent
   * This includes role-based default, team members, tools, and documents
   * @param {object} agent - The agent object
   * @param {object} session - The session object with agents, documents, and tool assignments
   * @returns {string} - Default agent session prompt
   */
  static buildDefaultAgentSessionPrompt(agent, session) {
    const OrchestratorAgent = require('../chat/OrchestratorAgent');
    
    // Start with the role-based default prompt
    let prompt = OrchestratorAgent.getDefaultSystemPrompt(agent.role);
    
    // Add identity section
    prompt += `\n\n## Your Identity\n`;
    prompt += `Your name is: ${agent.name}\n`;
    prompt += `Your role is: ${agent.role}\n`;
    prompt += `You are working on the project: ${session.name}\n`;

    // Add team members section (other agents in the session)
    const otherAgents = (session.agents || []).filter(a => a.id !== agent.id);
    if (otherAgents.length > 0) {
      prompt += `\n## Team Members\n`;
      prompt += `You are part of a team of specialized agents. Here are your team members:\n\n`;
      otherAgents.forEach((teammate, index) => {
        prompt += `${index + 1}. **${teammate.name}** (${teammate.role})\n`;
        if (teammate.initial_context) {
          prompt += `   - ${teammate.initial_context.substring(0, 100)}${teammate.initial_context.length > 100 ? '...' : ''}\n`;
        }
        const teammateToolNames = this.getAgentTools(teammate.id, session);
        prompt += `   - assigned tools for this agent: ${teammateToolNames.length ? teammateToolNames.join(', ') : 'none'}\n`;
      });
      prompt += `\nYou can reference these team members when their expertise would be helpful. The Orchestrator is the team leader, coordinates the team and assigns tasks.\n`;
    }

    // Documents list is not in default prompt; it is appended to each user message at runtime

    // Add assigned tools section
    const agentTools = this.getAgentTools(agent.id, session);
    if (agentTools.length > 0) {
      prompt += `\n## Your Available Tools\n`;
      prompt += `You have access to the following tools:\n\n`;
      
      const allTools = toolRegistry.getAll();
      agentTools.forEach((toolName, index) => {
        const tool = allTools.find(t => t.name === toolName);
        if (tool) {
          prompt += `${index + 1}. **${tool.name}**: ${tool.description || 'Tool for data operations'}\n`;
        } else {
          prompt += `${index + 1}. **${toolName}**\n`;
        }
      });
      prompt += `\n`;
    }

    // Add instructions
    prompt += `\n## Instructions\n`;
    prompt += `- Be professional, accurate, and helpful in your area of expertise\n`;
    prompt += `- When uncertain, acknowledge limitations and suggest consulting a specialist\n`;
    prompt += `- Reference your assigned documents when they contain relevant information\n`;
    prompt += `- Use your assigned tools when appropriate\n`;
    prompt += `- Collaborate with team members when their expertise would be helpful\n`;

    return prompt;
  }

  /**
   * Get documents assigned to a specific agent in a session
   * @param {number} agentId - Agent ID
   * @param {object} session - Session object with document_agent_assignment_map
   * @returns {Array} - Documents assigned to the agent
   */
  static getAgentDocuments(agentId, session) {
    const documents = session.documents || [];
    const map = session.document_agent_assignment_map || {};
    
    return documents.filter(doc => {
      const assignedAgentIds = map[doc.id] || map[String(doc.id)] || [];
      return assignedAgentIds.includes(agentId);
    });
  }

  /**
   * Build the "## Your Assigned Documents" section for the orchestrator (all session documents)
   * @param {object} session - Session object with documents
   * @returns {string} - Section text or empty string if no documents
   */
  static buildDocumentsSectionForOrchestrator(session) {
    const documents = session.documents || [];
    if (documents.length === 0) return '';
    let section = '\n## Your Assigned Documents\n\n';
    section += 'The following documents are available for reference:\n\n';
    documents.forEach((doc, index) => {
      section += `${index + 1}. **${doc.filename}** (${doc.file_type || 'unknown type'})\n`;
      section += `   - Uploaded: ${new Date(doc.uploaded_at).toLocaleDateString()}\n`;
      if (doc.chunk_count > 0) {
        section += `   - Indexed: ${doc.chunk_count} chunks\n`;
      }
    });
    return section + '\n';
  }

  /**
   * Build the "## Your Assigned Documents" section for an agent (agent-specific assignments)
   * @param {number} agentId - Agent ID
   * @param {object} session - Session object with document_agent_assignment_map
   * @returns {string} - Section text or empty string if no documents assigned
   */
  static buildDocumentsSectionForAgent(agentId, session) {
    const agentDocuments = this.getAgentDocuments(agentId, session);
    if (agentDocuments.length === 0) return '';
    let section = '\n## Your Assigned Documents\n\n';
    section += 'You have access to the following documents for reference:\n\n';
    agentDocuments.forEach((doc, index) => {
      section += `${index + 1}. **${doc.filename}** (${doc.file_type || 'unknown type'})\n`;
      if (doc.chunk_count > 0) {
        section += `   - Indexed: ${doc.chunk_count} chunks\n`;
      }
    });
    return section + '\n';
  }

  /**
   * Get tools assigned to a specific agent in a session
   * @param {number} agentId - Agent ID
   * @param {object} session - Session object with tool_agent_assignment_map or tool_agent_assignments
   * @returns {Array} - Tool names assigned to the agent
   */
  static getAgentTools(agentId, session) {
    let map = session.tool_agent_assignment_map;
    if (!map && Array.isArray(session.tool_agent_assignments)) {
      map = {};
      for (const row of session.tool_agent_assignments) {
        const toolName = row.tool_name;
        const aid = row.agent_id;
        if (!toolName || aid == null) continue;
        if (!map[toolName]) map[toolName] = [];
        map[toolName].push(aid);
      }
      for (const k of Object.keys(map)) {
        map[k] = Array.from(new Set(map[k]));
      }
    }
    map = map || {};
    const tools = [];
    for (const [toolName, agentIds] of Object.entries(map)) {
      if (agentIds.includes(agentId)) {
        tools.push(toolName);
      }
    }
    return tools;
  }

  /**
   * Format messages for LLM API
   * @param {Array} messages - Array of message objects from database
   * @returns {Array} - Formatted messages
   */
  static formatMessagesForLLM(messages) {
    return messages
      .filter(msg => msg.role !== 'system') // Filter out system messages
      .map(msg => ({
        role: msg.role === 'tool' ? 'assistant' : msg.role, // Convert tool to assistant
        content: msg.content,
      }));
  }

  /**
   * Summarize messages (simple text-based summarization)
   * @param {Array} messages - Array of messages to summarize
   * @returns {string} - Summary text
   */
  static summarizeMessages(messages) {
    if (messages.length === 0) {
      return 'No previous messages.';
    }

    // Simple summarization: extract key points
    const userMessages = messages.filter(m => m.role === 'user');
    const assistantMessages = messages.filter(m => m.role === 'assistant');

    let summary = `Earlier in this conversation (${messages.length} messages):\n\n`;

    // List topics discussed
    if (userMessages.length > 0) {
      summary += `User asked about:\n`;
      userMessages.slice(0, 5).forEach((msg, index) => {
        const preview = msg.content.substring(0, 80);
        summary += `- ${preview}${msg.content.length > 80 ? '...' : ''}\n`;
      });

      if (userMessages.length > 5) {
        summary += `... and ${userMessages.length - 5} more questions\n`;
      }
    }

    summary += `\n${assistantMessages.length} responses were provided by the assistant.`;

    return summary;
  }

  /**
   * Estimate tokens in text (rough approximation)
   * @param {string} text - Text to estimate
   * @returns {number} - Estimated token count
   */
  static estimateTokens(text) {
    // Rough approximation: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }

  /**
   * Get context window size in tokens
   * @param {Array} context - Context array
   * @returns {number} - Estimated token count
   */
  static getContextSize(context) {
    let totalTokens = 0;

    for (const message of context) {
      totalTokens += this.estimateTokens(message.content);
    }

    return totalTokens;
  }

  /**
   * Trim context to fit within token limit
   * @param {Array} context - Context array
   * @param {number} maxTokens - Maximum tokens allowed
   * @returns {Array} - Trimmed context
   */
  static trimContext(context, maxTokens = 8000) {
    let currentTokens = this.getContextSize(context);

    if (currentTokens <= maxTokens) {
      return context;
    }

    // Keep system messages and newest messages
    const systemMessages = context.filter(m => m.role === 'system');
    const otherMessages = context.filter(m => m.role !== 'system');

    // Remove oldest messages until we fit
    let trimmedMessages = [...otherMessages];
    let systemTokens = this.getContextSize(systemMessages);

    while (systemTokens + this.getContextSize(trimmedMessages) > maxTokens && trimmedMessages.length > 5) {
      trimmedMessages.shift(); // Remove oldest message
    }

    return [...systemMessages, ...trimmedMessages];
  }

  /**
   * Build minimal context (for quick responses)
   * @param {number} sessionId - Session ID
   * @param {string} newUserMessage - New user message
   * @returns {Promise<Array>} - Minimal context
   */
  static async buildMinimalContext(sessionId, newUserMessage) {
    try {
      const session = await WorkSession.getComplete(sessionId);

      if (!session) {
        throw new Error('Session not found');
      }

      // Get only the last few messages
      const recentMessages = await Message.getRecentMessages(sessionId, 10);

      const systemPrompt = this.buildSystemPrompt(session);

      return [
        { role: 'system', content: systemPrompt },
        ...this.formatMessagesForLLM(recentMessages.reverse()),
        { role: 'user', content: newUserMessage },
      ];
    } catch (error) {
      logger.error('Error building minimal context:', error);
      throw error;
    }
  }
}

module.exports = ContextManager;
