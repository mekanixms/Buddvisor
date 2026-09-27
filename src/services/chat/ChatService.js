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
const { expandPromptMacros } = require('../../utils/promptMacros');
const { usageFromResponse, tokenRow } = require('./tokenUsage');

const SUMMARY_MAX_MESSAGE_CHARS = 8000;
const SUMMARY_MAX_TRANSCRIPT_CHARS = 120000;
const SUMMARY_CALL_TIMEOUT_MS = 300000;

/**
 * Messages ending at anchorId, walking backward.
 * @param {Array<object>} ordered
 * @param {number} anchorId
 * @param {{ scope: string, count: number, includeArchived: boolean }} options
 * @returns {Array<object>|null}
 */
function selectSummaryMessages(ordered, anchorId, { scope, count, includeArchived }) {
  const index = ordered.findIndex((m) => Number(m.id) === Number(anchorId));
  if (index < 0) return null;

  const isArchived = (m) => Number(m.archived) === 1;
  if (includeArchived) {
    if (scope === 'conversation') return ordered.slice(0, index + 1);
    const n = Math.max(1, Number(count) || 1);
    const start = Math.max(0, index + 1 - n);
    return ordered.slice(start, index + 1);
  }

  const picked = [];
  const target = scope === 'conversation' ? Infinity : Math.max(1, Number(count) || 1);
  for (let i = index; i >= 0; i--) {
    const message = ordered[i];
    if (Number(message.id) !== Number(anchorId) && isArchived(message)) continue;
    picked.push(message);
    if (picked.length >= target) break;
  }
  picked.reverse();
  return picked;
}

/**
 * Plain-text excerpt. Drops the oldest messages first when the excerpt is too long.
 * @param {Array<object>} messages
 * @returns {{ text: string, includedCount: number, omitted: number }}
 */
function buildSummaryTranscript(messages) {
  const parts = messages.map((m) => {
    let speaker = 'Assistant';
    if (m.role === 'user') speaker = 'User';
    else if (m.agent_name) speaker = m.agent_name;
    else if (m.role && m.role !== 'assistant') speaker = m.role;
    let text = String(m.content || '').trim();
    if (!text) text = '(empty)';
    if (text.length > SUMMARY_MAX_MESSAGE_CHARS) {
      text = `${text.slice(0, SUMMARY_MAX_MESSAGE_CHARS)}…`;
    }
    return `[${speaker}]\n${text}`;
  });

  let omitted = 0;
  while (parts.length > 1 && parts.join('\n\n').length > SUMMARY_MAX_TRANSCRIPT_CHARS) {
    parts.shift();
    omitted += 1;
  }

  let text = parts.join('\n\n');
  if (omitted > 0) {
    text = `(${omitted} earlier message${omitted === 1 ? '' : 's'} omitted for length)\n\n${text}`;
  }
  return { text, includedCount: parts.length, omitted };
}

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

function attachTokenUsage(metadata, result) {
  if (Array.isArray(result?.tokenUsage) && result.tokenUsage.length > 0) {
    metadata.token_usage = result.tokenUsage;
  }
  return metadata;
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

      // Build context. In orchestrator-led mode, include compact summaries of past
      // delegations so the orchestrator remembers specialist results across turns.
      const context = await this.buildContext(sessionId, session.context_length || 50, {
        includeDelegationSummaries: session.orchestration_mode === 'orchestrator_led',
      });

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
        attachTokenUsage(metadata, orchestratorResult);

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
        attachTokenUsage(metadata, orchestratorResult);

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

      // Orchestrator-led mode: orchestrator is the lead agent and delegates
      // self-contained briefs to specialized agents (no history sent to agents).
      // Classic mode: orchestrator routes the message to agent(s) with their own history.
      const orchestratorParams = {
        session,
        agents,
        context,
        userMessage: userMessageForLLM,
        documentContext,
        documentContextByAgentId,
        processedMediaCacheByAgentId,
        stream,
        onChunk,
      };
      const orchestratorResult = session.orchestration_mode === 'orchestrator_led'
        ? await OrchestratorAgent.processOrchestratorLed(orchestratorParams)
        : await OrchestratorAgent.process(orchestratorParams);

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

      if (Array.isArray(orchestratorResult.delegations) && orchestratorResult.delegations.length > 0) {
        metadata.delegations = orchestratorResult.delegations;
      }
      attachTokenUsage(metadata, orchestratorResult);

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
   * @param {number} sessionId - Session ID
   * @param {number} contextLength - Max messages to include
   * @param {object} [options] - Formatting options (e.g. includeDelegationSummaries)
   */
  static async buildContext(sessionId, contextLength, options = {}) {
    const messages = await Message.getContextMessages(sessionId, contextLength);
    return Message.formatForLLM(messages, options);
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

    const systemPrompt = expandPromptMacros(`You are a helpful assistant for a small multi agent AI application.
${documentContext ? `Use the following document context to help answer questions:\n${documentContext}` : ''}

Provide clear, accurate responses. If you're unsure about something, say so.`, {
      session,
      provider: providerType,
      model,
    });

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

  /**
   * Summarize messages ending at anchorMessageId and insert the summary immediately after it.
   * @param {number} sessionId
   * @param {number} userId
   * @param {number} anchorMessageId
   * @param {object} options
   * @param {'count'|'conversation'} options.scope
   * @param {number} [options.count]
   * @param {number|null} [options.agentId] - null uses the session orchestrator
   * @param {string} options.prompt
   * @param {boolean} [options.includeArchived=true]
   * @param {boolean} [options.archiveSources=false]
   * @param {boolean} [options.saveToFile=false]
   * @param {string} [options.saveFolder]
   * @param {string} [options.saveFileName]
   * @returns {Promise<{ message: object, archivedIds: number[], savedFile: object|null, saveError: string|null }>}
   */
  static async summarizeFromMessage(sessionId, userId, anchorMessageId, options = {}) {
    const {
      scope,
      count = null,
      agentId = null,
      prompt,
      includeArchived = true,
      archiveSources = false,
      saveToFile = false,
      saveFolder = '',
      saveFileName = '',
    } = options;

    if (scope !== 'count' && scope !== 'conversation') {
      throw new Error('Choose how many messages to summarize, or the whole conversation up to this message');
    }
    if (scope === 'count' && (!Number.isInteger(count) || count < 1)) {
      throw new Error('Message count must be a positive number');
    }
    const instruction = String(prompt || '').trim();
    if (!instruction) {
      throw new Error('A summary prompt is required');
    }
    if (instruction.length > 8000) {
      throw new Error('Summary prompt is too long');
    }
    if (saveToFile) {
      const fileName = String(saveFileName || '').trim();
      if (!fileName) {
        throw new Error('Enter a file name for the summary');
      }
      if (fileName.length > 255 || /[/\\]/.test(fileName) || fileName.includes('\0') || fileName === '.' || fileName === '..') {
        throw new Error('Enter a file name without a folder path');
      }
    }

    const session = await SessionService.getCompleteSession(sessionId, userId);
    if (!session) {
      throw new Error('Session not found or access denied');
    }

    const anchor = await Message.findById(anchorMessageId);
    if (!anchor || anchor.session_id !== sessionId) {
      throw new Error('Message not found in this session');
    }

    let agent = null;
    let agentName = 'Orchestrator';
    if (agentId != null) {
      agent = (session.agents || []).find((a) => Number(a.id) === Number(agentId));
      if (!agent) {
        throw new Error('That agent is not assigned to this session');
      }
      agentName = agent.name || 'Agent';
    }

    const ordered = await Message.listOrdered(sessionId);
    const selected = selectSummaryMessages(ordered, anchorMessageId, {
      scope,
      count,
      includeArchived: !!includeArchived,
    });
    if (!selected || selected.length === 0) {
      throw new Error('No messages to summarize in that range');
    }

    const transcript = buildSummaryTranscript(selected);
    const who = agent
      ? `You are ${agentName}${agent.role ? `, ${agent.role}` : ''}.`
      : 'You are the Orchestrator for this session.';
    const messages = [
      {
        role: 'system',
        content: `${who} Summarize the conversation excerpt the user provides. Follow their instructions. Reply with the summary only.`,
      },
      {
        role: 'user',
        content: `${instruction}\n\n--- Conversation excerpt (${transcript.includedCount} message${transcript.includedCount === 1 ? '' : 's'}) ---\n\n${transcript.text}`,
      },
    ];

    const ProviderFactory = require('../../providers/ProviderFactory');
    let provider;
    if (agent) {
      provider = await AgentService.getAgentProvider(agent.id, userId, {
        minTimeout: SUMMARY_CALL_TIMEOUT_MS,
      });
    } else {
      const providerType = session.orchestrator_provider_type || 'claude';
      const apiKey = OrchestratorAgent.getOrchestratorApiKey(session, providerType);
      if (!apiKey) {
        throw new Error('No orchestrator API key is configured');
      }
      const model = OrchestratorAgent.getOrchestratorModel(session, providerType);
      const configuredTimeout = OrchestratorAgent.getOrchestratorTimeout(session);
      const cfg = session.orchestrator_provider_config || {};
      provider = ProviderFactory.create(providerType, {
        apiKey,
        model,
        timeout: Math.max(Number(configuredTimeout) || 0, SUMMARY_CALL_TIMEOUT_MS),
        ...(cfg.maxTokens ? { maxTokens: cfg.maxTokens } : {}),
        ...(cfg.temperature != null ? { temperature: cfg.temperature } : {}),
        ...(cfg.baseURL ? { baseURL: cfg.baseURL } : {}),
      });
    }

    logger.info(`Summarizing ${transcript.includedCount} messages in session ${sessionId} with ${agentName}`);
    const response = await provider.chat(messages, {});
    const content = ensureStringContent(response?.content).trim();
    if (!content) {
      throw new Error('The model returned an empty summary');
    }

    const usage = usageFromResponse(response);
    const summaryScope = scope === 'conversation' && transcript.omitted === 0
      ? 'conversation'
      : 'count';
    const metadata = {
      is_summary: true,
      summary: {
        agent_name: agentName,
        message_count: transcript.includedCount,
        scope: summaryScope,
        anchor_message_id: anchorMessageId,
        omitted_for_length: transcript.omitted,
      },
      token_usage: [tokenRow(agent ? agent.id : null, agentName, usage)],
    };

    const sortIndex = await Message.sortIndexAfter(sessionId, anchorMessageId);
    const message = await Message.create({
      session_id: sessionId,
      role: 'assistant',
      content,
      tokens_used: usage.tokensUsed || 0,
      agent_id: agent ? agent.id : null,
      agent_name: agentName,
      metadata,
      sort_index: sortIndex,
    });

    const archivedIds = [];
    if (archiveSources) {
      for (const source of selected) {
        if (Number(source.archived) !== 1) {
          await Message.update(source.id, { archived: 1 });
        }
        archivedIds.push(source.id);
      }
    }

    let savedFile = null;
    let saveError = null;
    if (saveToFile) {
      try {
        const SessionStorageExplorer = require('../sessions/SessionStorageExplorer');
        savedFile = await SessionStorageExplorer.writeTextFile(
          sessionId,
          userId,
          saveFolder || '',
          saveFileName,
          content
        );
      } catch (error) {
        logger.error('Failed to save summary file:', error);
        saveError = error.message || 'Failed to save the summary file';
      }
    }

    return { message, archivedIds, savedFile, saveError };
  }
}

module.exports = { ChatService };
