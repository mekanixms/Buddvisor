/**
 * EF API Tool (ef_api)
 * REPL-type access to the XML Invoice Viewer (ef) application API.
 * Connects to a remote ef instance using JWT auth and exposes invoice, document, and analytics operations.
 * Note: Some endpoints (list_tags, list_documents, create_tag) may return 404 if not configured or populated
 * in the remote ef instance. The tool returns clear messages in those cases.
 *
 * See ef-API.md for full API reference.
 */

const { toolRegistry } = require('./ToolRegistry');
const logger = require('../../utils/logger');
const https = require('https');
const http = require('http');

// Per-session token cache: Map<sessionAgentKey, { token, expiresAt }>
const tokenCache = new Map();
const TOKEN_CACHE_TTL_MS = 55 * 60 * 1000; // 55 minutes (JWT often 1h)

function getSessionAgentKey(sessionId, agentId) {
  const entityId = agentId !== null && agentId !== undefined ? agentId : 'orchestrator';
  return `${sessionId}:${entityId}`;
}

function isExpired(expiresAt) {
  return !expiresAt || Date.now() >= expiresAt;
}

/**
 * Make HTTPS/HTTP request to remote ef API
 */
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

/**
 * Login and obtain JWT token
 */
async function login(baseUrl, username, password, rejectUnauthorized = false) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/login`;
  const res = await makeRequest(url, {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    rejectUnauthorized,
  });

  if (res.status !== 200) {
    const msg = res.data?.message || res.raw || `HTTP ${res.status}`;
    throw new Error(`Login failed: ${msg}`);
  }

  const token = res.data?.token;
  if (!token) {
    throw new Error('Login succeeded but no token in response');
  }
  return token;
}

/**
 * Get valid token for session/agent, login if needed
 */
async function getToken(config, sessionId, agentId) {
  const key = getSessionAgentKey(sessionId, agentId);
  const cached = tokenCache.get(key);
  if (cached && !isExpired(cached.expiresAt)) {
    return cached.token;
  }

  // Pass false to allow self-signed/expired certs when user set reject_unauthorized: false
  const allowInvalidCerts = config.reject_unauthorized === false;
  const token = await login(
    config.base_url,
    config.username,
    config.password,
    !allowInvalidCerts
  );

  tokenCache.set(key, {
    token,
    expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
  });
  return token;
}

/**
 * Ensure tool config and fetch from DB if missing
 */
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
      [context.sessionId, 'ef_api']
    );
  } else {
    rows = await dbAll(
      `SELECT tool_config FROM session_agent_tools
       WHERE session_id = ? AND agent_id = ? AND tool_name = ?`,
      [context.sessionId, context.agentId, 'ef_api']
    );
  }

  if (!rows || rows.length === 0) {
    const entity = agentId ? 'agent' : 'orchestrator';
    throw new Error(`ef_api tool is not configured for this ${entity}. Configure base_url, username, and password in Session Settings → Tools.`);
  }

  let config = rows[0].tool_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (e) {
      throw new Error('Invalid ef_api tool configuration. Please reconfigure in Session Settings → Tools.');
    }
  }

  if (!config || !config.base_url || !config.username || !config.password) {
    const entity = agentId ? 'agent' : 'orchestrator';
    throw new Error(`ef_api requires base_url, username, and password. Configure in Session Settings → Tools.`);
  }

  context.toolConfig = config;
  return config;
}

/**
 * Build structured response for operations that may return 404 or 500.
 * Returns success: false with a clear message when the endpoint is unavailable.
 */
function buildApiResponse(res, operation, fallbackData = null) {
  if (res.status === 404) {
    const unavailableOps = ['list_tags', 'list_documents', 'create_tag', 'upload_document'];
    const msg = unavailableOps.includes(operation)
      ? `Endpoint ${operation} returned 404. This feature may not be configured or available in the current ef instance. Use search, list_invoices, view_invoice, get_overdue_invoices, or get_reminders instead.`
      : `Endpoint not found (404).`;
    return { success: false, status: 404, message: msg, data: fallbackData };
  }
  if (res.status >= 500) {
    const errMsg = (typeof res.data === 'object' && res.data?.error) ? res.data.error : res.raw?.slice(0, 200);
    return {
      success: false,
      status: res.status,
      message: `Server error (${res.status}): ${errMsg || 'The remote ef instance encountered an error.'}`,
      data: res.data,
    };
  }
  return { success: res.status >= 200 && res.status < 300, status: res.status, ...(res.data && typeof res.data === 'object' ? res.data : { data: res.data }) };
}

/**
 * Call ef API with auth
 */
async function callApi(config, token, path, options = {}) {
  const base = config.base_url.replace(/\/$/, '');
  const url = path.startsWith('http') ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`;

  const headers = {
    'Authorization': `Bearer ${token}`,
    ...options.headers,
  };

  return makeRequest(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    rejectUnauthorized: config.reject_unauthorized !== false,
    timeout: options.timeout || 60000,
  });
}

/**
 * Register EF API tool
 */
function registerEfApiTool() {
  toolRegistry.register({
    name: 'ef_api',
    description: 'REPL-style access to the XML Invoice Viewer (ef) application API on a remote server. Use to search invoices, list/view/upload/delete invoices, manage documents, tags, reminders, and analytics. Requires base_url, username, and password configured in Session Settings → Tools. Note: Some endpoints (list_tags, list_documents, create_tag) may return 404 if not configured in the remote ef instance; use search, list_invoices, get_overdue_invoices, get_reminders as fallbacks.',
    category: 'integration',
    parameters: {
      operation: {
        type: 'string',
        description: 'API operation to perform',
        required: true,
        enum: [
          'search',
          'list_invoices',
          'get_invoice_xml',
          'view_invoice',
          'process_invoice',
          'delete_invoice',
          'list_documents',
          'upload_document',
          'list_tags',
          'create_tag',
          'get_overdue_invoices',
          'mark_invoice_paid',
          'mark_all_invoices_paid',
          'set_reminder',
          'get_reminders',
          'complete_reminder',
          'analytics',
          'health',
        ],
      },
      // search
      q: { type: 'string', description: 'Search term for invoices (operation: search)', required: false },
      page: { type: 'number', description: 'Page number (default 1)', required: false },
      limit: { type: 'number', description: 'Items per page (default 10)', required: false },
      // get_invoice_xml, view_invoice, delete_invoice, mark_invoice_paid
      id: { type: 'number', description: 'Invoice/document ID', required: false },
      // process_invoice
      xml_content: { type: 'string', description: 'Raw XML invoice content (for process_invoice)', required: false },
      filename: { type: 'string', description: 'Filename for uploaded XML (e.g. invoice.xml)', required: false },
      // documents
      search: { type: 'string', description: 'Document search term', required: false },
      tag: { type: 'string', description: 'Document tag filter', required: false },
      type: { type: 'string', description: 'Document type filter', required: false },
      // tags
      name: { type: 'string', description: 'Tag name (create_tag)', required: false },
      color: { type: 'string', description: 'Tag color (create_tag)', required: false },
      // reminders
      invoiceId: { type: 'number', description: 'Invoice ID for reminder', required: false },
      reminderDate: { type: 'string', description: 'Reminder date (ISO)', required: false },
      // analytics
      filter: { type: 'object', description: 'Analytics filter', required: false },
      xValue: { type: 'string', description: 'Analytics x-axis value', required: false },
      yValue: { type: 'string', description: 'Analytics y-axis value', required: false },
    },
    handler: async (params, context) => {
      const { operation } = params;

      if (!context.sessionId) {
        throw new Error('sessionId is required in context');
      }

      const agentId = context.agentId !== undefined ? context.agentId : null;
      const config = await ensureToolConfig(context);
      const token = await getToken(config, context.sessionId, agentId);

      // Node's rejectUnauthorized: false = allow self-signed/expired certs. Config reject_unauthorized: false means "allow".
      const rejectUnauthorized = config.reject_unauthorized !== false; // false when user allows invalid certs

      try {
        switch (operation) {
          case 'search': {
            const q = params.q || '';
            const page = params.page ?? 1;
            const limit = params.limit ?? 10;
            const res = await callApi(config, token, `/api/search?q=${encodeURIComponent(q)}&page=${page}&limit=${limit}`);
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          case 'list_invoices': {
            const page = params.page ?? 1;
            const limit = params.limit ?? 10;
            const res = await callApi(config, token, `/history?page=${page}&limit=${limit}`);
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          case 'get_invoice_xml': {
            const id = params.id;
            if (!id) throw new Error('id is required for get_invoice_xml');
            const res = await callApi(config, token, `/invoice/${id}`);
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          case 'view_invoice': {
            const id = params.id;
            if (!id) throw new Error('id is required for view_invoice');
            const res = await callApi(config, token, `/view-invoice?id=${id}`);
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          case 'process_invoice': {
            const xmlContent = params.xml_content;
            const filename = params.filename || 'invoice.xml';
            if (!xmlContent) throw new Error('xml_content is required for process_invoice');

            const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
            const body = [
              `--${boundary}`,
              `Content-Disposition: form-data; name="xmlFile"; filename="${filename}"`,
              'Content-Type: application/xml',
              '',
              xmlContent,
              `--${boundary}--`,
            ].join('\r\n');

            const base = config.base_url.replace(/\/$/, '');
            const parsed = new URL(`${base}/process-invoice`);
            const lib = parsed.protocol === 'https:' ? https : http;
            const res = await new Promise((resolve, reject) => {
              const req = lib.request({
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname,
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': `multipart/form-data; boundary=${boundary}`,
                  'Content-Length': Buffer.byteLength(body, 'utf8'),
                },
                rejectUnauthorized: !rejectUnauthorized,
              }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                  try {
                    resolve({ status: res.statusCode, data: data ? JSON.parse(data) : null });
                  } catch {
                    resolve({ status: res.statusCode, data });
                  }
                });
              });
              req.on('error', reject);
              req.write(body);
              req.end();
            });
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          case 'delete_invoice': {
            const id = params.id;
            if (!id) throw new Error('id is required for delete_invoice');
            const res = await callApi(config, token, `/history/${id}`, { method: 'DELETE' });
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          case 'list_documents': {
            const qs = new URLSearchParams();
            if (params.search) qs.set('search', params.search);
            if (params.tag) qs.set('tag', params.tag);
            if (params.type) qs.set('type', params.type);
            const path = `/api/documents${qs.toString() ? '?' + qs : ''}`;
            const res = await callApi(config, token, path);
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            if (res.status === 404 || res.status >= 500) {
              return buildApiResponse(res, 'list_documents', []);
            }
            return { success: res.status === 200, status: res.status, data: res.data };
          }
          case 'upload_document': {
            throw new Error('upload_document requires multipart file upload; use process_invoice for XML or implement file upload separately');
          }
          case 'list_tags': {
            const res = await callApi(config, token, '/api/tags');
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            if (res.status === 404 || res.status >= 500) {
              return buildApiResponse(res, 'list_tags', []);
            }
            return { success: res.status === 200, status: res.status, data: res.data };
          }
          case 'create_tag': {
            const name = params.name;
            const color = params.color || '#808080';
            if (!name) throw new Error('name is required for create_tag');
            const res = await callApi(config, token, '/api/tags', {
              method: 'POST',
              body: JSON.stringify({ name, color }),
            });
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            if (res.status === 404 || res.status >= 500) {
              return buildApiResponse(res, 'create_tag');
            }
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          case 'get_overdue_invoices': {
            const res = await callApi(config, token, '/api/overdue-invoices');
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            return { success: res.status === 200, status: res.status, data: res.data };
          }
          case 'mark_invoice_paid': {
            const id = params.id;
            if (!id) throw new Error('id is required for mark_invoice_paid');
            const res = await callApi(config, token, `/api/mark-invoice-paid/${id}`, { method: 'POST' });
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          case 'mark_all_invoices_paid': {
            const res = await callApi(config, token, '/api/mark-all-invoices-paid', { method: 'POST' });
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          case 'set_reminder': {
            const invoiceId = params.invoiceId ?? params.id;
            const reminderDate = params.reminderDate;
            if (!invoiceId || !reminderDate) throw new Error('invoiceId and reminderDate are required for set_reminder');
            const res = await callApi(config, token, '/api/set-reminder', {
              method: 'POST',
              body: JSON.stringify({ invoiceId, reminderDate }),
            });
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          case 'get_reminders': {
            const res = await callApi(config, token, '/api/reminders');
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            return { success: res.status === 200, status: res.status, data: res.data };
          }
          case 'complete_reminder': {
            const id = params.id;
            if (!id) throw new Error('id is required for complete_reminder');
            const res = await callApi(config, token, `/api/complete-reminder/${id}`, { method: 'POST' });
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          case 'analytics': {
            const body = {
              filter: params.filter || {},
              xValue: params.xValue,
              yValue: params.yValue,
            };
            const res = await callApi(config, token, '/api/analytics', {
              method: 'POST',
              body: JSON.stringify(body),
            });
            if (res.status === 401) throw new Error('Authentication failed; credentials may have expired');
            if (res.status === 404 || res.status >= 500) {
              return buildApiResponse(res, 'analytics');
            }
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          case 'health': {
            const res = await makeRequest(`${config.base_url.replace(/\/$/, '')}/health`, { rejectUnauthorized });
            return { success: res.status === 200, status: res.status, ...res.data };
          }
          default:
            throw new Error(`Unknown operation: ${operation}`);
        }
      } catch (err) {
        logger.error('[ef_api]', err);
        throw err;
      }
    },
    examples: [
      {
        description: 'Search invoices by number',
        parameters: { operation: 'search', q: 'INV-001', page: 1, limit: 10 },
      },
      {
        description: 'List invoices',
        parameters: { operation: 'list_invoices', page: 1, limit: 20 },
      },
      {
        description: 'View parsed invoice',
        parameters: { operation: 'view_invoice', id: 1 },
      },
      {
        description: 'Get overdue invoices',
        parameters: { operation: 'get_overdue_invoices' },
      },
    ],
    requiresAuth: false,
    executionTimeout: 60000,
  });
}

module.exports = { registerEfApiTool };
