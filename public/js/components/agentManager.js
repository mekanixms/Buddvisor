/**
 * Agent Manager Component
 * Handles agent creation, editing, and management
 */

class AgentManager {
  constructor() {
    this.agents = [];
    this.roles = [];
    this.providers = [];
    this.selectedAgent = null;
    this.customModel = null; // Store custom model value for current modal
    /** @type {object|null} Parsed Hugging Face capability payload to save with the agent */
    this._pendingHfCapabilities = null;
    /** When true, next save clears hf_model_repo + model_capabilities in DB */
    this._clearHfMetadata = false;

    /** @type {object|null} Parsed OpenRouter capability payload to save with the agent */
    this._pendingOpenRouterCapabilities = null;
    /** When true, next save clears openrouter_model_id (and metadata) in DB */
    this._clearOpenRouterMetadata = false;
  }

  /**
   * Initialize the agent manager
   */
  async init() {
    try {
      // Load roles and providers in parallel
      const [rolesResponse, providersResponse] = await Promise.all([
        api.agents.getRoles(),
        api.agents.getProviders(),
      ]);

      this.roles = rolesResponse.data.roles;
      this.providers = providersResponse.data.providers;

      await this.loadAgents();
    } catch (error) {
      console.error('Error initializing agent manager:', error);
      showToast('Failed to initialize agent manager', 'danger');
    }
  }

  /**
   * Load all agents for the current user
   */
  async loadAgents() {
    try {
      const response = await api.agents.list({ active: true });
      this.agents = response.data.agents;
      this.renderAgentsList();
      return this.agents;
    } catch (error) {
      console.error('Error loading agents:', error);
      showToast('Failed to load agents', 'danger');
      return [];
    }
  }

  /**
   * Render agents list
   */
  renderAgentsList() {
    const agentsList = document.getElementById('agents-list');
    if (!agentsList) return;

    if (this.agents.length === 0) {
      agentsList.innerHTML = `
        <div class="text-center p-4 text-muted">
          <i class="bi bi-robot" style="font-size: 2rem;"></i>
          <p class="mt-2 mb-0">No agents yet</p>
          <p class="small">Create your first agent to get started</p>
          <button class="btn btn-primary btn-sm mt-2" data-action="show-create-modal">
            <i class="bi bi-plus-lg"></i> Create Agent
          </button>
        </div>
      `;
      return;
    }

    agentsList.innerHTML = this.agents.map(agent => `
      <div class="card mb-2 agent-card ${agent.id === this.selectedAgent?.id ? 'border-primary' : ''}"
           data-action="select-agent" data-agent-id="${agent.id}" style="cursor: pointer;">
        <div class="card-body p-2">
          <div class="d-flex justify-content-between align-items-start">
            <div class="flex-grow-1">
              <h6 class="mb-1">
                <i class="bi bi-robot me-1 text-${this.getRoleColor(agent.role)}"></i>
                ${escapeHtml(agent.name)}
              </h6>
              <small class="text-muted">
                ${this.getRoleDisplayName(agent.role)} • ${agent.provider_type}
              </small>
            </div>
            <div class="dropdown">
              <button class="btn btn-sm btn-link text-muted" type="button"
                      data-bs-toggle="dropdown" data-action="stop-propagation">
                <i class="bi bi-three-dots-vertical"></i>
              </button>
              <ul class="dropdown-menu dropdown-menu-end">
                <li><a class="dropdown-item" href="#" data-action="edit-agent" data-agent-id="${agent.id}">
                  <i class="bi bi-pencil me-2"></i>Edit
                </a></li>
                <li><a class="dropdown-item" href="#" data-action="test-agent" data-agent-id="${agent.id}">
                  <i class="bi bi-lightning me-2"></i>Test Connection
                </a></li>
                <li><a class="dropdown-item" href="#" data-action="duplicate-agent" data-agent-id="${agent.id}">
                  <i class="bi bi-copy me-2"></i>Duplicate
                </a></li>
                <li><a class="dropdown-item" href="#" data-action="export-agent" data-agent-id="${agent.id}">
                  <i class="bi bi-download me-2"></i>Export
                </a></li>
                <li><hr class="dropdown-divider"></li>
                <li><a class="dropdown-item text-danger" href="#" data-action="delete-agent" data-agent-id="${agent.id}">
                  <i class="bi bi-trash me-2"></i>Delete
                </a></li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    `).join('');
  }

  /**
   * Get role display name
   */
  getRoleDisplayName(roleId) {
    const role = this.roles.find(r => r.id === roleId);
    return role ? role.name : roleId.charAt(0).toUpperCase() + roleId.slice(1);
  }

  /**
   * Get color for role
   */
  getRoleColor(roleId) {
    const colors = {
      legal: 'primary',
      accounting: 'success',
      marketing: 'info',
      sales: 'warning',
      logistics: 'secondary',
      production: 'dark',
      hr: 'danger',
      custom: 'muted',
    };
    return colors[roleId] || 'muted';
  }

  /**
   * Select an agent
   */
  selectAgent(agentId) {
    this.selectedAgent = this.agents.find(a => a.id === agentId);
    this.renderAgentsList();
    this.showAgentDetails();
  }

  /**
   * Show agent details panel
   */
  showAgentDetails() {
    const detailsPanel = document.getElementById('agent-details');
    if (!detailsPanel || !this.selectedAgent) return;

    const agent = this.selectedAgent;

    detailsPanel.innerHTML = `
      <div class="card">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">
            <i class="bi bi-robot me-2"></i>${escapeHtml(agent.name)}
          </h6>
          <span class="badge bg-${agent.is_active ? 'success' : 'secondary'}">
            ${agent.is_active ? 'Active' : 'Inactive'}
          </span>
        </div>
        <div class="card-body">
          <dl class="row mb-0">
            <dt class="col-sm-4">Role</dt>
            <dd class="col-sm-8">${this.getRoleDisplayName(agent.role)}</dd>

            <dt class="col-sm-4">Provider</dt>
            <dd class="col-sm-8">${agent.provider_type}</dd>

            <dt class="col-sm-4">Model</dt>
            <dd class="col-sm-8">${agent.provider_config?.model || 'Default'}</dd>

            <dt class="col-sm-4">API Key</dt>
            <dd class="col-sm-8">
              ${agent.provider_config?.hasApiKey ? '<i class="bi bi-check-circle text-success"></i> Configured' : '<i class="bi bi-x-circle text-danger"></i> Not set'}
            </dd>
          </dl>
        </div>
        <div class="card-footer">
          <button class="btn btn-sm btn-primary" data-action="edit-agent" data-agent-id="${agent.id}">
            <i class="bi bi-pencil me-1"></i>Edit
          </button>
          <button class="btn btn-sm btn-outline-secondary" data-action="test-agent" data-agent-id="${agent.id}">
            <i class="bi bi-lightning me-1"></i>Test
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Show create agent modal
   */
  showCreateModal() {
    this.showAgentModal(null);
  }

  /**
   * Show edit agent modal
   */
  async showEditModal(agentId) {
    try {
      const response = await api.agents.get(agentId);
      this.showAgentModal(response.data.agent);
    } catch (error) {
      console.error('Error loading agent:', error);
      showToast('Failed to load agent details', 'danger');
    }
  }

  /**
   * Show agent modal (create or edit)
   */
  showAgentModal(agent = null) {
    const isEdit = !!agent;
    const modalTitle = isEdit ? 'Edit Agent' : 'Create New Agent';

    this._clearHfMetadata = false;
    this._pendingHfCapabilities =
      agent?.model_capabilities && typeof agent.model_capabilities === 'object'
        ? { ...agent.model_capabilities }
        : null;

    this._clearOpenRouterMetadata = false;
    this._pendingOpenRouterCapabilities =
      agent?.model_capabilities && typeof agent.model_capabilities === 'object'
        ? { ...agent.model_capabilities }
        : null;

    // Reset custom model (getModelOptions will set it if agent has custom model)
    this.customModel = null;

    const modalHtml = `
      <div class="modal fade" id="agentModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">${modalTitle}</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <form id="agent-form">
                <input type="hidden" id="agent-id" value="${agent?.id || ''}">

                <div class="row mb-3">
                  <div class="col-md-6">
                    <label class="form-label">Agent Name *</label>
                    <input type="text" class="form-control" id="agent-name"
                           value="${escapeHtml(agent?.name || '')}" required maxlength="100">
                  </div>
                  <div class="col-md-6">
                    <label class="form-label">Role *</label>
                    <select class="form-select" id="agent-role" required>
                      ${this.roles.map(role => `
                        <option value="${role.id}" ${agent?.role === role.id ? 'selected' : ''}>
                          ${role.name}
                        </option>
                      `).join('')}
                    </select>
                  </div>
                </div>

                <div class="alert alert-info small py-2 mb-3">
                  <div class="mb-2">
                    <i class="bi bi-info-circle me-1"></i>
                    Agent context (instructions, team info, tools, documents) is configured per-session in <strong>Configure Session → Agents</strong> tab.
                  </div>
                  <div class="border-top border-info-subtle pt-2 mt-2" id="agent-capabilities-alert-body"></div>
                </div>

                <hr>
                <h6>LLM Provider Configuration</h6>

                <div class="row mb-3">
                  <div class="col-md-6">
                    <label class="form-label">Provider *</label>
                    <select class="form-select" id="agent-provider" required data-action="provider-change">
                      ${this.providers.map(provider => `
                        <option value="${provider.type}" ${agent?.provider_type === provider.type ? 'selected' : ''}>
                          ${provider.type.charAt(0).toUpperCase() + provider.type.slice(1)}
                          ${provider.requiresApiKey ? '' : '(Local)'}
                        </option>
                      `).join('')}
                    </select>
                  </div>
                  <div class="col-md-6">
                    <label class="form-label">Model</label>
                    <select class="form-select" id="agent-model" data-action="model-change">
                      ${this.getModelOptions(agent?.provider_type || this.providers[0]?.type, agent?.provider_config?.model)}
                    </select>
                    <div id="custom-model-display" class="form-text text-info d-none">
                      <i class="bi bi-pencil"></i> Custom: <span id="custom-model-value"></span>
                    </div>
                  </div>
                </div>

                <div class="mb-3" id="api-key-group">
                  <label class="form-label">API Key ${isEdit ? '' : '*'}</label>
                  <div class="input-group">
                    <input type="password" class="form-control" id="agent-api-key"
                           placeholder="${isEdit ? 'Leave blank to keep existing key' : 'Enter API key'}">
                    <button class="btn btn-outline-secondary" type="button" data-action="toggle-api-key">
                      <i class="bi bi-eye" id="api-key-toggle-icon"></i>
                    </button>
                  </div>
                  ${isEdit && agent?.provider_config?.hasApiKey ? '<div class="form-text text-success"><i class="bi bi-check-circle"></i> API key is currently configured</div>' : ''}
                </div>

                <!-- Ollama Configuration (only visible when Ollama is selected) -->
                <div id="agent-ollama-config" class="row mb-3 d-none">
                  <div class="col-md-6">
                    <label class="form-label">Ollama Address</label>
                    <input type="text" class="form-control" id="agent-ollama-address" 
                           placeholder="localhost" value="${this.getOllamaAddress(agent?.provider_config)}">
                    <div class="form-text">Ollama server address (default from .env)</div>
                  </div>
                  <div class="col-md-6">
                    <label class="form-label">Ollama Port</label>
                    <input type="number" class="form-control" id="agent-ollama-port" 
                           placeholder="11434" min="1" max="65535" value="${this.getOllamaPort(agent?.provider_config)}">
                    <div class="form-text">Ollama server port (default from .env)</div>
                  </div>
                </div>

                <div class="row mb-3">
                  <div class="col-md-6">
                    <label class="form-label">Max Tokens</label>
                    <input type="number" class="form-control" id="agent-max-tokens"
                           value="${agent?.provider_config?.maxTokens || 4096}" min="1" max="128000">
                  </div>
                  <div class="col-md-6">
                    <label class="form-label">Temperature</label>
                    <input type="number" class="form-control" id="agent-temperature"
                           value="${agent?.provider_config?.temperature ?? 0.7}" min="0" max="2" step="0.1">
                  </div>
                </div>

                <div class="row mb-3">
                  <div class="col-md-6">
                    <label class="form-label">Timeout (ms)</label>
                    <input type="number" class="form-control" id="agent-timeout"
                           value="${agent?.provider_config?.timeout || 60000}" min="1000" max="600000" step="1000">
                    <div class="form-text">Request timeout in milliseconds (default: 60000 = 60 seconds)</div>
                  </div>
                </div>

                <div class="mb-3">
                  <div class="form-check form-switch">
                    <input class="form-check-input" type="checkbox" id="agent-enable-prompt-cache"
                           ${agent?.provider_config?.enablePromptCache ? 'checked' : ''}>
                    <label class="form-check-label" for="agent-enable-prompt-cache">
                      Enable prompt caching (use if your model supports it)
                    </label>
                  </div>
                  <div class="form-text text-muted">Reduces cost per million tokens when the model caches repeated context. Disable if you see API errors.</div>
                </div>

                <div class="mb-3 p-2 rounded border bg-light">
                  <label class="form-label mb-1">Hugging Face model (optional)</label>
                  <div class="input-group input-group-sm mb-1">
                    <input type="text" class="form-control" id="agent-hf-repo"
                      placeholder="org/model or paste a model page URL"
                      value="${escapeHtml(agent?.hf_model_repo || '')}"
                      autocomplete="off">
                    <button type="button" class="btn btn-outline-primary" data-action="fetch-hf-model" title="Load metadata from Hugging Face Hub API">
                      Fetch
                    </button>
                    <button type="button" class="btn btn-outline-secondary" data-action="clear-hf-model" title="Clear saved HF metadata">
                      Clear
                    </button>
                  </div>
                  <div class="form-text text-muted mb-1">
                    Uses the public Hub API (<code>/api/models/&lt;repo&gt;</code>). Set <code>HUGGINGFACE_API_KEY</code> on the server for private or gated models. Capabilities appear in the info box above after <strong>Fetch</strong>.
                  </div>
                </div>

                <div class="mb-3 p-2 rounded border bg-light">
                  <label class="form-label mb-1">OpenRouter model (optional)</label>
                  <div class="input-group input-group-sm mb-1">
                    <input type="text" class="form-control" id="agent-openrouter-model"
                      placeholder="author/slug (e.g. google/gemini-2.5-pro)"
                      value="${escapeHtml(agent?.openrouter_model_id || '')}"
                      autocomplete="off">
                    <button type="button" class="btn btn-outline-primary" data-action="fetch-openrouter-model" title="Load metadata from OpenRouter model catalog">
                      Fetch
                    </button>
                    <button type="button" class="btn btn-outline-secondary" data-action="clear-openrouter-model" title="Clear saved OpenRouter metadata">
                      Clear
                    </button>
                  </div>
                  <div class="form-text text-muted mb-1">
                    Uses OpenRouter’s public model catalog (<code>/api/v1/models</code>). Set <code>OPENROUTER_API_KEY</code> on the server if needed.
                  </div>
                </div>

                <div class="mb-3">
                  <button type="button" class="btn btn-outline-secondary btn-sm" data-action="test-provider">
                    <i class="bi bi-lightning me-1"></i>Test Provider Connection
                  </button>
                  <span id="provider-test-result" class="ms-2"></span>
                </div>
              </form>
              ${isEdit ? `
                <div id="agent-sessions-list" class="mt-3 pt-3 border-top">
                  <div class="text-muted" style="font-size: 0.75rem;">
                    <i class="bi bi-folder me-1"></i>Assigned to sessions:
                    <span id="agent-sessions-content" class="ms-1">Loading...</span>
                  </div>
                </div>
              ` : ''}
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-action="save-agent">
                ${isEdit ? 'Save Changes' : 'Create Agent'}
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById('agentModal');
    if (existingModal) {
      existingModal.remove();
    }

    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('agentModal'));
    modal.show();

    // Update API key visibility based on provider (isInitialLoad=true to preserve custom model)
    this.onProviderChange(true);

    // Update custom model display (in case editing agent with custom model)
    this.updateCustomModelDisplay();

    this.refreshCapabilitiesAlert();

    // Load assigned sessions if editing
    if (isEdit && agent?.id) {
      this.loadAgentSessions(agent.id);
    }

  }

  /**
   * Current model id from the agent modal (preset or custom).
   * @returns {string}
   */
  getCurrentModalModel() {
    const modelSelect = document.getElementById('agent-model');
    const v = modelSelect?.value;
    return this.customModel || (v && v !== '__custom__' ? v : '') || '';
  }

  /**
   * Best-effort capability flags from provider + model id (matches server heuristics).
   */
  getInferredCapabilitiesClient(providerType, modelId) {
    const t = String(providerType || '').toLowerCase();
    const m = String(modelId || '').toLowerCase();
    let vision = false;
    if (t === 'openai') vision = m.includes('4o') || m.includes('vision');
    else if (t === 'xai') vision = m.includes('vision');
    else if (t === 'gemini') vision = true;
    else if (t === 'claude') vision = true;
    else if (t === 'ollama') {
      vision =
        m.includes('vl') ||
        m.includes('vision') ||
        m.includes('llava') ||
        m.includes('moondream');
    } else if (t === 'kimi') vision = m.includes('k2');
    return {
      text: true,
      vision,
      audio: false,
      video: false,
      thinking: false,
      prompt_caching_hint: false,
    };
  }

  /**
   * Merge saved HF capabilities (if any) with client-side provider/model heuristics.
   */
  mergeCapabilitiesForDisplay(storedHf, providerType, modelId) {
    const inferred = this.getInferredCapabilitiesClient(providerType, modelId);
    if (!storedHf || typeof storedHf !== 'object') {
      return { merged: { ...inferred }, hfMeta: null };
    }
    return {
      merged: {
        text: typeof storedHf.text === 'boolean' ? storedHf.text : inferred.text,
        vision: typeof storedHf.vision === 'boolean' ? storedHf.vision : inferred.vision,
        audio: typeof storedHf.audio === 'boolean' ? storedHf.audio : inferred.audio,
        video: typeof storedHf.video === 'boolean' ? storedHf.video : inferred.video,
        thinking: typeof storedHf.thinking === 'boolean' ? storedHf.thinking : inferred.thinking,
        prompt_caching_hint:
          typeof storedHf.prompt_caching_hint === 'boolean'
            ? storedHf.prompt_caching_hint
            : inferred.prompt_caching_hint,
      },
      hfMeta: {
        repo_id: storedHf.repo_id,
        pipeline_tag: storedHf.pipeline_tag,
        library_name: storedHf.library_name,
        fetched_at: storedHf.fetched_at,
        source: storedHf.source,
        runtime_hints: storedHf.hf_runtime_hints || null,
      },
    };
  }

  _combineCapabilitiesForSave(hfCaps, orCaps) {
    const a = hfCaps && typeof hfCaps === 'object' ? hfCaps : null;
    const b = orCaps && typeof orCaps === 'object' ? orCaps : null;
    if (!a && !b) return null;
    if (a && !b) return { ...a };
    if (b && !a) return { ...b };

    const merged = { ...a, ...b };
    for (const k of ['text', 'vision', 'audio', 'video', 'thinking', 'prompt_caching_hint']) {
      merged[k] = !!(a?.[k] || b?.[k]);
    }
    merged.source = 'merged';
    merged.fetched_at = new Date().toISOString();
    return merged;
  }

  /**
   * Render merged capabilities inside the alert-info box (#agent-capabilities-alert-body).
   */
  refreshCapabilitiesAlert() {
    const body = document.getElementById('agent-capabilities-alert-body');
    if (!body) return;

    const provider = document.getElementById('agent-provider')?.value || '';
    const model = this.getCurrentModalModel();
    const hf = this._clearHfMetadata ? null : this._pendingHfCapabilities;
    const orCaps = this._clearOpenRouterMetadata ? null : this._pendingOpenRouterCapabilities;
    const primaryCaps = orCaps || hf;
    const { merged, hfMeta } = this.mergeCapabilitiesForDisplay(primaryCaps, provider, model);

    const cacheEl = document.getElementById('agent-enable-prompt-cache');
    const cacheOn = cacheEl?.checked;
    const displayMerged = {
      ...merged,
      prompt_caching_hint: !!cacheOn || !!merged.prompt_caching_hint,
    };

    const flagKeys = ['text', 'vision', 'audio', 'video', 'thinking', 'prompt_caching_hint'];
    const badges = flagKeys
      .filter((k) => displayMerged[k])
      .map((k) => {
        const label = k === 'prompt_caching_hint' ? 'prompt cache' : k;
        return `<span class="badge bg-primary me-1 mb-1">${escapeHtml(label)}</span>`;
      })
      .join('');

    let hfBlock = '';
    if (hfMeta && (hfMeta.repo_id || hfMeta.pipeline_tag || hfMeta.library_name)) {
      const hints = hfMeta.runtime_hints;
      let hintsHtml = '';
      if (hints && typeof hints === 'object') {
        const rows = [];
        if (hints.context_length != null) {
          rows.push(
            `<tr><td class="text-muted pe-2">Context length</td><td>${escapeHtml(String(hints.context_length))}${hints.context_source ? ` <span class="text-muted">(${escapeHtml(hints.context_source)})</span>` : ''}</td></tr>`
          );
        }
        if (hints.max_new_tokens != null) {
          rows.push(`<tr><td class="text-muted pe-2">max_new_tokens</td><td>${escapeHtml(String(hints.max_new_tokens))}</td></tr>`);
        }
        if (hints.max_length != null) {
          rows.push(`<tr><td class="text-muted pe-2">max_length</td><td>${escapeHtml(String(hints.max_length))}</td></tr>`);
        }
        if (hints.temperature != null) {
          rows.push(`<tr><td class="text-muted pe-2">temperature</td><td>${escapeHtml(String(hints.temperature))}</td></tr>`);
        }
        if (hints.top_p != null) {
          rows.push(`<tr><td class="text-muted pe-2">top_p</td><td>${escapeHtml(String(hints.top_p))}</td></tr>`);
        }
        if (hints.top_k != null) {
          rows.push(`<tr><td class="text-muted pe-2">top_k</td><td>${escapeHtml(String(hints.top_k))}</td></tr>`);
        }
        if (hints.do_sample != null) {
          rows.push(`<tr><td class="text-muted pe-2">do_sample</td><td>${hints.do_sample ? 'true' : 'false'}</td></tr>`);
        }
        if (Array.isArray(hints.config_files_loaded) && hints.config_files_loaded.length) {
          rows.push(
            `<tr><td class="text-muted pe-2 align-top">Config files</td><td class="text-break">${escapeHtml(hints.config_files_loaded.join(', '))}</td></tr>`
          );
        }
        if (rows.length) {
          hintsHtml = `
            <div class="mt-2"><strong class="d-block mb-1">Hub config (reference)</strong>
            <table class="table table-sm table-borderless mb-0" style="font-size: 0.8rem;"><tbody>${rows.join('')}</tbody></table>
            <div class="text-muted" style="font-size: 0.7rem;">From public <code>config.json</code> / <code>generation_config.json</code> when present. Your provider may use different defaults.</div>
            </div>`;
        }
      }
      hfBlock = `
        <div class="small mt-2 pt-2 border-top border-info-subtle">
          <strong class="d-block mb-1">Hugging Face metadata</strong>
          ${hfMeta.repo_id ? `<div><span class="text-muted">Repo:</span> ${escapeHtml(hfMeta.repo_id)}</div>` : ''}
          ${hfMeta.pipeline_tag ? `<div><span class="text-muted">Pipeline:</span> ${escapeHtml(hfMeta.pipeline_tag)}</div>` : ''}
          ${hfMeta.library_name ? `<div><span class="text-muted">Library:</span> ${escapeHtml(hfMeta.library_name)}</div>` : ''}
          ${hfMeta.fetched_at ? `<div class="text-muted" style="font-size: 0.75rem;">Fetched: ${escapeHtml(hfMeta.fetched_at)}</div>` : ''}
          ${hintsHtml}
        </div>
      `;
    } else {
      hfBlock = `<div class="small text-muted mt-1 mb-0">No Hugging Face metadata yet. Enter a repo below and click <strong>Fetch</strong> to merge Hub tags into the flags above.</div>`;
    }

    let orBlock = '';
    if (primaryCaps && primaryCaps.openrouter_model_id) {
      const hints = primaryCaps.openrouter_runtime_hints;
      const modelId = primaryCaps.openrouter_model_id;
      const rows = [];
      if (hints && typeof hints === 'object') {
        if (hints.context_length != null) {
          rows.push(`<tr><td class="text-muted pe-2">Context length</td><td>${escapeHtml(String(hints.context_length))}</td></tr>`);
        }
        if (hints.default_parameters && typeof hints.default_parameters === 'object') {
          const dp = hints.default_parameters;
          for (const k of ['temperature', 'top_p', 'top_k', 'max_tokens', 'max_output_tokens']) {
            if (dp[k] != null) {
              rows.push(`<tr><td class="text-muted pe-2">${escapeHtml(k)}</td><td>${escapeHtml(String(dp[k]))}</td></tr>`);
            }
          }
        }
        if (Array.isArray(hints.output_modalities) && hints.output_modalities.length) {
          rows.push(`<tr><td class="text-muted pe-2">Modalities</td><td>${escapeHtml(hints.output_modalities.join(', '))}</td></tr>`);
        }
      }
      orBlock = `
        <div class="small mt-2 pt-2 border-top border-info-subtle">
          <strong class="d-block mb-1">OpenRouter metadata</strong>
          <div><span class="text-muted">Model:</span> ${escapeHtml(String(modelId))}</div>
          ${rows.length ? `<table class="table table-sm table-borderless mb-0" style="font-size: 0.8rem;"><tbody>${rows.join('')}</tbody></table>` : ''}
          <div class="text-muted" style="font-size: 0.7rem;">Defaults are “recommended” parameters published by OpenRouter when available.</div>
        </div>
      `;
    } else {
      orBlock = `<div class="small text-muted mt-1 mb-0">No OpenRouter metadata yet. Enter a model id below and click <strong>Fetch</strong> to load catalog info.</div>`;
    }

    body.innerHTML = `
      <div class="fw-semibold mb-1"><i class="bi bi-cpu me-1"></i>Model capabilities</div>
      <div>${badges || '<span class="text-muted">No flags active</span>'}</div>
      ${hfBlock}
      ${orBlock}
      <div class="small text-muted mt-1 mb-0">Flags combine saved HF data (when present) with best-effort guesses from provider and model id.</div>
    `;
  }

  async fetchHfModelFromModal() {
    const input = document.getElementById('agent-hf-repo');
    const repo = (input?.value || '').trim();
    if (!repo) {
      showToast('Enter a Hugging Face model id (org/model) or URL', 'warning');
      return;
    }
    try {
      showToast('Fetching from Hugging Face…', 'info');
      const res = await api.agents.fetchHuggingFaceModel(repo);
      const caps = res.data?.capabilities;
      if (!caps) throw new Error('Invalid response from server');
      this._pendingHfCapabilities = caps;
      this._clearHfMetadata = false;
      if (input && caps.repo_id) input.value = caps.repo_id;
      this.refreshCapabilitiesAlert();
      showToast('Hugging Face metadata loaded', 'success');
    } catch (e) {
      console.error(e);
      showToast(e.message || 'Failed to fetch from Hugging Face', 'danger');
    }
  }

  clearHfModelInModal() {
    const input = document.getElementById('agent-hf-repo');
    if (input) input.value = '';
    this._pendingHfCapabilities = null;
    this._clearHfMetadata = true;
    this.refreshCapabilitiesAlert();
  }

  async fetchOpenRouterModelFromModal() {
    const input = document.getElementById('agent-openrouter-model');
    const modelId = (input?.value || '').trim();
    if (!modelId) {
      showToast('Enter an OpenRouter model id (author/slug)', 'warning');
      return;
    }
    try {
      showToast('Fetching from OpenRouter…', 'info');
      const res = await api.agents.fetchOpenRouterModel(modelId);
      const caps = res.data?.capabilities;
      console.log('OpenRouter res.data', res.data);
      if (!caps) throw new Error('Invalid response from server');
      this._pendingOpenRouterCapabilities = caps;
      this._clearOpenRouterMetadata = false;
      if (input && caps.openrouter_model_id) input.value = caps.openrouter_model_id;
      this.refreshCapabilitiesAlert();
      showToast('OpenRouter metadata loaded', 'success');
    } catch (e) {
      console.error(e);
      showToast(e.message || 'Failed to fetch from OpenRouter', 'danger');
    }
  }

  clearOpenRouterModelInModal() {
    const input = document.getElementById('agent-openrouter-model');
    if (input) input.value = '';
    this._pendingOpenRouterCapabilities = null;
    this._clearOpenRouterMetadata = true;
    this.refreshCapabilitiesAlert();
  }

  /**
   * Get model options for a provider
   */
  getModelOptions(providerType, selectedModel = null) {
    const provider = this.providers.find(p => p.type === providerType);

    // Check if selected model is a custom one (not in available models)
    const isCustomModel = selectedModel && provider?.availableModels &&
      !provider.availableModels.some(m => m.id === selectedModel);

    // If it's a custom model, store it
    if (isCustomModel) {
      this.customModel = selectedModel;
    }

    if (!provider || !provider.availableModels) {
      return `
        <option value="">Default</option>
        <option value="__custom__" ${isCustomModel ? 'selected' : ''}>Custom...</option>
      `;
    }

    const modelOptions = provider.availableModels.map(model => `
      <option value="${model.id}" ${selectedModel === model.id ? 'selected' : ''}>
        ${model.name} - ${model.description}
      </option>
    `).join('');

    return modelOptions + `
      <option value="__custom__" ${isCustomModel ? 'selected' : ''}>Custom...</option>
    `;
  }

  /**
   * Handle provider change in modal
   * @param {boolean} isInitialLoad - True if called during modal open, false if user changed provider
   */
  onProviderChange(isInitialLoad = false) {
    const providerSelect = document.getElementById('agent-provider');
    const modelSelect = document.getElementById('agent-model');
    const apiKeyGroup = document.getElementById('api-key-group');

    if (!providerSelect || !modelSelect) return;

    const providerType = providerSelect.value;
    const provider = this.providers.find(p => p.type === providerType);

    // Only reset custom model if user changed provider (not on initial load)
    if (!isInitialLoad) {
      this.customModel = null;
      this.updateCustomModelDisplay();
      // Update model options only when provider changes
      modelSelect.innerHTML = this.getModelOptions(providerType);
    }

    // Show/hide API key based on provider
    if (provider && !provider.requiresApiKey) {
      apiKeyGroup.style.display = 'none';
    } else {
      apiKeyGroup.style.display = 'block';
    }
    
    // Show/hide Ollama config fields
    const ollamaConfig = document.getElementById('agent-ollama-config');
    if (ollamaConfig) {
      if (providerType === 'ollama') {
        ollamaConfig.classList.remove('d-none');
      } else {
        ollamaConfig.classList.add('d-none');
      }
    }

    this.refreshCapabilitiesAlert();
  }

  /**
   * Get Ollama address from config or default
   */
  getOllamaAddress(config) {
    if (!config) {
      const ollamaProvider = this.providers.find(p => p.type === 'ollama');
      const defaultURL = ollamaProvider?.defaultOllamaBaseURL || 'http://localhost:11434';
      try {
        const url = new URL(defaultURL);
        return url.hostname;
      } catch {
        return 'localhost';
      }
    }
    
    if (config.baseURL) {
      try {
        const url = new URL(config.baseURL);
        return url.hostname;
      } catch {
        return 'localhost';
      }
    }
    
    return 'localhost';
  }

  /**
   * Get Ollama port from config or default
   */
  getOllamaPort(config) {
    if (!config) {
      const ollamaProvider = this.providers.find(p => p.type === 'ollama');
      const defaultURL = ollamaProvider?.defaultOllamaBaseURL || 'http://localhost:11434';
      try {
        const url = new URL(defaultURL);
        return url.port || '11434';
      } catch {
        return '11434';
      }
    }
    
    if (config.baseURL) {
      try {
        const url = new URL(config.baseURL);
        return url.port || '11434';
      } catch {
        return '11434';
      }
    }
    
    return '11434';
  }

  /**
   * Handle model change in modal
   */
  onModelChange() {
    const modelSelect = document.getElementById('agent-model');
    if (!modelSelect) return;

    const selectedValue = modelSelect.value;

    if (selectedValue === '__custom__') {
      // Show custom model dialog
      this.showCustomModelDialog();
    } else {
      // Clear custom model if a preset is selected
      this.customModel = null;
      this.updateCustomModelDisplay();
      console.log('Selected model:', selectedValue);
    }

    this.refreshCapabilitiesAlert();
  }

  /**
   * Show dialog to enter custom model name
   */
  showCustomModelDialog() {
    const currentValue = this.customModel || '';
    const customValue = prompt('Enter custom model name (e.g., gpt-4-turbo-preview, claude-3-opus-20240229):', currentValue);

    const modelSelect = document.getElementById('agent-model');

    if (customValue && customValue.trim()) {
      this.customModel = customValue.trim();
      this.updateCustomModelDisplay();
      console.log('Selected model:', this.customModel, '(custom)');
    } else {
      // User cancelled or entered empty - revert to first option
      this.customModel = null;
      this.updateCustomModelDisplay();
      if (modelSelect && modelSelect.options.length > 0) {
        modelSelect.selectedIndex = 0;
        console.log('Selected model:', modelSelect.value, '(reverted to default)');
      }
    }
  }

  /**
   * Update the custom model display below the select
   */
  updateCustomModelDisplay() {
    const displayDiv = document.getElementById('custom-model-display');
    const valueSpan = document.getElementById('custom-model-value');

    if (!displayDiv || !valueSpan) return;

    if (this.customModel) {
      valueSpan.textContent = this.customModel;
      displayDiv.classList.remove('d-none');
    } else {
      displayDiv.classList.add('d-none');
    }

    this.refreshCapabilitiesAlert();
  }

  /**
   * Toggle API key visibility
   */
  toggleApiKeyVisibility() {
    const input = document.getElementById('agent-api-key');
    const icon = document.getElementById('api-key-toggle-icon');

    if (input.type === 'password') {
      input.type = 'text';
      icon.classList.replace('bi-eye', 'bi-eye-slash');
    } else {
      input.type = 'password';
      icon.classList.replace('bi-eye-slash', 'bi-eye');
    }
  }

  /**
   * Test provider connection from modal
   */
  async testProviderFromModal() {
    const providerType = document.getElementById('agent-provider').value;
    const apiKey = document.getElementById('agent-api-key').value;
    const resultSpan = document.getElementById('provider-test-result');

    const provider = this.providers.find(p => p.type === providerType);

    // For providers that need API key, validate it's provided
    if (provider?.requiresApiKey && !apiKey) {
      resultSpan.innerHTML = '<span class="text-danger"><i class="bi bi-x-circle"></i> API key required</span>';
      return;
    }

    resultSpan.innerHTML = '<span class="text-muted"><i class="bi bi-hourglass-split"></i> Testing...</span>';

    try {
      const config = {
        apiKey: apiKey || 'local',
        model: document.getElementById('agent-model').value,
      };

      const response = await api.agents.testProvider(providerType, config);

      if (response.data.success) {
        resultSpan.innerHTML = `<span class="text-success"><i class="bi bi-check-circle"></i> Connected (${response.data.latency}ms)</span>`;
      } else {
        resultSpan.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle"></i> ${response.data.message}</span>`;
      }
    } catch (error) {
      resultSpan.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle"></i> ${error.message}</span>`;
    }
  }

  /**
   * Save agent (create or update)
   */
  async saveAgent() {
    const form = document.getElementById('agent-form');
    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    const agentId = document.getElementById('agent-id').value;
    const isEdit = !!agentId;

    const providerType = document.getElementById('agent-provider').value;
    const apiKey = document.getElementById('agent-api-key').value;
    const provider = this.providers.find(p => p.type === providerType);

    // For new agents with providers that need API key, validate
    if (!isEdit && provider?.requiresApiKey && !apiKey) {
      showToast('API key is required for this provider', 'warning');
      return;
    }

    // Get model - use custom model if set, otherwise use select value
    const modelSelectValue = document.getElementById('agent-model').value;
    const modelValue = this.customModel || (modelSelectValue !== '__custom__' ? modelSelectValue : undefined);

    const agentData = {
      name: document.getElementById('agent-name').value,
      role: document.getElementById('agent-role').value,
      provider_type: providerType,
      provider_config: {
        model: modelValue || undefined,
        maxTokens: parseInt(document.getElementById('agent-max-tokens').value) || 4096,
        temperature: parseFloat(document.getElementById('agent-temperature').value) ?? 0.7,
        timeout: parseInt(document.getElementById('agent-timeout').value) || 60000,
        enablePromptCache: document.getElementById('agent-enable-prompt-cache')?.checked || false,
      },
    };

    // Only include API key if provided (for edit, if empty, it means keep existing)
    if (apiKey) {
      agentData.provider_config.apiKey = apiKey;
    }
    
    // Add Ollama baseURL if Ollama is selected
    if (providerType === 'ollama') {
      const ollamaAddressInput = document.getElementById('agent-ollama-address');
      const ollamaPortInput = document.getElementById('agent-ollama-port');
      const ollamaAddress = ollamaAddressInput?.value?.trim();
      const ollamaPort = ollamaPortInput?.value?.trim();
      
      // Always set baseURL (use defaults if empty)
      const finalAddress = ollamaAddress || 'localhost';
      const finalPort = ollamaPort || '11434';
      agentData.provider_config.baseURL = `http://${finalAddress}:${finalPort}`;
    }

    if (this._clearHfMetadata) {
      agentData.hf_model_repo = null;
      // model_capabilities will be set below (may still include OpenRouter)
    } else {
      const hfRepoVal = document.getElementById('agent-hf-repo')?.value?.trim() || '';
      if (this._pendingHfCapabilities) {
        agentData.hf_model_repo = hfRepoVal || this._pendingHfCapabilities.repo_id || null;
      } else if (hfRepoVal) {
        agentData.hf_model_repo = hfRepoVal;
      }
    }

    if (this._clearOpenRouterMetadata) {
      agentData.openrouter_model_id = null;
    } else {
      const orVal = document.getElementById('agent-openrouter-model')?.value?.trim() || '';
      if (this._pendingOpenRouterCapabilities) {
        agentData.openrouter_model_id = orVal || this._pendingOpenRouterCapabilities.openrouter_model_id || null;
      } else if (orVal) {
        agentData.openrouter_model_id = orVal;
      }
    }

    const combinedCaps = this._combineCapabilitiesForSave(
      this._clearHfMetadata ? null : this._pendingHfCapabilities,
      this._clearOpenRouterMetadata ? null : this._pendingOpenRouterCapabilities
    );
    if (this._clearHfMetadata && this._clearOpenRouterMetadata) {
      agentData.model_capabilities = null;
    } else if (combinedCaps) {
      agentData.model_capabilities = combinedCaps;
    }

    try {
      if (isEdit) {
        await api.agents.update(parseInt(agentId), agentData);
        showToast('Agent updated successfully', 'success');
      } else {
        await api.agents.create(agentData);
        showToast('Agent created successfully', 'success');
      }

      this._clearHfMetadata = false;
      this._clearOpenRouterMetadata = false;

      // Close modal
      const modal = bootstrap.Modal.getInstance(document.getElementById('agentModal'));
      modal.hide();

      // Reload agents
      await this.loadAgents();
    } catch (error) {
      console.error('Error saving agent:', error);
      showToast(error.message || 'Failed to save agent', 'danger');
    }
  }

  /**
   * Test agent connection
   */
  async testAgent(agentId) {
    showToast('Testing agent connection...', 'info');

    try {
      const response = await api.agents.test(agentId);

      if (response.data.success) {
        showToast(`Agent "${response.data.agentName}" is working (${response.data.latency}ms)`, 'success');
      } else {
        showToast(`Agent test failed: ${response.data.message}`, 'danger');
      }
    } catch (error) {
      console.error('Error testing agent:', error);
      showToast(error.message || 'Failed to test agent', 'danger');
    }
  }

  /**
   * Duplicate an agent
   */
  async duplicateAgent(agentId) {
    const newName = prompt('Enter name for the duplicated agent:');
    if (!newName) return;

    try {
      await api.agents.duplicate(agentId, newName);
      showToast('Agent duplicated successfully', 'success');
      await this.loadAgents();
    } catch (error) {
      console.error('Error duplicating agent:', error);
      showToast(error.message || 'Failed to duplicate agent', 'danger');
    }
  }

  /**
   * Export an agent's settings as JSON
   */
  async exportAgent(agentId) {
    // Prompt user whether to include API key
    const includeApiKey = confirm(
      'Include API key in export?\n\n' +
      'Click OK to include the API key (for easy import later)\n' +
      'Click Cancel to export without API key (more secure)'
    );

    try {
      const response = await api.agents.export(agentId, includeApiKey);
      const agentData = response.data;

      // Create JSON blob
      const jsonString = JSON.stringify(agentData, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      // Create download link
      const a = document.createElement('a');
      a.href = url;
      const suffix = includeApiKey ? '_with_key' : '_no_key';
      a.download = `${agentData.name.replace(/[^a-z0-9]/gi, '_')}_agent_export${suffix}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const message = includeApiKey 
        ? 'Agent exported successfully (with API key)' 
        : 'Agent exported successfully (API key excluded)';
      showToast(message, 'success');
    } catch (error) {
      console.error('Error exporting agent:', error);
      showToast(error.message || 'Failed to export agent', 'danger');
    }
  }

  /**
   * Load and display sessions assigned to an agent
   */
  async loadAgentSessions(agentId) {
    const sessionsContent = document.getElementById('agent-sessions-content');
    if (!sessionsContent) return;

    try {
      const response = await api.agents.getSessions(agentId);
      const sessions = response.data.sessions || [];

      if (sessions.length === 0) {
        sessionsContent.textContent = 'None';
        sessionsContent.classList.add('text-muted');
      } else {
        const sessionBadges = sessions.map(s => 
          `<span class="badge bg-transparent border border-secondary text-secondary" style="font-size: 0.7rem; font-weight: normal; margin-right: 0.25rem;">${escapeHtml(s.name)}</span>`
        ).join('');
        sessionsContent.innerHTML = sessionBadges;
        sessionsContent.classList.remove('text-muted');
      }
    } catch (error) {
      console.error('Error loading agent sessions:', error);
      sessionsContent.textContent = 'Error loading sessions';
      sessionsContent.classList.add('text-danger');
    }
  }

  /**
   * Import an agent from JSON file
   */
  async importAgent() {
    // Create file input element
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.style.display = 'none';

    const cleanup = () => {
      if (input.parentNode) {
        document.body.removeChild(input);
      }
    };

    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) {
        cleanup();
        return;
      }

      try {
        const text = await file.text();
        const agentData = JSON.parse(text);

        // Validate required fields
        if (!agentData.name || !agentData.role || !agentData.provider_type || !agentData.provider_config) {
          showToast('Invalid agent export file: missing required fields', 'danger');
          cleanup();
          return;
        }

        // Prompt for new name
        const newName = prompt(
          `Enter a name for the imported agent:\n(Leave empty to use "${agentData.name}")`,
          agentData.name
        );

        if (newName === null) {
          // User cancelled
          cleanup();
          return;
        }

        // Prepare agent data for import
        // Clone provider_config to avoid mutating the original
        const providerConfig = { ...agentData.provider_config };
        
        // Remove placeholder API key if present
        if (providerConfig.apiKey === 'NO_KEY_SHOULD_BE_PROVIDED') {
          delete providerConfig.apiKey;
        }

        const importData = {
          name: newName.trim() || agentData.name,
          role: agentData.role,
          initial_context: agentData.initial_context || null,
          provider_type: agentData.provider_type,
          provider_config: providerConfig,
        };
        if (agentData.hf_model_repo) importData.hf_model_repo = agentData.hf_model_repo;
        if (agentData.model_capabilities && typeof agentData.model_capabilities === 'object') {
          importData.model_capabilities = agentData.model_capabilities;
        }

        // Check if API key is missing (and provider requires it)
        const provider = this.providers.find(p => p.type === agentData.provider_type);
        const hasApiKey = !!providerConfig.apiKey;
        const needsApiKey = provider?.requiresApiKey && !hasApiKey;

        // Create the agent
        await api.agents.create(importData);
        
        if (needsApiKey) {
          showToast('Agent imported successfully. Please add API key in agent settings.', 'warning');
        } else {
          showToast('Agent imported successfully', 'success');
        }
        await this.loadAgents();
      } catch (error) {
        console.error('Error importing agent:', error);
        if (error instanceof SyntaxError) {
          showToast('Invalid JSON file', 'danger');
        } else {
          showToast(error.message || 'Failed to import agent', 'danger');
        }
      } finally {
        cleanup();
      }
    };

    // Clean up if user cancels (no file selected after a short delay)
    setTimeout(() => {
      if (input.parentNode && !input.files.length) {
        cleanup();
      }
    }, 100);

    // Trigger file picker
    document.body.appendChild(input);
    input.click();
  }

  /**
   * Delete an agent
   */
  async deleteAgent(agentId) {
    const agent = this.agents.find(a => a.id === agentId);
    if (!agent) return;

    if (!confirm(`Are you sure you want to delete agent "${agent.name}"?`)) {
      return;
    }

    try {
      await api.agents.delete(agentId);
      showToast('Agent deleted successfully', 'success');

      if (this.selectedAgent?.id === agentId) {
        this.selectedAgent = null;
      }

      await this.loadAgents();
    } catch (error) {
      console.error('Error deleting agent:', error);
      showToast(error.message || 'Failed to delete agent', 'danger');
    }
  }

  /**
   * Get all agents (for session assignment)
   */
  getAgents() {
    return this.agents;
  }

  /**
   * Get agents for session assignment dropdown
   */
  getAgentsForAssignment(excludeIds = []) {
    return this.agents.filter(a => !excludeIds.includes(a.id));
  }
}

// Create global instance
window.agentManager = new AgentManager();

// Event delegation for agent manager actions
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const agentId = target.dataset.agentId ? parseInt(target.dataset.agentId) : null;

  switch (action) {
    case 'show-create-modal':
    case 'show-create-agent-modal':
      if (target.closest('#agents-list') || target.closest('#agents-view')) {
        agentManager.showCreateModal();
      }
      break;
    case 'import-agent':
      e.preventDefault();
      e.stopPropagation();
      agentManager.importAgent();
      break;
    case 'select-agent':
      agentManager.selectAgent(agentId);
      break;
    case 'stop-propagation':
      e.stopPropagation();
      break;
    case 'edit-agent':
      e.preventDefault();
      e.stopPropagation();
      agentManager.showEditModal(agentId);
      break;
    case 'test-agent':
      e.preventDefault();
      e.stopPropagation();
      agentManager.testAgent(agentId);
      break;
    case 'duplicate-agent':
      e.preventDefault();
      e.stopPropagation();
      agentManager.duplicateAgent(agentId);
      break;
    case 'export-agent':
      e.preventDefault();
      e.stopPropagation();
      agentManager.exportAgent(agentId);
      break;
    case 'delete-agent':
      e.preventDefault();
      e.stopPropagation();
      agentManager.deleteAgent(agentId);
      break;
    case 'toggle-api-key':
      agentManager.toggleApiKeyVisibility();
      break;
    case 'test-provider':
      agentManager.testProviderFromModal();
      break;
    case 'fetch-hf-model':
      e.preventDefault();
      agentManager.fetchHfModelFromModal();
      break;
    case 'clear-hf-model':
      e.preventDefault();
      agentManager.clearHfModelInModal();
      break;
    case 'fetch-openrouter-model':
      e.preventDefault();
      agentManager.fetchOpenRouterModelFromModal();
      break;
    case 'clear-openrouter-model':
      e.preventDefault();
      agentManager.clearOpenRouterModelInModal();
      break;
    case 'save-agent':
      agentManager.saveAgent();
      break;
  }
});

// Event delegation for change events
document.addEventListener('change', (e) => {
  if (e.target?.id === 'agent-enable-prompt-cache') {
    agentManager.refreshCapabilitiesAlert();
  }

  const target = e.target.closest('[data-action]');
  if (!target) return;

  switch (target.dataset.action) {
    case 'provider-change':
      agentManager.onProviderChange();
      break;
    case 'model-change':
      agentManager.onModelChange();
      break;
  }
});
