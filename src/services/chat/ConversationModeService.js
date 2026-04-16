/**
 * Conversation Mode Service
 * Handles autonomous multi-agent brainstorming sessions
 */

const WorkSession = require('../../models/WorkSession');
const Message = require('../../models/Message');
const ConversationRound = require('../../models/ConversationRound');
const AgentService = require('../agents/AgentService');
const ProviderFactory = require('../../providers/ProviderFactory');
const OrchestratorAgent = require('./OrchestratorAgent');
const { toolRegistry } = require('../tools/ToolRegistry');
const { syncAssignedDocumentsToWorkspace } = require('../tools/localWorkingFolderTool');
const { decrypt } = require('../../utils/crypto');
const logger = require('../../utils/logger');
const promptsLogger = logger.promptsLogger;

class ConversationModeService {
  constructor() {
    // Track active conversations in memory: sessionId -> ConversationState
    this.activeConversations = new Map();
  }

  /**
   * Build agent JSON list for brainstorming agent prompts (team members)
   */
  buildAgentJsonList_forAgents(agents) {
    const agentMap = {};

    for (const agent of agents || []) {
      let model = 'unknown';
      try {
        if (agent.provider_config) {
          const config = typeof agent.provider_config === 'string'
            ? JSON.parse(decrypt(agent.provider_config))
            : agent.provider_config;
          model = config.model || 'unknown';
        }
      } catch (error) {
        logger.warn(`Failed to decrypt agent config for ${agent?.name || 'unknown agent'}:`, error.message);
      }

      agentMap[agent.name] = {
        model,
        role: agent.role,
      };
    }

    return JSON.stringify(agentMap, null, 2);
  }

  /**
   * Start a new conversation mode session
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {string} initialPrompt - Initial topic/prompt for brainstorming
   * @param {object} options - Options (maxRounds, tokenBudget)
   * @returns {Promise<object>} - Conversation state
   */
  async startConversation(sessionId, userId, initialPrompt, options = {}) {
    try {
      // Check if conversation is already active
      if (this.activeConversations.has(sessionId)) {
        const existing = this.activeConversations.get(sessionId);
        if (existing.status === 'running') {
          throw new Error('A conversation is already running for this session');
        }
      }

      // Get session and validate
      const session = await WorkSession.findById(sessionId);
      if (!session || session.user_id !== userId) {
        throw new Error('Session not found or access denied');
      }

      // Get conversation mode settings from session or use provided options
      const settings = await WorkSession.getConversationModeSettings(sessionId);
      const maxRounds = options.maxRounds || settings?.maxRounds || 10;
      const tokenBudget = options.tokenBudget || settings?.tokenBudget || 50000;

      // Get assigned agents
      const agents = await WorkSession.getAgents(sessionId);
      if (agents.length === 0) {
        throw new Error('No agents assigned to session. Please assign agents before starting a conversation.');
      }

      // Create conversation state
      const state = {
        sessionId,
        userId,
        status: 'running',
        currentRound: 0,
        maxRounds,
        tokenBudget,
        tokensUsed: 0,
        agents,
        initialPrompt,
        startedAt: new Date(),
      };

      this.activeConversations.set(sessionId, state);

      // Store initial user message
      await Message.create({
        session_id: sessionId,
        role: 'user',
        content: initialPrompt,
      });

      logger.info(`Conversation mode started for session ${sessionId} with ${agents.length} agents`);

      return state;
    } catch (error) {
      logger.error('Error starting conversation:', error);
      throw error;
    }
  }

  /**
   * Execute the next round of conversation
   * @param {number} sessionId - Session ID
   * @param {function} onChunk - Callback for streaming chunks
   * @returns {Promise<object>} - Result { done, speaker, response, round, tokensUsed }
   */
  async executeNextRound(sessionId, onChunk = null) {
    const state = this.activeConversations.get(sessionId);

    if (!state || state.status !== 'running') {
      return { done: true, reason: 'not_running' };
    }

    // Check stop conditions
    if (state.currentRound >= state.maxRounds) {
      state.status = 'completed';
      logger.info(`Conversation ${sessionId} completed: max rounds reached`);
      return { done: true, reason: 'max_rounds' };
    }

    if (state.tokensUsed >= state.tokenBudget) {
      state.status = 'completed';
      logger.info(`Conversation ${sessionId} completed: token budget exceeded`);
      return { done: true, reason: 'token_budget' };
    }

    state.currentRound++;

    try {
      // Create round record
      const round = await ConversationRound.create({
        session_id: sessionId,
        round_number: state.currentRound,
        status: 'running',
      });

      // Get shared context (recent messages)
      const context = await Message.getContextForAgents(sessionId, process.env.DEFAULT_MESSAGE_LIMIT_CONTEXT_LENGTH || 10);

      // Orchestrator decides who speaks next
      const speakerDecision = await this.selectNextSpeaker(state, context);

      if (speakerDecision.conclude) {
        // Orchestrator decided to conclude
        state.status = 'completed';
        await ConversationRound.updateStatus(round.id, 'completed');

        // Add conclusion message
        await Message.create({
          session_id: sessionId,
          role: 'assistant',
          content: speakerDecision.conclusion,
          agent_name: 'Orchestrator',
        });

        logger.info(`Conversation ${sessionId} concluded by orchestrator`);

        return {
          done: true,
          reason: 'orchestrator_concluded',
          conclusion: speakerDecision.conclusion,
        };
      }

      // Find the selected agent
      const speaker = state.agents.find(a => a.id === speakerDecision.agentId);
      if (!speaker) {
        // Fallback to first agent
        logger.warn(`Agent ${speakerDecision.agentId} not found, using first agent`);
        speakerDecision.agentId = state.agents[0].id;
      }
      const actualSpeaker = speaker || state.agents[0];

      // Execute selected agent's turn
      const response = await this.executeAgentTurn(actualSpeaker, state, context, onChunk);

      // Update round and state
      await ConversationRound.updateStatus(round.id, 'completed', {
        speaker_agent_id: actualSpeaker.id,
        speaker_agent_name: actualSpeaker.name,
        tokens_used: response.tokensUsed,
      });

      state.tokensUsed += response.tokensUsed || 0;

      // Extract and create artifacts from the response content
      const ArtifactService = require('../artifacts/ArtifactService');
      const artifacts = await ArtifactService.processArtifacts(response.content);

      // Store agent message with artifact metadata
      const metadata = artifacts.length > 0 ? { artifacts } : null;

      await Message.create({
        session_id: sessionId,
        role: 'assistant',
        content: response.content,
        agent_id: actualSpeaker.id,
        agent_name: actualSpeaker.name,
        tokens_used: response.tokensUsed,
        metadata,
      });

      logger.debug(`Round ${state.currentRound} completed by ${actualSpeaker.name}`);

      return {
        done: false,
        speaker: actualSpeaker,
        response: response.content,
        round: state.currentRound,
        tokensUsed: state.tokensUsed,
      };
    } catch (error) {
      logger.error(`Error in round ${state.currentRound}:`, error);
      // Don't fail the entire conversation, just this round
      return {
        done: false,
        error: error.message,
        round: state.currentRound,
      };
    }
  }

  /**
   * Orchestrator selects next speaker
   * @param {object} state - Conversation state
   * @param {Array} context - Message context
   * @returns {Promise<object>} - { conclude: boolean, agentId?, conclusion? }
   */
  async selectNextSpeaker(state, context) {
    try {
      const session = await WorkSession.findById(state.sessionId);
      const provider = await this.getOrchestratorProvider(session);

      const agentList = state.agents.map(a =>
        `- ID: ${a.id}, Name: ${a.name}, Role: ${a.role}${a.initial_context ? `, Specialty: ${a.initial_context.substring(0, 100)}...` : ''}`
      ).join('\n');

      const recentMessages = context.slice(-10).map(m =>
        `[${m.agent_name || m.role}]: ${m.content.substring(0, 200)}${m.content.length > 200 ? '...' : ''}`
      ).join('\n\n');

      const prompt = `You are orchestrating a multi-agent brainstorming session.

Topic: ${state.initialPrompt}

Available Agents:
${agentList}

Recent Discussion:
${recentMessages}

Current Round: ${state.currentRound}/${state.maxRounds}
Tokens Used: ${state.tokensUsed}/${state.tokenBudget}

Your task: Decide who should speak next OR if the discussion should conclude.

Rules:
1. Each agent should contribute unique perspectives based on their role
2. Avoid having the same agent speak twice in a row unless necessary
3. Conclude when: the topic is thoroughly covered, agents are repeating themselves, or a natural endpoint is reached
4. When concluding, provide a brief summary of key insights

Respond in JSON format ONLY:
{
  "action": "continue" | "conclude",
  "agentId": <agent ID number if continue>,
  "reasoning": "<brief explanation>",
  "conclusion": "<summary if concluding, otherwise omit>"
}`;

      const orchestratorMessages = [
        { role: 'system', content: 'You are a discussion orchestrator. Respond only with valid JSON. No markdown, no explanation outside the JSON.' },
        { role: 'user', content: prompt },
      ];

      logger.info(`=== CONVERSATION MODE ORCHESTRATOR PROMPT session=${state.sessionId} round=${state.currentRound} ===`);
      promptsLogger.info(
        `\n\n=== CONVERSATION MODE ORCHESTRATOR PROMPT session=${state.sessionId} round=${state.currentRound} ===\n` +
        JSON.stringify(orchestratorMessages, null, 2)
      );

      let orchestratorChatOpts = { maxTokens: 500 };
      try {
        const config = typeof session.orchestrator_provider_config === 'string'
          ? JSON.parse(decrypt(session.orchestrator_provider_config))
          : session.orchestrator_provider_config;
        if (config?.enablePromptCache) {
          orchestratorChatOpts.usePromptCache = true;
          orchestratorChatOpts.conversationId = OrchestratorAgent.getConversationIdForCache(state.sessionId, null);
        }
      } catch (e) {
        // ignore
      }
      const response = await provider.chat(orchestratorMessages, orchestratorChatOpts);

      // Parse the response
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in orchestrator response');
      }

      const decision = JSON.parse(jsonMatch[0]);

      if (decision.action === 'conclude') {
        return {
          conclude: true,
          conclusion: decision.conclusion || 'Discussion concluded.',
        };
      }

      return {
        conclude: false,
        agentId: decision.agentId,
        reasoning: decision.reasoning,
      };
    } catch (error) {
      logger.error('Error selecting next speaker:', error);
      // Fallback: pick a random agent
      const randomAgent = state.agents[Math.floor(Math.random() * state.agents.length)];
      return {
        conclude: false,
        agentId: randomAgent.id,
        reasoning: 'Fallback selection due to error',
      };
    }
  }

  /**
   * Execute an agent's turn in the conversation
   * @param {object} agent - Agent object
   * @param {object} state - Conversation state
   * @param {Array} context - Message context
   * @param {function} onChunk - Callback for streaming
   * @returns {Promise<object>} - { content, tokensUsed }
   */
  async executeAgentTurn(agent, state, context, onChunk = null) {
    try {
      await syncAssignedDocumentsToWorkspace(state.sessionId, agent.id);

      const provider = await AgentService.getAgentProvider(agent.id, state.userId);

      const teamMembersSection = state.agents && state.agents.length > 1
        ? `\n\n--- Team Members ---\nYou are part of a team of specialized agents. Here are your team members you can collaborate with:\n\n${this.buildAgentJsonList_forAgents(state.agents)}\n\nYou can reference these team members when their expertise would be helpful, or when the topic spans multiple areas of expertise.\n--- End Team Members ---`
        : '';

      const systemPrompt = `${agent.initial_context || `You are a ${agent.role} specialist.`}

--- Your Identity ---
Your name is: ${agent.name}
Your role is: ${agent.role}

When you see messages in the conversation history, messages from you will be labeled with your name "${agent.name}". When the user refers to you by name "${agent.name}", they are addressing you directly.

You are participating in a brainstorming session about: ${state.initialPrompt}
${teamMembersSection}
Remaining rounds: ${state.currentRound}/${state.maxRounds}

--- CRITICAL: When to Respond ---
You MUST ONLY answer when:
1. The question is addressed to you specifically by name "${agent.name}" or "@${agent.name}"
2. The question is addressed to "the team" or "@team"

Otherwise, you MUST NEVER answer. If a question is not addressed to you or the team, remain silent and do not respond.

Guidelines:
- Build on previous contributions from other specialists
- Provide unique insights from your area of expertise
- Be concise but insightful (aim for 2-4 paragraphs)
- Reference and build upon what others have said
- Add new perspectives or develop existing ideas further
- Avoid repeating points already made`;

      // Format context messages for the agent
      const formattedContext = context.map(m => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.agent_name ? `[${m.agent_name}]: ${m.content}` : m.content,
      }));

      const messages = [
        { role: 'system', content: systemPrompt },
        ...formattedContext,
      ];

      const mode = onChunk ? 'stream' : 'chat';
      // Respect per-agent tool assignments if configured for this session
      const allowedToolNames = await OrchestratorAgent.getAllowedToolNamesForAgent(state.sessionId, agent.id);
      const tools = allowedToolNames
        ? toolRegistry.getToolDefinitionsForLLM(allowedToolNames)
        : toolRegistry.getToolDefinitionsForLLM();
      const providerTools = (provider && typeof provider.supportsTools === 'function' && !provider.supportsTools())
        ? []
        : tools;
      const providerAllowedToolNames = (provider && typeof provider.supportsTools === 'function' && !provider.supportsTools())
        ? []
        : allowedToolNames;
      const toolsLine = (providerTools && providerTools.length > 0) ? '\nTools: ' + providerTools.map(t => t.name).join(', ') : '';
      logger.info(`=== CONVERSATION MODE AGENT PROMPT session=${state.sessionId} round=${state.currentRound} agent=${agent.name} (${agent.role}) mode=${mode} ===`);
      promptsLogger.info(
        `\n\n=== CONVERSATION MODE AGENT PROMPT session=${state.sessionId} round=${state.currentRound} agent=${agent.name} (${agent.role}) mode=${mode} ===\n` +
        JSON.stringify(messages, null, 2) + toolsLine
      );

      // Enable tool use in conversation mode by using the same tool loop as normal chat.
      // Wrap streaming chunks so the UI can attribute them to the speaking agent.
      const execOpts = {
        stream: !!onChunk,
        onChunk: onChunk ? (text) => onChunk({ agent: agent.name, chunk: text }) : null,
        allowedToolNames: providerAllowedToolNames,
      };
      try {
        const agentConfig = typeof agent.provider_config === 'string'
          ? JSON.parse(decrypt(agent.provider_config))
          : agent.provider_config;
        if (agentConfig?.enablePromptCache) {
          execOpts.usePromptCache = true;
          execOpts.conversationId = OrchestratorAgent.getConversationIdForCache(state.sessionId, agent.id);
        }
      } catch (e) {
        // ignore
      }
      const result = await OrchestratorAgent.executeWithTools(
        provider,
        messages,
        providerTools,
        { userId: state.userId, sessionId: state.sessionId, agentId: agent.id },
        execOpts
      );

      return {
        content: result.content,
        tokensUsed: result.tokensUsed || 0,
      };
    } catch (error) {
      logger.error(`Error executing agent ${agent.name} turn:`, error);
      throw error;
    }
  }

  /**
   * Get orchestrator provider for a session
   * @param {object} session - Session object
   * @returns {Promise<object>} - Provider instance
   */
  async getOrchestratorProvider(session) {
    const providerType = session.orchestrator_provider_type || 'claude';
    
    // Get API key from session config first, then fall back to environment
    let apiKey = null;
    if (session.orchestrator_provider_config) {
      try {
        let config = session.orchestrator_provider_config;
        if (typeof config === 'string') {
          config = JSON.parse(decrypt(config));
        }
        if (config.apiKey && config.apiKey.trim()) {
          apiKey = config.apiKey.trim();
        }
      } catch (e) {
        logger.warn('Failed to parse orchestrator config for API key:', e.message);
      }
    }
    
    // Fall back to environment if not in session config
    if (!apiKey) {
      apiKey = this.getProviderApiKey(providerType);
    }

    if (!apiKey) {
      throw new Error(`No API key configured for ${providerType}. Please set it in session settings or environment variables.`);
    }

    // Get model from session config or use default
    let model = this.getDefaultModel(providerType);
    let baseURL = null;
    let timeout = null;
    if (session.orchestrator_provider_config) {
      try {
        let config = session.orchestrator_provider_config;
        if (typeof config === 'string') {
          config = JSON.parse(decrypt(config));
        }
        if (config.model) {
          model = config.model;
        }
        if (config.baseURL) {
          baseURL = config.baseURL;
        }
        if (config.timeout) {
          timeout = config.timeout;
        }
      } catch (e) {
        logger.warn('Failed to parse orchestrator config:', e.message);
      }
    }
    
    // Build provider config
    const providerConfig = { apiKey, model };
    if (timeout) {
      providerConfig.timeout = timeout;
    }
    if (providerType === 'ollama') {
      providerConfig.baseURL = baseURL || process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    }

    return ProviderFactory.create(providerType, providerConfig);
  }

  /**
   * Get API key for provider from environment
   */
  getProviderApiKey(providerType) {
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
   * Get default model for provider
   */
  getDefaultModel(providerType) {
    const defaultModels = {
      claude: 'claude-sonnet-4-20250514',
      openai: 'gpt-4o',
      gemini: 'gemini-1.5-pro',
      xai: 'grok-beta',
      ollama: 'llama3.1',
    };
    return defaultModels[providerType];
  }

  /**
   * Handle user interjection during conversation
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID
   * @param {string} message - User's message
   * @returns {Promise<object>} - Result
   */
  async handleInterjection(sessionId, userId, message) {
    const state = this.activeConversations.get(sessionId);
    if (!state) {
      throw new Error('No active conversation for this session');
    }

    if (state.userId !== userId) {
      throw new Error('Not authorized to interact with this conversation');
    }

    // Store user message
    await Message.create({
      session_id: sessionId,
      role: 'user',
      content: message,
    });

    // Resume if paused
    if (state.status === 'paused') {
      state.status = 'running';
      logger.info(`Conversation ${sessionId} resumed after interjection`);
    }

    return { success: true, message: 'Interjection recorded', state };
  }

  /**
   * Stop a conversation
   * @param {number} sessionId - Session ID
   * @returns {Promise<object>} - Result
   */
  async stopConversation(sessionId) {
    const state = this.activeConversations.get(sessionId);
    if (state) {
      state.status = 'stopped';
      logger.info(`Conversation ${sessionId} stopped by user`);
    }
    return { success: true };
  }

  /**
   * Pause a conversation
   * @param {number} sessionId - Session ID
   * @returns {Promise<object>} - Result
   */
  async pauseConversation(sessionId) {
    const state = this.activeConversations.get(sessionId);
    if (state && state.status === 'running') {
      state.status = 'paused';
      logger.info(`Conversation ${sessionId} paused`);
    }
    return { success: true };
  }

  /**
   * Resume a paused conversation
   * @param {number} sessionId - Session ID
   * @returns {Promise<object>} - Result
   */
  async resumeConversation(sessionId) {
    const state = this.activeConversations.get(sessionId);
    if (state && state.status === 'paused') {
      state.status = 'running';
      logger.info(`Conversation ${sessionId} resumed`);
    }
    return { success: true };
  }

  /**
   * Get conversation state
   * @param {number} sessionId - Session ID
   * @returns {object|null} - Conversation state or null
   */
  getConversationState(sessionId) {
    return this.activeConversations.get(sessionId) || null;
  }

  /**
   * Clean up completed/stopped conversations
   */
  cleanup() {
    for (const [sessionId, state] of this.activeConversations) {
      if (['completed', 'stopped'].includes(state.status)) {
        this.activeConversations.delete(sessionId);
      }
    }
  }
}

// Export singleton instance
const conversationModeService = new ConversationModeService();
module.exports = conversationModeService;
