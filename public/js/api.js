/**
 * API Client for Badvisor
 *
 * This module provides a simple wrapper around the fetch API
 * for making requests to the backend.
 */

class APIClient {
  constructor() {
    this.baseURL = '/api';
    this.token = localStorage.getItem('token');
  }

  /**
   * Set authentication token
   * @param {string} token - JWT token
   */
  setToken(token) {
    this.token = token;
    if (token) {
      localStorage.setItem('token', token);
    } else {
      localStorage.removeItem('token');
    }
  }

  /**
   * Get authentication token
   * @returns {string|null} - JWT token or null
   */
  getToken() {
    return this.token || localStorage.getItem('token');
  }

  /**
   * Clear authentication token
   */
  clearToken() {
    this.token = null;
    localStorage.removeItem('token');
  }

  /**
   * Make HTTP request
   * @param {string} method - HTTP method
   * @param {string} endpoint - API endpoint
   * @param {object} data - Request body data
   * @param {object} options - Additional options
   * @returns {Promise} - Response promise
   */
  async request(method, endpoint, data = null, options = {}) {
    const url = `${this.baseURL}${endpoint}`;

    const headers = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    // Add authorization header if token exists
    const token = this.getToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const config = {
      method,
      headers,
      ...options,
    };

    // Add body for POST, PUT, PATCH requests
    if (data && ['POST', 'PUT', 'PATCH'].includes(method)) {
      config.body = JSON.stringify(data);
    }

    try {
      const response = await fetch(url, config);

      // Handle unauthorized errors
      if (response.status === 401) {
        this.clearToken();
        window.location.href = '/login.html';
        throw new Error('Unauthorized');
      }

      // Safely parse response (some errors may return non-JSON bodies).
      // Read body once as text, then JSON.parse if possible.
      let result = null;
      let rawText = '';
      try {
        rawText = await response.text();
      } catch {
        rawText = '';
      }
      if (rawText) {
        try {
          result = JSON.parse(rawText);
        } catch {
          result = null;
        }
      }

      if (!response.ok) {
        const baseMsg =
          result?.error?.message ||
          rawText ||
          `Request failed (HTTP ${response.status})`;
        const details = result?.error?.details;
        const detailMsg = Array.isArray(details) && details.length > 0
          ? details
            .map(d => (d?.field && d?.message) ? `${d.field}: ${d.message}` : (d?.message || String(d)))
            .join(', ')
          : '';
        const err = new Error(detailMsg ? `${baseMsg} (${detailMsg})` : baseMsg);
        err.status = response.status;
        err.code = result?.error?.code;
        throw err;
      }

      return result;
    } catch (error) {
      console.error('API Error:', error);
      throw error;
    }
  }

  // Convenience methods
  async get(endpoint, options = {}) {
    return this.request('GET', endpoint, null, options);
  }

  async post(endpoint, data, options = {}) {
    return this.request('POST', endpoint, data, options);
  }

  async put(endpoint, data, options = {}) {
    return this.request('PUT', endpoint, data, options);
  }

  async delete(endpoint, options = {}) {
    return this.request('DELETE', endpoint, null, options);
  }

  // Authentication API
  auth = {
    register: (username, password) =>
      this.post('/auth/register', { username, password }),

    login: (username, password) =>
      this.post('/auth/login', { username, password }),

    logout: () =>
      this.post('/auth/logout'),

    getCurrentUser: () =>
      this.get('/auth/me'),

    changePassword: (oldPassword, newPassword) =>
      this.put('/auth/password', { oldPassword, newPassword }),

    getSessions: () =>
      this.get('/auth/sessions'),

    // Superuser only endpoints
    getAllUsers: () =>
      this.get('/auth/users'),

    deleteUser: (userId) =>
      this.delete(`/auth/users/${userId}`),

    resetUserPassword: (userId, newPassword) =>
      this.put(`/auth/users/${userId}/reset-password`, { newPassword }),

    setUserActiveStatus: (userId, isActive) =>
      this.put(`/auth/users/${userId}/activate`, { isActive }),
  };

  // Work Sessions API
  sessions = {
    list: () =>
      this.get('/sessions'),

    create: (data) =>
      this.post('/sessions', data),

    get: (id) =>
      this.get(`/sessions/${id}`),

    update: (id, data) =>
      this.put(`/sessions/${id}`, data),

    delete: (id) =>
      this.delete(`/sessions/${id}`),

    assignAgents: (sessionId, agentIds) =>
      this.post(`/sessions/${sessionId}/agents`, { agentIds }),

    removeAgent: (sessionId, agentId) =>
      this.delete(`/sessions/${sessionId}/agents/${agentId}`),

    assignDocuments: (sessionId, documentIds) =>
      this.post(`/sessions/${sessionId}/documents`, { documentIds }),

    removeDocument: (sessionId, documentId) =>
      this.delete(`/sessions/${sessionId}/documents/${documentId}`),

    setDocumentAgentAssignments: (sessionId, assignments, orchestratorDocumentIds = null) =>
      this.post(`/sessions/${sessionId}/document-assignments`, {
        assignments,
        ...(Array.isArray(orchestratorDocumentIds) && orchestratorDocumentIds.length >= 0 ? { orchestratorDocumentIds } : {}),
      }),

    setToolAgentAssignments: (sessionId, assignments) =>
      this.post(`/sessions/${sessionId}/tool-assignments`, { assignments }),

    getOrchestratorTools: (sessionId) =>
      this.get(`/sessions/${sessionId}/orchestrator-tools`),

    setOrchestratorTools: (sessionId, assignments) =>
      this.post(`/sessions/${sessionId}/orchestrator-tools`, { assignments }),

    getScheduledJobs: (sessionId = null) =>
      sessionId != null ? this.get(`/sessions/scheduled-jobs?sessionId=${sessionId}`) : this.get('/sessions/scheduled-jobs'),

    getMessages: (sessionId, limit = 50, offset = 0) =>
      this.get(`/sessions/${sessionId}/messages?limit=${limit}&offset=${offset}`),

    export: (sessionId, includeMessages = false) =>
      this.post(`/sessions/${sessionId}/export`, { includeMessages }),

    import: (data, name = null) => {
      const payload = { data };
      if (name && name.trim()) {
        payload.name = name.trim();
      }
      return this.post('/sessions/import', payload);
    },

    clearMessages: (sessionId) =>
      this.delete(`/sessions/${sessionId}/messages`),

    duplicate: (sessionId) =>
      this.post(`/sessions/${sessionId}/duplicate`),

    pin: (sessionId) =>
      this.post(`/sessions/${sessionId}/pin`),

    generateShareLink: (sessionId, baseUrl = '') =>
      this.post(`/sessions/${sessionId}/share-link`, { baseUrl }),

    getDefaultPrompt: (sessionId) =>
      this.get(`/sessions/${sessionId}/default-prompt`),

    testOllama: (sessionId, baseURL = null) =>
      this.post(`/sessions/${sessionId}/test-ollama`, baseURL ? { baseURL } : {}),

    getDocumentsSection: (sessionId) =>
      this.get(`/sessions/${sessionId}/documents-section`),

    getAgentDocumentsSection: (sessionId, agentId) =>
      this.get(`/sessions/${sessionId}/agents/${agentId}/documents-section`),

    getAgentContext: (sessionId, agentId) =>
      this.get(`/sessions/${sessionId}/agents/${agentId}/context`),

    setAgentContext: (sessionId, agentId, context) =>
      this.put(`/sessions/${sessionId}/agents/${agentId}/context`, { context }),

    getAgentDefaultPrompt: (sessionId, agentId) =>
      this.get(`/sessions/${sessionId}/agents/${agentId}/default-prompt`),

    getContextTokenEstimates: (sessionId) =>
      this.get(`/sessions/${sessionId}/context-token-estimates`),

    getPoolDump: (sessionId) =>
      this.get(`/sessions/${sessionId}/pool-dump`),
  };

  // Chat API
  chat = {
    sendMessage: (sessionId, message, attachedDocumentsInfo = null) =>
      this.post(`/chat/${sessionId}`, {
        message,
        ...(attachedDocumentsInfo && { attachedDocumentsInfo }),
      }),

    /**
     * Stream a message response using Server-Sent Events
     * @param {number} sessionId - Session ID
     * @param {string} message - User message
     * @param {object} callbacks - Event callbacks
     * @param {function} callbacks.onChunk - Called for each content chunk
     * @param {function} callbacks.onDone - Called when stream completes
     * @param {function} callbacks.onError - Called on error
     * @returns {function} - Abort function to cancel the stream
     */
    streamMessage: (sessionId, message, callbacks = {}, attachedDocumentsInfo = null) => {
      const { onChunk, onDone, onError } = callbacks;
      const controller = new AbortController();

      // Use fetch with POST for SSE (not standard EventSource which only supports GET)
      const token = api.getToken();
      const body = { message };
      if (attachedDocumentsInfo) body.attachedDocumentsInfo = attachedDocumentsInfo;

      fetch(`${api.baseURL}/chat/${sessionId}/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            let parsed = null;
            try {
              parsed = await response.json();
            } catch {
              parsed = null;
            }
            const baseMsg = parsed?.error?.message || 'Stream request failed';
            const details = parsed?.error?.details;
            const detailMsg = Array.isArray(details) && details.length > 0
              ? details
                .map(d => (d?.field && d?.message) ? `${d.field}: ${d.message}` : (d?.message || String(d)))
                .join(', ')
              : '';
            throw new Error(detailMsg ? `${baseMsg} (${detailMsg})` : baseMsg);
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;

                try {
                  const parsed = JSON.parse(data);
                  if (parsed.type === 'chunk' && onChunk) {
                    onChunk(parsed.content);
                  } else if (parsed.type === 'done' && onDone) {
                    onDone(parsed);
                  } else if (parsed.type === 'error' && onError) {
                    onError(new Error(parsed.message));
                  }
                } catch (e) {
                  console.error('Error parsing SSE data:', e);
                }
              }
            }
          }
        })
        .catch((error) => {
          if (error.name !== 'AbortError' && onError) {
            onError(error);
          }
        });

      // Return abort function
      return () => controller.abort();
    },

    getHistory: (sessionId, limit = 50, offset = 0) =>
      this.get(`/chat/${sessionId}/history?limit=${limit}&offset=${offset}`),

    getStatistics: (sessionId) =>
      this.get(`/chat/${sessionId}/statistics`),

    deleteMessage: (sessionId, messageId) =>
      this.delete(`/chat/${sessionId}/messages/${messageId}`),

    clearHistory: (sessionId) =>
      this.post(`/chat/${sessionId}/clear`),

    /**
     * Check if there's an active streaming session
     * @param {number} sessionId - Session ID
     * @returns {Promise<object>} - Streaming state
     */
    getStreamStatus: (sessionId) =>
      this.get(`/chat/${sessionId}/stream/status`),

    /**
     * Reconnect to an active streaming session (SSE)
     * @param {number} sessionId - Session ID
     * @param {object} callbacks - Event callbacks
     * @returns {function} - Abort function
     */
    reconnectStream: (sessionId, callbacks = {}) => {
      const { onReconnected, onChunk, onDone, onError, onNotFound } = callbacks;
      const controller = new AbortController();
      const token = api.getToken();

      // Use EventSource-like fetch for GET SSE
      fetch(`${api.baseURL}/chat/${sessionId}/stream/reconnect`, {
        method: 'GET',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        },
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error('Failed to reconnect to stream');
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = '';

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') continue;

                try {
                  const parsed = JSON.parse(data);
                  if (parsed.type === 'reconnected' && onReconnected) {
                    onReconnected(parsed.content);
                  } else if (parsed.type === 'chunk' && onChunk) {
                    onChunk(parsed.content);
                  } else if (parsed.type === 'done' && onDone) {
                    onDone(parsed);
                  } else if (parsed.type === 'not_found' && onNotFound) {
                    onNotFound();
                  } else if (parsed.type === 'error' && onError) {
                    onError(new Error(parsed.message));
                  }
                } catch (e) {
                  console.error('Error parsing SSE data:', e);
                }
              }
            }
          }
        })
        .catch((error) => {
          if (error.name !== 'AbortError' && onError) {
            onError(error);
          }
        });

      return () => controller.abort();
    },
  };

  // Agents API
  agents = {
    list: (options = {}) => {
      const params = new URLSearchParams();
      if (options.role) params.append('role', options.role);
      if (options.active !== undefined) params.append('active', options.active);
      if (options.orderBy) params.append('orderBy', options.orderBy);
      if (options.order) params.append('order', options.order);
      const query = params.toString();
      return this.get(`/agents${query ? `?${query}` : ''}`);
    },

    create: (data) =>
      this.post('/agents', data),

    get: (id) =>
      this.get(`/agents/${id}`),

    getSessions: (id) =>
      this.get(`/agents/${id}/sessions`),

    update: (id, data) =>
      this.put(`/agents/${id}`, data),

    delete: (id, hard = false) =>
      this.delete(`/agents/${id}${hard ? '?hard=true' : ''}`),

    getRoles: () =>
      this.get('/agents/roles'),

    getProviders: () =>
      this.get('/agents/providers'),

    test: (id) =>
      this.post(`/agents/${id}/test`),

    testProvider: (providerType, providerConfig) =>
      this.post('/agents/test-provider', { provider_type: providerType, provider_config: providerConfig }),

    duplicate: (id, name = null) =>
      this.post(`/agents/${id}/duplicate`, name ? { name } : {}),

    activate: (id) =>
      this.post(`/agents/${id}/activate`),

    export: (id, includeApiKey = false) =>
      this.get(`/agents/${id}/export?includeApiKey=${includeApiKey}`),

    getDefaultPrompt: (role = 'custom') =>
      this.get(`/agents/default-prompt?role=${encodeURIComponent(role)}`),

    fetchHuggingFaceModel: (repoId) =>
      this.get(`/agents/huggingface/model?repo_id=${encodeURIComponent(repoId)}`),

    fetchOpenRouterModel: (modelId) =>
      this.get(`/agents/openrouter/model?model_id=${encodeURIComponent(modelId)}`),
  };

  // Documents API
  documents = {
    list: (options = {}) => {
      const params = new URLSearchParams();
      if (options.fileType) params.append('fileType', options.fileType);
      if (options.orderBy) params.append('orderBy', options.orderBy);
      if (options.order) params.append('order', options.order);
      if (options.limit) params.append('limit', options.limit);
      if (options.offset) params.append('offset', options.offset);
      const query = params.toString();
      return this.get(`/documents${query ? `?${query}` : ''}`);
    },

    upload: async (file, generateEmbeddings = true) => {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('generateEmbeddings', generateEmbeddings.toString());

      const token = this.getToken();

      const response = await fetch(`${this.baseURL}/documents`, {
        method: 'POST',
        headers: {
          'Authorization': token ? `Bearer ${token}` : '',
        },
        body: formData,
      });

      return response.json();
    },

    get: (id) =>
      this.get(`/documents/${id}`),

    delete: (id) =>
      this.delete(`/documents/${id}`),

    reprocess: (id) =>
      this.post(`/documents/${id}/reprocess`),

    getStats: () =>
      this.get('/documents/stats'),

    getSupportedTypes: () =>
      this.get('/documents/supported-types'),

    search: (query, topK = 5, documentIds = null) =>
      this.post('/documents/search', { query, topK, documentIds }),

    download: (id) =>
      `${this.baseURL}/documents/${id}/download`,
  };

  // Tasks API
  tasks = {
    list: (options = {}) => {
      const params = new URLSearchParams();
      if (options.sessionId) params.append('session_id', options.sessionId);
      if (options.status) params.append('status', options.status);
      if (options.limit) params.append('limit', options.limit);
      if (options.offset) params.append('offset', options.offset);
      const query = params.toString();
      return this.get(`/tasks${query ? `?${query}` : ''}`);
    },

    getStats: () =>
      this.get('/tasks/stats'),

    create: (data) =>
      this.post('/tasks', data),

    get: (id) =>
      this.get(`/tasks/${id}`),

    getResults: (id) =>
      this.get(`/tasks/${id}/results`),

    getOutput: (id) =>
      this.get(`/tasks/${id}/output`),

    update: (id, data) =>
      this.put(`/tasks/${id}`, data),

    retry: (id) =>
      this.post(`/tasks/${id}/retry`),

    cancel: (id) =>
      this.post(`/tasks/${id}/cancel`),

    run: (id) =>
      this.post(`/tasks/${id}/run`),

    delete: (id) =>
      this.delete(`/tasks/${id}`),
  };

  // Tools API
  tools = {
    list: (options = {}) => {
      const params = new URLSearchParams();
      if (options.category) params.append('category', options.category);
      if (options.format) params.append('format', options.format);
      const query = params.toString();
      return this.get(`/tools${query ? `?${query}` : ''}`);
    },

    getCategories: () =>
      this.get('/tools/categories'),

    search: (query) =>
      this.get(`/tools/search?q=${encodeURIComponent(query)}`),

    get: (name) =>
      this.get(`/tools/${name}`),

    execute: (name, parameters = {}, sessionId = null) =>
      this.post(`/tools/${name}/execute`, { parameters, sessionId }),

    executeSequence: (toolCalls, sessionId = null) =>
      this.post('/tools/execute-sequence', { toolCalls, sessionId }),

    executeParallel: (toolCalls, sessionId = null) =>
      this.post('/tools/execute-parallel', { toolCalls, sessionId }),

    getExecutionStats: () =>
      this.get('/tools/stats/executions'),
  };

  // Artifacts API
  artifacts = {
    create: (content) =>
      this.post('/artifacts', { content }),

    get: (id) =>
      this.get(`/artifacts/${id}`),

    delete: (id) =>
      this.delete(`/artifacts/${id}`),
  };
}

// Create global API client instance
const api = new APIClient();
