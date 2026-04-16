/**
 * Session Manager Component
 * Handles session creation, loading, and switching
 */

class SessionManager {
  constructor() {
    this.sessions = [];
    this.currentSession = null;
  }

  /**
   * Load all sessions for the current user
   */
  async loadSessions() {
    try {
      const response = await api.sessions.list();
      this.sessions = response.data.sessions;

      this.renderSessionsList();

      return this.sessions;
    } catch (error) {
      console.error('Error loading sessions:', error);
      showToast('Failed to load sessions', 'danger');
      return [];
    }
  }

  /**
   * Render sessions list in sidebar
   */
  renderSessionsList() {
    const sessionsList = document.getElementById('sessions-list');

    if (this.sessions.length === 0) {
      sessionsList.innerHTML = `
        <div class="text-center p-4 text-muted">
          <i class="bi bi-folder2-open" style="font-size: 2rem;"></i>
          <p class="mt-2 mb-0">No sessions yet</p>
          <p class="small">Create one to get started</p>
        </div>
      `;
      return;
    }

    sessionsList.innerHTML = this.sessions.map(session => `
      <div
        class="list-group-item list-group-item-action ${session.id === this.currentSession?.id ? 'active' : ''}"
        data-action="select-session" data-session-id="${session.id}"
        style="cursor: pointer;"
      >
        <div class="d-flex justify-content-between align-items-start">
          <div class="flex-grow-1 d-flex align-items-center gap-2">
            ${session.pinned ? '<i class="bi bi-pin-fill text-warning" title="Pinned"></i>' : ''}
            <h6 class="mb-1">${escapeHtml(session.name)}</h6>
          </div>
          <div class="d-flex align-items-center">
            <small class="text-muted">${formatDate(session.last_accessed_at)}</small>
            ${(session.conversation_mode_enabled === 1 || session.conversation_mode_enabled === true)
              ? '<i class="bi bi-chat-dots text-muted ms-2" title="Conversation mode enabled"></i>'
              : ''}
          </div>
        </div>
      </div>
    `).join('');
  }

  /**
   * Select a session
   */
  async selectSession(sessionId) {
    try {
      const response = await api.sessions.get(sessionId);
      this.currentSession = response.data.session;
      if (typeof window.clearSessionPoolModifiedHighlight === 'function') {
        window.clearSessionPoolModifiedHighlight();
      }

      // Update UI
      this.renderSessionsList();
      this.updateSessionInfo();
      this.updateChatHeader();
      this.updateAgentInfo();

      // Load chat messages
      if (window.chatInterface) {
        await window.chatInterface.loadMessages(sessionId);
      }

      // Enable chat input
      document.getElementById('chat-input').disabled = false;
      document.getElementById('send-btn').disabled = false;

      // Dispatch session changed event for other components (like conversationMode)
      document.dispatchEvent(new CustomEvent('sessionChanged', {
        detail: { session: this.currentSession }
      }));

      showToast(`Switched to session: ${this.currentSession.name}`, 'success');
    } catch (error) {
      console.error('Error selecting session:', error);
      showToast('Failed to load session', 'danger');
    }
  }

  /**
   * Update session info panel
   */
  updateSessionInfo() {
    if (!this.currentSession) {
      document.getElementById('session-info-card').classList.add('d-none');
      return;
    }

    document.getElementById('session-info-card').classList.remove('d-none');
    document.getElementById('current-session-name').textContent = this.currentSession.name;

    // Show agent and document counts
    const agentCount = this.currentSession.agents?.length || 0;
    const docCount = this.currentSession.documents?.length || 0;

    document.getElementById('current-session-desc').textContent =
      `${agentCount} agents • ${docCount} documents`;

    // Update pin button state
    this.updatePinButton();
  }

  /**
   * Update chat header with session name
   */
  updateChatHeader() {
    const header = document.getElementById('chat-session-header');
    if (!header) return;

    if (this.currentSession) {
      header.innerHTML = `
        <i class="bi bi-chat-dots-fill"></i>
        Chat for session ${escapeHtml(this.currentSession.name)}
      `;
    } else {
      header.innerHTML = `
        <i class="bi bi-chat-dots-fill"></i>
        Session Chat
      `;
    }
  }

  /**
   * Update agent info header with agents, tools, and documents
   */
  updateAgentInfo() {
    const agentInfoHeader = document.getElementById('chat-agent-info-header');
    const agentInfoContent = document.getElementById('chat-agent-info-content');
    
    if (!agentInfoHeader || !agentInfoContent) return;

    if (!this.currentSession) {
      agentInfoHeader.classList.add('d-none');
      return;
    }

    // Check if there are per-agent document assignments
    const hasPerAgentDocAssignments = this.currentSession.document_agent_assignments && 
                                      this.currentSession.document_agent_assignments.length > 0;

    // Build HTML tables - start with orchestrator table
    const agentTables = [];
    
    // Add orchestrator table
    if (this.currentSession.orchestrator_provider_type) {
      const orchestratorProvider = escapeHtml(this.currentSession.orchestrator_provider_type || 'N/A');
      const orchestratorModel = this.currentSession.orchestrator_provider_config?.model 
        ? escapeHtml(this.currentSession.orchestrator_provider_config.model) 
        : 'N/A';
      const orchestratorContextFull = this.currentSession.description || '';
      const orchestratorContext = orchestratorContextFull
        ? (orchestratorContextFull.length > 100 
            ? escapeHtml(orchestratorContextFull.substring(0, 100)) + '...'
            : escapeHtml(orchestratorContextFull))
        : 'None';
      
      const orchestratorTableHtml = `
        <table class="table table-sm table-bordered mb-0 small agent-detail-table" style="width: auto;">
          <thead>
            <tr>
              <th colspan="2" class="text-center bg-success text-white small position-relative agent-table-header" style="cursor: pointer;" title="Long press to collapse/expand">
                <i class="bi bi-chevron-up collapse-indicator" style="position: absolute; left: 5px; top: 50%; transform: translateY(-50%); font-size: 0.7em; opacity: 0.7;"></i>
                Orchestrator
                <i class="bi bi-question-circle orchestrator-info-icon" style="position: absolute; right: 5px; top: 50%; transform: translateY(-50%); font-size: 0.8em; cursor: pointer; opacity: 0.8;" title="Orchestrator details"></i>
              </th>
            </tr>
          </thead>
          <tbody class="small agent-table-body" style="display: none;">
            <tr>
              <th class="bg-light text-center small">Provider</th>
              <td class="small">${orchestratorProvider}</td>
            </tr>
            <tr>
              <th class="bg-light text-center small">Model</th>
              <td class="small">${orchestratorModel}</td>
            </tr>
            <tr>
              <th class="bg-light text-center small align-top">Initial Context</th>
              <td class="small" style="white-space: pre-wrap; max-width: 300px; word-wrap: break-word;">${orchestratorContext}</td>
            </tr>
          </tbody>
        </table>
      `;
      agentTables.push(orchestratorTableHtml);
    }

    // Build HTML tables for each agent
    if (!this.currentSession.agents || this.currentSession.agents.length === 0) {
      // If no agents but we have orchestrator, show just orchestrator
      if (agentTables.length > 0) {
        agentInfoContent.innerHTML = agentTables.join('');
        agentInfoHeader.classList.remove('d-none');
        this.attachOrchestratorInfoHandler();
      } else {
        agentInfoContent.innerHTML = '';
        agentInfoHeader.classList.add('d-none');
      }
      return;
    }
    
    for (const agent of this.currentSession.agents) {
      const agentName = escapeHtml(agent.name);
      
      // Get tools for this agent
      const tools = [];
      if (this.currentSession.tool_agent_assignments) {
        for (const assignment of this.currentSession.tool_agent_assignments) {
          if (assignment.agent_id === agent.id && assignment.tool_name) {
            tools.push(escapeHtml(assignment.tool_name));
          }
        }
      }
      
      // Get documents for this agent
      const documents = [];
      if (hasPerAgentDocAssignments) {
        // Only show documents specifically assigned to this agent
        const agentDocIds = new Set();
        for (const assignment of this.currentSession.document_agent_assignments) {
          if (assignment.agent_id === agent.id && assignment.document_id) {
            agentDocIds.add(assignment.document_id);
          }
        }
        
        // Get document names
        if (this.currentSession.documents) {
          for (const doc of this.currentSession.documents) {
            if (agentDocIds.has(doc.id)) {
              documents.push(escapeHtml(doc.filename || doc.name || `Document ${doc.id}`));
            }
          }
        }
      } else {
        // If no per-agent assignments, all session documents apply to all agents
        if (this.currentSession.documents) {
          for (const doc of this.currentSession.documents) {
            documents.push(escapeHtml(doc.filename || doc.name || `Document ${doc.id}`));
          }
        }
      }
      
      // Build table HTML for this agent
      const maxRows = Math.max(tools.length, documents.length, 1);
      let tableRows = '';
      
      // Build data rows
      for (let i = 0; i < maxRows; i++) {
        const tool = i < tools.length ? tools[i] : '';
        const doc = i < documents.length ? documents[i] : '';
        const toolEscaped = tool ? escapeHtml(tool) : '';
        const docEscaped = doc ? escapeHtml(doc) : '';
        const toolClickable = tool ? `class="small clickable-copy" data-copy-text="${toolEscaped.replace(/"/g, '&quot;')}" style="cursor: pointer;" title="Click to copy"` : 'class="small"';
        const docClickable = doc ? `class="small clickable-copy" data-copy-text="${docEscaped.replace(/"/g, '&quot;')}" style="cursor: pointer;" title="Click to copy"` : 'class="small"';
        tableRows += `<tr><td ${toolClickable}>${toolEscaped}</td><td ${docClickable}>${docEscaped}</td></tr>`;
      }
      
      // Only create table if there are tools or documents
      if (tools.length > 0 || documents.length > 0) {
        const agentNameEscaped = escapeHtml(agentName);
        const tableHtml = `
          <table class="table table-sm table-bordered mb-0 small agent-detail-table" style="width: auto;">
            <thead>
              <tr>
                <th colspan="2" class="text-center bg-primary text-white small clickable-copy position-relative agent-table-header" data-copy-text="${agentNameEscaped.replace(/"/g, '&quot;')}" style="cursor: pointer;" title="Click to copy, long press to collapse/expand">
                  <i class="bi bi-chevron-up collapse-indicator" style="position: absolute; left: 5px; top: 50%; transform: translateY(-50%); font-size: 0.7em; opacity: 0.7;"></i>
                  <button type="button" class="btn btn-sm btn-outline-light edit-agent-btn ${window.isShareMode ? 'd-none' : ''}" data-action="edit-agent" data-agent-id="${agent.id}" style="position: absolute; left: 20px; top: 50%; transform: translateY(-50%); padding: 1px 4px; font-size: 0.7em; line-height: 1;" title="Edit agent">
                    <i class="bi bi-pencil"></i>
                  </button>
                  ${agentNameEscaped}
                  <i class="bi bi-question-circle agent-info-icon" data-agent-id="${agent.id}" style="position: absolute; right: 5px; top: 50%; transform: translateY(-50%); font-size: 0.8em; cursor: pointer; opacity: 0.8;" title="Agent details"></i>
                </th>
              </tr>
              <tr>
                <th class="bg-light text-center small"><i class="bi bi-tools"></i></th>
                <th class="bg-light text-center small"><i class="bi bi-file-earmark-text"></i></th>
              </tr>
            </thead>
            <tbody class="small agent-table-body" style="display: none;">
              ${tableRows}
            </tbody>
          </table>
        `;
        agentTables.push(tableHtml);
      }
    }
    
    if (agentTables.length > 0) {
      agentInfoContent.innerHTML = agentTables.join('');
      agentInfoHeader.classList.remove('d-none');
      
      // Add click handlers for copy-to-clipboard functionality
      this.attachCopyHandlers();
      
      // Add click handlers for agent info icons
      this.attachAgentInfoHandlers();
      
      // Add click handler for orchestrator info icon
      this.attachOrchestratorInfoHandler();
      
      // Add long-press handlers for collapsing/expanding tables
      this.attachTableCollapseHandlers();
    } else {
      agentInfoContent.innerHTML = '';
      agentInfoHeader.classList.add('d-none');
    }
  }

  /**
   * Attach click handler for orchestrator info icon
   */
  attachOrchestratorInfoHandler() {
    const orchestratorIcon = document.querySelector('#chat-agent-info-content .orchestrator-info-icon');
    if (!orchestratorIcon || !this.currentSession) return;
    
    orchestratorIcon.addEventListener('click', (e) => {
      e.stopPropagation();
      
      const orchestratorData = {
        name: 'Orchestrator',
        provider_type: this.currentSession.orchestrator_provider_type || 'N/A',
        model: this.currentSession.orchestrator_provider_config?.model || 'N/A',
        initial_context: this.currentSession.description || 'None'
      };
      
      this.showAgentInfoDialog(orchestratorData);
    });
  }

  /**
   * Attach click handlers for agent info question mark icons
   * Shows saved session context if any, otherwise the default prompt (same as Configure session → Session Context).
   */
  attachAgentInfoHandlers() {
    const infoIcons = document.querySelectorAll('#chat-agent-info-content .agent-info-icon');
    
    infoIcons.forEach(icon => {
      icon.addEventListener('click', async (e) => {
        e.stopPropagation(); // Prevent triggering the copy action on the parent
        const agentId = parseInt(icon.dataset.agentId);
        if (!agentId || !this.currentSession || !this.currentSession.agents) return;

        const agent = this.currentSession.agents.find(a => a.id === agentId);
        if (!agent) {
          showToast('Agent information not found', 'warning');
          return;
        }

        let promptLabel = 'Default prompt';
        let promptContent = agent.initial_context || 'None';

        try {
          const contextRes = await api.sessions.getAgentContext(this.currentSession.id, agentId);
          const rawContext = contextRes?.data?.context;
          const saved = (rawContext != null && String(rawContext).trim() !== '') ? String(rawContext) : '';
          if (saved) {
            promptLabel = 'Session context (saved)';
            promptContent = saved;
          } else {
            const defaultRes = await api.sessions.getAgentDefaultPrompt(this.currentSession.id, agentId);
            if (defaultRes?.data?.prompt != null) {
              promptLabel = 'Default prompt (as in Configure session → Session Context)';
              promptContent = defaultRes.data.prompt;
            }
          }
        } catch (err) {
          console.error('Error loading agent prompt for details:', err);
          showToast('Could not load session context; showing agent default.', 'warning');
        }

        const agentData = {
          name: agent.name,
          role: agent.role || 'N/A',
          provider_type: agent.provider_type || 'N/A',
          model: agent.provider_config?.model || 'N/A',
          promptLabel,
          promptContent
        };

        this.showAgentInfoDialog(agentData);
      });
    });
  }

  /**
   * Show agent information dialog
   */
  showAgentInfoDialog(agentData) {
    // Remove existing modal if any
    const existingModal = document.getElementById('agentInfoModal');
    if (existingModal) {
      existingModal.remove();
    }

    const modalHtml = `
      <div class="modal fade" id="agentInfoModal" tabindex="-1">
        <div class="modal-dialog modal-dialog-centered">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">${escapeHtml(agentData.name)} Information</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <dl class="row mb-3">
                <dt class="col-sm-4">Name:</dt>
                <dd class="col-sm-8">${escapeHtml(agentData.name)}</dd>
                
                <dt class="col-sm-4">Role:</dt>
                <dd class="col-sm-8"><span class="badge bg-primary">${escapeHtml(agentData.role)}</span></dd>
                
                <dt class="col-sm-4">Provider:</dt>
                <dd class="col-sm-8">${escapeHtml(agentData.provider_type)}</dd>
                
                <dt class="col-sm-4">Model:</dt>
                <dd class="col-sm-8">${escapeHtml(agentData.model)}</dd>
              </dl>
              <p class="small text-muted mb-1"><strong>${escapeHtml(agentData.promptLabel || 'Prompt')}</strong></p>
              <div class="border rounded p-3 bg-light" style="max-height: 400px; overflow-y: auto; white-space: pre-wrap; font-size: 0.9em;">
                ${escapeHtml(agentData.promptContent || '')}
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = new bootstrap.Modal(document.getElementById('agentInfoModal'));
    modal.show();
    
    // Clean up modal when hidden
    document.getElementById('agentInfoModal').addEventListener('hidden.bs.modal', function() {
      this.remove();
    });
  }

  /**
   * Attach long-press handlers for collapsing/expanding agent detail tables
   */
  attachTableCollapseHandlers() {
    const tableHeaders = document.querySelectorAll('#chat-agent-info-content .agent-table-header');
    
    tableHeaders.forEach(header => {
      let pressTimer = null;
      let isLongPress = false;
      
      const startPress = (e) => {
        // Don't trigger on buttons or icons
        if (e.target.closest('button') || e.target.closest('.agent-info-icon') || e.target.closest('.orchestrator-info-icon') || e.target.closest('.edit-agent-btn')) {
          return;
        }
        
        isLongPress = false;
        pressTimer = setTimeout(() => {
          isLongPress = true;
          this.toggleTableCollapse(header);
        }, 500); // 500ms for long press
      };
      
      const endPress = (e) => {
        if (pressTimer) {
          clearTimeout(pressTimer);
          pressTimer = null;
        }
      };
      
      // Mouse events
      header.addEventListener('mousedown', startPress);
      header.addEventListener('mouseup', endPress);
      header.addEventListener('mouseleave', endPress);
      
      // Touch events for mobile
      header.addEventListener('touchstart', (e) => {
        e.preventDefault(); // Prevent mouse events from firing
        startPress(e);
      });
      header.addEventListener('touchend', (e) => {
        e.preventDefault();
        endPress(e);
      });
      header.addEventListener('touchcancel', (e) => {
        e.preventDefault();
        endPress(e);
      });
    });
  }

  /**
   * Toggle collapse state of an agent detail table
   */
  toggleTableCollapse(header) {
    const table = header.closest('.agent-detail-table');
    if (!table) return;
    
    const tbody = table.querySelector('.agent-table-body');
    const indicator = header.querySelector('.collapse-indicator');
    
    if (!tbody || !indicator) return;
    
    const isCollapsed = tbody.style.display === 'none';
    
    if (isCollapsed) {
      tbody.style.display = '';
      indicator.classList.remove('bi-chevron-up');
      indicator.classList.add('bi-chevron-down');
    } else {
      tbody.style.display = 'none';
      indicator.classList.remove('bi-chevron-down');
      indicator.classList.add('bi-chevron-up');
    }
  }

  /**
   * Attach click handlers for copy-to-clipboard on agent info elements
   */
  attachCopyHandlers() {
    const copyableElements = document.querySelectorAll('#chat-agent-info-content .clickable-copy');
    
    copyableElements.forEach(element => {
      element.addEventListener('click', async (e) => {
        // Don't trigger copy if clicking on buttons, icons, or interactive elements
        if (e.target.closest('button') || e.target.closest('.agent-info-icon') || e.target.closest('.orchestrator-info-icon') || e.target.closest('[data-action]')) {
          return;
        }
        
        const textToCopy = element.dataset.copyText;
        if (!textToCopy) return;
        
        try {
          await navigator.clipboard.writeText(textToCopy);
          showToast(`Copied "${textToCopy}" to clipboard`, 'success');
        } catch (error) {
          console.error('Failed to copy to clipboard:', error);
          // Fallback for older browsers
          try {
            const textArea = document.createElement('textarea');
            textArea.value = textToCopy;
            textArea.style.position = 'fixed';
            textArea.style.opacity = '0';
            document.body.appendChild(textArea);
            textArea.select();
            document.execCommand('copy');
            document.body.removeChild(textArea);
            showToast(`Copied "${textToCopy}" to clipboard`, 'success');
          } catch (fallbackError) {
            console.error('Fallback copy failed:', fallbackError);
            showToast('Failed to copy to clipboard', 'danger');
          }
        }
      });
    });
  }

  /**
   * Update pin button state
   */
  updatePinButton() {
    const pinBtn = document.getElementById('pin-session-btn');
    const pinIcon = document.getElementById('pin-session-icon');

    if (!pinBtn || !pinIcon || !this.currentSession) {
      return;
    }

    const isPinned = this.currentSession.pinned === 1 || this.currentSession.pinned === true;

    if (isPinned) {
      pinIcon.className = 'bi bi-pin-fill';
      pinBtn.classList.remove('btn-outline-warning');
      pinBtn.classList.add('btn-warning');
      pinBtn.title = 'Unpin session';
    } else {
      pinIcon.className = 'bi bi-pin';
      pinBtn.classList.remove('btn-warning');
      pinBtn.classList.add('btn-outline-warning');
      pinBtn.title = 'Pin session';
    }
  }

  /**
   * Toggle pin status of current session
   */
  async togglePin() {
    if (!this.currentSession) {
      showToast('Please select a session first', 'warning');
      return;
    }

    try {
      const response = await api.sessions.pin(this.currentSession.id);
      this.currentSession = response.data.session;
      if (typeof window.clearSessionPoolModifiedHighlight === 'function') {
        window.clearSessionPoolModifiedHighlight();
      }

      // Update UI
      this.updatePinButton();
      await this.loadSessions(); // Reload to update order
      this.updateSessionInfo();

      const isPinned = this.currentSession.pinned === 1 || this.currentSession.pinned === true;
      showToast(`Session ${isPinned ? 'pinned' : 'unpinned'} successfully`, 'success');
    } catch (error) {
      console.error('Error toggling pin:', error);
      showToast(error.message || 'Failed to toggle pin status', 'danger');
    }
  }

  /**
   * Create new session
   */
  async createSession() {
    // Show modal with form
    const name = prompt('Enter session name:');
    if (!name) return;

    const description = prompt('Enter session description (optional):');

    try {
      const response = await api.sessions.create({
        name,
        description,
        context_length: 50,
      });

      const newSession = response.data.session;

      showToast('Session created successfully', 'success');

      // Reload sessions and select the new one
      await this.loadSessions();
      await this.selectSession(newSession.id);
    } catch (error) {
      console.error('Error creating session:', error);
      showToast(error.message || 'Failed to create session', 'danger');
    }
  }

  /**
   * Configure session
   */
  async configureSession() {
    if (!this.currentSession) {
      showToast('Please select a session first', 'warning');
      return;
    }

    // TODO: Show proper modal with form
    const name = prompt('Enter new session name:', this.currentSession.name);
    if (!name) return;

    const description = prompt('Enter new description:', this.currentSession.description);

    try {
      await api.sessions.update(this.currentSession.id, {
        name,
        description,
      });

      showToast('Session updated successfully', 'success');

      // Reload sessions
      await this.loadSessions();
      await this.selectSession(this.currentSession.id);
    } catch (error) {
      console.error('Error updating session:', error);
      showToast(error.message || 'Failed to update session', 'danger');
    }
  }

  /**
   * Show share link modal: generate or return share link and offer copy.
   */
  async showShareLinkModal() {
    if (!this.currentSession) {
      showToast('Please select a session first', 'warning');
      return;
    }
    const baseUrl = window.location.origin || '';
    try {
      const response = await api.sessions.generateShareLink(this.currentSession.id, baseUrl);
      const { link, token } = response.data;
      const fullLink = link.startsWith('http') ? link : `${window.location.origin}${link.replace(/^\?/, '/?')}`;
      const modalHtml = `
        <div class="modal fade" id="shareLinkModal" tabindex="-1">
          <div class="modal-dialog">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title"><i class="bi bi-link-45deg me-2"></i>Share session link</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
              </div>
              <div class="modal-body">
                <p class="text-muted small">Anyone with this link can use the session: chat, brainstorm, and manage documents. They cannot change session or agent settings.</p>
                <div class="input-group">
                  <input type="text" class="form-control font-monospace" id="share-link-input" value="${escapeHtml(fullLink)}" readonly>
                  <button type="button" class="btn btn-primary" id="share-link-copy-btn" title="Copy link">
                    <i class="bi bi-clipboard"></i> Copy
                  </button>
                </div>
              </div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
              </div>
            </div>
          </div>
        </div>
      `;
      const existing = document.getElementById('shareLinkModal');
      if (existing) existing.closest('.modal')?.remove();
      document.body.insertAdjacentHTML('beforeend', modalHtml);
      const modalEl = document.getElementById('shareLinkModal');
      const modal = new bootstrap.Modal(modalEl);
      modal.show();
      const inputEl = document.getElementById('share-link-input');
      document.getElementById('share-link-copy-btn').addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(fullLink);
          showToast('Link copied to clipboard', 'success');
        } catch (e) {
          inputEl.select();
          document.execCommand('copy');
          showToast('Link copied to clipboard', 'success');
        }
      });
      modalEl.addEventListener('hidden.bs.modal', () => modalEl.closest('.modal')?.remove(), { once: true });
    } catch (error) {
      console.error('Error generating share link:', error);
      showToast(error.message || 'Failed to generate share link', 'danger');
    }
  }

  /**
   * Export session
   */
  async exportSession() {
    if (!this.currentSession) {
      showToast('Please select a session first', 'warning');
      return;
    }

    // Ask user if they want to include messages
    const includeMessages = confirm(
      'Include session messages in export?\n\n' +
      'Click OK to include all messages\n' +
      'Click Cancel to export only settings (agents, documents, tools)'
    );

    try {
      const response = await api.sessions.export(this.currentSession.id, includeMessages);
      const exportData = response.data;

      // Download as JSON file
      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const suffix = includeMessages ? '_with_messages' : '_settings_only';
      a.download = `${this.currentSession.name.replace(/[^a-z0-9]/gi, '_')}_export${suffix}.json`;
      a.click();

      URL.revokeObjectURL(url);

      const message = includeMessages 
        ? 'Session exported successfully (with messages)' 
        : 'Session exported successfully (settings only)';
      showToast(message, 'success');
    } catch (error) {
      console.error('Error exporting session:', error);
      showToast(error.message || 'Failed to export session', 'danger');
    }
  }

  /**
   * Import session from JSON file
   */
  async importSession() {
    // Create file input
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
        let importData = JSON.parse(text);

        // Debug: log what we read
        console.log('Import file contents keys:', Object.keys(importData || {}));

        // Handle if the data is wrapped (e.g., { data: { session: ... } })
        if (importData && importData.data && importData.data.session) {
          console.log('Unwrapping nested data structure');
          importData = importData.data;
        }

        // Validate import data - must have session object
        if (!importData || !importData.session) {
          console.error('Invalid import data:', importData);
          showToast(`Invalid session file: missing session data. Found keys: ${Object.keys(importData || {}).join(', ')}`, 'danger');
          cleanup();
          return;
        }

        // Prompt for new name (start with original name if available)
        const originalName = importData.session.name || 'New Session';
        const newName = prompt(
          `Enter name for the imported session:\n(Leave empty to use: "${originalName} (Imported)")`,
          originalName
        );

        if (newName === null) {
          // User cancelled
          cleanup();
          return;
        }

        // Use trimmed name if provided and not empty, otherwise use null to trigger default
        const finalName = newName.trim() || null;

        // Show loading toast
        showToast('Importing session...', 'info');

        // Debug: log what we're sending
        console.log('Sending import data with session name:', importData.session?.name);
        console.log('Import data keys:', Object.keys(importData));

        // Import the session (pass null if empty to use default name)
        const response = await api.sessions.import(importData, finalName);
        const session = response.data.session;

        showToast('Session imported successfully', 'success');

        // Reload sessions and select the imported one
        await this.loadSessions();
        await this.selectSession(session.id);
      } catch (error) {
        console.error('Error importing session:', error);
        if (error instanceof SyntaxError) {
          showToast('Invalid JSON file: not valid JSON format', 'danger');
        } else {
          // Show detailed error message
          const errorMsg = error.message || 'Failed to import session';
          console.error('Full error:', errorMsg);
          showToast(errorMsg, 'danger');
        }
      } finally {
        cleanup();
      }
    };

    // Clean up if user cancels
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
   * Duplicate current session
   */
  async duplicateSession() {
    if (!this.currentSession) {
      showToast('Please select a session first', 'warning');
      return;
    }

    try {
      const response = await api.sessions.duplicate(this.currentSession.id);
      const newSession = response.data.session;

      showToast(`Session duplicated: ${newSession.name}`, 'success');

      // Reload sessions and select the new one
      await this.loadSessions();
      await this.selectSession(newSession.id);
    } catch (error) {
      console.error('Error duplicating session:', error);
      showToast(error.message || 'Failed to duplicate session', 'danger');
    }
  }

  /**
   * Delete current session
   */
  async deleteSession() {
    if (!this.currentSession) {
      showToast('Please select a session first', 'warning');
      return;
    }

    if (!confirm(`Are you sure you want to delete session "${this.currentSession.name}"? This action cannot be undone.`)) {
      return;
    }

    try {
      await api.sessions.delete(this.currentSession.id);

      showToast('Session deleted successfully', 'success');

      this.currentSession = null;
      if (typeof window.clearSessionPoolModifiedHighlight === 'function') {
        window.clearSessionPoolModifiedHighlight();
      }

      // Reload sessions
      await this.loadSessions();

      // Clear chat interface
      if (window.chatInterface) {
        window.chatInterface.clearMessages();
      }

      // Disable chat input
      document.getElementById('chat-input').disabled = true;
      document.getElementById('send-btn').disabled = true;

      // Reset chat header and agent info
      this.updateChatHeader();
      this.updateAgentInfo();
    } catch (error) {
      console.error('Error deleting session:', error);
      showToast(error.message || 'Failed to delete session', 'danger');
    }
  }

  /**
   * Get current session
   */
  getCurrentSession() {
    return this.currentSession;
  }


  /**
   * Show session actions modal
   */
  showActionsModal() {
    if (!this.currentSession) {
      showToast('Please select a session first', 'warning');
      return;
    }

    // Remove existing modal if any
    const existingModal = document.getElementById('sessionActionsModal');
    if (existingModal) {
      existingModal.remove();
    }

    const modalHtml = `
      <div class="modal fade" id="sessionActionsModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">Session: ${escapeHtml(this.currentSession.name)}</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="d-grid gap-2">
                <button class="btn btn-outline-primary" data-action="export-session">
                  <i class="bi bi-download me-2"></i>Export Session
                </button>
                <button class="btn btn-outline-success" data-action="import-session">
                  <i class="bi bi-upload me-2"></i>Import Session
                </button>
                <button class="btn btn-outline-secondary" data-action="duplicate-session">
                  <i class="bi bi-files me-2"></i>Duplicate Session
                </button>
                <hr>
                <button class="btn btn-outline-danger" data-action="delete-session">
                  <i class="bi bi-trash me-2"></i>Delete Session
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = new bootstrap.Modal(document.getElementById('sessionActionsModal'));
    modal.show();
  }

}

// Create global instance
window.sessionManager = new SessionManager();

// Event delegation for session manager actions
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const sessionId = target.dataset.sessionId ? parseInt(target.dataset.sessionId) : null;

  // Helper to close modal
  const closeActionsModal = () => {
    const modal = bootstrap.Modal.getInstance(document.getElementById('sessionActionsModal'));
    if (modal) modal.hide();
  };

  switch (action) {
    case 'select-session':
      sessionManager.selectSession(sessionId);
      break;
    case 'export-session':
      sessionManager.exportSession();
      closeActionsModal();
      break;
    case 'import-session':
      sessionManager.importSession();
      closeActionsModal();
      break;
    case 'duplicate-session':
      sessionManager.duplicateSession();
      closeActionsModal();
      break;
    case 'delete-session':
      sessionManager.deleteSession();
      closeActionsModal();
      break;
  }
});
