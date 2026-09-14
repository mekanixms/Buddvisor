/**
 * Orchestrator Agent
 * Routes tasks to specialized agents and coordinates multi-agent responses
 */

const crypto = require('crypto');
const AgentService = require('../agents/AgentService');
const ProviderFactory = require('../../providers/ProviderFactory');
const { toolRegistry } = require('../tools/ToolRegistry');
const { toolExecutor } = require('../tools/ToolExecutor');
const { syncAssignedDocumentsToWorkspace } = require('../tools/localWorkingFolderTool');
const WorkSession = require('../../models/WorkSession');
const Message = require('../../models/Message');
const { decrypt } = require('../../utils/crypto');
const logger = require('../../utils/logger');
const promptsLogger = logger.promptsLogger;
const BaseLLMProvider = require('../../providers/BaseLLMProvider');
const { expandPromptMacros } = require('../../utils/promptMacros');

/**
 * Generate a stable UUID-like conversation ID for prompt caching (e.g. xAI x-grok-conv-id).
 * @param {number} sessionId - Session ID
 * @param {number|null} agentId - Agent ID or null for orchestrator
 * @returns {string} - UUID v4-style string
 */
function conversationIdForCache(sessionId, agentId) {
  const seed = `conv-${sessionId}-${agentId ?? 'orch'}`;
  const hex = crypto.createHash('sha256').update(seed).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

class OrchestratorAgent {
  /**
   * Determine which tools are allowed for an agent in a session.
   * If no per-agent tool assignments exist for the session, returns [] (meaning "no tools allowed").
   * @returns {Promise<string[]>}
   */
  static async getAllowedToolNamesForAgent(sessionId, agentId) {
    const hasAssignments = await WorkSession.hasToolAssignments(sessionId);
    if (!hasAssignments) return [];
    return await WorkSession.getToolNamesBySessionAndAgent(sessionId, agentId);
  }

  /**
   * Build tool definitions list for an agent, respecting per-agent tool assignments (if configured).
   * @returns {Promise<{tools: any[], allowedToolNames: string[]}>}
   */
  static async buildToolsForAgent(sessionId, agentId) {
    const allowedToolNames = await this.getAllowedToolNamesForAgent(sessionId, agentId);
    const tools = toolRegistry.getToolDefinitionsForLLM(allowedToolNames);
    return { tools, allowedToolNames };
  }

  /**
   * Process a user request through the multi-agent system
   */
  static async process(params) {
    const {
      session,
      agents,
      context,
      userMessage,
      documentContext = '',
      documentContextByAgentId = null,
      processedMediaCacheByAgentId = null,
      stream = false,
      onChunk = null,
    } = params;

    try {
      // Step 1: Analyze the request and determine routing
      const routingDecision = await this.analyzeAndRoute(
        session,
        agents,
        userMessage,
        documentContext
      );

      logger.info(`Routing decision: ${JSON.stringify(routingDecision)}`);

      // Step 2: Execute with the selected agent(s)
      if (routingDecision.type === 'single') {
        // Route to a single specialized agent
        const agentDocContext = documentContextByAgentId && documentContextByAgentId[routingDecision.agent.id] != null
          ? documentContextByAgentId[routingDecision.agent.id]
          : documentContext;
        return await this.executeWithAgent(
          routingDecision.agent,
          session,
          agents,
          context,
          userMessage,
          agentDocContext,
          routingDecision.reasoning,
          { stream, onChunk, processedMediaCacheByAgentId }
        );
      } else if (routingDecision.type === 'multi') {
        // Coordinate multiple agents
        return await this.executeMultiAgent(
          routingDecision.agents,
          session,
          agents,
          context,
          userMessage,
          documentContextByAgentId || documentContext,
          routingDecision.reasoning,
          { stream, onChunk, processedMediaCacheByAgentId }
        );
      } else {
        // Handle directly with orchestrator (general query)
        return await this.handleDirectly(
          session,
          agents,
          context,
          userMessage,
          documentContext,
          { stream, onChunk }
        );
      }
    } catch (error) {
      logger.error('Orchestrator error:', error);
      throw error;
    }
  }

  /**
   * Analyze the user request and determine which agent(s) should handle it
   */
  static async analyzeAndRoute(session, agents, userMessage, documentContext) {
    // Build agent descriptions for routing
    const agentDescriptions = agents.map(a => ({
      id: a.id,
      name: a.name,
      role: a.role,
      description: this.getRoleDescription(a.role),
      specialties: a.system_prompt ? this.extractSpecialties(a.system_prompt) : [],
    }));

    // Get orchestrator provider
    const providerType = session.orchestrator_provider_type || 'claude';
    const apiKey = this.getOrchestratorApiKey(session, providerType);

    if (!apiKey) {
      // Fall back to using first available agent or direct handling
      if (agents.length === 1) {
        return {
          type: 'single',
          agent: agents[0],
          reasoning: 'Using only available agent (no orchestrator API key configured)',
        };
      }
      return {
        type: 'direct',
        reasoning: 'No orchestrator API key configured',
      };
    }

    // Get model from session config or use default
    const model = this.getOrchestratorModel(session, providerType);
    
    // Get timeout from session config or use default
    const timeout = this.getOrchestratorTimeout(session);

    const provider = ProviderFactory.create(providerType, {
      apiKey,
      model,
      timeout,
    });

    // Build routing prompt
    const routingPrompt = this.buildRoutingPrompt(session, agentDescriptions, agents, userMessage, documentContext);

    const routingMessages = [
      { role: 'system', content: routingPrompt.system },
      { role: 'user', content: routingPrompt.user },
    ];

    logger.info('=== ORCHESTRATOR ROUTING PROMPT ===');
    promptsLogger.info('\n\n=== ORCHESTRATOR ROUTING PROMPT ===\n' + JSON.stringify(routingMessages, null, 2));
    logger.info('Routing prompt sent', { messageCount: routingMessages.length });

    try {
      const chatOptions = { maxTokens: 500 };
      if (session.orchestrator_provider_config?.enablePromptCache) {
        chatOptions.usePromptCache = true;
        chatOptions.conversationId = conversationIdForCache(session.id, null);
      }
      const response = await provider.chat(routingMessages, chatOptions);

      // Parse the routing decision
      return this.parseRoutingResponse(response.content, agents);
    } catch (error) {
      logger.error('Routing analysis failed:', error);
      // Fall back to first agent or direct handling
      if (agents.length > 0) {
        return {
          type: 'single',
          agent: agents[0],
          reasoning: 'Routing failed, using default agent',
        };
      }
      return { type: 'direct', reasoning: 'Routing analysis failed' };
    }
  }

  /**
   * Build agent JSON list for system prompt
   */
  static buildAgentJsonList(agents) {
    const agentMap = {};
    
    for (const agent of agents) {
      let model = 'unknown';
      try {
        if (agent.provider_config) {
          const config = typeof agent.provider_config === 'string' 
            ? JSON.parse(decrypt(agent.provider_config))
            : agent.provider_config;
          model = config.model || 'unknown';
        }
      } catch (error) {
        logger.warn(`Failed to decrypt agent config for ${agent.name}:`, error.message);
      }

      agentMap[agent.name] = {
        model: model,
        role: agent.role,
        agentContext: agent.initial_context || '',
      };
    }

    return JSON.stringify(agentMap, null, 2);
  }

    /**
   * Build agent JSON list for agent prompt
   */
    static buildAgentJsonList_forAgents(agents) {
      const agentMap = {};
      
      for (const agent of agents) {
        let model = 'unknown';
        try {
          if (agent.provider_config) {
            const config = typeof agent.provider_config === 'string' 
              ? JSON.parse(decrypt(agent.provider_config))
              : agent.provider_config;
            model = config.model || 'unknown';
          }
        } catch (error) {
          logger.warn(`Failed to decrypt agent config for ${agent.name}:`, error.message);
        }
  
        agentMap[agent.name] = {
          model: model,
          role: agent.role
        };
      }
  
      return JSON.stringify(agentMap, null, 2);
    }

  /**
   * Build the routing prompt
   */
  static buildRoutingPrompt(session, agentDescriptions, agents, userMessage, documentContext) {
    const agentList = agentDescriptions.map(a =>
      `- ${a.name} (ID: ${a.id}, Role: ${a.role}): ${a.description}`
    ).join('\n');

    // Build agent JSON list
    const agentJsonList = agents && agents.length > 0
      ? this.buildAgentJsonList(agents)
      : '{}';

    // Include session description as initial context if provided
    const initialContext = session.description
      ? `\n\n## Application Context\n\n${session.description}\n`
      : '';

    return {
      system: expandPromptMacros(`You are a routing orchestrator for a multi-agent advisor system. Your job is to analyze user requests and determine which specialist agent(s) should handle them.${initialContext}

Available agents:
${agentList}

Agent Details (JSON):
${agentJsonList}

Respond ONLY with a JSON object in this exact format:
{
  "type": "single" | "multi" | "direct",
  "agentIds": [<agent IDs to use>],
  "reasoning": "<brief explanation of your choice>"
}

Rules:
- Use "single" when one specialist can fully handle the request
- Use "multi" when the request requires expertise from multiple specialists
- Use "direct" when the request is general and doesn't need specialist knowledge
- Always include the agent IDs as numbers in an array
- Be concise in your reasoning
- Consider the application context when making routing decisions`, {
        session,
        tools: session.orchestrator_tools || [],
      }),

      user: `User request: "${userMessage}"
${documentContext ? `\nRelevant document context is available.` : ''}

Which agent(s) should handle this request?`,
    };
  }

  /**
   * Parse the routing response from the LLM
   */
  static parseRoutingResponse(responseText, agents) {
    try {
      // Extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in routing response');
      }

      const decision = JSON.parse(jsonMatch[0]);

      if (decision.type === 'direct') {
        return { type: 'direct', reasoning: decision.reasoning || 'General query' };
      }

      if (decision.type === 'single' && decision.agentIds?.length > 0) {
        const agent = agents.find(a => a.id === decision.agentIds[0]);
        if (agent) {
          return {
            type: 'single',
            agent,
            reasoning: decision.reasoning || 'Single agent routing',
          };
        }
      }

      if (decision.type === 'multi' && decision.agentIds?.length > 1) {
        const selectedAgents = decision.agentIds
          .map(id => agents.find(a => a.id === id))
          .filter(Boolean);
        if (selectedAgents.length > 0) {
          return {
            type: 'multi',
            agents: selectedAgents,
            reasoning: decision.reasoning || 'Multi-agent routing',
          };
        }
      }

      // Fallback
      return {
        type: agents.length > 0 ? 'single' : 'direct',
        agent: agents[0],
        reasoning: 'Default routing',
      };
    } catch (error) {
      logger.error('Error parsing routing response:', error);
      return {
        type: agents.length > 0 ? 'single' : 'direct',
        agent: agents[0],
        reasoning: 'Routing parse error - using default',
      };
    }
  }

  /**
   * Summarize conversation context for passing to specialized agents
   */
  static async summarizeConversation(session, context, userMessage) {
    // Skip summarization if context is too short
    if (!context || context.length < 2) {
      return null;
    }

    const providerType = session.orchestrator_provider_type || 'claude';
    const apiKey = this.getOrchestratorApiKey(session, providerType);

    if (!apiKey) {
      return null; // Can't summarize without orchestrator API key
    }

    const model = this.getOrchestratorModel(session, providerType);
    
    // Get timeout from session config or use default
    const timeout = this.getOrchestratorTimeout(session);
    
    // Get baseURL for Ollama if configured
    const providerConfig = { apiKey, model, timeout };
    if (providerType === 'ollama') {
      let baseURL = null;
      if (session.orchestrator_provider_config) {
        // Config should already be decrypted by ChatService, but handle both cases
        try {
          let config = session.orchestrator_provider_config;
          if (typeof config === 'string') {
            const { decrypt } = require('../../utils/encryption');
            config = JSON.parse(decrypt(config));
          }
          if (config.baseURL) {
            baseURL = config.baseURL;
          }
        } catch (e) {
          logger.warn('Failed to parse orchestrator config for baseURL:', e.message);
        }
      }
      providerConfig.baseURL = baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    }
    
    const provider = ProviderFactory.create(providerType, providerConfig);

    // Build conversation text for summarization
    const conversationText = context.map(msg =>
      `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.content}`
    ).join('\n\n');

    const summaryPrompt = `Summarize the following conversation concisely, focusing on key topics discussed, decisions made, and relevant context that would help a specialist agent understand the background. Keep it under 200 words.

Conversation:
${conversationText}

Current user request: "${userMessage}"

Summary:`;

    const summaryMessages = [
      { role: 'user', content: summaryPrompt }
    ];

    logger.info('=== CONVERSATION SUMMARY PROMPT ===');
    promptsLogger.info('\n\n=== CONVERSATION SUMMARY PROMPT ===\n' + JSON.stringify(summaryMessages, null, 2));

    try {
      const chatOptions = { maxTokens: 300 };
      if (session.orchestrator_provider_config?.enablePromptCache) {
        chatOptions.usePromptCache = true;
        chatOptions.conversationId = conversationIdForCache(session.id, null);
      }
      const response = await provider.chat(summaryMessages, chatOptions);

      return response.content?.trim() || null;
    } catch (error) {
      logger.warn('Failed to summarize conversation:', error.message);
      return null;
    }
  }

  /**
   * Execute request with a single specialized agent
   */
  static async executeWithAgent(agent, session, allAgents, context, userMessage, documentContext, reasoning, options) {
    const { stream, onChunk, processedMediaCacheByAgentId = null } = options || {};

    try {
      await syncAssignedDocumentsToWorkspace(session.id, agent.id);

      // Get agent-specific conversation history (user messages + this agent's messages only)
      const agentContext = await Message.getContextForAgent(session.id, agent.id, session.context_length || process.env.DEFAULT_MESSAGE_LIMIT_CONTEXT_LENGTH || 10);
      const formattedAgentContext = Message.formatForLLM(agentContext);

      // Optional: Summarize conversation context for additional context in system prompt
      const conversationSummary = await this.summarizeConversation(session, agentContext, userMessage);

      // Get agent's provider
      const provider = await AgentService.getAgentProvider(agent.id, session.user_id);

      // Build the prompt with agent's system prompt and conversation summary
      const processedMediaCacheInfo = processedMediaCacheByAgentId?.[agent.id] || [];
      const systemPrompt = this.buildAgentSystemPrompt(agent, allAgents, documentContext, conversationSummary, processedMediaCacheInfo, session);

      // Get tools available to this agent (per-agent selection if configured)
      const { tools, allowedToolNames } = await this.buildToolsForAgent(session.id, agent.id);
      // Some providers/models (notably many Ollama vision/VL models) don't accept the `tools` field at all.
      // If the provider explicitly indicates it doesn't support tools, avoid passing tools to prevent 400s.
      const agentModel = provider?.model || null;
      const providerTools = (provider && typeof provider.supportsTools === 'function' && !provider.supportsTools(agentModel))
        ? []
        : tools;
      const providerAllowedToolNames = (provider && typeof provider.supportsTools === 'function' && !provider.supportsTools(agentModel))
        ? []
        : allowedToolNames;

      const ContextManager = require('../sessions/ContextManager');
      const documentsSuffix = (session.document_agent_assignment_map && ContextManager.buildDocumentsSectionForAgent(agent.id, session)) || '';
      const userMessageWithDocs = userMessage + documentsSuffix;

      // Include agent-specific conversation history in messages
      const messages = [
        { role: 'system', content: systemPrompt },
        ...formattedAgentContext,
        { role: 'user', content: userMessageWithDocs },
      ];

      logger.info(`=== AGENT PROMPT: ${agent.name} (${agent.role}) ===`);
      const toolsLine = (tools && tools.length > 0) ? '\nTools: ' + tools.map(t => t.name).join(', ') : '';
      promptsLogger.info(`\n\n=== AGENT PROMPT: ${agent.name} (${agent.role}) ===\n` + JSON.stringify(messages, null, 2) + toolsLine);
      if (tools && tools.length > 0) {
        logger.info(`Tools available: ${tools.map(t => t.name).join(', ')}`);
      }

      // Execute with tool support
      const execOpts = { stream, onChunk, allowedToolNames: providerAllowedToolNames };
      if (agent.provider_config?.enablePromptCache) {
        execOpts.usePromptCache = true;
        execOpts.conversationId = conversationIdForCache(session.id, agent.id);
      }
      const result = await this.executeWithTools(
        provider,
        messages,
        providerTools,
        { userId: session.user_id, sessionId: session.id, agentId: agent.id },
        execOpts
      );

      return {
        content: result.content,
        agentId: agent.id,
        agentName: agent.name,
        routedTo: agent.role,
        reasoning,
        tokensUsed: result.tokensUsed,
        toolCalls: result.toolCalls,
      };
    } catch (error) {
      logger.error(`Error executing with agent ${agent.name}:`, error);
      throw error;
    }
  }

  /**
   * Get tools relevant to a specific agent role
   */
  static getToolsForRole(role) {
    // Map roles to relevant tool categories
    const roleToCategoryMap = {
      accounting: ['tax-calculation', 'business-analysis', 'financial'],
      legal: ['tax-calculation', 'utility'],
      marketing: ['business-analysis', 'utility'],
      sales: ['business-analysis', 'utility'],
      logistics: ['business-analysis', 'utility'],
      production: ['business-analysis', 'utility'],
      hr: ['tax-calculation', 'utility'],
      custom: ['tax-calculation', 'business-analysis', 'utility'],
    };

    const categories = roleToCategoryMap[role] || roleToCategoryMap.custom;

    // Get all tools and filter by category
    const allTools = toolRegistry.getAll();
    const relevantTools = allTools.filter(tool =>
      categories.includes(tool.category)
    );

    return toolRegistry.getToolDefinitionsForLLM(
      relevantTools.map(t => t.name)
    );
  }

  /**
   * Execute request with multiple agents and synthesize response
   */
  static async executeMultiAgent(agents, session, allAgents, context, userMessage, documentContext, reasoning, options) {
    const { stream, onChunk, processedMediaCacheByAgentId = null } = options || {};

    try {
      // Get responses from each agent in parallel
      const agentResponses = await Promise.all(
        agents.map(async (agent) => {
          try {
            await syncAssignedDocumentsToWorkspace(session.id, agent.id);

            // Get agent-specific conversation history (user messages + this agent's messages only)
            const agentContext = await Message.getContextForAgent(session.id, agent.id, session.context_length || process.env.DEFAULT_MESSAGE_LIMIT_CONTEXT_LENGTH || 10);
            const formattedAgentContext = Message.formatForLLM(agentContext);

            // Optional: Summarize conversation context for additional context in system prompt
            const conversationSummary = await this.summarizeConversation(session, agentContext, userMessage);

            const provider = await AgentService.getAgentProvider(agent.id, session.user_id);
            const agentDocContext = (documentContext && typeof documentContext === 'object' && !Array.isArray(documentContext))
              ? (documentContext[agent.id] || '')
              : (documentContext || '');
            const processedMediaCacheInfo = processedMediaCacheByAgentId?.[agent.id] || [];
            const systemPrompt = this.buildAgentSystemPrompt(agent, allAgents, agentDocContext, conversationSummary, processedMediaCacheInfo, session);

            const ContextManager = require('../sessions/ContextManager');
            const documentsSuffix = (session.document_agent_assignment_map && ContextManager.buildDocumentsSectionForAgent(agent.id, session)) || '';
            const userMessageWithDocs = userMessage + documentsSuffix;

            // Include agent-specific conversation history in messages
            const messages = [
              { role: 'system', content: systemPrompt },
              ...formattedAgentContext,
              { role: 'user', content: userMessageWithDocs },
            ];

            logger.info(`=== AGENT PROMPT: ${agent.name} (${agent.role}) ===`);
            const { tools, allowedToolNames } = await this.buildToolsForAgent(session.id, agent.id);
            const agentModel = provider?.model || null;
            const providerTools = (provider && typeof provider.supportsTools === 'function' && !provider.supportsTools(agentModel))
              ? []
              : tools;
            const providerAllowedToolNames = (provider && typeof provider.supportsTools === 'function' && !provider.supportsTools(agentModel))
              ? []
              : allowedToolNames;
            const toolsLine = (providerTools && providerTools.length > 0) ? '\nTools: ' + providerTools.map(t => t.name).join(', ') : '';
            promptsLogger.info(`\n\n=== AGENT PROMPT: ${agent.name} (${agent.role}) ===\n` + JSON.stringify(messages, null, 2) + toolsLine);

            const multiExecOpts = { stream: false, onChunk: null, allowedToolNames: providerAllowedToolNames };
            if (agent.provider_config?.enablePromptCache) {
              multiExecOpts.usePromptCache = true;
              multiExecOpts.conversationId = conversationIdForCache(session.id, agent.id);
            }
            const response = await this.executeWithTools(
              provider,
              messages,
              providerTools,
              { userId: session.user_id, sessionId: session.id, agentId: agent.id },
              multiExecOpts
            );
            return {
              agent,
              content: response.content,
              tokensUsed: response.tokensUsed || 0,
            };
          } catch (error) {
            logger.error(`Error from agent ${agent.name}:`, error);
            return {
              agent,
              content: `[Error getting response from ${agent.name}]`,
              tokensUsed: 0,
            };
          }
        })
      );

      // Synthesize the responses
      const synthesizedContent = this.synthesizeResponses(agentResponses, userMessage);
      const totalTokens = agentResponses.reduce((sum, r) => sum + r.tokensUsed, 0);

      if (stream && onChunk) {
        // Stream the synthesized content
        const chunks = synthesizedContent.match(/.{1,50}/g) || [synthesizedContent];
        for (const chunk of chunks) {
          onChunk(chunk);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      return {
        content: synthesizedContent,
        agentId: null,
        agentName: 'Multi-Agent',
        routedTo: agents.map(a => a.role).join(', '),
        reasoning,
        tokensUsed: totalTokens,
      };
    } catch (error) {
      logger.error('Error in multi-agent execution:', error);
      throw error;
    }
  }

  /**
   * Handle request directly without specialized agents
   */
  static async handleDirectly(session, agents, context, userMessage, documentContext, options) {
    const { stream, onChunk } = options;

    await syncAssignedDocumentsToWorkspace(session.id, null);

    const providerType = session.orchestrator_provider_type || 'claude';
    const apiKey = this.getOrchestratorApiKey(session, providerType);

    if (!apiKey) {
      return {
        content: 'I apologize, but I cannot process your request without a configured API key. Please set up an API key in settings.',
        agentId: null,
        agentName: 'System',
        routedTo: 'none',
        reasoning: 'No API key configured',
        tokensUsed: 0,
      };
    }

    // Get model from session config or use default
    const model = this.getOrchestratorModel(session, providerType);
    
    // Get timeout from session config or use default
    const timeout = this.getOrchestratorTimeout(session);
    
    // Get baseURL for Ollama if configured
    const providerConfig = { apiKey, model, timeout };
    if (providerType === 'ollama' && session.orchestrator_provider_config?.baseURL) {
      providerConfig.baseURL = session.orchestrator_provider_config.baseURL;
    } else if (providerType === 'ollama') {
      // Use default from environment
      providerConfig.baseURL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    }
    if (providerType === 'ollama') {
      logger.info(`Ollama baseURL for session ${session.id}: ${providerConfig.baseURL}`);
    }

    const provider = ProviderFactory.create(providerType, providerConfig);

    // Include session description as initial context if provided
    const initialContext = session.description
      ? `\n\n## Application Context\n\n${session.description}\n`
      : '';

    // Build agent JSON list
    const agentJsonList = agents && agents.length > 0
      ? this.buildAgentJsonList(agents)
      : '{}';

    // Build a helpful system prompt that mentions available agents and tools
    const agentSummary = agents.length > 0
      ? `\n\n## Available Specialist Agents\n\nYou have access to the following specialist agents that can help with specific questions:\n${agents.map(a => `- ${a.name}: ${this.getRoleDescription(a.role)}`).join('\n')}\n\nIf the user's question would benefit from specialist knowledge, suggest they ask about specific topics.`
      : '';

    // Get available tools (only assigned orchestrator tools)
    const orchestratorToolNames = session.orchestrator_tools || [];
    const tools = orchestratorToolNames.length > 0
      ? toolRegistry.getToolDefinitionsForLLM(orchestratorToolNames)
      : [];
    const toolSummary = tools.length > 0
      ? `\n\n## Available Tools\n\nYou have access to the following tools. Use them when appropriate:\n${tools.map(t => `- ${t.name}: ${t.description}`).join('\n')}`
      : '';

    const systemPrompt = expandPromptMacros(`You are a helpful assistant for a small multi agent AI application. Provide clear, accurate, and practical advice.${initialContext}${agentSummary}

Agent Details (JSON):
${agentJsonList}
${toolSummary}
${documentContext ? `\n\n## Document Context\n\nUse the following document context to help answer questions:\n${documentContext}` : ''}`, {
      session,
      provider: providerType,
      model,
      tools: orchestratorToolNames,
    });

    const ContextManager = require('../sessions/ContextManager');
    const documentsSuffix = ContextManager.buildDocumentsSectionForOrchestrator(session) || '';
    const userMessageWithDocs = userMessage + documentsSuffix;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...context,
      { role: 'user', content: userMessageWithDocs },
    ];

    logger.info('=== ORCHESTRATOR DIRECT HANDLING PROMPT ===');
    const directToolsLine = (tools && tools.length > 0) ? '\nTools: ' + tools.map(t => t.name).join(', ') : '';
    promptsLogger.info('\n\n=== ORCHESTRATOR DIRECT HANDLING PROMPT ===\n' + JSON.stringify(messages, null, 2) + directToolsLine);
    if (tools && tools.length > 0) {
      logger.info(`Tools available: ${tools.map(t => t.name).join(', ')}`);
    }

    // Execute with tool support
    const execOptions = { stream, onChunk };
    if (session.orchestrator_provider_config?.enablePromptCache) {
      execOptions.usePromptCache = true;
      execOptions.conversationId = conversationIdForCache(session.id, null);
    }
    const result = await this.executeWithTools(
      provider,
      messages,
      tools,
      { userId: session.user_id, sessionId: session.id, agentId: null },
      execOptions
    );

    return {
      content: result.content,
      agentId: null,
      agentName: 'Assistant',
      routedTo: 'direct',
      reasoning: 'General query handled directly',
      tokensUsed: result.tokensUsed,
      toolCalls: result.toolCalls,
    };
  }

  /**
   * Orchestrator-led mode: the orchestrator is the lead agent.
   * It holds the full conversation history and delegates work to specialized
   * agents via a delegate_to_agent tool with self-contained briefs.
   * Specialized agents receive ONLY the brief (no conversation history).
   */
  static async processOrchestratorLed(params) {
    const {
      session,
      agents,
      context,
      userMessage,
      documentContext = '',
      documentContextByAgentId = null,
      processedMediaCacheByAgentId = null,
      stream = false,
      onChunk = null,
    } = params;

    const providerType = session.orchestrator_provider_type || 'claude';
    const apiKey = this.getOrchestratorApiKey(session, providerType);

    if (!apiKey) {
      // Orchestrator-led mode requires a configured orchestrator; fall back to classic routing
      logger.warn(`Orchestrator-led mode requested for session ${session.id} but no orchestrator API key is configured. Falling back to classic routing.`);
      return await this.process(params);
    }

    await syncAssignedDocumentsToWorkspace(session.id, null);

    const model = this.getOrchestratorModel(session, providerType);
    const timeout = this.getOrchestratorTimeout(session);
    const providerConfig = { apiKey, model, timeout };
    if (providerType === 'ollama') {
      providerConfig.baseURL = session.orchestrator_provider_config?.baseURL
        || process.env.OLLAMA_BASE_URL
        || 'http://localhost:11434';
    }
    const provider = ProviderFactory.create(providerType, providerConfig);

    // Orchestrator tools (assigned in Configure Session → Tools) + synthetic delegate tool
    const orchestratorToolNames = session.orchestrator_tools || [];
    const orchestratorTools = orchestratorToolNames.length > 0
      ? toolRegistry.getToolDefinitionsForLLM(orchestratorToolNames)
      : [];

    const delegateToolDefinition = {
      name: 'delegate_to_agent',
      description: 'Delegate a task to one of the specialized agents on your team. The agent does NOT see the conversation history: it only receives your brief, so the task and context must be fully self-contained. The agent runs with its own system prompt, tools, and assigned documents, and its response is returned to you as the tool result. You can call this tool multiple times (for different agents or follow-up tasks) before writing your final answer.',
      input_schema: {
        type: 'object',
        properties: {
          agent_id: {
            type: 'number',
            description: 'The numeric ID of the agent to delegate to (see "Your Team" list).',
          },
          task: {
            type: 'string',
            description: 'A clear, self-contained description of what the agent must do.',
          },
          context: {
            type: 'string',
            description: 'All background information the agent needs (relevant facts from the conversation, data, constraints, prior results). The agent has NO other context.',
          },
          expected_output: {
            type: 'string',
            description: 'Optional: the format or content you expect back (e.g. "a bullet list of risks", "a table of figures").',
          },
        },
        required: ['agent_id', 'task', 'context'],
      },
    };
    const tools = [...orchestratorTools, delegateToolDefinition];

    // Delegation guardrails (per user turn)
    const maxDelegations = parseInt(process.env.ORCHESTRATOR_LED_MAX_DELEGATIONS, 10) || 10;
    // 0 / unset = unlimited token budget for delegated agents
    const delegationTokenBudget = parseInt(process.env.ORCHESTRATOR_LED_DELEGATION_TOKEN_BUDGET, 10) || 0;

    // Emit structured delegation status events to the streaming channel.
    // The chat route forwards these as dedicated SSE events (not text chunks).
    const emitDelegationStatus = (payload) => {
      if (!stream || typeof onChunk !== 'function') return;
      try {
        onChunk({ type: 'delegation_status', ...payload });
      } catch (e) {
        logger.warn('Failed to emit delegation status event:', e.message);
      }
    };

    // Delegation handler (locally scoped tool, not in the global registry)
    const delegations = [];
    let delegatedTokens = 0;
    // Counted synchronously at delegation start so the cap holds under parallel execution
    let startedDelegations = 0;
    const extraToolHandlers = new Map();
    extraToolHandlers.set('delegate_to_agent', async (input) => {
      if (startedDelegations >= maxDelegations) {
        logger.warn(`Delegation cap reached (${maxDelegations}) for session ${session.id}`);
        return {
          success: false,
          error: `Delegation limit reached (${maxDelegations} per turn). Do not delegate again. Write your final answer now using the specialist results you already have.`,
        };
      }
      if (delegationTokenBudget > 0 && delegatedTokens >= delegationTokenBudget) {
        logger.warn(`Delegation token budget reached (${delegatedTokens}/${delegationTokenBudget}) for session ${session.id}`);
        return {
          success: false,
          error: `Delegation token budget exhausted (${delegatedTokens}/${delegationTokenBudget} tokens used). Do not delegate again. Write your final answer now using the specialist results you already have.`,
        };
      }

      const agentId = parseInt(input.agent_id, 10);
      const agent = agents.find(a => a.id === agentId);
      if (!agent) {
        return {
          success: false,
          error: `Agent with id "${input.agent_id}" is not assigned to this session. Valid agent IDs: ${agents.map(a => `${a.id} (${a.name})`).join(', ')}`,
        };
      }
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      if (!task) {
        return { success: false, error: 'A non-empty "task" is required.' };
      }

      startedDelegations++;
      const delegationId = startedDelegations;
      const taskPreview = task.length > 200 ? task.slice(0, 200) + '…' : task;
      emitDelegationStatus({
        status: 'started',
        delegationId,
        agentId: agent.id,
        agentName: agent.name,
        task: taskPreview,
      });

      try {
        const result = await this.executeAgentWithBrief(agent, session, {
          task,
          context: input.context != null ? String(input.context) : '',
          expectedOutput: input.expected_output != null ? String(input.expected_output) : '',
        }, {
          allAgents: agents,
          documentContext: (documentContextByAgentId && documentContextByAgentId[agent.id] != null)
            ? documentContextByAgentId[agent.id]
            : documentContext,
          processedMediaCacheInfo: processedMediaCacheByAgentId?.[agent.id] || [],
        });

        delegations.push({
          agentId: agent.id,
          agentName: agent.name,
          task,
          content: result.content,
          tokensUsed: result.tokensUsed || 0,
        });
        delegatedTokens += result.tokensUsed || 0;

        emitDelegationStatus({
          status: 'finished',
          delegationId,
          agentId: agent.id,
          agentName: agent.name,
          tokensUsed: result.tokensUsed || 0,
        });

        return {
          success: true,
          result: {
            agent_id: agent.id,
            agent_name: agent.name,
            response: result.content,
          },
        };
      } catch (error) {
        logger.error(`Delegation to agent ${agent.name} failed:`, error);
        delegations.push({
          agentId: agent.id,
          agentName: agent.name,
          task,
          content: `[Error: ${error.message}]`,
          tokensUsed: 0,
          error: true,
        });
        emitDelegationStatus({
          status: 'failed',
          delegationId,
          agentId: agent.id,
          agentName: agent.name,
          error: error.message,
        });
        return { success: false, error: `Agent "${agent.name}" failed: ${error.message}` };
      }
    });

    // Build the lead-agent system prompt
    const initialContext = session.description
      ? `\n\n## Application Context\n\n${session.description}\n`
      : '';

    const agentList = agents.map(a =>
      `- ${a.name} (ID: ${a.id}, Role: ${a.role}): ${this.getRoleDescription(a.role)}`
    ).join('\n');

    const agentJsonList = agents.length > 0 ? this.buildAgentJsonList(agents) : '{}';

    const toolSummary = orchestratorTools.length > 0
      ? `\n\n## Your Own Tools\n\nBesides delegation, you have direct access to the following tools. Use them when appropriate:\n${orchestratorTools.map(t => `- ${t.name}: ${t.description}`).join('\n')}`
      : '';

    const systemPrompt = expandPromptMacros(`You are the lead agent (orchestrator) of a multi-agent advisory team. You are the only team member who sees the full conversation history, and you are responsible for the final answer to the user.${initialContext}

## Your Team

You can delegate work to the following specialized agents using the delegate_to_agent tool:
${agentList}

Agent Details (JSON):
${agentJsonList}

## How to work

- Answer simple or general questions yourself, without delegating.
- When specialist expertise would improve the answer, delegate to the relevant agent(s) using delegate_to_agent.
- IMPORTANT: delegated agents do NOT see the conversation history. Each brief must be fully self-contained: include all relevant facts, data, constraints, and prior results in the "task" and "context" fields.
- Keep briefs focused and concise: include only what the agent needs, not the entire conversation.
- You may delegate to multiple agents and you may send follow-up delegations based on earlier results, up to ${maxDelegations} delegations per user turn.
- When tasks are independent, issue multiple delegate_to_agent calls in the SAME response: they will run in parallel, which is faster. Use sequential follow-up delegations only when one result depends on another.
- Past assistant messages in the conversation history may include "[Specialist results behind this answer]" blocks with what each agent previously reported. Reuse those results instead of re-delegating identical tasks.
- After gathering the results you need, write the final answer to the user yourself, synthesizing and reconciling the agents' contributions. Do not just paste raw agent output: integrate it.${toolSummary}${documentContext ? `\n\n## Document Context\n\nUse the following document context to help answer questions:\n${documentContext}` : ''}`, {
      session,
      provider: providerType,
      model,
      tools: orchestratorToolNames,
    });

    const ContextManager = require('../sessions/ContextManager');
    const documentsSuffix = ContextManager.buildDocumentsSectionForOrchestrator(session) || '';
    const userMessageWithDocs = userMessage + documentsSuffix;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...context,
      { role: 'user', content: userMessageWithDocs },
    ];

    logger.info('=== ORCHESTRATOR-LED MODE PROMPT ===');
    const ledToolsLine = (tools && tools.length > 0) ? '\nTools: ' + tools.map(t => t.name).join(', ') : '';
    promptsLogger.info('\n\n=== ORCHESTRATOR-LED MODE PROMPT ===\n' + JSON.stringify(messages, null, 2) + ledToolsLine);

    const execOptions = {
      stream,
      onChunk,
      extraToolHandlers,
      // Independent delegations issued in one orchestrator response run concurrently
      parallelToolNames: ['delegate_to_agent'],
      // delegate_to_agent emits structured delegation_status events instead of raw [Tool] notices
      toolNoticeExclude: ['delegate_to_agent'],
    };
    if (session.orchestrator_provider_config?.enablePromptCache) {
      execOptions.usePromptCache = true;
      execOptions.conversationId = conversationIdForCache(session.id, null);
    }

    const result = await this.executeWithTools(
      provider,
      messages,
      tools,
      { userId: session.user_id, sessionId: session.id, agentId: null },
      execOptions
    );

    const delegatedNames = [...new Set(delegations.map(d => d.agentName))];
    return {
      content: result.content,
      agentId: null,
      agentName: 'Orchestrator',
      routedTo: 'orchestrator_led',
      reasoning: delegatedNames.length > 0
        ? `Orchestrator-led: delegated to ${delegatedNames.join(', ')}`
        : 'Orchestrator-led: handled without delegation',
      tokensUsed: (result.tokensUsed || 0) + delegatedTokens,
      toolCalls: result.toolCalls,
      delegations,
    };
  }

  /**
   * Execute a specialized agent with ONLY an orchestrator-crafted brief (no conversation history).
   * Used by orchestrator-led mode via the delegate_to_agent tool.
   * @param {object} agent - The agent to run
   * @param {object} session - Complete session object
   * @param {{task: string, context: string, expectedOutput: string}} brief - Orchestrator-provided brief
   * @param {object} options - { allAgents, documentContext, processedMediaCacheInfo }
   * @returns {Promise<{content: string, tokensUsed: number, toolCalls: Array}>}
   */
  static async executeAgentWithBrief(agent, session, brief, options = {}) {
    const { allAgents = null, documentContext = '', processedMediaCacheInfo = [] } = options;

    await syncAssignedDocumentsToWorkspace(session.id, agent.id);

    const provider = await AgentService.getAgentProvider(agent.id, session.user_id);

    // No conversation summary: the agent works exclusively from the brief
    const systemPrompt = this.buildAgentSystemPrompt(agent, allAgents, documentContext, null, processedMediaCacheInfo, session);

    const { tools, allowedToolNames } = await this.buildToolsForAgent(session.id, agent.id);
    const agentModel = provider?.model || null;
    const providerSupportsTools = !(provider && typeof provider.supportsTools === 'function' && !provider.supportsTools(agentModel));
    const providerTools = providerSupportsTools ? tools : [];
    const providerAllowedToolNames = providerSupportsTools ? allowedToolNames : [];

    const ContextManager = require('../sessions/ContextManager');
    const documentsSuffix = (session.document_agent_assignment_map && ContextManager.buildDocumentsSectionForAgent(agent.id, session)) || '';

    const briefSections = [
      'You have been delegated a task by the team orchestrator. You do not have access to the conversation history; everything you need is in this brief.',
      `## Task\n\n${brief.task}`,
    ];
    if (brief.context && brief.context.trim()) {
      briefSections.push(`## Context (provided by the orchestrator)\n\n${brief.context.trim()}`);
    }
    if (brief.expectedOutput && brief.expectedOutput.trim()) {
      briefSections.push(`## Expected Output\n\n${brief.expectedOutput.trim()}`);
    }
    briefSections.push('Complete the task now. Respond with your result only; it will be returned to the orchestrator.');

    const briefMessage = briefSections.join('\n\n') + documentsSuffix;

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: briefMessage },
    ];

    logger.info(`=== AGENT BRIEF PROMPT: ${agent.name} (${agent.role}) ===`);
    const briefToolsLine = (providerTools && providerTools.length > 0) ? '\nTools: ' + providerTools.map(t => t.name).join(', ') : '';
    promptsLogger.info(`\n\n=== AGENT BRIEF PROMPT: ${agent.name} (${agent.role}) ===\n` + JSON.stringify(messages, null, 2) + briefToolsLine);

    const execOpts = { stream: false, onChunk: null, allowedToolNames: providerAllowedToolNames };
    if (agent.provider_config?.enablePromptCache) {
      execOpts.usePromptCache = true;
      execOpts.conversationId = conversationIdForCache(session.id, agent.id);
    }

    const result = await this.executeWithTools(
      provider,
      messages,
      providerTools,
      { userId: session.user_id, sessionId: session.id, agentId: agent.id },
      execOpts
    );

    return {
      content: result.content,
      tokensUsed: result.tokensUsed,
      toolCalls: result.toolCalls,
    };
  }

  /**
   * Execute LLM call with tool support (handles tool use loop)
   */
  static async executeWithTools(provider, messages, tools, context, options) {
    const {
      stream,
      onChunk,
      emitToolNotices = true,
      allowedToolNames = null,
      usePromptCache = false,
      conversationId = null,
      extraToolHandlers = null,
      parallelToolNames = null,
      toolNoticeExclude = null,
    } = options;
    const maxIterations = 100; // Prevent infinite loops
    let iterations = 0;
    let totalTokensUsed = 0;
    const toolCalls = [];
    const allowedToolNameSet = Array.isArray(allowedToolNames) ? new Set(allowedToolNames) : null;
    const parallelToolNameSet = Array.isArray(parallelToolNames) ? new Set(parallelToolNames) : null;
    const toolNoticeExcludeSet = Array.isArray(toolNoticeExclude) ? new Set(toolNoticeExclude) : null;

    // Make a copy of messages to avoid mutating the original
    const workingMessages = [...messages];

    while (iterations < maxIterations) {
      iterations++;

      let response;
      if (stream && onChunk && iterations === 1) {
        // Only stream on first iteration (before any tool calls)
        // Providers return chunk objects like { type: 'text', content: '...' }
        logger.info(`=== EXECUTING WITH TOOLS (Streaming, Iteration ${iterations}) ===`);
        const execToolsLine = (tools && tools.length > 0) ? '\nTools: ' + tools.map(t => t.name).join(', ') : '';
        promptsLogger.info(`\n\n=== EXECUTING WITH TOOLS (Streaming, Iteration ${iterations}) ===\n` + JSON.stringify(workingMessages, null, 2) + execToolsLine);
        const chatOpts = { tools };
        if (usePromptCache) chatOpts.usePromptCache = true;
        if (conversationId) chatOpts.conversationId = conversationId;
        response = await provider.streamChat(workingMessages, (chunk) => {
          // Pass the text content to the outer callback; normalize in case content is array/object
          if (chunk.type === 'text' && chunk.content != null) {
            const text = BaseLLMProvider.extractTextFromContent(chunk.content);
            if (text) onChunk(text);
          }
        }, chatOpts);
        response = response || { content: '', stop_reason: 'end_turn' };
      } else {
        logger.info(`=== EXECUTING WITH TOOLS (Iteration ${iterations}) ===`);
        const execToolsLine = (tools && tools.length > 0) ? '\nTools: ' + tools.map(t => t.name).join(', ') : '';
        promptsLogger.info(`\n\n=== EXECUTING WITH TOOLS (Iteration ${iterations}) ===\n` + JSON.stringify(workingMessages, null, 2) + execToolsLine);
        const chatOpts = { tools };
        if (usePromptCache) chatOpts.usePromptCache = true;
        if (conversationId) chatOpts.conversationId = conversationId;
        response = await provider.chat(workingMessages, chatOpts);
      }

      totalTokensUsed += response.usage?.total_tokens || 0;

      // Check if the response includes tool use
      // Different providers use different stop/finish reasons:
      // - Claude: 'tool_use'
      // - OpenAI/Ollama: 'tool_calls' 
      // - Gemini: normalized to 'tool_use'
      // Primary check: tool_calls array exists and has items
      // Secondary check: stop_reason indicates tool use
      const hasToolCalls = response.tool_calls && response.tool_calls.length > 0;
      if (hasToolCalls) {
        // Add assistant message with tool use to conversation.
        // Kimi thinking models require reasoning_content when thinking is enabled.
        const assistantMessage = {
          role: 'assistant',
          content: BaseLLMProvider.extractTextFromContent(response.content) || '',
          tool_calls: response.tool_calls,
          reasoning_content: response.reasoning_content ?? '',
        };
        workingMessages.push(assistantMessage);
        logger.info(`=== ASSISTANT TOOL CALLS (Iteration ${iterations}) ===`);
        promptsLogger.info(`\n\n=== ASSISTANT TOOL CALLS (Iteration ${iterations}) ===\n` + JSON.stringify(assistantMessage, null, 2));

        // Execute a single tool call and return its result
        const executeToolCall = async (toolCall) => {
          const toolName = toolCall.name;
          logger.info(`Executing tool: ${toolName}`, { input: toolCall.input });

          const extraHandler = extraToolHandlers &&
            (typeof extraToolHandlers.get === 'function' ? extraToolHandlers.get(toolName) : extraToolHandlers[toolName]);
          if (extraHandler) {
            // Locally-scoped tool (e.g. delegate_to_agent) not registered in the global ToolRegistry
            try {
              return await extraHandler(toolCall.input || {});
            } catch (handlerError) {
              logger.error(`Extra tool handler error (${toolName}):`, handlerError);
              return { success: false, error: handlerError.message || 'Tool handler failed' };
            }
          }
          if (allowedToolNameSet && !allowedToolNameSet.has(toolName)) {
            logger.warn(`Blocked tool call (not allowed): ${toolName}`);
            return {
              success: false,
              error: `Tool "${toolName}" is not enabled for this agent in this session.`,
            };
          }
          return await toolExecutor.execute(toolName, toolCall.input, context);
        };

        // Run tool calls in parallel when every call in this response is whitelisted
        // for concurrency (e.g. independent delegate_to_agent calls); otherwise sequential.
        const canParallelize = parallelToolNameSet &&
          response.tool_calls.length > 1 &&
          response.tool_calls.every(tc => parallelToolNameSet.has(tc.name));

        let toolResults;
        if (canParallelize) {
          logger.info(`Executing ${response.tool_calls.length} tool calls in parallel: ${response.tool_calls.map(tc => tc.name).join(', ')}`);
          toolResults = await Promise.all(response.tool_calls.map(tc => executeToolCall(tc)));
        } else {
          toolResults = [];
          for (const tc of response.tool_calls) {
            toolResults.push(await executeToolCall(tc));
          }
        }

        // Append results to the conversation in the original tool-call order
        for (let i = 0; i < response.tool_calls.length; i++) {
          const toolCall = response.tool_calls[i];
          const toolName = toolCall.name;
          const toolResult = toolResults[i];

          toolCalls.push({
            name: toolName,
            input: toolCall.input,
            result: toolResult,
          });

          // Add tool result to conversation
          const toolResultMessage = {
            role: 'tool',
            tool_call_id: toolCall.id,
            tool_name: toolName, // Required for Gemini provider
            content: JSON.stringify(toolResult.success ? toolResult.result : { error: toolResult.error }),
          };
          workingMessages.push(toolResultMessage);
          logger.info(`=== TOOL RESULT ADDED: ${toolName} ===`);
          promptsLogger.info(`\n\n=== TOOL RESULT ADDED: ${toolName} ===\n` + JSON.stringify(toolResultMessage, null, 2));

          // If streaming, notify about tool execution (excluded tools emit their own
          // structured events instead, e.g. delegate_to_agent)
          if (emitToolNotices && stream && onChunk && !(toolNoticeExcludeSet && toolNoticeExcludeSet.has(toolName))) {
            let inputPreview = '';
            try {
              inputPreview = toolCall?.input != null ? JSON.stringify(toolCall.input) : '';
            } catch (e) {
              inputPreview = '[unserializable input]';
            }
            if (typeof inputPreview === 'string' && inputPreview.length > 800) {
              inputPreview = inputPreview.slice(0, 800) + '…';
            }
            const inputPart = inputPreview ? ` input=${inputPreview}` : '';
            const blockedPart = (allowedToolNameSet && !allowedToolNameSet.has(toolName)) ? ' (blocked)' : '';
            onChunk(`\n[Tool] ${toolName}${blockedPart}${inputPart}\n`);
          }
        }

        // Continue the loop to get the next response
        continue;
      }

      // No more tool calls, return the final response
      // Normalize content to string (some providers return array/object for multimodal)
      const finalContent = BaseLLMProvider.extractTextFromContent(response.content) || '';

      // If we have tool calls and are streaming, stream the final response
      if (stream && onChunk && iterations > 1 && finalContent) {
        const chunks = finalContent.match(/.{1,50}/g) || [finalContent];
        for (const chunk of chunks) {
          onChunk(chunk);
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      return {
        content: finalContent,
        tokensUsed: totalTokensUsed,
        toolCalls,
      };
    }

    // Max iterations reached
    logger.warn('Max tool iterations reached');
    return {
      content: 'I was unable to complete the task due to too many tool calls. Please try a simpler request.',
      tokensUsed: totalTokensUsed,
      toolCalls,
    };
  }

  /**
   * Build system prompt for an agent
   * Priority: session_context > initial_context > role default
   * When session_context is used, we skip adding identity/team/orchestrator sections
   * since those are already included in the user-editable session context.
   * Documents list is appended to the user message at runtime, not in the system prompt.
   * @param {Array<{filename: string, cacheRelativePath: string}>} processedMediaCacheInfo - Assigned docs already processed by process_media and cached in working folder
   * @param {object} session - Session object (unused here; documents are on user message)
   */
  static buildAgentSystemPrompt(agent, allAgents = [], documentContext, conversationSummary = null, processedMediaCacheInfo = null, session = null) {
    const processedMediaSection = (processedMediaCacheInfo && processedMediaCacheInfo.length > 0)
      ? `\n\n--- Processed Media (Cached) ---\nThe following assigned documents have been processed by process_media; results are cached in your working folder. Load when needed via local_working_folder read_file using the path shown:\n${processedMediaCacheInfo.map(({ filename, cacheRelativePath }) => `- "${filename}" → ${cacheRelativePath}`).join('\n')}\n--- End Processed Media ---\n`
      : '';

    const assignedDocsSymlinkNote = (session && session.document_agent_assignment_map)
      ? '\n\nWhen local_working_folder is configured, assigned documents are also symlinked in your workspace under assigned_documents/; use list_dir or read_file to access them.'
      : '';

    const agentTools = session
      ? require('../sessions/ContextManager').getAgentTools(agent.id, session)
      : [];
    const expand = (text) => expandPromptMacros(text, { session, agent, tools: agentTools });

    // Check if agent has session-specific context (set via Configure Session)
    if (agent.session_context) {
      // Session context already includes identity, team members, tools
      let prompt = agent.session_context;

      const summarySection = conversationSummary
        ? `\n\n--- Conversation Context ---\nThe user has been discussing the following with the main assistant:\n${conversationSummary}\n--- End Conversation Context ---\nUse this context to understand the background of the user's request.`
        : '';

      const docSection = documentContext
        ? `\n\n--- Relevant Document Context ---\n${documentContext}\n--- End Document Context ---\nUse this context when relevant to the user's question.`
        : '';

      return expand(`${prompt}${summarySection}${docSection}${processedMediaSection}${assignedDocsSymlinkNote}`);
    }

    // Fallback to old behavior for backwards compatibility
    const basePrompt = agent.initial_context || this.getDefaultSystemPrompt(agent.role);

    // Add agent name identification at the beginning
    const nameSection = `\n\n--- Your Identity ---\nYour name is: ${agent.name}\nYour role is: ${agent.role}\n\nWhen you see messages in the conversation history, messages from you will be labeled with your name "${agent.name}". When the user refers to you by name "${agent.name}", they are addressing you directly.`;

    // Add team members section if there are other agents
    const teamMembersSection = allAgents && allAgents.length > 1
      ? `\n\n--- Team Members ---\nYou are part of a team of specialized agents. Here are your team members you can collaborate with:\n\n${this.buildAgentJsonList_forAgents(allAgents)}\n\nYou can reference these team members when their expertise would be helpful, or when the user's question spans multiple areas of expertise. Use @team_member_name to reference a team member by name.`
      : '';
    const orchestratorSection = `\n\n--- The Team leader is the Orchestrator; He is the main assistant for the project and he is helping the user with the project. He will assign tasks to the team members and keep track of the tasks for the project and each agent and will look for ways to measure the progress of the project.  ---\n`;
  
    
    const summarySection = conversationSummary
      ? `\n\n--- Conversation Context ---\nThe user has been discussing the following with the main assistant:\n${conversationSummary}\n--- End Conversation Context ---\nUse this context to understand the background of the user's request.`
      : '';

    const docSection = documentContext
      ? `\n\n--- Relevant Document Context ---\n${documentContext}\n--- End Document Context ---\nUse this context when relevant to the user's question.`
      : '';

    return expand(`${basePrompt}${nameSection}${teamMembersSection}${orchestratorSection}${summarySection}${docSection}${processedMediaSection}${assignedDocsSymlinkNote}`);
  }

  /**
   * Synthesize multiple agent responses into a coherent answer
   */
  static synthesizeResponses(responses, userMessage) {
    if (responses.length === 1) {
      return responses[0].content;
    }

    const parts = responses.map(r => {
      return `**${r.agent.name} (${this.getRoleDescription(r.agent.role)}):**\n${r.content}`;
    });

    return `I've gathered insights from multiple specialists to address your question:\n\n${parts.join('\n\n---\n\n')}`;
  }

  /**
   * Get description for agent role
   */
  static getRoleDescription(role) {
    const descriptions = {
      legal: 'Legal compliance and regulations',
      accounting: 'Financial accounting and tax preparation',
      marketing: 'Marketing strategy and customer acquisition',
      sales: 'Sales processes and revenue optimization',
      logistics: 'Supply chain and operations management',
      production: 'Manufacturing and production efficiency',
      hr: 'Human resources and employment matters',
      custom: 'General business advisory',
    };
    return descriptions[role] || 'Business advisory';
  }

  /**
   * Get default system prompt for a role
   */
  static getDefaultSystemPrompt(role) {
    const prompts = {
      legal: `You are a legal advisor specializing in small business law. You help with:
- Business entity selection and formation
- Contract review and compliance
- Employment law and regulations
- Intellectual property protection
- Regulatory compliance

Always recommend consulting with a licensed attorney for specific legal advice.`,

      accounting: `You are an accounting expert for small businesses. You help with:
- Bookkeeping and financial statements
- Tax planning and preparation
- Payroll and expense management
- Financial analysis and reporting
- Cash flow management

Always recommend consulting with a CPA for specific tax advice.`,

      marketing: `You are a marketing strategist for small businesses. You help with:
- Brand development and positioning
- Digital marketing strategies
- Customer acquisition and retention
- Social media and content marketing
- Marketing budget optimization`,

      sales: `You are a sales consultant for small businesses. You help with:
- Sales process optimization
- Lead generation and qualification
- Pricing strategies
- Customer relationship management
- Sales team management`,

      logistics: `You are a logistics coordinator for small businesses. You help with:
- Supply chain management
- Inventory optimization
- Shipping and fulfillment
- Vendor relationships
- Operational efficiency`,

      production: `You are a production manager for small businesses. You help with:
- Manufacturing processes
- Quality control
- Resource planning
- Production scheduling
- Cost optimization`,

      hr: `You are an HR specialist for small businesses. You help with:
- Hiring and onboarding
- Employee policies and handbooks
- Benefits administration
- Performance management
- Workplace compliance`,

      custom: `You are a knowledgeable business advisor. Provide helpful, accurate information while being clear about the limits of your expertise.`,
    };

    return prompts[role] || prompts.custom;
  }

  /**
   * Extract specialties from system prompt
   */
  static extractSpecialties(systemPrompt) {
    // Simple extraction of bullet points or key topics
    const matches = systemPrompt.match(/[-•]\s*([^\n]+)/g) || [];
    return matches.slice(0, 5).map(m => m.replace(/[-•]\s*/, '').trim());
  }

  /**
   * Get orchestrator API key from session config or environment
   * @param {object} session - Session object
   * @param {string} providerType - Provider type
   * @returns {string|null} - API key or null
   */
  static getOrchestratorApiKey(session, providerType) {
    // First check session config
    if (session.orchestrator_provider_config) {
      try {
        let config = session.orchestrator_provider_config;
        if (typeof config === 'string') {
          const { decrypt } = require('../../utils/encryption');
          config = JSON.parse(decrypt(config));
        }
        if (config.apiKey && config.apiKey.trim()) {
          return config.apiKey.trim();
        }
      } catch (e) {
        logger.warn('Failed to parse orchestrator config for API key:', e.message);
      }
    }
    
    // Fall back to environment variables
    return this.getProviderApiKey(providerType);
  }

  /**
   * Get API key for provider from environment
   */
  static getProviderApiKey(providerType) {
    const envKeys = {
      claude: process.env.ANTHROPIC_API_KEY,
      openai: process.env.OPENAI_API_KEY,
      gemini: process.env.GOOGLE_API_KEY,
      xai: process.env.XAI_API_KEY,
      deepseek: process.env.DEEPSEEK_API_KEY,
      qwen: process.env.DASHSCOPE_API_KEY || process.env.QWEN_API_KEY,
      kimi: process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY,
      ollama: 'not-required',
    };
    return envKeys[providerType];
  }

  /**
   * Get orchestrator model from session config or use default
   */
  static getOrchestratorModel(session, providerType) {
    // Check if session has a configured model
    if (session.orchestrator_provider_config?.model) {
      return session.orchestrator_provider_config.model;
    }
    // Fall back to default
    return this.getDefaultModel(providerType);
  }

  /**
   * Get orchestrator timeout from session config or use default
   */
  static getOrchestratorTimeout(session) {
    // Check if session has a configured timeout
    if (session.orchestrator_provider_config?.timeout) {
      return session.orchestrator_provider_config.timeout;
    }
    // Fall back to default (60 seconds)
    return 60000;
  }

  /**
   * Get default model for provider
   */
  static getDefaultModel(providerType) {
    const defaultModels = {
      claude: 'claude-haiku-4-5-20251001',
      openai: 'gpt-5-mini',
      gemini: 'gemini-2.5-flash',
      ollama: 'granite4:small-h',
    };
    return defaultModels[providerType];
  }

  /** Stable conversation ID for prompt caching (e.g. xAI x-grok-conv-id). */
  static getConversationIdForCache(sessionId, agentId) {
    return conversationIdForCache(sessionId, agentId);
  }
}

module.exports = OrchestratorAgent;
