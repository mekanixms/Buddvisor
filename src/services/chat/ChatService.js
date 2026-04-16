/**
 * Chat Service
 * Orchestrates multi-agent conversations and message handling
 */

const Message = require('../../models/Message');
const WorkSession = require('../../models/WorkSession');
const SessionService = require('../sessions/SessionService');
const AgentService = require('../agents/AgentService');
const DocumentService = require('../documents/DocumentService');
const OrchestratorAgent = require('./OrchestratorAgent');
const Document = require('../../models/Document');
const { toolExecutor } = require('../tools/ToolExecutor');
const BaseLLMProvider = require('../../providers/BaseLLMProvider');
const logger = require('../../utils/logger');

/**
 * Ensure assistant message content is a string. Some LLM providers may return
 * arrays or objects (e.g. content blocks); coercing prevents "[object Object]" in DB.
 * @param {*} content - Raw content from provider
 * @returns {string}
 */
function ensureStringContent(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object' && (c.text != null || c.content != null)) {
        return String(c.text ?? c.content ?? '');
      }
      return String(c ?? '');
    }).join('');
  }
  if (typeof content === 'object' && (content.text != null || content.content != null)) {
    return String(content.text ?? content.content ?? '');
  }
  return String(content);
}

class ChatService {
  static parseExplicitProcessMediaRequest(text) {
    const s = String(text || '');
    // Accept: process the file <name> using process_media
    // Allow quoted filenames and flexible whitespace.
    const re = /process\s+(?:the\s+)?file\s+("([^"]+)"|'([^']+)'|(.+?))\s+using\s+(process_media)\b/i;
    const m = s.match(re);
    if (!m) return null;
    const filename = (m[2] || m[3] || m[4] || '').trim();
    const toolName = (m[5] || '').trim();
    if (!filename || !toolName) return null;
    return { toolName, filename };
  }

  static async tryRunExplicitMediaTool({ sessionId, userId, agents, userMessage }) {
    const parsed = this.parseExplicitProcessMediaRequest(userMessage);
    if (!parsed) return null;

    // Only handle process_media explicitly for now.
    if (parsed.toolName !== 'process_media') return null;

    // Find an agent that has BOTH:
    // - tool enabled (per-agent tools)
    // - document assigned (per-agent docs)
    const hasToolAssignments = await WorkSession.hasToolAssignments(sessionId);
    if (!hasToolAssignments) {
      return {
        ok: false,
        error:
          'This session has no per-agent tool assignments configured. Enable `process_media` for an agent in Configure Session → Tools.',
      };
    }

    const hasDocAssignments = await Document.hasAgentAssignments(sessionId);
    if (!hasDocAssignments) {
      return {
        ok: false,
        error:
          'This session has no per-agent document assignments configured. Assign the document to an agent in Configure Session → Documents.',
      };
    }

    const wanted = parsed.filename.trim().toLowerCase();

    for (const agent of agents || []) {
      const allowedToolNames = await WorkSession.getToolNamesBySessionAndAgent(sessionId, agent.id);
      if (!Array.isArray(allowedToolNames) || !allowedToolNames.includes('process_media')) continue;

      const docs = await Document.getBySessionAndAgent(sessionId, agent.id);
      const found = (docs || []).find(d => String(d.filename || '').trim().toLowerCase() === wanted);
      if (!found) continue;

      const toolResult = await toolExecutor.execute(
        'process_media',
        { document_name: found.filename, instruction: 'Extract all useful information from this media. If image: extract all text verbatim and describe key elements.' },
        { userId, sessionId, agentId: agent.id, source: 'explicit_user_request' }
      );

      return {
        ok: true,
        agent,
        filename: found.filename,
        toolResult,
      };
    }

    return {
      ok: false,
      error:
        `Could not find any agent in this session that has BOTH the tool "process_media" enabled AND the document "${parsed.filename}" assigned.`,
    };
  }

  /**
   * Process a user message and generate response
   */
  static async processMessage(sessionId, userId, userMessage, options = {}) {
    const { stream = false, onChunk = null, attachedDocumentsInfo = null, directAgentIds = null } = options;

    try {
      // Get full session (agents, documents, document_agent_assignment_map) for appending documents list to user message
      const session = await SessionService.getCompleteSession(sessionId, userId);
      if (!session) {
        throw new Error('Session not found or access denied');
      }
      const agents = session.agents || [];
      const documents = session.documents || [];

      // Get username for metadata
      const User = require('../../models/User');
      const user = await User.findById(userId);
      const username = user ? user.username : null;

      const userMessageMetadata = { ...(username ? { username } : null) };
      if (attachedDocumentsInfo && typeof attachedDocumentsInfo === 'object' &&
          Array.isArray(attachedDocumentsInfo.documentNames) && attachedDocumentsInfo.documentNames.length > 0) {
        userMessageMetadata.attachedDocumentsInfo = {
          documentNames: attachedDocumentsInfo.documentNames,
          assignedToAgentNames: Array.isArray(attachedDocumentsInfo.assignedToAgentNames)
            ? attachedDocumentsInfo.assignedToAgentNames
            : [],
        };
      }
      const metadataToStore = Object.keys(userMessageMetadata).length ? userMessageMetadata : null;

      // Store user message
      const userMsg = await Message.create({
        session_id: sessionId,
        role: 'user',
        content: userMessage,
        metadata: metadataToStore,
      });

      // Build context
      const context = await this.buildContext(sessionId, session.context_length || 50);

      // If user explicitly requests running process_media on a specific file, run it server-side first.
      // This avoids relying on the LLM/tool-calling support of the selected model (e.g., many Ollama VL models).
      const explicitToolRun = await this.tryRunExplicitMediaTool({
        sessionId,
        userId,
        agents,
        userMessage,
      });

      let userMessageForLLM = userMessage;
      if (explicitToolRun && explicitToolRun.ok) {
        const payload = explicitToolRun.toolResult?.success
          ? explicitToolRun.toolResult.result
          : { error: explicitToolRun.toolResult?.error || 'Tool failed' };

        // Include the tool output as plain text context for the agent/orchestrator.
        userMessageForLLM =
          `The user requested: ${userMessage}\n\n` +
          `I executed the tool process_media on "${explicitToolRun.filename}" for agent "${explicitToolRun.agent.name}".\n` +
          `Tool output (JSON):\n${JSON.stringify(payload, null, 2)}\n\n` +
          `Now answer the user using that tool output.`;
      } else if (explicitToolRun && explicitToolRun.ok === false) {
        userMessageForLLM =
          `The user requested: ${userMessage}\n\n` +
          `I could not execute process_media automatically: ${explicitToolRun.error}\n` +
          `Explain what the user needs to configure (Documents + Tools assignments) and ask them to retry.`;
      }

      // Get relevant document chunks if documents are assigned
      let documentContext = '';
      const documentContextByAgentId = {};
      if (documents.length > 0) {
        // Use more chunks (10) to ensure we capture enough context, especially for explicitly mentioned docs
        const relevantChunks = await DocumentService.getSessionDocumentContext(
          sessionId,
          userMessageForLLM,
          10 // max chunks - increased to handle explicit document references
        );
        if (relevantChunks && relevantChunks.length > 0) {
          documentContext = this.formatDocumentContext(relevantChunks);
          logger.info(`Document context prepared: ${relevantChunks.length} chunks, ${documentContext.length} chars`);
        }

        // Build per-agent document context (based on per-agent document assignments if configured)
        for (const agent of agents) {
          const agentChunks = await DocumentService.getSessionDocumentContext(
            sessionId,
            userMessageForLLM,
            10,
            agent.id
          );
          if (agentChunks && agentChunks.length > 0) {
            documentContextByAgentId[agent.id] = this.formatDocumentContext(agentChunks);
          } else {
            documentContextByAgentId[agent.id] = '';
          }
        }
      }

      // Per-agent process_media cache locations (assigned docs already processed and cached in working folder)
      const { getProcessedMediaCacheInfo } = require('../tools/mediaProcessingTool');
      const processedMediaCacheByAgentId = {};
      for (const agent of agents) {
        processedMediaCacheByAgentId[agent.id] = await getProcessedMediaCacheInfo(sessionId, agent.id);
      }

      // Check if we have agents assigned
      if (agents.length === 0) {
        // No agents - use orchestrator directly with tools and documents (same flow as handleDirectly)
        const orchestratorResult = await OrchestratorAgent.handleDirectly(
          session,
          [],
          context,
          userMessageForLLM,
          documentContext,
          { stream, onChunk }
        );

        const ArtifactService = require('../artifacts/ArtifactService');
        const contentStr = ensureStringContent(orchestratorResult.content);
        const artifacts = await ArtifactService.processArtifacts(contentStr);
        const metadata = {
          routedTo: orchestratorResult.routedTo,
          reasoning: orchestratorResult.reasoning,
        };
        if (artifacts.length > 0) metadata.artifacts = artifacts;

        await Message.create({
          session_id: sessionId,
          role: 'assistant',
          content: contentStr,
          agent_id: orchestratorResult.agentId,
          agent_name: orchestratorResult.agentName,
          tokens_used: orchestratorResult.tokensUsed || 0,
          metadata,
        });

        return {
          success: true,
          message: contentStr,
          agentName: orchestratorResult.agentName,
          routedTo: orchestratorResult.routedTo,
          tokensUsed: orchestratorResult.tokensUsed,
        };
      }

      // Direct agent targeting (e.g. scheduled prompts): skip orchestrator routing
      const useDirectAgents = Array.isArray(directAgentIds) && directAgentIds.length > 0;
      let targetAgents = agents;
      if (useDirectAgents) {
        const idSet = new Set(directAgentIds);
        targetAgents = agents.filter((a) => idSet.has(a.id));
        if (targetAgents.length === 0) {
          targetAgents = agents;
        }
      }

      if (useDirectAgents && targetAgents.length > 0) {
        const reasoning = 'Scheduled';
        const opts = { stream: false, onChunk: null, processedMediaCacheByAgentId };
        let orchestratorResult;

        if (targetAgents.length === 1) {
          const agent = targetAgents[0];
          const agentDocContext = documentContextByAgentId[agent.id] != null
            ? documentContextByAgentId[agent.id]
            : documentContext;
          orchestratorResult = await OrchestratorAgent.executeWithAgent(
            agent,
            session,
            agents,
            context,
            userMessageForLLM,
            agentDocContext,
            reasoning,
            opts
          );
        } else {
          const docContextForMulti = documentContextByAgentId && Object.keys(documentContextByAgentId).length > 0
            ? documentContextByAgentId
            : documentContext;
          orchestratorResult = await OrchestratorAgent.executeMultiAgent(
            targetAgents,
            session,
            agents,
            context,
            userMessageForLLM,
            docContextForMulti,
            reasoning,
            opts
          );
        }

        const ArtifactService = require('../artifacts/ArtifactService');
        const contentStr = ensureStringContent(orchestratorResult.content);
        const artifacts = await ArtifactService.processArtifacts(contentStr);
        const metadata = {
          routedTo: orchestratorResult.routedTo,
          reasoning: orchestratorResult.reasoning,
        };
        if (artifacts.length > 0) metadata.artifacts = artifacts;

        await Message.create({
          session_id: sessionId,
          role: 'assistant',
          content: contentStr,
          agent_id: orchestratorResult.agentId,
          agent_name: orchestratorResult.agentName,
          tokens_used: orchestratorResult.tokensUsed || 0,
          metadata,
        });

        return {
          success: true,
          message: contentStr,
          agentName: orchestratorResult.agentName,
          routedTo: orchestratorResult.routedTo,
          tokensUsed: orchestratorResult.tokensUsed,
        };
      }

      // Use orchestrator for multi-agent routing
      const orchestratorResult = await OrchestratorAgent.process({
        session,
        agents,
        context,
        userMessage: userMessageForLLM,
        documentContext,
        documentContextByAgentId,
        processedMediaCacheByAgentId,
        stream,
        onChunk,
      });

      // Extract and create artifacts from the response content
      const ArtifactService = require('../artifacts/ArtifactService');
      const contentStr = ensureStringContent(orchestratorResult.content);
      const artifacts = await ArtifactService.processArtifacts(contentStr);

      // Store the response with artifact metadata
      const metadata = {
        routedTo: orchestratorResult.routedTo,
        reasoning: orchestratorResult.reasoning,
      };
      
      if (artifacts.length > 0) {
        metadata.artifacts = artifacts;
      }

      await Message.create({
        session_id: sessionId,
        role: 'assistant',
        content: contentStr,
        agent_id: orchestratorResult.agentId,
        agent_name: orchestratorResult.agentName,
        tokens_used: orchestratorResult.tokensUsed || 0,
        metadata,
      });

      return {
        success: true,
        message: contentStr,
        agentName: orchestratorResult.agentName,
        routedTo: orchestratorResult.routedTo,
        tokensUsed: orchestratorResult.tokensUsed,
      };
    } catch (error) {
      logger.error('Error processing message:', error);
      throw error;
    }
  }

  /**
   * Add a message to context without processing through agents
   * This is useful for sensor data or other context that should be stored
   * but not trigger agent processing (saves tokens)
   * @param {number} sessionId - Session ID
   * @param {number} userId - User ID (for session access check)
   * @param {string} message - Message content to add to context
   * @param {number} [authorUserId] - Optional author user ID (for alias posting)
   * @returns {Promise<object>} - Created message
   */
  static async addContextMessage(sessionId, userId, message, authorUserId = null) {
    try {
      // Verify session access (check against userId, not authorUserId)
      const session = await WorkSession.findById(sessionId);
      if (!session || session.user_id !== userId) {
        throw new Error('Session not found or access denied');
      }

      // Get username for metadata (use alias user if provided, otherwise session owner)
      let username = null;
      if (authorUserId && authorUserId !== userId) {
        // Get alias user's username
        const User = require('../../models/User');
        const aliasUser = await User.findById(authorUserId);
        username = aliasUser ? aliasUser.username : null;
      } else {
        // Get session owner's username
        const User = require('../../models/User');
        const sessionOwner = await User.findById(userId);
        username = sessionOwner ? sessionOwner.username : null;
      }

      // Add message to context without processing
      const userMsg = await Message.create({
        session_id: sessionId,
        role: 'user',
        content: message,
        metadata: username ? { username } : null,
      });

      // Update session last accessed time
      await WorkSession.updateLastAccessed(sessionId);

      const authorInfo = authorUserId && authorUserId !== userId ? ` (on behalf of user ${authorUserId})` : '';
      logger.info(`Context message added to session ${sessionId} by user ${userId}${authorInfo} (not processed)`);

      return {
        success: true,
        message: userMsg,
      };
    } catch (error) {
      logger.error('Error adding context message:', error);
      throw error;
    }
  }

  /**
   * Build conversation context from recent messages
   */
  static async buildContext(sessionId, contextLength) {
    const messages = await Message.getContextMessages(sessionId, contextLength);
    return Message.formatForLLM(messages);
  }

  /**
   * Format document context for inclusion in prompts
   */
  static formatDocumentContext(chunks) {
    if (!chunks || chunks.length === 0) return '';

    const formattedChunks = chunks.map((chunk, idx) => {
      return `[Document: ${chunk.filename}, Chunk ${idx + 1}]\n${chunk.text}`;
    });

    return `\n\n--- Relevant Document Context ---\n${formattedChunks.join('\n\n')}\n--- End Document Context ---\n`;
  }

  /**
   * Generate a simple response when no agents are assigned
   */
  static async generateSimpleResponse(session, context, userMessage, documentContext, options) {
    const { stream, onChunk } = options;

    // Try to use the orchestrator provider configured for the session
    const providerType = session.orchestrator_provider_type || 'claude';

    // For simple responses without agents, we need an API key
    // This would typically come from user settings or environment
    const ProviderFactory = require('../../providers/ProviderFactory');

    // Get API key from session config first, then fall back to environment
    let apiKey = null;
    if (session.orchestrator_provider_config) {
      try {
        let config = session.orchestrator_provider_config;
        if (typeof config === 'string') {
          const { decrypt } = require('../../utils/encryption');
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
      return {
        content: 'No agents are assigned to this session and no orchestrator API key is configured. Please assign agents to the session or configure an API key in session settings or environment variables.',
        tokensUsed: 0,
      };
    }

    const OrchestratorAgent = require('./OrchestratorAgent');
    const model = OrchestratorAgent.getOrchestratorModel(session, providerType);

    const provider = ProviderFactory.create(providerType, {
      apiKey,
      model,
    });

    const systemPrompt = `You are a helpful assistant for a small multi agent AI application.
${documentContext ? `Use the following document context to help answer questions:\n${documentContext}` : ''}

Provide clear, accurate responses. If you're unsure about something, say so.`;

    const ContextManager = require('../sessions/ContextManager');
    const documentsSuffix = ContextManager.buildDocumentsSectionForOrchestrator(session) || '';
    const userMessageWithDocs = userMessage + documentsSuffix;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...context,
      { role: 'user', content: userMessageWithDocs },
    ];

    const chatOpts = {};
    if (session.orchestrator_provider_config?.enablePromptCache) {
      chatOpts.usePromptCache = true;
      chatOpts.conversationId = OrchestratorAgent.getConversationIdForCache(session.id, null);
    }

    if (stream && onChunk) {
      let fullContent = '';
      const response = await provider.streamChat(messages, (chunk) => {
        let text = '';
        if (typeof chunk === 'string') {
          text = chunk;
        } else if (chunk && chunk.type === 'text' && chunk.content != null) {
          text = BaseLLMProvider.extractTextFromContent(chunk.content);
        }
        if (text) {
          fullContent += text;
          onChunk(text);
        }
      }, chatOpts);
      return {
        content: fullContent,
        tokensUsed: response?.usage?.total_tokens || 0,
      };
    } else {
      const response = await provider.chat(messages, chatOpts);
      return {
        content: response.content,
        tokensUsed: response.usage?.total_tokens || 0,
      };
    }
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
      ollama: 'not-required', // Ollama doesn't need an API key
    };
    return envKeys[providerType];
  }

  /**
   * Get default model for provider
   */
  static getDefaultModel(providerType) {
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
   * Get conversation history for a session
   * Returns the most recent messages in chronological order (oldest first)
   */
  static async getHistory(sessionId, userId, options = {}) {
    const { limit = 50, offset = 0 } = options;

    // Verify session access
    const session = await WorkSession.findById(sessionId);
    if (!session || session.user_id !== userId) {
      throw new Error('Session not found or access denied');
    }

    const totalCount = await Message.countBySessionId(sessionId);
    
    // Get the most recent messages (newest first)
    // We need to get enough messages to cover the limit + offset from the end
    const messagesToFetch = limit + offset;
    const recentMessages = await Message.getRecentMessages(sessionId, messagesToFetch);
    
    // Apply offset (skip the most recent 'offset' messages) and limit
    // Then reverse to get chronological order (oldest first) for chat display
    // Parse metadata (e.g. JSON string from DB) and expose attachedDocumentsInfo for UI
    const messages = recentMessages
      .slice(offset, offset + limit)
      .reverse()
      .map((m) => {
        const parsed = Message.parseMessage(m);
        if (parsed.metadata && parsed.metadata.attachedDocumentsInfo) {
          parsed.attachedDocumentsInfo = parsed.metadata.attachedDocumentsInfo;
        }
        return parsed;
      });

    return {
      messages,
      total: totalCount,
      hasMore: offset + limit < totalCount,
    };
  }

  /**
   * Clear conversation history for a session
   */
  static async clearHistory(sessionId, userId) {
    // Verify session access
    const session = await WorkSession.findById(sessionId);
    if (!session || session.user_id !== userId) {
      throw new Error('Session not found or access denied');
    }

    await Message.deleteBySessionId(sessionId);
    logger.info(`Cleared history for session ${sessionId}`);

    return { success: true };
  }

  /**
   * Get token usage statistics for a session
   */
  static async getTokenUsage(sessionId, userId) {
    // Verify session access
    const session = await WorkSession.findById(sessionId);
    if (!session || session.user_id !== userId) {
      throw new Error('Session not found or access denied');
    }

    const totalTokens = await Message.getTotalTokens(sessionId);
    const messageCount = await Message.countBySessionId(sessionId);

    return {
      totalTokens,
      messageCount,
      averageTokensPerMessage: messageCount > 0 ? Math.round(totalTokens / messageCount) : 0,
    };
  }
}

module.exports = { ChatService };
