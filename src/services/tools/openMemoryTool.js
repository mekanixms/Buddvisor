/**
 * OpenMemory Tool (open_memory)
 * Long-term persistent memory via an OpenMemory server.
 * Agents can add, query, get, delete, and list memories. Data is scoped by session/agent.
 * See https://openmemory.cavira.app/docs
 */

const { toolRegistry } = require('./ToolRegistry');
const logger = require('../../utils/logger');
const https = require('https');
const http = require('http');

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      rejectUnauthorized: options.rejectUnauthorized !== false,
    };

    if (options.body) {
      reqOptions.headers['Content-Type'] = options.headers?.['Content-Type'] || 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(options.body, 'utf8');
    }

    const req = lib.request(reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsedData;
        try {
          parsedData = data ? JSON.parse(data) : null;
        } catch {
          parsedData = data;
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: parsedData,
          raw: data,
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(options.timeout || 30000, () => {
      req.destroy(new Error('Request timeout'));
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function ensureToolConfig(context) {
  if (context.toolConfig && context.toolConfig.base_url) {
    return context.toolConfig;
  }

  const { dbAll } = require('../../../config/database');
  const agentId = context.agentId !== undefined ? context.agentId : null;

  let rows;
  if (!agentId) {
    rows = await dbAll(
      `SELECT tool_config FROM session_orchestrator_tools
       WHERE session_id = ? AND tool_name = ?`,
      [context.sessionId, 'open_memory']
    );
  } else {
    rows = await dbAll(
      `SELECT tool_config FROM session_agent_tools
       WHERE session_id = ? AND agent_id = ? AND tool_name = ?`,
      [context.sessionId, context.agentId, 'open_memory']
    );
  }

  if (!rows || rows.length === 0) {
    const entity = agentId ? 'agent' : 'orchestrator';
    throw new Error(`open_memory is not configured for this ${entity}. Set base_url in Session Settings → Tools.`);
  }

  let config = rows[0].tool_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      throw new Error('Invalid open_memory tool configuration. Please reconfigure in Session Settings → Tools.');
    }
  }

  if (!config || !config.base_url) {
    const entity = agentId ? 'agent' : 'orchestrator';
    throw new Error(`open_memory requires base_url. Configure in Session Settings → Tools.`);
  }

  context.toolConfig = config;
  return config;
}

function getDefaultUserId(context, config) {
  const sessionScope = config?.session_scope;
  const agentScope = config?.agent_scope;

  const parts = [];
  if (sessionScope && String(sessionScope).trim()) {
    parts.push(`session:${String(sessionScope).trim()}`);
  }
  if (agentScope && String(agentScope).trim()) {
    parts.push(`agent:${String(agentScope).trim()}`);
  }
  if (parts.length > 0) return parts.join(':');

  // Fallback when no config scopes are set (shouldn't happen with UI defaults)
  const agentId = context.agentId !== undefined ? context.agentId : null;
  const sessionId = context.sessionId || '';
  return agentId != null ? `session:${sessionId}:agent:${agentId}` : `session:${sessionId}:orchestrator`;
}

async function callOpenMemory(config, method, path, body = null) {
  const base = config.base_url.replace(/\/$/, '');
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;

  const headers = {};
  if (config.api_key) {
    headers['Authorization'] = `Bearer ${config.api_key}`;
  }
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const options = {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    rejectUnauthorized: config.reject_unauthorized !== false,
    timeout: 30000,
  };

  return makeRequest(url, options);
}

function registerOpenMemoryTool() {
  toolRegistry.register({
    name: 'open_memory',
    description: 'Long-term persistent memory via an OpenMemory server. Use add to store facts; query to recall by natural language; get/delete by id; list recent or by tag. Data is scoped by session/agent. Configure base_url (and optional api_key) in Session Settings → Tools.',
    category: 'storage',
    parameters: {
      operation: {
        type: 'string',
        description: 'Operation to perform',
        required: true,
        enum: ['add', 'query', 'get', 'delete', 'list', 'health'],
      },
      content: {
        type: 'string',
        description: 'Memory content to store (required for add)',
        required: false,
      },
      tags: {
        type: 'array',
        description: 'Tags for categorization (optional for add; filter for list)',
        required: false,
        items: { type: 'string' },
      },
      metadata: {
        type: 'object',
        description: 'Additional metadata (optional for add)',
        required: false,
      },
      query: {
        type: 'string',
        description: 'Natural language question to recall memories (required for query)',
        required: false,
      },
      id: {
        type: 'string',
        description: 'Memory id (required for get and delete)',
        required: false,
      },
      limit: {
        type: 'number',
        description: 'Max number of memories to return (for query/list, default 10; list max 100)',
        required: false,
        minimum: 1,
        maximum: 100,
      },
      offset: {
        type: 'number',
        description: 'Skip this many items (for list pagination, default 0)',
        required: false,
        minimum: 0,
      },
      tag: {
        type: 'string',
        description: 'Single tag to filter list (optional for list)',
        required: false,
      },
      sector: {
        type: 'string',
        description: 'Filter list by memory sector (optional for list; backend-dependent)',
        required: false,
      },
      user_id: {
        type: 'string',
        description: 'Override scope; if omitted, session/agent scope is used',
        required: false,
      },
    },
    handler: async (params, context) => {
      const { operation } = params;

      if (!context.sessionId) {
        throw new Error('sessionId is required in context');
      }

      const config = await ensureToolConfig(context);
      const userId = params.user_id || getDefaultUserId(context, config);

      try {
        switch (operation) {
          case 'health': {
            const res = await callOpenMemory(config, 'GET', '/health');
            const ok = res.status >= 200 && res.status < 300;
            return {
              success: ok,
              status: res.status,
              ok,
              message: ok ? 'OpenMemory server reachable' : (res.data?.message || res.raw || `HTTP ${res.status}`),
              ...(res.data && typeof res.data === 'object' ? res.data : {}),
            };
          }

          case 'add': {
            const content = params.content;
            if (!content || typeof content !== 'string' || content.trim() === '') {
              throw new Error('content is required for add and must be a non-empty string');
            }
            const body = {
              content: content.trim(),
              tags: Array.isArray(params.tags) ? params.tags : [],
              metadata: params.metadata && typeof params.metadata === 'object' ? params.metadata : {},
              user_id: userId,
            };
            const res = await callOpenMemory(config, 'POST', '/memory/add', body);
            if (res.status >= 400) {
              const msg = res.data?.message || res.raw || `HTTP ${res.status}`;
              return { success: false, status: res.status, error: msg, data: res.data };
            }
            return {
              success: true,
              status: res.status,
              id: res.data?.id,
              primary_sector: res.data?.primary_sector,
              sectors: res.data?.sectors,
              ...(res.data && typeof res.data === 'object' ? res.data : {}),
            };
          }

          case 'query': {
            const query = params.query;
            if (!query || typeof query !== 'string' || query.trim() === '') {
              throw new Error('query is required for query and must be a non-empty string');
            }
            const limit = Math.min(50, Math.max(1, Number(params.limit) || 10));
            const body = { query: query.trim(), k: limit, user_id: userId };
            const res = await callOpenMemory(config, 'POST', '/memory/query', body);
            if (res.status >= 400) {
              const msg = res.data?.message || res.raw || `HTTP ${res.status}`;
              return { success: false, status: res.status, error: msg, memories: [] };
            }
            const memories = Array.isArray(res.data?.matches)
              ? res.data.matches
              : (Array.isArray(res.data?.memories) ? res.data.memories : (res.data?.results || res.data || []));
            return {
              success: true,
              status: res.status,
              memories,
              count: memories.length,
              ...(res.data && typeof res.data === 'object' ? res.data : {}),
            };
          }

          case 'get': {
            const id = params.id;
            if (!id || typeof id !== 'string' || id.trim() === '') {
              throw new Error('id is required for get and must be a non-empty string');
            }
            const idTrimmed = id.trim();
            const path = `/memory/${encodeURIComponent(idTrimmed)}?user_id=${encodeURIComponent(userId)}`;
            const res = await callOpenMemory(config, 'GET', path);
            if (res.status === 404) {
              return { success: false, status: 404, error: 'Memory not found', id: idTrimmed };
            }
            if (res.status === 403) {
              return { success: false, status: 403, error: 'Forbidden: memory belongs to another user', id: idTrimmed };
            }
            if (res.status >= 400) {
              const msg = res.data?.err || res.data?.message || res.raw || `HTTP ${res.status}`;
              return { success: false, status: res.status, error: msg, id: idTrimmed, data: res.data };
            }
            return {
              success: true,
              status: res.status,
              memory: res.data,
              id: idTrimmed,
              ...(res.data && typeof res.data === 'object' ? res.data : {}),
            };
          }

          case 'delete': {
            const id = params.id;
            if (!id || typeof id !== 'string' || id.trim() === '') {
              throw new Error('id is required for delete and must be a non-empty string');
            }
            const idTrimmed = id.trim();
            const path = `/memory/${encodeURIComponent(idTrimmed)}?user_id=${encodeURIComponent(userId)}`;
            const res = await callOpenMemory(config, 'DELETE', path);
            if (res.status === 404) {
              return { success: false, status: 404, error: 'Memory not found', id: idTrimmed, deleted: false };
            }
            if (res.status === 403) {
              return { success: false, status: 403, error: 'Forbidden: memory belongs to another user', id: idTrimmed, deleted: false };
            }
            if (res.status >= 400) {
              const msg = res.data?.err || res.data?.message || res.raw || `HTTP ${res.status}`;
              return { success: false, status: res.status, error: msg, id: idTrimmed, deleted: false, data: res.data };
            }
            return {
              success: true,
              status: res.status,
              deleted: true,
              id: idTrimmed,
              ...(res.data && typeof res.data === 'object' ? res.data : {}),
            };
          }

          case 'list': {
            const limit = Math.min(100, Math.max(1, Number(params.limit) || 10));
            const offset = Math.max(0, Number(params.offset) || 0);
            const sector = (params.sector && String(params.sector).trim()) || '';
            let path = `/memory/all?user_id=${encodeURIComponent(userId)}&l=${limit}&u=${offset}`;
            if (sector) path += `&s=${encodeURIComponent(sector)}`;
            const res = await callOpenMemory(config, 'GET', path);
            if (res.status >= 400) {
              const msg = res.data?.err || res.data?.message || res.raw || `HTTP ${res.status}`;
              return { success: false, status: res.status, error: msg, items: [], message: 'List may not be supported by this OpenMemory server.' };
            }
            const items = Array.isArray(res.data?.items) ? res.data.items : [];
            return {
              success: true,
              status: res.status,
              items,
              count: items.length,
              ...(res.data && typeof res.data === 'object' ? res.data : {}),
            };
          }

          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
      } catch (err) {
        logger.warn('[open_memory]', { operation, error: err.message });
        throw err;
      }
    },
    examples: [
      {
        description: 'Store a memory',
        parameters: {
          operation: 'add',
          content: 'User prefers summaries in bullet points',
          tags: ['preferences', 'ui'],
        },
      },
      {
        description: 'Recall relevant memories',
        parameters: {
          operation: 'query',
          query: 'What does the user prefer for reports?',
          limit: 5,
        },
      },
      {
        description: 'Get one memory by id',
        parameters: { operation: 'get', id: 'mem_abc123' },
      },
      {
        description: 'Delete a memory by id',
        parameters: { operation: 'delete', id: 'mem_abc123' },
      },
      {
        description: 'List recent memories (returns items array)',
        parameters: { operation: 'list', limit: 20, offset: 0 },
      },
      {
        description: 'Check server connectivity',
        parameters: { operation: 'health' },
      },
    ],
  });
}

module.exports = {
  registerOpenMemoryTool,
};
