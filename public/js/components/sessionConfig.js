/**
 * Session Configuration Component
 * Handles session configuration including agent and document assignments
 */

class SessionConfig {
  constructor() {
    this.currentSession = null;
    this.providers = [];
    this.customOrchestratorModel = null;
    this.currentOrchestratorModel = null; // Track the loaded model from session
    this._docAgentMatrixCache = {}; // docId -> Set(agentId)
    this._availableToolsCache = null; // Array of available tools from /api/tools
  }

  /**
   * Load providers from API
   */
  async loadProviders() {
    if (this.providers.length === 0) {
      try {
        const response = await api.agents.getProviders();
        this.providers = response.data.providers;
      } catch (error) {
        console.error('Error loading providers:', error);
      }
    }
    return this.providers;
  }

  /**
   * Get model options for a provider
   */
  getOrchestratorModelOptions(providerType, selectedModel = null) {
    const provider = this.providers.find(p => p.type === providerType);

    // Check if selected model is custom (not in predefined list)
    const isCustomModel = selectedModel && (
      !provider?.availableModels ||
      !provider.availableModels.length ||
      !provider.availableModels.some(m => m.id === selectedModel)
    );

    if (isCustomModel) {
      this.customOrchestratorModel = selectedModel;
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
   * Show session configuration modal
   */
  async showConfigModal(sessionId = null) {
    // Always fetch session from server to ensure we have latest orchestrator_provider_config
    const idToLoad = sessionId ?? window.sessionManager?.getCurrentSession()?.id;
    if (idToLoad) {
      try {
        const response = await api.sessions.get(idToLoad);
        this.currentSession = response.data.session;
      } catch (error) {
        console.error('Error loading session:', error);
        showToast('Failed to load session', 'danger');
        return;
      }
    } else {
      this.currentSession = null;
    }

    if (!this.currentSession) {
      showToast('Please select a session first', 'warning');
      return;
    }

    // Load providers for model selection
    await Promise.all([
      this.loadProviders(),
      this.loadAvailableTools(),
      this.loadOrchestratorTools(),
    ]);

    // Parse orchestrator config to get current model
    this.currentOrchestratorModel = null;
    if (this.currentSession.orchestrator_provider_config) {
      try {
        const config = typeof this.currentSession.orchestrator_provider_config === 'string'
          ? JSON.parse(this.currentSession.orchestrator_provider_config)
          : this.currentSession.orchestrator_provider_config;
        this.currentOrchestratorModel = config.model;
      } catch (e) {
        console.error('Error parsing orchestrator config:', e);
      }
    }

    // Check if current model is custom and set it
    // A model is "custom" if: we have a model AND (provider has no model list OR model is not in the list)
    // This ensures we show the custom display when provider.availableModels is missing (e.g. API failed)
    // or when the user has a model ID not in the predefined list (e.g. gemini-3-flash-preview before it was added)
    const provider = this.providers.find(p => p.type === (this.currentSession.orchestrator_provider_type || 'claude'));
    const isCustomModel = this.currentOrchestratorModel && (
      !provider?.availableModels ||
      !provider.availableModels.length ||
      !provider.availableModels.some(m => m.id === this.currentOrchestratorModel)
    );

    if (isCustomModel) {
      this.customOrchestratorModel = this.currentOrchestratorModel;
    } else {
      this.customOrchestratorModel = null;
    }

    const currentOrchestratorModel = this.currentOrchestratorModel;

    // Get all available agents
    const availableAgents = window.agentManager?.getAgents() || [];
    const assignedAgentIds = (this.currentSession.agents || []).map(a => a.id);
    const assignedAgents = (this.currentSession.agents || []);

    const modalHtml = `
      <div class="modal fade" id="sessionConfigModal" tabindex="-1">
        <div class="modal-dialog" style="max-width: 98vw; width: 98vw; height: 98vh; margin: 1vh auto;">
          <div class="modal-content" style="height: 100%; display: flex; flex-direction: column;">
            <div class="modal-header">
              <h5 class="modal-title">
                <i class="bi bi-gear me-2"></i>Configure Session: ${escapeHtml(this.currentSession.name)}
              </h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" style="flex: 1; min-height: 0; overflow-y: auto;">
              <ul class="nav nav-tabs" id="configTabs" role="tablist">
                <li class="nav-item" role="presentation">
                  <button class="nav-link active" id="general-tab" data-bs-toggle="tab"
                          data-bs-target="#general-panel" type="button" role="tab">
                    <i class="bi bi-sliders me-1"></i>General
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="agents-tab" data-bs-toggle="tab"
                          data-bs-target="#agents-panel" type="button" role="tab">
                    <i class="bi bi-robot me-1"></i>Agents
                    <span class="badge bg-primary ms-1">${assignedAgentIds.length}</span>
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="documents-tab" data-bs-toggle="tab"
                          data-bs-target="#documents-panel" type="button" role="tab">
                    <i class="bi bi-file-earmark-text me-1"></i>Documents
                    <span class="badge bg-primary ms-1">${(this.currentSession.documents || []).length}</span>
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="tools-tab" data-bs-toggle="tab"
                          data-bs-target="#tools-panel" type="button" role="tab">
                    <i class="bi bi-tools me-1"></i>Tools
                    <span class="badge bg-primary ms-1">${(this.getAvailableTools() || []).length}</span>
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="scheduled-jobs-tab" data-bs-toggle="tab"
                          data-bs-target="#scheduled-jobs-panel" type="button" role="tab">
                    <i class="bi bi-clock-history me-1"></i>Scheduled jobs
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="orchestrator-tab" data-bs-toggle="tab"
                          data-bs-target="#orchestrator-panel" type="button" role="tab">
                    <i class="bi bi-diagram-3 me-1"></i>Orchestrator
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="brainstorming-tab" data-bs-toggle="tab"
                          data-bs-target="#brainstorming-panel" type="button" role="tab">
                    <i class="bi bi-chat-dots me-1"></i>Brainstorming
                    ${this.currentSession.conversation_mode_enabled ? '<span class="badge bg-success ms-1">ON</span>' : ''}
                  </button>
                </li>
              </ul>

              <div class="tab-content mt-3" id="configTabContent">
                <!-- General Settings Tab -->
                <div class="tab-pane fade show active" id="general-panel" role="tabpanel">
                  <form id="session-general-form">
                    <div class="mb-3">
                      <label class="form-label">Session ID</label>
                      <input
                        type="text"
                        class="form-control"
                        id="config-session-id"
                        value="${this.currentSession.id}"
                        readonly>
                      <div class="form-text">Use this ID for API calls (e.g. n8n → <code>/api/chat/:sessionId</code>).</div>
                    </div>
                    <div class="mb-3">
                      <label class="form-label">Session Name *</label>
                      <input type="text" class="form-control" id="config-session-name"
                             value="${escapeHtml(this.currentSession.name)}" required maxlength="255">
                    </div>
                    <div class="mb-3">
                      <label class="form-label">
                        <i class="bi bi-info-circle me-1"></i>
                        Orchestrator Initial Context
                      </label>
                      <textarea class="form-control" id="config-session-desc" rows="8"
                                placeholder="Describe the application, requirements, external context tools and their use, resources (cached files), agent roles and their use. This information will be provided to the Orchestrator model as initial context to guide its work.">${escapeHtml(this.currentSession.description || '')}</textarea>
                      <div class="mt-2">
                        <button type="button" class="btn btn-sm btn-outline-secondary" id="load-default-prompt-btn">
                          <i class="bi bi-arrow-clockwise me-1"></i>Load Default Prompt
                        </button>
                        <button type="button" class="btn btn-sm btn-outline-info" id="insert-artifact-prompt-btn">
                          <i class="bi bi-code-square me-1"></i>Insert Artifact Prompt
                        </button>
                        <button type="button" class="btn btn-sm btn-outline-info" id="insert-predefined-prompt-btn">
                          <i class="bi bi-card-text me-1"></i>Insert Predefined Prompt
                        </button>
                      </div>
                      <div class="form-text">
                        <strong>Purpose:</strong> This context is passed to the Orchestrator model to guide its routing decisions and responses. Include:
                        <ul class="mb-0 mt-1 small">
                          <li>Application requirements and description</li>
                          <li>External context tools and their usage</li>
                          <li>Resources (cached files) and how to use them</li>
                          <li>Agent roles and when to use each one</li>
                        </ul>
                      </div>
                    </div>
                    <div class="mb-3">
                      <label class="form-label">Context Window Size</label>
                      <input type="number" class="form-control" id="config-context-length"
                             value="${this.currentSession.context_length || 10}" min="1" max="200">
                      <div class="form-text">Number of recent messages to include in context (1-200)</div>
                    </div>
                  </form>
                </div>

                <!-- Agents Tab -->
                <div class="tab-pane fade" id="agents-panel" role="tabpanel">
                  <div class="mb-3">
                    <label class="form-label">Assign Agents to Session</label>
                    <div class="form-text mb-2">Select agents that will be available for tasks in this session</div>

                    ${availableAgents.length === 0 ? `
                      <div class="alert alert-info">
                        <i class="bi bi-info-circle me-2"></i>
                        No agents available. <a href="#" data-action="create-agent-from-config">Create your first agent</a>
                      </div>
                    ` : `
                      <div class="form-text mb-2 small">
                        <i class="bi bi-info-circle me-1"></i>
                        Click the <i class="bi bi-chat-text"></i> icon on assigned agents to edit their session-specific context.
                      </div>
                      <div class="list-group" id="agent-assignment-list">
                        ${availableAgents.map(agent => {
                          const isAssigned = assignedAgentIds.includes(agent.id);
                          const assignedAgent = assignedAgents.find(a => a.id === agent.id);
                          const hasContext = assignedAgent?.session_context;
                          return `
                          <div class="list-group-item d-flex align-items-center">
                            <input class="form-check-input me-3 agent-checkbox" type="checkbox"
                                   id="agent-check-${agent.id}"
                                   value="${agent.id}" ${isAssigned ? 'checked' : ''}>
                            <label class="flex-grow-1 mb-0" for="agent-check-${agent.id}" style="cursor: pointer;">
                              <strong>${escapeHtml(agent.name)}</strong>
                              <small class="d-block text-muted">
                                ${this.getRoleDisplayName(agent.role)} • ${agent.provider_type}
                              </small>
                            </label>
                            ${isAssigned ? `
                              <button type="button" class="btn btn-outline-secondary btn-sm ms-2"
                                      data-action="edit-agent-context" data-agent-id="${agent.id}"
                                      title="Edit session context for ${escapeHtml(agent.name)}">
                                <i class="bi bi-chat-text${hasContext ? '-fill' : ''}"></i>
                              </button>
                            ` : ''}
                          </div>
                        `}).join('')}
                      </div>
                    `}
                  </div>
                </div>

                <!-- Documents Tab -->
                <div class="tab-pane fade" id="documents-panel" role="tabpanel">
                  <div class="mb-3">
                    <label class="form-label">Assign Documents per Agent</label>
                    <div class="form-text mb-2">
                      Select which documents each agent should load for context. Rows are documents; columns are assigned agents.
                      <br><span class="text-muted">Note: columns reflect agents currently assigned to the session (save/reopen after changing agents).</span>
                    </div>

                    ${(this.getAvailableDocuments().length === 0) ? `
                      <div class="alert alert-info">
                        <i class="bi bi-info-circle me-2"></i>
                        No documents available. <a href="#" data-action="upload-document-from-config">Upload your first document</a>
                      </div>
                    ` : `
                      <div class="form-text mb-2">
                        Select which documents the <strong>Orchestrator</strong> and each agent should use. Orchestrator sees session-level docs when it handles requests directly.
                        ${assignedAgents.length ? '<br><span class="text-muted">Tip: uncheck a document for agents that don’t need it to reduce context size.</span>' : ''}
                      </div>
                      <div class="table-responsive" style="max-height: 320px; overflow: auto;">
                        <table class="table table-sm table-bordered align-middle mb-0" id="document-agent-matrix">
                          <thead class="table-light" style="position: sticky; top: 0; z-index: 2;">
                            <tr>
                              <th style="min-width: 260px;">Document</th>
                              <th class="text-center" style="min-width: 140px; background-color: #f8f9fa;">
                                <div class="fw-semibold">Orchestrator</div>
                                <div class="small text-muted">Session / Router</div>
                              </th>
                              ${assignedAgents.map(a => `
                                <th class="text-center" style="min-width: 120px;">
                                  <div class="fw-semibold">${escapeHtml(a.name)}</div>
                                  <div class="small text-muted">${escapeHtml(this.getRoleDisplayName(a.role))}</div>
                                  ${a.provider_config?.model ? `
                                    <div class="small text-muted">${escapeHtml(a.provider_type)} • ${escapeHtml(a.provider_config.model)}</div>
                                  ` : (a.provider_type ? `
                                    <div class="small text-muted">${escapeHtml(a.provider_type)}</div>
                                  ` : '')}
                                  ${this.getModelCapabilities(a).vision ? `
                                    <span class="badge bg-info-subtle text-info-emphasis border border-info-subtle mt-1">vision</span>
                                  ` : `
                                    <span class="badge bg-light text-muted border mt-1">text-only</span>
                                  `}
                                </th>
                              `).join('')}
                            </tr>
                          </thead>
                          <tbody>
                            ${this.getAvailableDocuments().map(doc => `
                              <tr>
                                <td>
                                  <div class="fw-semibold">${escapeHtml(doc.filename)}</div>
                                  <div class="small text-muted">${this.formatFileSize(doc.file_size)} • ${doc.chunk_count || 0} chunks</div>
                                </td>
                                <td class="text-center" style="background-color: #f8f9fa;">
                                  <input
                                    class="form-check-input doc-orchestrator-checkbox"
                                    type="checkbox"
                                    data-document-id="${doc.id}"
                                    ${this.isDocumentAssigned(doc.id) ? 'checked' : ''}>
                                </td>
                                ${assignedAgents.map(a => `
                                  <td class="text-center">
                                    <input
                                      class="form-check-input doc-agent-checkbox"
                                      type="checkbox"
                                      data-document-id="${doc.id}"
                                      data-agent-id="${a.id}"
                                      ${this.isDocumentAssignedToAgent(doc.id, a.id) ? 'checked' : ''}>
                                  </td>
                                `).join('')}
                              </tr>
                            `).join('')}
                          </tbody>
                        </table>
                      </div>
                    `}
                  </div>
                </div>

                <!-- Tools Tab -->
                <div class="tab-pane fade" id="tools-panel" role="tabpanel">
                  <div class="mb-3">
                    <label class="form-label">Assign Tools per Agent and Orchestrator</label>
                    <div class="form-text mb-2">
                      Select which tools each agent and the orchestrator can use. Rows are tools; columns are the orchestrator and assigned agents.
                      <br><span class="text-muted">Note: agent columns reflect agents currently assigned to the session (save/reopen after changing agents).</span>
                    </div>
                    ${(this.getAvailableTools().length === 0) ? `
                      <div class="alert alert-info">
                        <i class="bi bi-info-circle me-2"></i>
                        No tools available.
                      </div>
                    ` : (assignedAgents.length === 0) ? `
                      <div class="alert alert-info">
                        <i class="bi bi-info-circle me-2"></i>
                        No agents assigned yet. You can still configure tools for the orchestrator below.
                      </div>
                    ` : ''}
                  </div>
                  ${(this.getAvailableTools().length > 0) ? `
                  <div class="table-responsive" style="max-height: 65vh; overflow: auto;">
                    <table class="table table-sm table-bordered align-middle mb-0 w-100" id="tool-agent-matrix" data-session-id="${this.currentSession?.id ?? ''}">
                          <thead class="table-light" style="position: sticky; top: 0; z-index: 2;">
                            <tr>
                              <th style="min-width: 260px;">Tool</th>
                              <th class="text-center" style="min-width: 120px; background-color: #f8f9fa;">
                                <div class="fw-semibold">Orchestrator</div>
                                <div class="small text-muted">Main Router</div>
                                ${this.currentSession.orchestrator_provider_type ? `
                                  <div class="small text-muted">${escapeHtml(this.currentSession.orchestrator_provider_type)}</div>
                                ` : ''}
                              </th>
                              ${assignedAgents.map(a => `
                                <th class="text-center" style="min-width: 120px;">
                                  <div class="fw-semibold">${escapeHtml(a.name)}</div>
                                  <div class="small text-muted">${escapeHtml(this.getRoleDisplayName(a.role))}</div>
                                  ${a.provider_config?.model ? `
                                    <div class="small text-muted">${escapeHtml(a.provider_type)} • ${escapeHtml(a.provider_config.model)}</div>
                                  ` : (a.provider_type ? `
                                    <div class="small text-muted">${escapeHtml(a.provider_type)}</div>
                                  ` : '')}
                                  ${this.getModelCapabilities(a).vision ? `
                                    <span class="badge bg-info-subtle text-info-emphasis border border-info-subtle mt-1">vision</span>
                                  ` : `
                                    <span class="badge bg-light text-muted border mt-1">text-only</span>
                                  `}
                                </th>
                              `).join('')}
                            </tr>
                          </thead>
                          <tbody>
                            ${this.getAvailableTools().map(tool => `
                              <tr>
                                <td>
                                  <div class="fw-semibold">${escapeHtml(tool.name)}</div>
                                  <div class="small text-muted">${escapeHtml(tool.category || 'general')} • ${escapeHtml((tool.description || '').substring(0, 120))}${(tool.description || '').length > 120 ? '…' : ''}</div>
                                </td>
                                <td class="text-center" style="background-color: #f8f9fa;">
                                  ${tool.name === 'sqlite_local_db' ? (() => {
                                    const dbName = this.getOrchestratorToolConfig(tool.name)?.database_name || '';
                                    return `
                                      <div class="d-flex justify-content-center">
                                        <input
                                          type="text"
class="form-control form-control-sm orchestrator-tool-config-input text-center"
                                        placeholder="Database name"
                                        data-tool-name="${escapeHtml(tool.name)}"
                                        data-is-orchestrator="true"
                                        value="${escapeHtml(dbName)}"
                                        style="min-width: 120px; max-width: 200px;">
                                      </div>
                                      <small class="tool-resource-path-display text-muted d-block mt-1" style="font-size: 0.7rem; word-break: break-all;">
                                        ${dbName ? '…' : 'Empty = disabled'}
                                      </small>
                                    `;
                                  })() : tool.name === 'local_working_folder' ? (() => {
                                    const folderName = this.getOrchestratorToolConfig(tool.name)?.folder_name || '';
                                    const randomizeName = this.getOrchestratorToolConfig(tool.name)?.randomize_name !== false;
                                    return `
                                      <div class="d-flex justify-content-center">
                                        <input
                                          type="text"
class="form-control form-control-sm orchestrator-tool-config-input text-center"
                                        placeholder="Folder name"
                                        data-tool-name="${escapeHtml(tool.name)}"
                                        data-is-orchestrator="true"
                                        value="${escapeHtml(folderName)}"
                                        style="min-width: 120px; max-width: 200px;">
                                      </div>
                                      <div class="form-check d-flex justify-content-center mt-1">
                                        <input class="form-check-input local-working-folder-randomize"
                                          type="checkbox"
                                          data-tool-name="${escapeHtml(tool.name)}"
                                          data-is-orchestrator="true"
                                          ${randomizeName ? 'checked' : ''}>
                                        <label class="form-check-label small ms-1">Randomize name</label>
                                      </div>
                                      <small class="tool-resource-path-display text-muted d-block mt-1" style="font-size: 0.7rem; word-break: break-all;">
                                        ${folderName ? '…' : 'Empty = disabled'}
                                      </small>
                                    `;
                                  })() : tool.name === 'ef_api' ? (() => {
                                    const cfg = this.getOrchestratorToolConfig(tool.name) || {};
                                    return `
                                      <div class="ef-api-config-block d-flex flex-column gap-1" data-tool-name="${escapeHtml(tool.name)}" data-is-orchestrator="true">
                                        <input type="text" class="form-control form-control-sm" placeholder="Base URL (https://host:port)"
                                          data-config-key="base_url" value="${escapeHtml(cfg.base_url || '')}" style="font-size: 0.75rem;">
                                        <input type="text" class="form-control form-control-sm" placeholder="Username"
                                          data-config-key="username" value="${escapeHtml(cfg.username || '')}" style="font-size: 0.75rem;">
                                        <input type="password" class="form-control form-control-sm" placeholder="Password"
                                          data-config-key="password" value="${escapeHtml(cfg.password || '')}" style="font-size: 0.75rem;" autocomplete="off">
                                        <label class="small mb-0"><input type="checkbox" data-config-key="reject_unauthorized" ${cfg.reject_unauthorized !== false ? 'checked' : ''}> Verify SSL</label>
                                      </div>
                                      <small class="text-muted d-block mt-1" style="font-size: 0.65rem;">ef API</small>
                                    `;
                                  })() : tool.name === 'open_memory' ? (() => {
                                    const cfg = this.getOrchestratorToolConfig(tool.name) || {};
                                    const defaultSessionScope = String(this.currentSession?.id || '');
                                    return `
                                      <div class="open-memory-config-block d-flex flex-column gap-1" data-tool-name="${escapeHtml(tool.name)}" data-is-orchestrator="true">
                                        <input type="text" class="form-control form-control-sm" placeholder="Base URL (http://localhost:8080)"
                                          data-config-key="base_url" value="${escapeHtml(cfg.base_url || '')}" style="font-size: 0.75rem;">
                                        <input type="text" class="form-control form-control-sm" placeholder="API key (optional)"
                                          data-config-key="api_key" value="${escapeHtml(cfg.api_key || '')}" style="font-size: 0.75rem;" autocomplete="off">
                                        <input type="text" class="form-control form-control-sm" placeholder="Session scope (default: ${escapeHtml(defaultSessionScope)})"
                                          data-config-key="session_scope" value="${escapeHtml(cfg.session_scope != null ? String(cfg.session_scope) : defaultSessionScope)}" style="font-size: 0.75rem;" title="Empty = access all sessions">
                                        <input type="text" class="form-control form-control-sm" placeholder="Agent scope (default: orchestrator)"
                                          data-config-key="agent_scope" value="${escapeHtml(cfg.agent_scope != null ? String(cfg.agent_scope) : 'orchestrator')}" style="font-size: 0.75rem;" title="Empty = access all agents">
                                        <label class="small mb-0"><input type="checkbox" data-config-key="reject_unauthorized" ${cfg.reject_unauthorized !== false ? 'checked' : ''}> Verify SSL</label>
                                      </div>
                                      <small class="text-muted d-block mt-1" style="font-size: 0.65rem;">OpenMemory</small>
                                    `;
                                  })() : `
                                    <input
                                      class="form-check-input orchestrator-tool-checkbox"
                                      type="checkbox"
                                      data-tool-name="${escapeHtml(tool.name)}"
                                      ${this.isOrchestratorToolAssigned(tool.name) ? 'checked' : ''}>
                                  `}
                                </td>
                                ${assignedAgents.map(a => {
                                  const isAssigned = this.isToolAssignedToAgent(tool.name, a.id);
                                  const toolConfig = this.getToolConfigForAgent(tool.name, a.id);
                                  
                                  // Special handling for tools that require text input: show text input instead of checkbox
                                  if (tool.name === 'sqlite_local_db') {
                                    const dbName = toolConfig?.database_name || '';
                                    return `
                                      <td class="text-center">
                                        <div class="d-flex justify-content-center">
                                          <input
                                            type="text"
                                            class="form-control form-control-sm tool-config-input text-center"
                                            placeholder="Database name"
                                            data-tool-name="${escapeHtml(tool.name)}"
                                            data-agent-id="${a.id}"
                                            value="${escapeHtml(dbName)}"
                                            style="min-width: 120px; max-width: 200px;">
                                        </div>
                                        <small class="tool-resource-path-display text-muted d-block mt-1" style="font-size: 0.7rem; word-break: break-all;">
                                          ${dbName ? '…' : 'Empty = disabled'}
                                        </small>
                                      </td>
                                    `;
                                  }
                                  
                                  if (tool.name === 'local_working_folder') {
                                    const folderName = toolConfig?.folder_name || '';
                                    const randomizeName = toolConfig?.randomize_name !== false;
                                    return `
                                      <td class="text-center">
                                        <div class="d-flex justify-content-center">
                                          <input
                                            type="text"
                                            class="form-control form-control-sm tool-config-input text-center"
                                            placeholder="Folder name"
                                            data-tool-name="${escapeHtml(tool.name)}"
                                            data-agent-id="${a.id}"
                                            value="${escapeHtml(folderName)}"
                                            style="min-width: 120px; max-width: 200px;">
                                        </div>
                                        <div class="form-check d-flex justify-content-center mt-1">
                                          <input class="form-check-input local-working-folder-randomize"
                                            type="checkbox"
                                            data-tool-name="${escapeHtml(tool.name)}"
                                            data-agent-id="${a.id}"
                                            ${randomizeName ? 'checked' : ''}>
                                          <label class="form-check-label small ms-1">Randomize name</label>
                                        </div>
                                        <small class="tool-resource-path-display text-muted d-block mt-1" style="font-size: 0.7rem; word-break: break-all;">
                                          ${folderName ? '…' : 'Empty = disabled'}
                                        </small>
                                      </td>
                                    `;
                                  }
                                  
                                  if (tool.name === 'ef_api') {
                                    const cfg = toolConfig || {};
                                    return `
                                      <td class="text-center">
                                        <div class="ef-api-config-block d-flex flex-column gap-1" data-tool-name="${escapeHtml(tool.name)}" data-agent-id="${a.id}">
                                          <input type="text" class="form-control form-control-sm" placeholder="Base URL (https://host:port)"
                                            data-config-key="base_url" value="${escapeHtml(cfg.base_url || '')}" style="font-size: 0.75rem;">
                                          <input type="text" class="form-control form-control-sm" placeholder="Username"
                                            data-config-key="username" value="${escapeHtml(cfg.username || '')}" style="font-size: 0.75rem;">
                                          <input type="password" class="form-control form-control-sm" placeholder="Password"
                                            data-config-key="password" value="${escapeHtml(cfg.password || '')}" style="font-size: 0.75rem;" autocomplete="off">
                                          <label class="small mb-0"><input type="checkbox" data-config-key="reject_unauthorized" ${cfg.reject_unauthorized !== false ? 'checked' : ''}> Verify SSL</label>
                                        </div>
                                        <small class="text-muted d-block mt-1" style="font-size: 0.65rem;">ef API</small>
                                      </td>
                                    `;
                                  }
                                  
                                  if (tool.name === 'open_memory') {
                                    const cfg = toolConfig || {};
                                    const defaultSessionScope = String(this.currentSession?.id || '');
                                    const defaultAgentScope = String(a.id);
                                    return `
                                      <td class="text-center">
                                        <div class="open-memory-config-block d-flex flex-column gap-1" data-tool-name="${escapeHtml(tool.name)}" data-agent-id="${a.id}">
                                          <input type="text" class="form-control form-control-sm" placeholder="Base URL (http://localhost:8080)"
                                            data-config-key="base_url" value="${escapeHtml(cfg.base_url || '')}" style="font-size: 0.75rem;">
                                          <input type="text" class="form-control form-control-sm" placeholder="API key (optional)"
                                            data-config-key="api_key" value="${escapeHtml(cfg.api_key || '')}" style="font-size: 0.75rem;" autocomplete="off">
                                          <input type="text" class="form-control form-control-sm" placeholder="Session scope (default: ${escapeHtml(defaultSessionScope)})"
                                            data-config-key="session_scope" value="${escapeHtml(cfg.session_scope != null ? String(cfg.session_scope) : defaultSessionScope)}" style="font-size: 0.75rem;" title="Empty = access all sessions">
                                          <input type="text" class="form-control form-control-sm" placeholder="Agent scope (default: ${escapeHtml(defaultAgentScope)})"
                                            data-config-key="agent_scope" value="${escapeHtml(cfg.agent_scope != null ? String(cfg.agent_scope) : defaultAgentScope)}" style="font-size: 0.75rem;" title="Empty = access all agents">
                                          <label class="small mb-0"><input type="checkbox" data-config-key="reject_unauthorized" ${cfg.reject_unauthorized !== false ? 'checked' : ''}> Verify SSL</label>
                                        </div>
                                        <small class="text-muted d-block mt-1" style="font-size: 0.65rem;">OpenMemory</small>
                                      </td>
                                    `;
                                  }
                                  
                                  // Default: checkbox for other tools
                                  return `
                                    <td class="text-center">
                                      <input
                                        class="form-check-input tool-agent-checkbox"
                                        type="checkbox"
                                        data-tool-name="${escapeHtml(tool.name)}"
                                        data-agent-id="${a.id}"
                                        ${isAssigned ? 'checked' : ''}>
                                    </td>
                                  `;
                                }).join('')}
                              </tr>
                            `).join('')}
                          </tbody>
                        </table>
                  </div>
                  <div class="form-text mt-2">
                    Tip: disable tools an agent doesn’t need to reduce tool-call noise and keep behavior predictable.
                  </div>
                  ` : ''}
                </div>

                <!-- Scheduled jobs Tab -->
                <div class="tab-pane fade" id="scheduled-jobs-panel" role="tabpanel">
                  <div class="mb-3 d-flex align-items-center justify-content-between">
                    <div>
                      <label class="form-label mb-0">Scheduled jobs (this session)</label>
                      <div class="form-text">Cron and interval jobs for this session only. To see all sessions, use the Scheduled jobs item in the main navigation.</div>
                    </div>
                    <button type="button" class="btn btn-outline-primary btn-sm" id="scheduled-jobs-refresh-btn" data-action="refresh-scheduled-jobs" title="Refresh list">
                      <i class="bi bi-arrow-clockwise me-1"></i>Refresh
                    </button>
                  </div>
                  <div id="scheduled-jobs-content">
                    <div class="text-muted text-center py-4">
                      <i class="bi bi-clock-history fs-2"></i>
                      <p class="mb-0 mt-2">Click the tab or Refresh to load scheduled jobs.</p>
                    </div>
                  </div>
                </div>

                <!-- Orchestrator Tab -->
                <div class="tab-pane fade" id="orchestrator-panel" role="tabpanel">
                  <form id="orchestrator-form">
                    <div class="row mb-3">
                      <div class="col-md-6">
                        <label class="form-label">Orchestrator Provider</label>
                        <select class="form-select" id="config-orchestrator-provider" data-action="orchestrator-provider-change">
                          ${this.providers.map(provider => `
                            <option value="${provider.type}" ${this.currentSession.orchestrator_provider_type === provider.type ? 'selected' : ''}>
                              ${provider.type.charAt(0).toUpperCase() + provider.type.slice(1)}
                              ${provider.requiresApiKey ? '' : '(Local)'}
                            </option>
                          `).join('')}
                        </select>
                        <div class="form-text">The main orchestrator agent that routes tasks</div>
                      </div>
                      <div class="col-md-6">
                        <label class="form-label">Orchestrator Model</label>
                        <select class="form-select" id="config-orchestrator-model" data-action="orchestrator-model-change">
                          ${this.getOrchestratorModelOptions(this.currentSession.orchestrator_provider_type || 'claude', currentOrchestratorModel)}
                        </select>
                        <div id="custom-orchestrator-model-display" class="form-text text-info d-none">
                          <i class="bi bi-pencil"></i> Custom: <span id="custom-orchestrator-model-value"></span>
                        </div>
                      </div>
                    </div>

                    <!-- Ollama Configuration (only visible when Ollama is selected) -->
                    <div id="orchestrator-ollama-config" class="row mb-3 d-none">
                      <div class="col-md-6">
                        <label class="form-label">Ollama Address</label>
                        <input type="text" class="form-control" id="config-ollama-address" 
                               placeholder="localhost" value="${this.getOllamaAddress(this.currentSession.orchestrator_provider_config)}">
                        <div class="form-text">Hostname or IP (e.g. 192.168.1.10 for LAN). Full URL also accepted.</div>
                      </div>
                      <div class="col-md-6">
                        <label class="form-label">Ollama Port</label>
                        <input type="number" class="form-control" id="config-ollama-port" 
                               placeholder="11434" min="1" max="65535" value="${this.getOllamaPort(this.currentSession.orchestrator_provider_config)}">
                        <div class="form-text">Ollama server port (default from .env)</div>
                      </div>
                      <div class="col-12 mt-2">
                        <button type="button" class="btn btn-outline-secondary btn-sm" data-action="test-ollama-connection" title="Test from this server">
                          Test connection
                        </button>
                        <span id="ollama-test-result" class="ms-2 small text-muted"></span>
                      </div>
                    </div>

                    <!-- API Key Configuration (only visible when provider requires API key) -->
                    <div id="orchestrator-api-key-config" class="row mb-3 ${this.currentSession.orchestrator_provider_type === 'ollama' ? 'd-none' : ''}">
                      <div class="col-md-12">
                        <label class="form-label">API Key</label>
                        <input type="password" class="form-control" id="config-orchestrator-api-key"
                               placeholder="Leave empty to use .env value"
                               value="${this.getOrchestratorApiKey(this.currentSession.orchestrator_provider_config)}">
                        <div class="form-text">API key for the orchestrator provider. Leave empty to use the value from environment variables (.env).</div>
                      </div>
                    </div>

                    <div class="row mb-3">
                      <div class="col-md-6">
                        <label class="form-label">Timeout (ms)</label>
                        <input type="number" class="form-control" id="config-orchestrator-timeout"
                               value="${this.getOrchestratorTimeout(this.currentSession.orchestrator_provider_config)}"
                               min="1000" max="600000" step="1000">
                        <div class="form-text">Request timeout in milliseconds (default: 60000 = 60 seconds)</div>
                      </div>
                    </div>

                    <div class="mb-3">
                      <div class="form-check form-switch">
                        <input class="form-check-input" type="checkbox" id="config-orchestrator-enable-prompt-cache"
                               ${this.currentSession.orchestrator_provider_config?.enablePromptCache ? 'checked' : ''}>
                        <label class="form-check-label" for="config-orchestrator-enable-prompt-cache">
                          Enable prompt caching (use if your model supports it)
                        </label>
                      </div>
                      <div class="form-text text-muted">Reduces cost per million tokens when the model caches repeated context. Disable if you see API errors.</div>
                    </div>
                  </form>
                </div>

                <!-- Brainstorming/Conversation Mode Tab -->
                <div class="tab-pane fade" id="brainstorming-panel" role="tabpanel">
                  <form id="brainstorming-form">
                    <div class="mb-4">
                      <div class="form-check form-switch">
                        <input class="form-check-input" type="checkbox" id="config-conversation-mode"
                               data-action="conversation-mode-toggle"
                               ${this.currentSession.conversation_mode_enabled ? 'checked' : ''}>
                        <label class="form-check-label" for="config-conversation-mode">
                          <strong>Enable Conversation Mode (AI Brainstorming)</strong>
                        </label>
                      </div>
                      <div class="form-text">
                        When enabled, agents will engage in autonomous multi-turn discussions,
                        building on each other's ideas to brainstorm solutions.
                      </div>
                    </div>

                    <div id="conversation-mode-settings" class="${this.currentSession.conversation_mode_enabled ? '' : 'd-none'}">
                      <div class="row mb-3">
                        <div class="col-md-6">
                          <label class="form-label">Max Rounds</label>
                          <input type="number" class="form-control" id="config-max-rounds"
                                 value="${this.currentSession.conversation_max_rounds || 10}"
                                 min="1" max="100">
                          <div class="form-text">Maximum discussion rounds before auto-stopping (1-100)</div>
                        </div>
                        <div class="col-md-6">
                          <label class="form-label">Token Budget</label>
                          <input type="number" class="form-control" id="config-token-budget"
                                 value="${this.currentSession.conversation_token_budget || 50000}"
                                 min="1000" max="500000" step="1000">
                          <div class="form-text">Maximum tokens for the conversation (1,000-500,000)</div>
                        </div>
                      </div>

                      <div class="alert alert-secondary">
                        <h6><i class="bi bi-lightbulb me-2"></i>How Brainstorming Works</h6>
                        <ol class="mb-0 small">
                          <li>Enter a topic or question in the chat</li>
                          <li>The orchestrator selects which agent should respond first</li>
                          <li>Agents take turns contributing ideas, building on each other</li>
                          <li>Discussion continues until you stop it, max rounds, or the orchestrator concludes</li>
                          <li>You can interject with new messages at any time</li>
                        </ol>
                      </div>
                    </div>

                    <div class="alert alert-warning ${this.currentSession.conversation_mode_enabled ? 'd-none' : ''}" id="conversation-mode-disabled-alert">
                      <i class="bi bi-exclamation-triangle me-2"></i>
                      Conversation mode is disabled. Enable it to allow multi-agent brainstorming sessions.
                    </div>
                  </form>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-action="save-session-config">
                Save Changes
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById('sessionConfigModal');
    if (existingModal) {
      existingModal.remove();
    }

    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // When Scheduled jobs tab is shown, load jobs
    const configTabsEl = document.getElementById('configTabs');
    if (configTabsEl) {
      configTabsEl.addEventListener('shown.bs.tab', (e) => {
        if (e.target.getAttribute('data-bs-target') === '#scheduled-jobs-panel') {
          window.sessionConfig.loadScheduledJobs(window.sessionConfig.currentSession?.id ?? null, 'scheduled-jobs-content');
        }
      });
    }

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('sessionConfigModal'));
    modal.show();
    
    // Set initial Ollama config visibility
    setTimeout(() => {
      this.onOrchestratorProviderChange();
    }, 100);

    // Update custom model display if set
    this.updateCustomOrchestratorModelDisplay();

    // Update tool resource path displays (local_working_folder, sqlite_local_db)
    this.updateAllToolResourcePathDisplays();

    // Attach event handler for Insert Artifact Prompt button
    const insertArtifactBtn = document.getElementById('insert-artifact-prompt-btn');
    if (insertArtifactBtn) {
      insertArtifactBtn.addEventListener('click', () => {
        const textarea = document.getElementById('config-session-desc');
        if (textarea) {
          const artifactPrompt = '\n\nAgents in this session can create interactive HTML/JavaScript artifacts by outputting code blocks with ```html or ```iframe. These will be rendered as interactive iframes in the chat interface, allowing for visualizations, charts, interactive tools, and other dynamic content.';
          
          // Append to the end of the textarea content
          textarea.value = textarea.value + artifactPrompt;
          
          // Move cursor to the end
          textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
          
          // Focus the textarea
          textarea.focus();
        }
      });
    }

    // Insert Predefined Prompt (orchestrator)
    const insertPredefinedBtn = document.getElementById('insert-predefined-prompt-btn');
    if (insertPredefinedBtn) {
      insertPredefinedBtn.addEventListener('click', (e) => {
        this.showPredefinedPromptsPopup(e.target.closest('button'), 'config-session-desc');
      });
    }

    // Load default prompt if description is empty
    const descTextarea = document.getElementById('config-session-desc');
    if (descTextarea && !descTextarea.value.trim()) {
      await this.loadDefaultOrchestratorPrompt();
    }

    // Attach event handler for Load Default Prompt button
    const loadDefaultBtn = document.getElementById('load-default-prompt-btn');
    if (loadDefaultBtn) {
      loadDefaultBtn.addEventListener('click', async () => {
        const textarea = document.getElementById('config-session-desc');
        if (textarea) {
          // Confirm if textarea has content
          if (textarea.value.trim() && !confirm('This will replace the current content with the default prompt. Continue?')) {
            return;
          }
          await this.loadDefaultOrchestratorPrompt();
        }
      });
    }
  }

  /**
   * Load the default orchestrator prompt into the textarea
   */
  async loadDefaultOrchestratorPrompt() {
    try {
      const textarea = document.getElementById('config-session-desc');
      if (!textarea || !this.currentSession?.id) return;

      // Show loading state
      const loadBtn = document.getElementById('load-default-prompt-btn');
      if (loadBtn) {
        loadBtn.disabled = true;
        loadBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Loading...';
      }

      const response = await api.sessions.getDefaultPrompt(this.currentSession.id);
      if (response.success && response.data?.prompt) {
        textarea.value = response.data.prompt;
        textarea.focus();
      }
    } catch (error) {
      console.error('Error loading default prompt:', error);
      showToast('Failed to load default prompt', 'danger');
    } finally {
      // Reset button state
      const loadBtn = document.getElementById('load-default-prompt-btn');
      if (loadBtn) {
        loadBtn.disabled = false;
        loadBtn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Load Default Prompt';
      }
    }
  }

  /**
   * Get available documents from documentManager
   */
  getAvailableDocuments() {
    return window.documentManager?.getDocuments() || [];
  }

  /**
   * Load available tools from API (for tools matrix)
   */
  async loadAvailableTools() {
    if (Array.isArray(this._availableToolsCache)) return this._availableToolsCache;
    try {
      const response = await api.tools.list();
      if (response && response.success && response.data && Array.isArray(response.data.tools)) {
        this._availableToolsCache = response.data.tools;
      } else {
        this._availableToolsCache = [];
      }
    } catch (e) {
      console.error('Error loading tools:', e);
      this._availableToolsCache = [];
    }
    return this._availableToolsCache;
  }

  /**
   * Get available tools from cache
   */
  getAvailableTools() {
    return Array.isArray(this._availableToolsCache) ? this._availableToolsCache : [];
  }

  /**
   * Check if document is assigned to current session
   */
  isDocumentAssigned(docId) {
    const assignedDocs = this.currentSession?.documents || [];
    return assignedDocs.some(d => d.id === docId);
  }

  /**
   * Check if a document is assigned to a specific agent (uses session.document_agent_assignment_map)
   */
  isDocumentAssignedToAgent(docId, agentId) {
    const map = this.currentSession?.document_agent_assignment_map || {};
    const agentIds = map[docId] || map[String(docId)] || [];
    return agentIds.includes(agentId);
  }

  /**
   * Load orchestrator tool assignments from API
   */
  async loadOrchestratorTools() {
    if (!this.currentSession?.id) return;
    try {
      const response = await api.sessions.getOrchestratorTools(this.currentSession.id);
      if (response && response.success && response.data) {
        const assignments = response.data.assignments || [];
        this.currentSession.orchestrator_tools = assignments.map(a => a.tool_name);
        this.currentSession.orchestrator_tool_assignments = assignments;
      } else {
        this.currentSession.orchestrator_tools = [];
        this.currentSession.orchestrator_tool_assignments = [];
      }
    } catch (e) {
      console.error('Error loading orchestrator tools:', e);
      this.currentSession.orchestrator_tools = [];
      this.currentSession.orchestrator_tool_assignments = [];
    }
  }

  /**
   * Check if a tool is assigned to the orchestrator
   */
  isOrchestratorToolAssigned(toolName) {
    const tools = this.currentSession?.orchestrator_tools || [];
    return tools.includes(toolName);
  }

  /**
   * Load scheduled jobs and render. In config dialog pass currentSession.id to show only this session's jobs.
   * @param {number|null} sessionId - If set, only jobs for this session; otherwise all sessions (for main view).
   * @param {string} containerId - ID of the DOM element to render into.
   */
  async loadScheduledJobs(sessionId = null, containerId = 'scheduled-jobs-content') {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '<div class="text-center py-4"><span class="spinner-border spinner-border-sm me-2"></span>Loading…</div>';
    try {
      const response = await api.sessions.getScheduledJobs(sessionId);
      if (response && response.success && response.data && Array.isArray(response.data.groups)) {
        this.renderScheduledJobsPanel(response.data.groups, containerId);
      } else {
        this.renderScheduledJobsPanel([], containerId);
      }
    } catch (e) {
      console.error('Error loading scheduled jobs:', e);
      if (typeof showToast === 'function') showToast('Failed to load scheduled jobs', 'danger');
      this.renderScheduledJobsPanel([], containerId);
    }
  }

  /**
   * Render the Scheduled jobs panel content (groups by session).
   * @param {Array<{ sessionId: number, sessionName: string, jobs: Array }>} groups
   * @param {string} containerId - ID of the DOM element to render into (default: config dialog container).
   */
  renderScheduledJobsPanel(groups, containerId = 'scheduled-jobs-content') {
    const container = document.getElementById(containerId);
    if (!container) return;
    const escapeHtml = (typeof window !== 'undefined' && window.escapeHtml) ? window.escapeHtml : (t) => (t == null ? '' : String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
    if (!groups || groups.length === 0) {
      container.innerHTML = '<div class="alert alert-secondary mb-0"><i class="bi bi-clock-history me-2"></i>No scheduled jobs. Agents can add them via the <code>session_schedule</code> tool.</div>';
      return;
    }
    let html = '';
    for (const group of groups) {
      const sessionName = escapeHtml(group.sessionName || `Session ${group.sessionId}`);
      html += `<div class="mb-4"><h6 class="text-muted border-bottom pb-1 mb-2"><i class="bi bi-folder2 me-1"></i>${sessionName}</h6>`;
      html += '<div class="table-responsive"><table class="table table-sm table-bordered align-middle mb-0"><thead class="table-light"><tr>';
      html += '<th>ID</th><th>Task key</th><th>Schedule</th><th>Type</th><th>Created by</th><th>Next run</th><th>Last run</th><th>Enabled</th></tr></thead><tbody>';
      for (const job of group.jobs || []) {
        const nextRun = job.next_run_at ? escapeHtml(new Date(job.next_run_at).toLocaleString()) : '—';
        const lastRun = job.last_run_at ? escapeHtml(new Date(job.last_run_at).toLocaleString()) : '—';
        const schedule = escapeHtml((job.schedule_type === 'cron' ? job.schedule_value : `every ${job.schedule_value}s`) || '—');
        const taskType = escapeHtml((job.task_type || '').toLowerCase());
        const taskKey = job.task_key ? escapeHtml(job.task_key) : '—';
        const createdBy = (job.created_by_agent_name && String(job.created_by_agent_name).trim()) ? escapeHtml(job.created_by_agent_name) : '—';
        const enabled = job.enabled ? '<span class="badge bg-success">Yes</span>' : '<span class="badge bg-secondary">No</span>';
        html += `<tr><td>${job.id}</td><td>${taskKey}</td><td><code>${schedule}</code></td><td>${taskType}</td><td>${createdBy}</td><td>${nextRun}</td><td>${lastRun}</td><td>${enabled}</td></tr>`;
      }
      html += '</tbody></table></div></div>';
    }
    container.innerHTML = html;
  }

  /**
   * Get tool config for the orchestrator
   */
  getOrchestratorToolConfig(toolName) {
    const assignments = this.currentSession?.orchestrator_tool_assignments || [];
    const assignment = assignments.find(a => a.tool_name === toolName);
    return assignment?.tool_config || null;
  }

  /**
   * Check if a tool is assigned to a specific agent (uses session.tool_agent_assignment_map)
   */
  isToolAssignedToAgent(toolName, agentId) {
    const map = this.currentSession?.tool_agent_assignment_map || {};
    const agentIds = map[toolName] || [];
    return agentIds.includes(agentId);
  }

  /**
   * Get tool config for a specific agent
   */
  getToolConfigForAgent(toolName, agentId) {
    const assignments = this.currentSession?.tool_agent_assignments || [];
    const assignment = assignments.find(
      a => a.tool_name === toolName && a.agent_id === agentId
    );
    return assignment?.tool_config || null;
  }

  /**
   * Compute SHA256 hash (first 16 hex chars) for resource path - matches backend logic
   */
  async computeResourceHash(sessionId, entityId, name) {
    const str = `${sessionId}-${entityId}-${name}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
  }

  /**
   * Get display path for local_working_folder or sqlite_local_db (matches backend)
   */
  getResourceDisplayPath(toolName, name, hash) {
    const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
    const suffix = `${sanitized}_${hash}`;
    if (toolName === 'local_working_folder') {
      return `storage/agents-workspaces/${suffix}`;
    }
    if (toolName === 'sqlite_local_db') {
      return `storage/agents-dbs/${suffix}.db`;
    }
    return suffix;
  }

  /**
   * Update the resource path display below a tool config input
   */
  async updateToolResourcePathDisplay(input) {
    const sessionId = input.closest('#tool-agent-matrix')?.dataset?.sessionId;
    if (!sessionId) return;
    const toolName = input.dataset.toolName;
    if (toolName !== 'local_working_folder' && toolName !== 'sqlite_local_db') return;
    const name = (input.value || '').trim();
    const displayEl = input.closest('td')?.querySelector('.tool-resource-path-display');
    if (!displayEl) return;
    if (!name) {
      displayEl.textContent = 'Empty = disabled';
      displayEl.classList.remove('text-primary');
      return;
    }
    const entityId = input.dataset.agentId || 'orchestrator';
    try {
      // local_working_folder supports non-randomized folder names
      if (toolName === 'local_working_folder') {
        const randomizeCb = input.closest('td')?.querySelector('.local-working-folder-randomize');
        const randomizeName = randomizeCb ? randomizeCb.checked : true;
        if (!randomizeName) {
          // In non-randomized mode, the folder is used as-is under storage/agents-workspaces/.
          const safe = name.replace(/^[./\\]+/, '').replace(/\\+/g, '/');
          displayEl.textContent = `storage/agents-workspaces/${safe}`;
          displayEl.classList.add('text-primary');
          return;
        }
      }

      const hash = await this.computeResourceHash(sessionId, entityId, name);
      const path = this.getResourceDisplayPath(toolName, name, hash);
      displayEl.textContent = path;
      displayEl.classList.add('text-primary');
    } catch (e) {
      displayEl.textContent = 'Error computing path';
      displayEl.classList.remove('text-primary');
    }
  }

  /**
   * Update all tool resource path displays in the Tools tab
   */
  async updateAllToolResourcePathDisplays() {
    const matrix = document.getElementById('tool-agent-matrix');
    if (!matrix) return;
    matrix.dataset.sessionId = String(this.currentSession?.id || '');
    const inputs = matrix.querySelectorAll('.tool-config-input, .orchestrator-tool-config-input');
    for (const input of inputs) {
      await this.updateToolResourcePathDisplay(input);
    }
  }

  /**
   * Format file size to human readable
   */
  formatFileSize(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
  }

  /**
   * Get role display name
   */
  getRoleDisplayName(roleId) {
    const roles = {
      legal: 'Legal Advisor',
      accounting: 'Accounting Expert',
      marketing: 'Marketing Strategist',
      sales: 'Sales Consultant',
      logistics: 'Logistics Coordinator',
      production: 'Production Manager',
      hr: 'HR Specialist',
      custom: 'Custom Agent',
    };
    return roles[roleId] || roleId.charAt(0).toUpperCase() + roleId.slice(1);
  }

  /**
   * Best-effort model capability hint for UI display.
   * Backend may also provide `agent.model_capabilities`.
   */
  getModelCapabilities(agent) {
    if (agent?.model_capabilities) return agent.model_capabilities;

    const providerType = (agent?.provider_type || '').toLowerCase();
    const model = (agent?.provider_config?.model || '').toLowerCase();

    let vision = false;
    if (providerType === 'openai') {
      vision = model.includes('4o') || model.includes('vision');
    } else if (providerType === 'xai') {
      vision = model.includes('vision');
    } else if (providerType === 'gemini') {
      vision = true;
    } else if (providerType === 'claude') {
      vision = true;
    } else if (providerType === 'ollama') {
      vision =
        model.includes('vl') ||
        model.includes('vision') ||
        model.includes('llava') ||
        model.includes('moondream');
    } else if (providerType === 'kimi') {
      vision = model.includes('k2');
    }

    return { vision, audio: false, video: false, text: true, thinking: false, prompt_caching_hint: false };
  }

  /**
   * Quick remove agent from session
   */
  async quickRemoveAgent(agentId) {
    if (!this.currentSession) return;

    try {
      await api.sessions.removeAgent(this.currentSession.id, agentId);

      // Update local state
      this.currentSession.agents = (this.currentSession.agents || []).filter(a => a.id !== agentId);

      // Update checkbox
      const checkbox = document.querySelector(`#agent-assignment-list input[value="${agentId}"]`);
      if (checkbox) {
        checkbox.checked = false;
      }

      // Update badge in assigned list
      const badge = document.querySelector(`#agents-panel .badge button[data-agent-id="${agentId}"]`)?.parentElement;
      if (badge) {
        badge.remove();
      }

      // Update tab badge
      const tabBadge = document.querySelector('#agents-tab .badge');
      if (tabBadge) {
        tabBadge.textContent = this.currentSession.agents.length;
      }

      showToast('Agent removed from session', 'success');
    } catch (error) {
      console.error('Error removing agent:', error);
      showToast('Failed to remove agent', 'danger');
    }
  }

  /**
   * Show modal to edit agent's session-specific context
   */
  async showAgentContextModal(agentId) {
    if (!this.currentSession) return;

    const agent = (this.currentSession.agents || []).find(a => a.id === agentId);
    if (!agent) {
      showToast('Agent not found in session', 'danger');
      return;
    }

    // Remove existing modal if any
    const existingModal = document.getElementById('agentContextModal');
    if (existingModal) {
      existingModal.remove();
    }

    const modalHtml = `
      <div class="modal fade" id="agentContextModal" tabindex="-1">
        <div class="modal-dialog" style="max-width: 90vw; width: 90vw; height: 90vh; margin: 5vh auto;">
          <div class="modal-content" style="height: 100%; display: flex; flex-direction: column;">
            <div class="modal-header">
              <h5 class="modal-title">
                <i class="bi bi-chat-text me-2"></i>Session Context: ${escapeHtml(agent.name)}
              </h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body" style="flex: 1; overflow: hidden; display: flex; flex-direction: column;">
              <div style="flex: 1; display: flex; flex-direction: column; min-height: 0;">
                <label class="form-label">
                  <strong>Agent Session Context</strong>
                </label>
                <div class="form-text mb-2">
                  This context is specific to this session and includes team members, assigned tools, and documents.
                  Edit this to customize how the agent behaves in this session.
                </div>
                <textarea class="form-control font-monospace" id="agent-session-context"
                          style="flex: 1; resize: none; min-height: 200px;"
                          placeholder="Loading..."></textarea>
              </div>
              <div class="d-flex gap-2 mt-2 flex-wrap align-items-center">
                <button type="button" class="btn btn-sm btn-outline-secondary" id="load-agent-session-default-btn">
                  <i class="bi bi-arrow-clockwise me-1"></i>Load Default Prompt
                </button>
                <button type="button" class="btn btn-sm btn-outline-info" id="insert-agent-artifact-prompt-btn">
                  <i class="bi bi-code-square me-1"></i>Insert Artifact Prompt
                </button>
                <button type="button" class="btn btn-sm btn-outline-info" id="insert-agent-predefined-prompt-btn">
                  <i class="bi bi-card-text me-1"></i>Insert Predefined Prompt
                </button>
                <span class="form-text align-self-center">
                  Default includes: role instructions, team members, assigned tools & documents
                </span>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-primary" id="save-agent-context-btn">
                <i class="bi bi-check-lg me-1"></i>Save Context
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = new bootstrap.Modal(document.getElementById('agentContextModal'));
    modal.show();

    const textarea = document.getElementById('agent-session-context');
    const saveBtn = document.getElementById('save-agent-context-btn');
    const loadDefaultBtn = document.getElementById('load-agent-session-default-btn');

    // Fetch saved context from API (source of truth) and populate textarea
    try {
      const res = await api.sessions.getAgentContext(this.currentSession.id, agentId);
      const saved = (res?.data?.context != null && res.data.context !== '') ? String(res.data.context) : '';
      textarea.value = saved;
      textarea.placeholder = 'Optional: add custom session context...';
      // Update local state so icon and other UI stay in sync
      agent.session_context = saved;
    } catch (e) {
      console.error('Error loading agent context:', e);
      showToast('Failed to load saved context', 'danger');
      textarea.placeholder = 'Optional: add custom session context...';
    }

    // Load default prompt only when there is no saved context
    if (!textarea.value.trim()) {
      await this.loadAgentSessionDefaultPrompt(agentId);
    }
    textarea.placeholder = 'Optional: add custom session context...';

    // Event handler for Load Default Prompt button
    loadDefaultBtn.addEventListener('click', async () => {
      if (textarea.value.trim() && !confirm('This will replace the current content with the default prompt. Continue?')) {
        return;
      }
      await this.loadAgentSessionDefaultPrompt(agentId);
    });

    // Insert Artifact Prompt (same text as orchestrator)
    const insertAgentArtifactBtn = document.getElementById('insert-agent-artifact-prompt-btn');
    if (insertAgentArtifactBtn) {
      insertAgentArtifactBtn.addEventListener('click', () => {
        const artifactPrompt = '\n\nYou can create interactive HTML/JavaScript artifacts by outputting code blocks with ```html or ```iframe. These will be rendered as interactive iframes in the chat interface, allowing for visualizations, charts, interactive tools, and other dynamic content.';
        textarea.value = textarea.value + artifactPrompt;
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;
        textarea.focus();
      });
    }

    // Insert Predefined Prompt (agent context)
    const insertAgentPredefinedBtn = document.getElementById('insert-agent-predefined-prompt-btn');
    if (insertAgentPredefinedBtn) {
      insertAgentPredefinedBtn.addEventListener('click', (e) => {
        this.showPredefinedPromptsPopup(e.target.closest('button'), 'agent-session-context');
      });
    }

    // Event handler for Save button
    saveBtn.addEventListener('click', async () => {
      try {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Saving...';

        await api.sessions.setAgentContext(this.currentSession.id, agentId, textarea.value);

        // Update local state
        agent.session_context = textarea.value;

        // Update the icon to show filled if has content
        const iconBtn = document.querySelector(`[data-action="edit-agent-context"][data-agent-id="${agentId}"] i`);
        if (iconBtn) {
          iconBtn.className = textarea.value.trim() ? 'bi bi-chat-text-fill' : 'bi bi-chat-text';
        }

        showToast('Agent session context saved', 'success');
        modal.hide();
      } catch (error) {
        console.error('Error saving agent context:', error);
        showToast('Failed to save agent context', 'danger');
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = '<i class="bi bi-check-lg me-1"></i>Save Context';
      }
    });
  }

  /**
   * Load predefined prompts data from JSON (user-editable file). Falls back to inline default if fetch fails.
   */
  async loadPredefinedPromptsData() {
    try {
      const res = await fetch('/data/predefined-prompts.json');
      if (res.ok) {
        const data = await res.json();
        if (data.roles && data.prompts) return data;
      }
    } catch (e) {
      console.warn('Predefined prompts: could not load JSON, using fallback', e);
    }
    return {
      roles: [
        { id: 'orchestrator', label: 'Orchestrator' },
        { id: 'critical_thinker', label: 'Critical Thinker' },
        { id: 'research', label: 'Research' },
        { id: 'planner', label: 'Planner' }
      ],
      prompts: [
        { id: 'challenge-team', label: 'Challenge the team', roles: ['orchestrator'], text: 'Your role is to challenge the team and avoid converging too quickly to an opinion before all leads are followed.' }
      ]
    };
  }

  /**
   * Show two-level popup: roles list, then on hover prompts for that role. On prompt click, insert at cursor in textarea.
   * @param {HTMLElement} anchorButton - Button that opened the popup (for positioning)
   * @param {string} textareaId - ID of the textarea to insert into (e.g. 'config-session-desc' or 'agent-session-context')
   */
  async showPredefinedPromptsPopup(anchorButton, textareaId) {
    const data = await this.loadPredefinedPromptsData();
    const textarea = document.getElementById(textareaId);
    if (!textarea || !data.roles?.length) return;

    const close = () => {
      document.body.removeChild(container);
      document.removeEventListener('keydown', onEscape);
      document.removeEventListener('click', onClickOutside);
    };

    const onEscape = (e) => { if (e.key === 'Escape') close(); };
    const onClickOutside = (e) => {
      if (!container.contains(e.target) && e.target !== anchorButton) close();
    };

    const insertAtCursor = (text) => {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const before = textarea.value.slice(0, start);
      const after = textarea.value.slice(end);
      const insert = text.startsWith(' ') || before.endsWith('\n') || before === '' ? text : ' ' + text;
      textarea.value = before + insert + after;
      textarea.selectionStart = textarea.selectionEnd = start + insert.length;
      textarea.focus();
      close();
    };

    const rect = anchorButton.getBoundingClientRect();
    const margin = 8;
    const rolesWidth = 200;
    const promptsWidth = 360;
    const totalWidth = rolesWidth + promptsWidth;
    const maxHeight = Math.min(400, window.innerHeight * 0.7);
    let left = rect.left;
    let top = rect.bottom + 4;
    if (left + totalWidth > window.innerWidth - margin) {
      left = window.innerWidth - totalWidth - margin;
    }
    if (left < margin) left = margin;
    if (top + maxHeight > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - maxHeight - margin);
    }
    if (top < margin) top = margin;

    const container = document.createElement('div');
    container.className = 'predefined-prompts-popup';
    container.style.cssText = `position: fixed; left: ${left}px; top: ${top}px; z-index: 1060; display: flex; max-height: ${maxHeight}px; box-shadow: 0 0.5rem 1rem rgba(0,0,0,0.15); border-radius: 0.25rem; background: var(--bs-body-bg, #fff); border: 1px solid var(--bs-border-color, #dee2e6);`;

    const rolesEl = document.createElement('div');
    rolesEl.className = 'predefined-prompts-roles';
    rolesEl.style.cssText = `min-width: 160px; max-width: ${rolesWidth}px; max-height: ${maxHeight}px; overflow-y: auto; border-right: 1px solid var(--bs-border-color, #dee2e6);`;
    data.roles.forEach(role => {
      const row = document.createElement('div');
      row.className = 'predefined-role-row';
      row.style.cssText = 'padding: 0.4rem 0.6rem; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';
      row.textContent = role.label;
      row.dataset.roleId = role.id;
      rolesEl.appendChild(row);
    });

    const promptsEl = document.createElement('div');
    promptsEl.className = 'predefined-prompts-list';
    promptsEl.style.cssText = `min-width: 280px; max-width: ${promptsWidth}px; max-height: ${maxHeight}px; overflow-y: auto; padding: 0.25rem;`;
    promptsEl.innerHTML = '<div class="text-muted small p-2">Hover a role to see prompts</div>';

    rolesEl.querySelectorAll('.predefined-role-row').forEach(row => {
      row.addEventListener('mouseenter', () => {
        rolesEl.querySelectorAll('.predefined-role-row').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        const roleId = row.dataset.roleId;
        const promptsForRole = data.prompts.filter(p => p.roles && p.roles.includes(roleId));
        promptsEl.innerHTML = '';
        if (promptsForRole.length === 0) {
          promptsEl.appendChild(document.createTextNode('No prompts for this role.'));
        } else {
          promptsForRole.forEach(p => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn btn-sm btn-outline-secondary text-start w-100 mb-1';
            btn.style.whiteSpace = 'normal';
            btn.textContent = p.label || p.text.slice(0, 60) + (p.text.length > 60 ? '…' : '');
            btn.title = p.text;
            btn.addEventListener('click', (e) => { e.stopPropagation(); insertAtCursor(p.text); });
            promptsEl.appendChild(btn);
          });
        }
      });
    });

    container.appendChild(rolesEl);
    container.appendChild(promptsEl);
    document.body.appendChild(container);
    document.addEventListener('keydown', onEscape);
    setTimeout(() => document.addEventListener('click', onClickOutside), 0);
  }

  /**
   * Strip any existing "## Your Assigned Documents" section and append the fresh one from API
   */
  async appendAgentDocumentsSection(agentId, textarea) {
    if (!textarea || !this.currentSession?.id) return;
    try {
      const res = await api.sessions.getAgentDocumentsSection(this.currentSession.id, agentId);
      const section = res?.data?.section || '';
      if (!section) return;
      let text = textarea.value;
      text = text.replace(/\n## Your Assigned Documents[\s\S]*?(?=\n## |$)/, '');
      textarea.value = (text.trimEnd() + section).trim();
    } catch (e) {
      console.error('Error appending agent documents section:', e);
    }
  }

  /**
   * Strip any existing "## Your Assigned Documents" section and append the fresh one from API (orchestrator)
   */
  async appendOrchestratorDocumentsSection(textarea) {
    if (!textarea || !this.currentSession?.id) return;
    try {
      const res = await api.sessions.getDocumentsSection(this.currentSession.id);
      const section = res?.data?.section || '';
      if (!section) return;
      let text = textarea.value;
      text = text.replace(/\n## Your Assigned Documents[\s\S]*?(?=\n## |$)/, '');
      textarea.value = (text.trimEnd() + section).trim();
    } catch (e) {
      console.error('Error appending orchestrator documents section:', e);
    }
  }

  /**
   * Load the default session prompt for an agent
   */
  async loadAgentSessionDefaultPrompt(agentId) {
    try {
      const textarea = document.getElementById('agent-session-context');
      const loadBtn = document.getElementById('load-agent-session-default-btn');
      
      if (!textarea || !this.currentSession?.id) return;

      // Show loading state
      if (loadBtn) {
        loadBtn.disabled = true;
        loadBtn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Loading...';
      }
      textarea.placeholder = 'Loading default prompt...';

      const response = await api.sessions.getAgentDefaultPrompt(this.currentSession.id, agentId);
      if (response.success && response.data?.prompt) {
        textarea.value = response.data.prompt;
        textarea.focus();
      }
    } catch (error) {
      console.error('Error loading default prompt:', error);
      showToast('Failed to load default prompt', 'danger');
    } finally {
      const loadBtn = document.getElementById('load-agent-session-default-btn');
      if (loadBtn) {
        loadBtn.disabled = false;
        loadBtn.innerHTML = '<i class="bi bi-arrow-clockwise me-1"></i>Load Default Prompt';
      }
    }
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
    
    try {
      const parsedConfig = typeof config === 'string' ? JSON.parse(config) : config;
      if (parsedConfig.baseURL) {
        const url = new URL(parsedConfig.baseURL);
        return url.hostname;
      }
    } catch (e) {
      // Ignore parsing errors
    }
    
    return 'localhost';
  }

  /**
   * Build baseURL from current Ollama address/port form values (same logic as saveConfig)
   */
  buildOllamaBaseURLFromForm() {
    const ollamaAddressRaw = (document.getElementById('config-ollama-address')?.value || 'localhost').trim();
    const ollamaPortRaw = (document.getElementById('config-ollama-port')?.value || '11434').trim();
    let host = 'localhost';
    let port = '11434';
    if (ollamaAddressRaw) {
      try {
        const looksLikeUrl = /^https?:\/\//i.test(ollamaAddressRaw);
        if (looksLikeUrl) {
          const u = new URL(ollamaAddressRaw);
          host = u.hostname;
          port = u.port || '11434';
        } else {
          host = ollamaAddressRaw.replace(/^\/+|\/+$/g, '');
          port = ollamaPortRaw || '11434';
        }
      } catch {
        host = ollamaAddressRaw;
        port = ollamaPortRaw || '11434';
      }
    }
    return `http://${host}:${port}`;
  }

  /**
   * Test Ollama connection using current form values. Shows result in #ollama-test-result.
   */
  async testOllamaConnection() {
    const resultEl = document.getElementById('ollama-test-result');
    if (!resultEl || !this.currentSession) return;
    resultEl.textContent = 'Testing…';
    resultEl.className = 'ms-2 small text-muted';
    try {
      const baseURL = this.buildOllamaBaseURLFromForm();
      const res = await api.sessions.testOllama(this.currentSession.id, baseURL);
      const data = res?.data ?? res;
      if (data.success) {
        const models = (data.models || []).length ? ` (${data.models.length} models)` : '';
        resultEl.textContent = `OK${models}`;
        resultEl.className = 'ms-2 small text-success';
      } else {
        resultEl.textContent = data.message || 'Failed';
        resultEl.className = 'ms-2 small text-danger';
      }
    } catch (err) {
      resultEl.textContent = err.message || 'Request failed';
      resultEl.className = 'ms-2 small text-danger';
    }
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
    
    try {
      const parsedConfig = typeof config === 'string' ? JSON.parse(config) : config;
      if (parsedConfig.baseURL) {
        const url = new URL(parsedConfig.baseURL);
        return url.port || '11434';
      }
    } catch (e) {
      // Ignore parsing errors
    }
    
    return '11434';
  }

  /**
   * Get orchestrator API key from config or empty string
   */
  getOrchestratorApiKey(config) {
    if (!config) {
      return '';
    }
    
    try {
      const parsedConfig = typeof config === 'string' ? JSON.parse(config) : config;
      if (parsedConfig.apiKey) {
        return parsedConfig.apiKey;
      }
    } catch (e) {
      // Ignore parsing errors
    }
    
    return '';
  }

  /**
   * Get orchestrator timeout from config or default
   */
  getOrchestratorTimeout(config) {
    if (!config) {
      return 60000; // Default 60 seconds
    }
    
    try {
      const parsedConfig = typeof config === 'string' ? JSON.parse(config) : config;
      if (parsedConfig.timeout) {
        return parsedConfig.timeout;
      }
    } catch (e) {
      // Ignore parsing errors
    }
    
    return 60000; // Default 60 seconds
  }

  /**
   * Handle orchestrator provider change
   */
  onOrchestratorProviderChange() {
    const providerSelect = document.getElementById('config-orchestrator-provider');
    const modelSelect = document.getElementById('config-orchestrator-model');
    const ollamaConfig = document.getElementById('orchestrator-ollama-config');

    if (!providerSelect || !modelSelect) return;

    const providerType = providerSelect.value;
    const sessionProvider = this.currentSession?.orchestrator_provider_type;
    const isSameProvider = sessionProvider === providerType;

    if (!isSameProvider) {
      this.customOrchestratorModel = null;
    }

    // Determine which model to use when updating options
    let modelToUse = null;
    const currentModelValue = modelSelect.value;
    const provider = this.providers.find(p => p.type === providerType);
    const isCurrentModelValidForProvider = provider?.availableModels?.some(m => m.id === currentModelValue);

    // Only use currentModelValue if it's valid for the NEW provider (same provider, or valid cross-provider)
    if (isSameProvider && this.currentOrchestratorModel) {
      modelToUse = this.currentOrchestratorModel;
      const isCustomModel = modelToUse && (
        !provider?.availableModels ||
        !provider.availableModels.length ||
        !provider.availableModels.some(m => m.id === modelToUse)
      );
      if (isCustomModel && !this.customOrchestratorModel) {
        this.customOrchestratorModel = modelToUse;
      }
    } else if (currentModelValue && currentModelValue !== '__custom__' && currentModelValue !== '' && isCurrentModelValidForProvider) {
      modelToUse = currentModelValue;
      this.customOrchestratorModel = null;
    } else if (currentModelValue === '__custom__' && this.customOrchestratorModel) {
      modelToUse = this.customOrchestratorModel;
    } else if (this.customOrchestratorModel) {
      modelToUse = this.customOrchestratorModel;
    }

    // Prevent change event from firing when we update options (avoids prompt dialog)
    this._updatingOrchestratorModel = true;
    modelSelect.innerHTML = this.getOrchestratorModelOptions(providerType, modelToUse);
    this._updatingOrchestratorModel = false;

    // Update custom model display
    this.updateCustomOrchestratorModelDisplay();
    
    // Show/hide Ollama config fields
    if (ollamaConfig) {
      if (providerType === 'ollama') {
        ollamaConfig.classList.remove('d-none');
      } else {
        ollamaConfig.classList.add('d-none');
      }
    }
    
    // Show/hide API key config field (only for providers that require API key)
    const apiKeyConfig = document.getElementById('orchestrator-api-key-config');
    if (apiKeyConfig) {
      if (providerType === 'ollama') {
        apiKeyConfig.classList.add('d-none');
      } else {
        apiKeyConfig.classList.remove('d-none');
      }
    }
  }

  /**
   * Handle orchestrator model change
   */
  onOrchestratorModelChange() {
    if (this._updatingOrchestratorModel) return;

    const modelSelect = document.getElementById('config-orchestrator-model');
    if (!modelSelect) return;

    const selectedValue = modelSelect.value;

    if (selectedValue === '__custom__') {
      this.showCustomOrchestratorModelDialog();
    } else {
      this.customOrchestratorModel = null;
      this.updateCustomOrchestratorModelDisplay();
    }
  }

  /**
   * Show dialog to enter custom orchestrator model
   */
  showCustomOrchestratorModelDialog() {
    const customModel = prompt(
      'Enter the custom model ID (e.g., claude-3-5-sonnet-20241022):',
      this.customOrchestratorModel || ''
    );

    const modelSelect = document.getElementById('config-orchestrator-model');

    if (customModel && customModel.trim()) {
      this.customOrchestratorModel = customModel.trim();
      this.updateCustomOrchestratorModelDisplay();
    } else {
      // User cancelled or entered empty - revert to first option
      this.customOrchestratorModel = null;
      if (modelSelect && modelSelect.options.length > 0) {
        modelSelect.selectedIndex = 0;
      }
      this.updateCustomOrchestratorModelDisplay();
    }
  }

  /**
   * Update custom orchestrator model display indicator
   */
  updateCustomOrchestratorModelDisplay() {
    const displayDiv = document.getElementById('custom-orchestrator-model-display');
    const valueSpan = document.getElementById('custom-orchestrator-model-value');

    if (!displayDiv || !valueSpan) return;

    if (this.customOrchestratorModel) {
      valueSpan.textContent = this.customOrchestratorModel;
      displayDiv.classList.remove('d-none');
    } else {
      displayDiv.classList.add('d-none');
    }
  }

  /**
   * Quick remove document from session (updates UI inline)
   */
  async quickRemoveDocument(documentId) {
    if (!this.currentSession) return;

    try {
      await api.sessions.removeDocument(this.currentSession.id, documentId);

      // Update local state
      this.currentSession.documents = (this.currentSession.documents || []).filter(d => d.id !== documentId);

      // Update checkbox (per-agent matrix or document-assignment-list)
      const checkbox = document.querySelector(`#document-assignment-list input[value="${documentId}"]`);
      if (checkbox) checkbox.checked = false;
      const orchestratorCb = document.querySelector(`.doc-orchestrator-checkbox[data-document-id="${documentId}"]`);
      if (orchestratorCb) orchestratorCb.checked = false;

      // Update badge in assigned list
      const badge = document.querySelector(`#documents-panel .badge button[data-document-id="${documentId}"]`)?.parentElement;
      if (badge) {
        badge.remove();
      }

      // Update tab badge
      const tabBadge = document.querySelector('#documents-tab .badge');
      if (tabBadge) {
        tabBadge.textContent = this.currentSession.documents.length;
      }

      showToast('Document removed from session', 'success');
    } catch (error) {
      console.error('Error removing document:', error);
      showToast('Failed to remove document', 'danger');
    }
  }

  /**
   * Toggle conversation mode settings visibility
   */
  onConversationModeToggle() {
    const checkbox = document.getElementById('config-conversation-mode');
    const settingsDiv = document.getElementById('conversation-mode-settings');
    const alertDiv = document.getElementById('conversation-mode-disabled-alert');

    if (checkbox && settingsDiv && alertDiv) {
      if (checkbox.checked) {
        settingsDiv.classList.remove('d-none');
        alertDiv.classList.add('d-none');
      } else {
        settingsDiv.classList.add('d-none');
        alertDiv.classList.remove('d-none');
      }
    }
  }

  /**
   * Save session configuration
   */
  async saveConfig() {
    if (!this.currentSession) return;

    try {
      // Get general settings
      const name = document.getElementById('config-session-name').value;
      const description = document.getElementById('config-session-desc').value;
      const contextLength = parseInt(document.getElementById('config-context-length').value) || 50;
      const orchestratorProvider = document.getElementById('config-orchestrator-provider').value;

      // Get orchestrator model
      const modelSelect = document.getElementById('config-orchestrator-model');
      let orchestratorModel = modelSelect ? modelSelect.value : null;

      // Use custom model if set
      if (orchestratorModel === '__custom__' && this.customOrchestratorModel) {
        orchestratorModel = this.customOrchestratorModel;
      } else if (orchestratorModel === '__custom__') {
        orchestratorModel = null; // No custom model entered
      } else if (!orchestratorModel && this.customOrchestratorModel && orchestratorProvider === 'gemini') {
        // Gemini-specific fallback: use custom model if select value was lost (e.g. tab visibility, timing)
        orchestratorModel = this.customOrchestratorModel;
      }

      // Build orchestrator config as object (not string - API expects object)
      const orchestratorConfig = orchestratorModel ? { model: orchestratorModel } : {};
      
      // Add API key if specified (only for providers that require it)
      if (orchestratorProvider !== 'ollama') {
        const apiKeyInput = document.getElementById('config-orchestrator-api-key');
        if (apiKeyInput && apiKeyInput.value && apiKeyInput.value.trim()) {
          orchestratorConfig.apiKey = apiKeyInput.value.trim();
        }
      }
      
      // Add Ollama baseURL if Ollama is selected
      if (orchestratorProvider === 'ollama') {
        const ollamaAddressRaw = (document.getElementById('config-ollama-address')?.value || 'localhost').trim();
        const ollamaPortRaw = (document.getElementById('config-ollama-port')?.value || '11434').trim();
        let host = 'localhost';
        let port = '11434';
        if (ollamaAddressRaw) {
          try {
            const looksLikeUrl = /^https?:\/\//i.test(ollamaAddressRaw);
            if (looksLikeUrl) {
              const u = new URL(ollamaAddressRaw);
              host = u.hostname;
              port = u.port || '11434';
            } else {
              host = ollamaAddressRaw.replace(/^\/+|\/+$/g, '');
              port = ollamaPortRaw || '11434';
            }
          } catch {
            host = ollamaAddressRaw;
            port = ollamaPortRaw || '11434';
          }
        }
        orchestratorConfig.baseURL = `http://${host}:${port}`;
      }
      
      // Add timeout if specified
      const timeoutInput = document.getElementById('config-orchestrator-timeout');
      if (timeoutInput && timeoutInput.value) {
        const timeout = parseInt(timeoutInput.value);
        if (timeout && timeout >= 1000 && timeout <= 600000) {
          orchestratorConfig.timeout = timeout;
        }
      }

      // Prompt caching (user enables if model supports it)
      const enablePromptCacheEl = document.getElementById('config-orchestrator-enable-prompt-cache');
      orchestratorConfig.enablePromptCache = enablePromptCacheEl?.checked || false;
      
      // Only set config if it has content
      const finalConfig = Object.keys(orchestratorConfig).length > 0 ? orchestratorConfig : null;

      // Get conversation mode settings
      const conversationModeEnabled = document.getElementById('config-conversation-mode')?.checked || false;
      const maxRounds = parseInt(document.getElementById('config-max-rounds')?.value) || 10;
      const tokenBudget = parseInt(document.getElementById('config-token-budget')?.value) || 50000;

      // Update session
      await api.sessions.update(this.currentSession.id, {
        name,
        description,
        context_length: contextLength,
        orchestrator_provider_type: orchestratorProvider,
        orchestrator_provider_config: finalConfig,
        conversation_mode_enabled: conversationModeEnabled ? 1 : 0,
        conversation_max_rounds: maxRounds,
        conversation_token_budget: tokenBudget,
      });

      // Get selected agents
      const selectedAgentIds = Array.from(document.querySelectorAll('.agent-checkbox:checked'))
        .map(cb => parseInt(cb.value));

      const currentAgentIds = (this.currentSession.agents || []).map(a => a.id);

      // Agents to add
      const agentsToAdd = selectedAgentIds.filter(id => !currentAgentIds.includes(id));

      // Agents to remove
      const agentsToRemove = currentAgentIds.filter(id => !selectedAgentIds.includes(id));

      // Save orchestrator tool assignments
      const orchestratorToolCheckboxes = Array.from(document.querySelectorAll('.orchestrator-tool-checkbox'));
      const orchestratorToolConfigInputs = Array.from(document.querySelectorAll('.orchestrator-tool-config-input'));
      const orchestratorEfApiBlocks = Array.from(document.querySelectorAll('.ef-api-config-block[data-is-orchestrator="true"]'));
      const orchestratorOpenMemoryBlocks = Array.from(document.querySelectorAll('.open-memory-config-block[data-is-orchestrator="true"]'));
      
      const orchestratorAssignments = [];
      
      // Handle regular checkboxes
      for (const cb of orchestratorToolCheckboxes) {
        if (cb.checked) {
          orchestratorAssignments.push({ tool_name: cb.dataset.toolName });
        }
      }
      
      // Handle tool config inputs (e.g., sqlite_local_db, local_working_folder)
      for (const input of orchestratorToolConfigInputs) {
        const toolName = input.dataset.toolName;
        const configValue = (input.value || '').trim();
        
        if (!toolName) continue;
        
        // If there's a value, the tool is enabled
        if (configValue) {
          const assignment = { tool_name: toolName };
          if (toolName === 'sqlite_local_db') {
            assignment.tool_config = { database_name: configValue };
            orchestratorAssignments.push(assignment);
          } else if (toolName === 'local_working_folder') {
            const td = input.closest('td');
            const randomizeCb = td?.querySelector('.local-working-folder-randomize');
            const randomizeName = randomizeCb ? !!randomizeCb.checked : true;
            assignment.tool_config = { folder_name: configValue, randomize_name: randomizeName };
            orchestratorAssignments.push(assignment);
          } else {
            assignment.tool_config = { value: configValue };
            orchestratorAssignments.push(assignment);
          }
        }
      }
      
      // Handle ef_api orchestrator config blocks (base_url, username, password)
      for (const block of orchestratorEfApiBlocks) {
        const toolName = block.dataset.toolName;
        if (toolName !== 'ef_api') continue;
        const baseUrl = (block.querySelector('[data-config-key="base_url"]')?.value || '').trim();
        const username = (block.querySelector('[data-config-key="username"]')?.value || '').trim();
        const password = (block.querySelector('[data-config-key="password"]')?.value || '').trim();
        if (baseUrl && username && password) {
          const verifySsl = block.querySelector('[data-config-key="reject_unauthorized"]')?.checked !== false;
          orchestratorAssignments.push({
            tool_name: 'ef_api',
            tool_config: { base_url: baseUrl, username, password, reject_unauthorized: verifySsl }
          });
        }
      }
      
      // Handle open_memory orchestrator config blocks
      for (const block of orchestratorOpenMemoryBlocks) {
        const toolName = block.dataset.toolName;
        if (toolName !== 'open_memory') continue;
        const baseUrl = (block.querySelector('[data-config-key="base_url"]')?.value || '').trim();
        if (baseUrl) {
          const apiKey = (block.querySelector('[data-config-key="api_key"]')?.value || '').trim();
          const sessionScope = (block.querySelector('[data-config-key="session_scope"]')?.value || '').trim();
          const agentScope = (block.querySelector('[data-config-key="agent_scope"]')?.value || '').trim();
          const verifySsl = block.querySelector('[data-config-key="reject_unauthorized"]')?.checked !== false;
          orchestratorAssignments.push({
            tool_name: 'open_memory',
            tool_config: { base_url: baseUrl, api_key: apiKey || undefined, session_scope: sessionScope, agent_scope: agentScope, reject_unauthorized: verifySsl }
          });
        }
      }
      
      await api.sessions.setOrchestratorTools(this.currentSession.id, orchestratorAssignments);

      // Add new agents
      if (agentsToAdd.length > 0) {
        await api.sessions.assignAgents(this.currentSession.id, agentsToAdd);
      }

      // Remove agents
      for (const agentId of agentsToRemove) {
        await api.sessions.removeAgent(this.currentSession.id, agentId);
      }

      // Save document matrix: Orchestrator column + per-agent columns (always present when documents tab is rendered)
      const matrixCheckboxes = Array.from(document.querySelectorAll('.doc-agent-checkbox'));
      const orchestratorDocCheckboxes = Array.from(document.querySelectorAll('.doc-orchestrator-checkbox'));
      if (orchestratorDocCheckboxes.length > 0 || matrixCheckboxes.length > 0) {
        const orchestratorDocumentIds = orchestratorDocCheckboxes
          .filter(cb => cb.checked)
          .map(cb => parseInt(cb.dataset.documentId))
          .filter(id => Number.isFinite(id));
        const map = {};
        for (const cb of matrixCheckboxes) {
          const docId = parseInt(cb.dataset.documentId);
          const agentId = parseInt(cb.dataset.agentId);
          if (!Number.isFinite(docId) || !Number.isFinite(agentId)) continue;
          if (!map[docId]) map[docId] = [];
          if (cb.checked) map[docId].push(agentId);
        }
        // Include every document that appears in the table so backend can clear unchecked agents
        const allDocIdsInTable = [...new Set([
          ...orchestratorDocCheckboxes.map(cb => parseInt(cb.dataset.documentId)).filter(id => Number.isFinite(id)),
          ...matrixCheckboxes.map(cb => parseInt(cb.dataset.documentId)).filter(id => Number.isFinite(id)),
        ])];
        const assignments = allDocIdsInTable.map(documentId => ({
          documentId,
          agentIds: map[documentId] || [],
        }));
        await api.sessions.setDocumentAgentAssignments(this.currentSession.id, assignments, orchestratorDocumentIds);
        const keptDocIds = [...new Set([...orchestratorDocumentIds, ...Object.keys(map).map(Number).filter(docId => (map[docId] || []).length > 0)])];
        const allDocs = window.documentManager?.getDocuments() || [];
        this.currentSession.documents = keptDocIds
          .map(id => allDocs.find(d => d.id === id))
          .filter(Boolean);
        this.currentSession.documents.sort((a, b) => (a.filename || '').localeCompare(b.filename || ''));
      }

      // Save per-agent tool matrix (toolName -> [agentIds] + toolConfigs)
      const toolCheckboxes = Array.from(document.querySelectorAll('.tool-agent-checkbox'));
      const toolConfigInputs = Array.from(document.querySelectorAll('.tool-config-input'));
      const agentEfApiBlocks = Array.from(document.querySelectorAll('.ef-api-config-block[data-agent-id]'));
      const agentOpenMemoryBlocks = Array.from(document.querySelectorAll('.open-memory-config-block[data-agent-id]'));
      
      if (toolCheckboxes.length > 0 || toolConfigInputs.length > 0 || agentEfApiBlocks.length > 0 || agentOpenMemoryBlocks.length > 0) {
        const map = {};
        const toolConfigsMap = {};
        
        // Handle regular checkboxes
        for (const cb of toolCheckboxes) {
          const toolName = cb.dataset.toolName;
          const agentId = parseInt(cb.dataset.agentId);
          if (!toolName || !Number.isFinite(agentId)) continue;
          if (!map[toolName]) map[toolName] = [];
          if (cb.checked) map[toolName].push(agentId);
        }
        
        // Handle tool config inputs (e.g., sqlite_local_db, local_working_folder)
        for (const input of toolConfigInputs) {
          const toolName = input.dataset.toolName;
          const agentId = parseInt(input.dataset.agentId);
          const configValue = (input.value || '').trim();
          
          if (!toolName || !Number.isFinite(agentId)) continue;
          
          // If there's a value, the tool is enabled
          if (configValue) {
            if (!map[toolName]) map[toolName] = [];
            if (!map[toolName].includes(agentId)) {
              map[toolName].push(agentId);
            }
            
            // Store tool config based on tool type
            if (!toolConfigsMap[toolName]) toolConfigsMap[toolName] = {};
            if (toolName === 'sqlite_local_db') {
              toolConfigsMap[toolName][agentId] = { database_name: configValue };
            } else             if (toolName === 'local_working_folder') {
              const td = input.closest('td');
              const randomizeCb = td?.querySelector('.local-working-folder-randomize');
              const randomizeName = randomizeCb ? !!randomizeCb.checked : true;
              toolConfigsMap[toolName][agentId] = { folder_name: configValue, randomize_name: randomizeName };
            } else {
              // Generic fallback
              toolConfigsMap[toolName][agentId] = { value: configValue };
            }
          }
        }
        
        // Handle ef_api per-agent config blocks
        for (const block of agentEfApiBlocks) {
          const toolName = block.dataset.toolName;
          const agentId = parseInt(block.dataset.agentId);
          if (toolName !== 'ef_api' || !Number.isFinite(agentId)) continue;
          const baseUrl = (block.querySelector('[data-config-key="base_url"]')?.value || '').trim();
          const username = (block.querySelector('[data-config-key="username"]')?.value || '').trim();
          const password = (block.querySelector('[data-config-key="password"]')?.value || '').trim();
          if (baseUrl && username && password) {
            const verifySsl = block.querySelector('[data-config-key="reject_unauthorized"]')?.checked !== false;
            if (!map[toolName]) map[toolName] = [];
            if (!map[toolName].includes(agentId)) map[toolName].push(agentId);
            if (!toolConfigsMap[toolName]) toolConfigsMap[toolName] = {};
            toolConfigsMap[toolName][agentId] = { base_url: baseUrl, username, password, reject_unauthorized: verifySsl };
          }
        }
        
        // Handle open_memory per-agent config blocks
        for (const block of agentOpenMemoryBlocks) {
          const toolName = block.dataset.toolName;
          const agentId = parseInt(block.dataset.agentId);
          if (toolName !== 'open_memory' || !Number.isFinite(agentId)) continue;
          const baseUrl = (block.querySelector('[data-config-key="base_url"]')?.value || '').trim();
          if (baseUrl) {
            const apiKey = (block.querySelector('[data-config-key="api_key"]')?.value || '').trim();
            const sessionScope = (block.querySelector('[data-config-key="session_scope"]')?.value || '').trim();
            const agentScopeVal = (block.querySelector('[data-config-key="agent_scope"]')?.value || '').trim();
            const verifySsl = block.querySelector('[data-config-key="reject_unauthorized"]')?.checked !== false;
            if (!map[toolName]) map[toolName] = [];
            if (!map[toolName].includes(agentId)) map[toolName].push(agentId);
            if (!toolConfigsMap[toolName]) toolConfigsMap[toolName] = {};
            toolConfigsMap[toolName][agentId] = { base_url: baseUrl, api_key: apiKey || undefined, session_scope: sessionScope, agent_scope: agentScopeVal, reject_unauthorized: verifySsl };
          }
        }
        
        const assignments = Object.entries(map).map(([toolName, agentIds]) => ({
          toolName,
          agentIds: agentIds,
          toolConfigs: toolConfigsMap[toolName] || {},
        }));
        await api.sessions.setToolAgentAssignments(this.currentSession.id, assignments);
      }

      // Close modal
      const modal = bootstrap.Modal.getInstance(document.getElementById('sessionConfigModal'));
      modal.hide();

      showToast('Session configuration saved', 'success');

      // Reload session in session manager
      if (window.sessionManager) {
        await window.sessionManager.loadSessions();
        await window.sessionManager.selectSession(this.currentSession.id);
      }
    } catch (error) {
      console.error('Error saving session config:', error);
      showToast(error.message || 'Failed to save configuration', 'danger');
    }
  }
}

// Create global instance
window.sessionConfig = new SessionConfig();

// Event delegation for session config actions
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const agentId = target.dataset.agentId ? parseInt(target.dataset.agentId) : null;
  const documentId = target.dataset.documentId ? parseInt(target.dataset.documentId) : null;

  switch (action) {
    case 'create-agent-from-config':
      e.preventDefault();
      agentManager.showCreateModal();
      break;
    case 'upload-document-from-config':
      e.preventDefault();
      documentManager.showUploadModal();
      break;
    case 'quick-remove-agent':
      sessionConfig.quickRemoveAgent(agentId);
      break;
    case 'edit-agent-context':
      sessionConfig.showAgentContextModal(agentId);
      break;
    case 'quick-remove-document':
      sessionConfig.quickRemoveDocument(documentId);
      break;
    case 'save-session-config':
      sessionConfig.saveConfig();
      break;
    case 'refresh-scheduled-jobs':
      // Refresh in config dialog: filter to current session; in main view container may not exist
      if (document.getElementById('scheduled-jobs-content')) {
        sessionConfig.loadScheduledJobs(sessionConfig.currentSession?.id ?? null, 'scheduled-jobs-content');
      } else if (document.getElementById('scheduled-jobs-main-content')) {
        sessionConfig.loadScheduledJobs(null, 'scheduled-jobs-main-content');
      }
      break;
    case 'test-ollama-connection':
      sessionConfig.testOllamaConnection();
      break;
  }
});

// Event delegation for change events (orchestrator provider/model)
document.addEventListener('change', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;

  switch (action) {
    case 'orchestrator-provider-change':
      sessionConfig.onOrchestratorProviderChange();
      break;
    case 'orchestrator-model-change':
      sessionConfig.onOrchestratorModelChange();
      break;
    case 'conversation-mode-toggle':
      sessionConfig.onConversationModeToggle();
      break;
  }
});

// Debounced update for tool resource path displays (local_working_folder, sqlite_local_db)
let _toolResourcePathDebounce = null;
function scheduleToolResourcePathUpdate(input) {
  // Text inputs
  if (input?.matches?.('.tool-config-input, .orchestrator-tool-config-input')) {
    if (input.dataset.toolName !== 'local_working_folder' && input.dataset.toolName !== 'sqlite_local_db') return;
    clearTimeout(_toolResourcePathDebounce);
    _toolResourcePathDebounce = setTimeout(() => {
      sessionConfig.updateToolResourcePathDisplay(input);
    }, 200);
    return;
  }

  // Randomize checkbox: re-render the display using the sibling input
  if (input?.matches?.('.local-working-folder-randomize')) {
    const td = input.closest('td');
    const textInput = td?.querySelector('.tool-config-input[data-tool-name="local_working_folder"], .orchestrator-tool-config-input[data-tool-name="local_working_folder"]');
    if (!textInput) return;
    clearTimeout(_toolResourcePathDebounce);
    _toolResourcePathDebounce = setTimeout(() => {
      sessionConfig.updateToolResourcePathDisplay(textInput);
    }, 50);
  }
}
document.addEventListener('input', (e) => scheduleToolResourcePathUpdate(e.target));
document.addEventListener('change', (e) => scheduleToolResourcePathUpdate(e.target));
