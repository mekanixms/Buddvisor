/**
 * Conversation History Tool
 * Allows agents to read archived chat history from their session
 * Useful for summarizing long conversations or checking what users asked
 * Enhanced with filters and chunked responses for large histories
 */

const { toolRegistry } = require('./ToolRegistry');
const logger = require('../../utils/logger');
const Message = require('../../models/Message');
const { dbGet, dbAll } = require('../../../config/database');
const { getWorkspacePath, resolveWorkspacePath } = require('./localWorkingFolderTool');
const fs = require('fs').promises;
const path = require('path');

// Maximum messages to return in a single request (prevents overload)
const MAX_MESSAGES_PER_REQUEST = 100;
const DEFAULT_MESSAGE_LIMIT = 50;
const DEFAULT_CHUNK_SIZE = 100; // Default chunk size for chunked responses

/**
 * Get total message count for a session with optional filters
 * @param {number} sessionId - Session ID
 * @param {object} filters - Filter options
 * @returns {Promise<number>} - Total message count
 */
async function getTotalMessageCount(sessionId, filters = {}) {
  try {
    const { whereClause, params } = buildWhereClause(sessionId, filters);
    const sql = `SELECT COUNT(*) as count FROM messages ${whereClause}`;
    const result = await dbGet(sql, params);
    return result.count || 0;
  } catch (error) {
    logger.error('Error getting total message count:', error);
    throw error;
  }
}

/**
 * Build WHERE clause and parameters for filtering
 * @param {number} sessionId - Session ID
 * @param {object} filters - Filter options
 * @returns {object} - {whereClause, params}
 */
function buildWhereClause(sessionId, filters = {}) {
  const params = [sessionId];
  const conditions = ['session_id = ?'];

  // Filter by role (user/assistant)
  if (filters.role) {
    const role = filters.role.toLowerCase();
    if (role === 'user' || role === 'assistant') {
      conditions.push('role = ?');
      params.push(role);
    }
  }

  // Filter by date range
  if (filters.date_from) {
    conditions.push('created_at >= ?');
    params.push(filters.date_from);
  }
  if (filters.date_to) {
    conditions.push('created_at <= ?');
    params.push(filters.date_to);
  }

  // Filter by keywords (search in content)
  if (filters.keywords && Array.isArray(filters.keywords) && filters.keywords.length > 0) {
    // Build LIKE conditions for each keyword
    const keywordConditions = filters.keywords.map((keyword) => {
      params.push(`%${keyword}%`);
      return 'content LIKE ?';
    });
    // All keywords must match (AND condition)
    conditions.push(`(${keywordConditions.join(' AND ')})`);
  } else if (filters.keywords && typeof filters.keywords === 'string') {
    // Single keyword as string
    conditions.push('content LIKE ?');
    params.push(`%${filters.keywords}%`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { whereClause, params };
}

/**
 * Get messages with pagination and filters
 * @param {number} sessionId - Session ID
 * @param {number} from - Starting index (0-based)
 * @param {number} to - Ending index (exclusive, 0-based)
 * @param {boolean} orderedAsc - If true, order by created_at ASC; if false, DESC
 * @param {object} filters - Filter options
 * @returns {Promise<Array>} - Array of messages
 */
async function getMessages(sessionId, from, to, orderedAsc = true, filters = {}) {
  try {
    const limit = Math.min(to - from, MAX_MESSAGES_PER_REQUEST);
    const offset = from;
    const orderDirection = orderedAsc ? 'ASC' : 'DESC';

    const { whereClause, params } = buildWhereClause(sessionId, filters);
    
    const sql = `SELECT id, session_id, role, content, agent_id, agent_name, tokens_used, created_at, metadata
       FROM messages
       ${whereClause}
       ORDER BY created_at ${orderDirection}
       LIMIT ? OFFSET ?`;
    
    params.push(limit, offset);

    const messages = await dbAll(sql, params);

    // Parse messages
    const parsedMessages = messages.map(m => Message.parseMessage(m));

    return parsedMessages;
  } catch (error) {
    logger.error('Error getting messages:', error);
    throw error;
  }
}

/**
 * Validate and parse date string
 * @param {string} dateStr - Date string (ISO format or YYYY-MM-DD)
 * @returns {string|null} - Validated date string or null
 */
function validateDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') {
    return null;
  }
  // Try to parse the date
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) {
    return null;
  }
  // Return ISO string format for SQLite
  return date.toISOString();
}

/**
 * Convert messages to JSON format
 * @param {Array} messages - Array of message objects
 * @returns {string} - JSON string
 */
function formatAsJSON(messages) {
  return JSON.stringify(messages, null, 2);
}

/**
 * Convert messages to CSV format
 * @param {Array} messages - Array of message objects
 * @returns {string} - CSV string
 */
function formatAsCSV(messages) {
  if (messages.length === 0) {
    return '';
  }

  // CSV header
  const headers = ['id', 'role', 'content', 'agent_name', 'agent_id', 'created_at', 'tokens_used'];
  const rows = [headers.join(',')];

  // CSV rows
  for (const msg of messages) {
    const row = [
      msg.id || '',
      msg.role || '',
      // Escape content: replace quotes with double quotes and wrap in quotes
      `"${(msg.content || '').replace(/"/g, '""').replace(/\n/g, ' ').replace(/\r/g, '')}"`,
      msg.agent_name || '',
      msg.agent_id || '',
      msg.created_at || '',
      msg.tokens_used || 0,
    ];
    rows.push(row.join(','));
  }

  return rows.join('\n');
}

/**
 * Get local_working_folder configuration for agent
 * @param {number} sessionId - Session ID
 * @param {number} agentId - Agent ID
 * @returns {Promise<object|null>} - Tool config or null if not configured
 */
async function getWorkingFolderConfig(sessionId, agentId) {
  try {
    const toolAssignments = await dbAll(
      `SELECT tool_config FROM session_agent_tools 
       WHERE session_id = ? AND agent_id = ? AND tool_name = ?`,
      [sessionId, agentId, 'local_working_folder']
    );

    if (!toolAssignments || toolAssignments.length === 0) {
      return null;
    }

    let toolConfig = toolAssignments[0].tool_config;
    if (typeof toolConfig === 'string') {
      try {
        toolConfig = JSON.parse(toolConfig);
      } catch (e) {
        return null;
      }
    }

    if (!toolConfig || !toolConfig.folder_name || toolConfig.folder_name.trim() === '') {
      return null;
    }

    return toolConfig;
  } catch (error) {
    logger.error('Error getting working folder config:', error);
    return null;
  }
}

/**
 * Register Conversation History tool
 */
function registerConversationHistoryTool() {
  toolRegistry.register({
    name: 'archived_conversation_history',
    description: 'Read archived chat history from the current session with advanced filtering and automatic chunking. Allows agents to review past conversations, summarize long discussions, or check what users asked. Supports pagination, date filtering, role filtering, and keyword search. For super-long histories (thousands of messages), automatically breaks responses into bite-sized chunks (default 100 messages per chunk) to prevent timeouts and overloads. Each chunked response includes metadata for fetching the next chunk, like paging through a book. Useful for understanding context and providing accurate responses based on conversation history.',
    category: 'communication',
    parameters: {
      from: {
        type: 'number',
        description: 'Starting index (0-based) of messages to retrieve. Use 0 for the first message. Default: 0.',
        required: false,
        default: 0,
        minimum: 0,
      },
      to: {
        type: 'number',
        description: `Ending index (exclusive, 0-based) of messages to retrieve. If omitted and auto_chunk is true, automatically chunks large requests. If omitted and auto_chunk is false, returns up to ${DEFAULT_MESSAGE_LIMIT} messages. When requesting large ranges (e.g., thousands of messages), the tool automatically chunks the response. Example: from=0, to=10 retrieves messages 0-9.`,
        required: false,
        minimum: 1,
      },
      orderedAsc: {
        type: 'boolean',
        description: 'If true, messages are ordered chronologically (oldest first). If false, ordered reverse-chronologically (newest first). Default: true (oldest first).',
        required: false,
        default: true,
      },
      role: {
        type: 'string',
        description: 'Filter by message role: "user" to get only user messages, "assistant" to get only assistant/agent messages. Omit to get all messages.',
        required: false,
        enum: ['user', 'assistant'],
      },
      date_from: {
        type: 'string',
        description: 'Filter messages from this date onwards (ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss). Example: "2026-01-20" or "2026-01-20T10:00:00".',
        required: false,
      },
      date_to: {
        type: 'string',
        description: 'Filter messages up to this date (ISO format: YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss). Example: "2026-01-24" or "2026-01-24T23:59:59".',
        required: false,
      },
      keywords: {
        type: 'array',
        description: 'Filter messages containing these keywords (case-insensitive). All keywords must be present in the message content. Example: ["artifact", "T:"] to find messages mentioning artifacts or tasks. Can also be a single string for one keyword.',
        required: false,
        items: {
          type: 'string',
        },
      },
      chunk_size: {
        type: 'number',
        description: `Size of each chunk when retrieving large histories (default: ${DEFAULT_CHUNK_SIZE}). When retrieving thousands of messages, the tool automatically breaks responses into chunks to prevent timeouts. Use this parameter to customize chunk size (max: ${MAX_MESSAGES_PER_REQUEST}).`,
        required: false,
        default: DEFAULT_CHUNK_SIZE,
        minimum: 10,
        maximum: MAX_MESSAGES_PER_REQUEST,
      },
      auto_chunk: {
        type: 'boolean',
        description: `If true (default), automatically chunk large requests. When 'to' is omitted or requests exceed chunk_size, responses are automatically chunked with metadata for fetching next chunks. Set to false to disable auto-chunking (may fail on very large requests).`,
        required: false,
        default: true,
      },
      format: {
        type: 'string',
        description: 'Export format: "json" to return messages as JSON string, "csv" to return as CSV string. If omitted, returns messages as structured array. When used with export_to_file, writes the file in the specified format.',
        required: false,
        enum: ['json', 'csv'],
      },
      export_to_file: {
        type: 'string',
        description: 'Export messages to a file in the agent\'s working folder. Requires local_working_folder tool to be configured. File path must be relative to the working folder (e.g., "exports/history.json" or "./data/conversation.csv"). The format parameter determines the file format. If format is not specified, defaults to JSON.',
        required: false,
      },
    },
    handler: async (params, context) => {
      const { 
        from = 0, 
        to = null, 
        orderedAsc = true,
        role = null,
        date_from = null,
        date_to = null,
        keywords = null,
        chunk_size = DEFAULT_CHUNK_SIZE,
        auto_chunk = true,
        format = null,
        export_to_file = null,
      } = params;

      if (!context.sessionId) {
        throw new Error('sessionId is required in context');
      }

      // Validate from parameter
      if (typeof from !== 'number' || from < 0 || !Number.isInteger(from)) {
        throw new Error('from must be a non-negative integer');
      }

      // Build filters object
      const filters = {};
      if (role) {
        filters.role = role;
      }
      if (date_from) {
        const validatedDate = validateDate(date_from);
        if (!validatedDate) {
          throw new Error(`Invalid date_from format: ${date_from}. Use ISO format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)`);
        }
        filters.date_from = validatedDate;
      }
      if (date_to) {
        const validatedDate = validateDate(date_to);
        if (!validatedDate) {
          throw new Error(`Invalid date_to format: ${date_to}. Use ISO format (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)`);
        }
        filters.date_to = validatedDate;
      }
      if (keywords) {
        // Handle both array and string
        if (Array.isArray(keywords)) {
          filters.keywords = keywords.filter(k => k && typeof k === 'string' && k.trim().length > 0);
          if (filters.keywords.length === 0) {
            filters.keywords = null;
          }
        } else if (typeof keywords === 'string' && keywords.trim().length > 0) {
          filters.keywords = [keywords.trim()];
        }
      }

      // Get total message count with filters
      const totalCount = await getTotalMessageCount(context.sessionId, filters);

      if (totalCount === 0) {
        const filterInfo = Object.keys(filters).length > 0 
          ? ` (with applied filters: ${JSON.stringify(filters)})`
          : '';
        return {
          success: true,
          messages: [],
          total_count: 0,
          filtered_count: 0,
          from: 0,
          to: 0,
          returned_count: 0,
          filters_applied: filters,
          message: `No messages found in this session${filterInfo}`,
        };
      }

      // Check if from is beyond total count
      if (from >= totalCount) {
        return {
          success: true,
          messages: [],
          total_count: totalCount,
          filtered_count: totalCount,
          from: from,
          to: from,
          returned_count: 0,
          filters_applied: filters,
          message: `No messages found. Requested from index ${from}, but filtered count is ${totalCount}`,
        };
      }

      // Validate chunk_size
      const validatedChunkSize = Math.min(
        Math.max(10, Math.floor(chunk_size) || DEFAULT_CHUNK_SIZE),
        MAX_MESSAGES_PER_REQUEST
      );

      // When exporting to file, disable chunking to export all requested messages
      // (but still respect MAX_MESSAGES_PER_REQUEST for safety)
      const shouldChunk = auto_chunk && !export_to_file;

      // Validate and set 'to' parameter
      let toIndex = to;
      let isChunkedRequest = false;
      let originalToIndex = null;

      if (toIndex === null || toIndex === undefined) {
        // If 'to' is omitted
        if (export_to_file) {
          // For exports, get all messages (up to MAX_MESSAGES_PER_REQUEST for safety)
          toIndex = Math.min(from + MAX_MESSAGES_PER_REQUEST, totalCount);
          if (totalCount - from > MAX_MESSAGES_PER_REQUEST) {
            logger.warn(`Exporting ${MAX_MESSAGES_PER_REQUEST} messages (requested all ${totalCount - from}). Use 'to' parameter to export more.`);
          }
        } else if (shouldChunk && (totalCount - from) > validatedChunkSize) {
          // Auto-chunk: return first chunk
          toIndex = from + validatedChunkSize;
          isChunkedRequest = true;
          originalToIndex = totalCount; // Remember we want all messages
        } else {
          // Small request, use default limit
          toIndex = Math.min(from + DEFAULT_MESSAGE_LIMIT, totalCount);
        }
      } else {
        originalToIndex = toIndex;
        // Check if requested range exceeds chunk size
        const requestedCount = toIndex - from;
        if (export_to_file && requestedCount > MAX_MESSAGES_PER_REQUEST) {
          // For exports, warn but allow up to MAX_MESSAGES_PER_REQUEST
          logger.warn(`Export requested ${requestedCount} messages, limiting to ${MAX_MESSAGES_PER_REQUEST} for safety`);
          toIndex = from + MAX_MESSAGES_PER_REQUEST;
        } else if (shouldChunk && requestedCount > validatedChunkSize) {
          // Auto-chunk: return first chunk
          toIndex = from + validatedChunkSize;
          isChunkedRequest = true;
        }
      }

      if (typeof toIndex !== 'number' || toIndex <= from || !Number.isInteger(toIndex)) {
        throw new Error(`to must be an integer greater than from (from=${from})`);
      }

      // Clamp toIndex to totalCount
      toIndex = Math.min(toIndex, totalCount);

      // Get messages with filters
      const messages = await getMessages(context.sessionId, from, toIndex, orderedAsc, filters);

      // Format messages for readability
      const formattedMessages = messages.map(msg => ({
        id: msg.id,
        role: msg.role,
        content: msg.content,
        agent_name: msg.agent_name || null,
        agent_id: msg.agent_id || null,
        created_at: msg.created_at,
        tokens_used: msg.tokens_used || 0,
        metadata: msg.metadata || null,
      }));

      // Handle export functionality
      let exportedData = null;
      let exportInfo = null;
      
      if (export_to_file) {
        // Validate that local_working_folder is configured
        if (!context.agentId) {
          throw new Error('agentId is required in context for file export');
        }
        
        const workingFolderConfig = await getWorkingFolderConfig(context.sessionId, context.agentId);
        if (!workingFolderConfig) {
          throw new Error('local_working_folder tool must be configured to export to file. Please configure it in Session Settings → Tools.');
        }

        // Get workspace path
        const workspacePath = getWorkspacePath(
          workingFolderConfig.folder_name.trim(),
          context.sessionId,
          context.agentId,
          workingFolderConfig.randomize_name !== false
        );

        // Resolve and validate file path (must be within workspace)
        let filePath;
        try {
          filePath = resolveWorkspacePath(export_to_file, workspacePath);
        } catch (error) {
          throw new Error(`Invalid file path: ${error.message}. Path must be relative to the working folder.`);
        }

        // Determine format (default to JSON if not specified)
        const exportFormat = format || 'json';
        
        // Format messages according to format
        let fileContent;
        if (exportFormat === 'csv') {
          fileContent = formatAsCSV(formattedMessages);
        } else {
          fileContent = formatAsJSON(formattedMessages);
        }

        // Ensure directory exists
        const fileDir = path.dirname(filePath);
        await fs.mkdir(fileDir, { recursive: true });

        // Write file
        await fs.writeFile(filePath, fileContent, 'utf8');
        
        exportInfo = {
          file_path: export_to_file,
          absolute_path: filePath,
          format: exportFormat,
          messages_exported: formattedMessages.length,
          file_size_bytes: Buffer.byteLength(fileContent, 'utf8'),
        };
        
        logger.info(`Exported ${formattedMessages.length} messages to ${filePath} (format: ${exportFormat})`);
      } else if (format) {
        // Return formatted string in response (not writing to file)
        if (format === 'csv') {
          exportedData = formatAsCSV(formattedMessages);
        } else {
          exportedData = formatAsJSON(formattedMessages);
        }
      }

      // Build response with progress indicators and chunk metadata
      const hasMore = toIndex < totalCount;
      const isChunked = isChunkedRequest && hasMore;
      
      // Calculate chunk information
      let chunkInfo = null;
      if (isChunked) {
        // Calculate total requested range (clamp to available messages)
        const effectiveTo = originalToIndex !== null 
          ? Math.min(originalToIndex, totalCount) 
          : totalCount;
        const totalRequested = effectiveTo - from;
        const totalChunks = Math.ceil(totalRequested / validatedChunkSize);
        const currentChunk = Math.floor((toIndex - from) / validatedChunkSize) + 1;
        const remainingMessages = effectiveTo - toIndex;
        const nextChunkTo = originalToIndex !== null
          ? Math.min(toIndex + validatedChunkSize, originalToIndex, totalCount)
          : Math.min(toIndex + validatedChunkSize, totalCount);
        
        // Build filter string for suggestion
        const filterParams = [];
        if (role) filterParams.push(`role="${role}"`);
        if (date_from) filterParams.push(`date_from="${date_from}"`);
        if (date_to) filterParams.push(`date_to="${date_to}"`);
        if (keywords) {
          const kwStr = Array.isArray(keywords) ? keywords.join(',') : keywords;
          filterParams.push(`keywords=[${kwStr}]`);
        }
        const filterStr = filterParams.length > 0 ? `, ${filterParams.join(', ')}` : '';
        
        chunkInfo = {
          is_chunked: true,
          chunk_size: validatedChunkSize,
          current_chunk: currentChunk,
          total_chunks: totalChunks,
          messages_in_chunk: formattedMessages.length,
          remaining_messages: remainingMessages,
          next_chunk: {
            from: toIndex,
            to: nextChunkTo,
            suggestion: `To get the next chunk, call again with from=${toIndex}${originalToIndex !== null && originalToIndex < totalCount ? `, to=${originalToIndex}` : ''}${filterStr}`,
          },
        };
      }

      const progressInfo = isChunked
        ? ` (chunk ${chunkInfo.current_chunk} of ${chunkInfo.total_chunks}, ${formattedMessages.length} messages in this chunk, ${chunkInfo.remaining_messages} remaining)`
        : totalCount > MAX_MESSAGES_PER_REQUEST 
          ? ` (showing ${formattedMessages.length} of ${totalCount} filtered messages${hasMore ? `, ${totalCount - toIndex} more available` : ''})`
          : '';

      // Build response message
      let responseMessage = `Retrieved ${formattedMessages.length} message(s)${progressInfo}`;
      if (exportInfo) {
        responseMessage += `. Exported to ${exportInfo.file_path} (${exportInfo.format.toUpperCase()}, ${exportInfo.file_size_bytes} bytes)`;
      } else if (exportedData) {
        responseMessage += `. Formatted as ${format.toUpperCase()}`;
      }

      return {
        success: true,
        messages: formattedMessages, // Always include messages array
        exported_data: exportedData, // Formatted string when format is specified without export_to_file
        total_count: totalCount,
        filtered_count: totalCount,
        from: from,
        to: toIndex,
        returned_count: formattedMessages.length,
        ordered_asc: orderedAsc,
        filters_applied: Object.keys(filters).length > 0 ? filters : null,
        has_more: hasMore,
        max_per_request: MAX_MESSAGES_PER_REQUEST,
        message: responseMessage,
        // Export information
        ...(exportInfo ? { export: exportInfo } : {}),
        // Chunk information for chunked responses
        ...(chunkInfo ? { chunk: chunkInfo } : {}),
        // Progress indicator for large histories (non-chunked)
        ...(!isChunked && totalCount > MAX_MESSAGES_PER_REQUEST ? {
          progress: {
            current_range: `${from}-${toIndex}`,
            total_available: totalCount,
            percentage: Math.round((toIndex / totalCount) * 100),
            suggestion: hasMore ? `Use from=${toIndex} to retrieve next batch` : null,
          },
        } : {}),
      };
    },
    examples: [
      {
        description: 'Get first 10 messages (oldest first)',
        parameters: {
          from: 0,
          to: 10,
          orderedAsc: true,
        },
      },
      {
        description: 'Get last 5 messages (newest first)',
        parameters: {
          from: 0,
          to: 5,
          orderedAsc: false,
        },
      },
      {
        description: 'Get all user messages from last week',
        parameters: {
          role: 'user',
          date_from: '2026-01-17',
          orderedAsc: false,
        },
      },
      {
        description: 'Search for messages containing "artifact" or "T:"',
        parameters: {
          keywords: ['artifact', 'T:'],
          orderedAsc: true,
        },
      },
      {
        description: 'Get assistant messages from a specific date range',
        parameters: {
          role: 'assistant',
          date_from: '2026-01-20T00:00:00',
          date_to: '2026-01-24T23:59:59',
          orderedAsc: true,
        },
      },
      {
        description: 'Get messages 20-30 with keyword filter',
        parameters: {
          from: 20,
          to: 30,
          keywords: 'artifact',
          orderedAsc: true,
        },
      },
      {
        description: 'Get all messages (auto-chunked for large histories)',
        parameters: {
          from: 0,
          orderedAsc: true,
          auto_chunk: true,
        },
      },
      {
        description: 'Get first chunk of 1000 messages (will auto-chunk into 100-message chunks)',
        parameters: {
          from: 0,
          to: 1000,
          chunk_size: 100,
          auto_chunk: true,
        },
      },
      {
        description: 'Get next chunk after receiving chunked response',
        parameters: {
          from: 100,
          to: 1000,
          chunk_size: 100,
          auto_chunk: true,
        },
      },
      {
        description: 'Get all messages with custom chunk size of 50',
        parameters: {
          from: 0,
          chunk_size: 50,
          auto_chunk: true,
        },
      },
      {
        description: 'Export messages as JSON string',
        parameters: {
          from: 0,
          to: 100,
          format: 'json',
        },
      },
      {
        description: 'Export messages as CSV string',
        parameters: {
          from: 0,
          to: 100,
          format: 'csv',
        },
      },
      {
        description: 'Export messages to JSON file in working folder',
        parameters: {
          from: 0,
          to: 100,
          export_to_file: 'exports/conversation_history.json',
          format: 'json',
        },
      },
      {
        description: 'Export filtered messages to CSV file',
        parameters: {
          role: 'user',
          date_from: '2026-01-20',
          export_to_file: './data/user_messages.csv',
          format: 'csv',
        },
      },
      {
        description: 'Export all messages to file (auto-formats as JSON)',
        parameters: {
          from: 0,
          export_to_file: 'conversation_backup.json',
        },
      },
    ],
  });
}

module.exports = {
  registerConversationHistoryTool,
};
