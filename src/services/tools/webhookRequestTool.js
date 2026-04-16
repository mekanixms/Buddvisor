/**
 * Webhook Request Tool
 * Provides outbound HTTP requests to webhook endpoints (e.g., remote n8n).
 */

const { toolRegistry } = require('./ToolRegistry');
const logger = require('../../utils/logger');

const ALLOWED_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function getAllowlistedBaseUrls() {
  const raw =
    process.env.WEBHOOK_REQUEST_ALLOWLIST ||
    process.env.WEBHOOK_REQUEST_ALLOWED_BASE_URLS ||
    '';

  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function isUrlAllowlisted(urlString, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true; // allow all when not configured
  return allowlist.some(prefix => urlString.startsWith(prefix));
}

function truncateString(value, maxChars) {
  if (typeof value !== 'string') return value;
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + `\n… (truncated to ${maxChars} chars)`;
}

/**
 * Register webhook_request tool
 */
function registerWebhookRequestTool() {
  toolRegistry.register({
    name: 'webhook_request',
    description:
      'Send an outbound HTTP request to a webhook endpoint (e.g., n8n). Use this to trigger automations or fetch data from external systems. Supports GET/POST/PUT/PATCH/DELETE with optional headers, query params, and JSON body.',
    category: 'integration',
    parameters: {
      url: {
        type: 'string',
        description: 'Target URL (must be http(s) and absolute)',
        required: true,
        minLength: 1,
        maxLength: 5000,
      },
      method: {
        type: 'string',
        description: 'HTTP method (default: POST)',
        required: false,
        enum: ALLOWED_METHODS,
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP headers (object of string → string)',
        required: false,
      },
      query: {
        type: 'object',
        description: 'Optional query parameters appended to the URL (object of string → string/number/boolean)',
        required: false,
      },
      body: {
        type: 'object',
        description: 'Optional JSON body for POST/PUT/PATCH requests',
        required: false,
      },
      timeout_ms: {
        type: 'number',
        description: 'Request timeout in milliseconds (default: 30000)',
        required: false,
        minimum: 100,
        maximum: 120000,
      },
      max_response_chars: {
        type: 'number',
        description: 'Maximum characters of response body to return (default: 20000)',
        required: false,
        minimum: 500,
        maximum: 200000,
      },
    },
    handler: async (params, context) => {
      const {
        url,
        method = 'POST',
        headers = {},
        query = null,
        body = null,
        timeout_ms = 30000,
        max_response_chars = 20000,
      } = params || {};

      const upperMethod = String(method || 'POST').toUpperCase();
      if (!ALLOWED_METHODS.includes(upperMethod)) {
        return { error: `Unsupported method: ${upperMethod}` };
      }

      let parsedUrl;
      try {
        parsedUrl = new URL(url);
      } catch {
        return { error: 'Invalid url. Must be an absolute http(s) URL.' };
      }

      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { error: 'Invalid url protocol. Only http and https are supported.' };
      }

      const allowlist = getAllowlistedBaseUrls();
      if (!isUrlAllowlisted(url, allowlist)) {
        return {
          error:
            'URL is not allowlisted. Configure WEBHOOK_REQUEST_ALLOWLIST (comma-separated URL prefixes) to permit this destination.',
          allowlist,
        };
      }

      // Append query params if provided
      if (query && typeof query === 'object' && !Array.isArray(query)) {
        for (const [k, v] of Object.entries(query)) {
          if (v === undefined || v === null) continue;
          parsedUrl.searchParams.set(k, String(v));
        }
      }

      // Avoid logging secrets (headers/body may contain tokens)
      logger.info('webhook_request', {
        method: upperMethod,
        url: parsedUrl.toString(),
        sessionId: context?.sessionId,
        userId: context?.userId,
        headerKeys: headers && typeof headers === 'object' ? Object.keys(headers).slice(0, 50) : [],
      });

      try {
        const res = await fetch(parsedUrl.toString(), {
          method: upperMethod,
          headers: {
            // Default to JSON if sending a body and no content-type provided
            ...(body != null && (!headers || typeof headers !== 'object' || !('Content-Type' in headers))
              ? { 'Content-Type': 'application/json' }
              : {}),
            ...(headers && typeof headers === 'object' ? headers : {}),
          },
          body:
            ['POST', 'PUT', 'PATCH'].includes(upperMethod) && body != null
              ? JSON.stringify(body)
              : undefined,
          signal: AbortSignal.timeout(timeout_ms),
        });

        const contentType = res.headers.get('content-type') || '';
        const isJson = contentType.includes('application/json');

        let responseBody;
        if (isJson) {
          // For safety, parse JSON then stringify (keeps it bounded/truncatable)
          const parsed = await res.json().catch(() => null);
          responseBody = parsed;
        } else {
          responseBody = await res.text();
        }

        return {
          ok: res.ok,
          status: res.status,
          status_text: res.statusText,
          url: parsedUrl.toString(),
          method: upperMethod,
          response: typeof responseBody === 'string'
            ? truncateString(responseBody, max_response_chars)
            : responseBody,
          response_content_type: contentType,
          note: typeof responseBody === 'string' && responseBody.length > max_response_chars
            ? `Response body truncated to ${max_response_chars} chars.`
            : undefined,
        };
      } catch (e) {
        const msg = e?.name === 'TimeoutError'
          ? `Request timed out after ${timeout_ms}ms`
          : (e?.message || String(e));

        return {
          ok: false,
          error: msg,
          url: parsedUrl.toString(),
          method: upperMethod,
        };
      }
    },
    examples: [
      {
        description: 'Trigger an n8n webhook with JSON payload',
        parameters: {
          url: 'http://n8n.local:5678/webhook/my-flow',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { event: 'invoice.paid', invoiceId: 'INV-10023' },
        },
      },
      {
        description: 'GET with query params',
        parameters: {
          url: 'http://n8n.local:5678/webhook/get-status',
          method: 'GET',
          query: { id: 123 },
        },
      },
    ],
    requiresAuth: false,
  });

  logger.info('Webhook request tool registered');
}

module.exports = { registerWebhookRequestTool };

