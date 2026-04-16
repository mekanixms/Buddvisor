/**
 * Main Application Logic
 */

let currentUser = null;
let currentSession = null;

window.isShareMode = false;
window.shareSessionId = null;

// Check authentication on page load
document.addEventListener('DOMContentLoaded', async () => {
  const shareMatch = window.location.search && window.location.search.match(/[?&]share=([^&]+)/);
  if (shareMatch && shareMatch[1]) {
    try {
      const res = await api.request('POST', '/auth/share-exchange', { token: shareMatch[1].trim() });
      if (res.success && res.data && res.data.token) {
        api.setToken(res.data.token);
        window.isShareMode = true;
        window.shareSessionId = res.data.shareSessionId || null;
        if (window.history && window.history.replaceState) {
          window.history.replaceState(null, '', window.location.pathname || '/');
        }
      }
    } catch (e) {
      console.error('Share exchange failed:', e);
      showToast('Invalid or expired share link', 'danger');
      window.location.href = '/login.html';
      return;
    }
  }

  if (!api.getToken()) {
    window.location.href = '/login.html';
    return;
  }

  try {
    // Get current user (or share-mode pseudo user)
    const response = await api.auth.getCurrentUser();
    currentUser = response.data.user;
    window.currentUser = currentUser; // Make globally accessible

    // Restore share mode on refresh: JWT is still share token but URL no longer has ?share=
    if (currentUser.isShareMode === true || currentUser.username === 'share') {
      window.isShareMode = true;
      window.shareSessionId = currentUser.shareSessionId != null ? currentUser.shareSessionId : window.shareSessionId;
    }

    // Update UI
    document.getElementById('username-display').textContent = currentUser.username;

    // In share mode, hide nav/sidebar elements that are not allowed
    if (window.isShareMode) {
      applyShareModeUI();
      if (document.getElementById('username-display')) {
        document.getElementById('username-display').textContent = 'Shared session';
      }
    }

    // Load sessions using SessionManager component (in share mode returns single session)
    await sessionManager.loadSessions();
    if (window.isShareMode && sessionManager.sessions && sessionManager.sessions.length === 1) {
      await sessionManager.selectSession(sessionManager.sessions[0].id);
    }

    // Initialize agent manager
    await agentManager.init();

    // Initialize document manager
    await documentManager.init();

    // Initialize task manager
    await taskManager.init();

    // Initialize tools manager
    window.toolsManager = new ToolsManager('tools-container');

    // Show default view
    showView('chat');
  } catch (error) {
    console.error('Authentication error:', error);
    if (error?.status === 401 || error?.message === 'Unauthorized') {
      api.clearToken();
      window.location.href = '/login.html';
      return;
    }

    // Don't treat transient API errors (e.g. 429) as an auth failure.
    showToast(error?.message || 'Unable to initialize the app. Please try again shortly.', 'danger');
  }
});

/**
 * Apply share mode: hide nav, sidebar actions, and settings that shared users cannot use.
 */
function applyShareModeUI() {
  const hide = (selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      if (el && el.parentNode) el.parentNode.classList.add('d-none');
    });
  };
  const hideSelf = (selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      if (el) el.classList.add('d-none');
    });
  };
  // Nav: hide Tasks, Agents, Tools (keep Chat, Documents)
  hideSelf('#nav-tasks');
  hideSelf('#nav-agents');
  hideSelf('#nav-tools');
  // User menu: hide Settings
  document.querySelectorAll('[data-action="show-settings"]').forEach((el) => {
    const li = el.closest('li');
    if (li) li.classList.add('d-none');
  });
  // Sidebar: hide Create and Import
  hide('[data-action="create-session"]');
  hide('[data-action="import-session"]');
  // Current session card: hide Pin, Delete, Configure, Duplicate, Export, Share
  hideSelf('#pin-session-btn');
  hideSelf('#share-session-link-btn');
  hide('[data-action="delete-session-sidebar"]');
  hide('[data-action="configure-session"]');
  hide('[data-action="duplicate-session"]');
  hide('[data-action="export-session-sidebar"]');

  // Chat agent info: hide edit-agent buttons (keep in DOM, hidden in share mode)
  document.querySelectorAll('.edit-agent-btn').forEach((el) => {
    if (el) el.classList.add('d-none');
  });

  // Hide session selector sidebar (col-md-3) and expand main content to full width
  const sidebar = document.getElementById('session-sidebar') ||
    document.querySelector('.row.h-100 > .col-md-3.d-flex.flex-column.h-100');
  const mainContent = document.getElementById('main-content-area') ||
    document.querySelector('.row.h-100 > .col-md-9.d-flex.flex-column.h-100');
  if (sidebar) sidebar.classList.add('d-none');
  if (mainContent) {
    mainContent.classList.remove('col-md-9');
    mainContent.classList.add('col-12');
  }
}

/**
 * Logout user
 */
async function logout() {
  try {
    await api.auth.logout();
  } catch (error) {
    console.error('Logout error:', error);
  } finally {
    api.clearToken();
    window.location.href = '/login.html';
  }
}

// Note: Session and chat functions are now handled by components:
// - sessionManager (sessionManager.js)
// - chatInterface (chatInterface.js)

/**
 * Show different views
 * @param {string} viewName - View name (chat, tasks, agents, documents)
 */
function showView(viewName) {
  // Hide all views
  document.querySelectorAll('.content-view').forEach(view => {
    view.classList.add('d-none');
  });

  // Show selected view
  document.getElementById(`${viewName}-view`).classList.remove('d-none');

  // Update active nav link
  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.remove('active');
  });

  document.getElementById(`nav-${viewName}`).classList.add('active');

  // Load view-specific data
  if (viewName === 'agents' && window.agentManager) {
    agentManager.loadAgents();
  }
  if (viewName === 'documents' && window.documentManager) {
    documentManager.loadDocuments();
    documentManager.loadStats();
  }
  if (viewName === 'tasks' && window.taskManager) {
    taskManager.loadTasks();
    taskManager.loadStats();
  }
  if (viewName === 'tools' && window.toolsManager) {
    toolsManager.init();
  }
  if (viewName === 'scheduled-jobs' && window.sessionConfig) {
    sessionConfig.loadScheduledJobs(null, 'scheduled-jobs-main-content');
  }
}

/**
 * Create new session
 */
function createSession() {
  sessionManager.createSession();
}

/**
 * Configure session - opens the full configuration modal
 */
function configureSession() {
  sessionConfig.showConfigModal();
}

/**
 * Export session
 */
function exportSession() {
  sessionManager.exportSession();
}

/**
 * Delete session
 */
function deleteSession() {
  sessionManager.deleteSession();
}

/**
 * Send message - routes to chat interface
 */
function sendMessage() {
  if (window.chatInterface) {
    chatInterface.sendMessage();
  }
}

/**
 * Create agent - opens the agent creation modal
 */
function createAgent() {
  agentManager.showCreateModal();
}

/**
 * Upload document - opens the upload modal
 */
function uploadDocument() {
  if (window.documentManager) {
    documentManager.showUploadModal();
  }
}

/**
 * Show settings modal
 */
function showSettings() {
  if (window.settings) {
    settings.showModal();
  }
}

/**
 * Show toast notification
 * @param {string} message - Toast message
 * @param {string} type - Toast type (success, danger, warning, info)
 */
function showToast(message, type = 'info') {
  // Create toast container if it doesn't exist
  let toastContainer = document.getElementById('toast-container');
  if (!toastContainer) {
    toastContainer = document.createElement('div');
    toastContainer.id = 'toast-container';
    toastContainer.className = 'position-fixed bottom-0 end-0 p-3';
    toastContainer.style.zIndex = '11';
    document.body.appendChild(toastContainer);
  }

  // Create toast element
  const toastId = 'toast-' + Date.now();
  const toast = document.createElement('div');
  toast.id = toastId;
  toast.className = `toast align-items-center text-white bg-${type} border-0`;
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `
    <div class="d-flex">
      <div class="toast-body">
        ${escapeHtml(message)}
      </div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast"></button>
    </div>
  `;

  toastContainer.appendChild(toast);

  // Show toast
  const bsToast = new bootstrap.Toast(toast, { delay: 3000 });
  bsToast.show();

  // Remove toast element after it's hidden
  toast.addEventListener('hidden.bs.toast', () => {
    toast.remove();
  });
}

/**
 * Format date
 * @param {string} dateString - Date string
 * @returns {string} - Formatted date
 */
function formatDate(dateString) {
  const date = new Date(dateString);
  const now = new Date();
  const diff = now - date;

  // Less than 1 minute
  if (diff < 60000) {
    return 'Just now';
  }

  // Less than 1 hour
  if (diff < 3600000) {
    const minutes = Math.floor(diff / 60000);
    return `${minutes}m ago`;
  }

  // Less than 24 hours
  if (diff < 86400000) {
    const hours = Math.floor(diff / 3600000);
    return `${hours}h ago`;
  }

  // Less than 7 days
  if (diff < 604800000) {
    const days = Math.floor(diff / 86400000);
    return `${days}d ago`;
  }

  // Otherwise, show date
  return date.toLocaleDateString();
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} - Escaped text
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Prompting recommendations panel (movable dialog, non-modal).
 * Content is loaded from /data/prompting-recommendations.json (user-editable).
 */
let _promptingRecommendationsPanel = null;
let _promptingRecommendationsContentCache = null;

function renderPromptingRecommendations(data) {
  if (!data || !Array.isArray(data.sections)) return '';
  return data.sections.map(section => {
    const title = escapeHtml(section.title || '');
    if (!title) return '';
    let html = `<h6 class="mb-2">${title}</h6>`;
    if (section.body) {
      if (section.note) {
        html += `<p class="small mb-3">${escapeHtml(section.body)}<br><em class="text-muted">${escapeHtml(section.note)}</em></p>`;
      } else {
        html += `<p class="small mb-3">${escapeHtml(section.body)}</p>`;
      }
    }
    if (section.items && section.items.length) {
      html += '<ul class="small mb-0">';
      section.items.forEach(item => {
        html += `<li>${escapeHtml(item)}</li>`;
      });
      html += '</ul>';
    }
    return html;
  }).join('\n');
}

/**
 * Load prompting recommendations from JSON. Returns cached HTML if already loaded.
 * @returns {Promise<string>} HTML string for the panel body
 */
async function loadPromptingRecommendationsData() {
  if (_promptingRecommendationsContentCache) return _promptingRecommendationsContentCache;
  try {
    const res = await fetch('/data/prompting-recommendations.json');
    if (res.ok) {
      const data = await res.json();
      const html = renderPromptingRecommendations(data);
      if (html) {
        _promptingRecommendationsContentCache = html;
        return html;
      }
    }
  } catch (e) {
    console.warn('Prompting recommendations: could not load JSON, using fallback', e);
  }
  const fallback = { sections: [{ title: 'Prompting recommendations', body: 'Edit public/data/prompting-recommendations.json to add content.' }] };
  return renderPromptingRecommendations(fallback);
}

function createPromptingRecommendationsPanel() {
  if (_promptingRecommendationsPanel) return _promptingRecommendationsPanel;
  const panel = document.createElement('div');
  panel.id = 'prompting-recommendations-panel';
  panel.className = 'prompting-recommendations-panel';
  panel.innerHTML = `
    <div class="prompting-recommendations-titlebar">
      <span class="prompting-recommendations-title">Prompting recommendations</span>
      <button type="button" class="btn btn-link btn-sm p-0 text-secondary prompting-recommendations-close" title="Close" aria-label="Close">
        <i class="bi bi-x-lg"></i>
      </button>
    </div>
    <div class="prompting-recommendations-body">Loading…</div>
  `;
  const bodyEl = panel.querySelector('.prompting-recommendations-body');
  loadPromptingRecommendationsData().then(html => { bodyEl.innerHTML = html; });
  const titlebar = panel.querySelector('.prompting-recommendations-titlebar');
  const closeBtn = panel.querySelector('.prompting-recommendations-close');
  closeBtn.addEventListener('click', () => hidePromptingRecommendationsPanel());

  let drag = { active: false, startX: 0, startY: 0, startLeft: 0, startTop: 0 };
  titlebar.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    drag.active = true;
    drag.startX = e.clientX;
    drag.startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    drag.startLeft = rect.left;
    drag.startTop = rect.top;
  });
  document.addEventListener('mousemove', (e) => {
    if (!drag.active) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    panel.style.left = (drag.startLeft + dx) + 'px';
    panel.style.top = (drag.startTop + dy) + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', () => { drag.active = false; });

  document.body.appendChild(panel);
  _promptingRecommendationsPanel = panel;
  return panel;
}

// Baseline pool version per session; when user opens the modal we set this and clear the "modified" highlight
window._sessionPoolBaselineVersion = window._sessionPoolBaselineVersion || {};

/**
 * Clear the session-pool-dump button highlight (e.g. when switching sessions).
 */
function clearSessionPoolModifiedHighlight() {
  const btn = document.getElementById('session-pool-dump-btn');
  if (btn) btn.classList.remove('session-pool-modified');
}

/**
 * Check if session pool was modified (pool_version > baseline) and highlight the dump button if so.
 * Called after chat responses complete so the UI reflects that the pool may have changed.
 */
async function checkSessionPoolModified() {
  const session = window.sessionManager?.currentSession;
  if (!session || !session.id) return;
  const btn = document.getElementById('session-pool-dump-btn');
  if (!btn) return;
  try {
    const res = await api.sessions.getPoolDump(session.id);
    if (!res.assigned || !res.data || typeof res.data.pool_version !== 'number') return;
    const baseline = window._sessionPoolBaselineVersion[session.id] ?? 0;
    if (res.data.pool_version > baseline) {
      btn.classList.add('session-pool-modified');
    }
  } catch (_) {
    // Ignore errors (e.g. no session or network)
  }
}

/**
 * Show session pool dump modal: fetches pool for current session and displays content (if session_pool is assigned).
 */
async function showSessionPoolDumpModal() {
  const session = window.sessionManager?.currentSession;
  if (!session) {
    showToast('Select a session first', 'warning');
    return;
  }
  const btn = document.getElementById('session-pool-dump-btn');
  if (btn) btn.classList.remove('session-pool-modified');

  const existingModal = document.getElementById('sessionPoolDumpModal');
  if (existingModal) {
    existingModal.closest('.modal')?.remove();
  }
  const modalHtml = `
    <div class="modal fade" id="sessionPoolDumpModal" tabindex="-1">
      <div class="modal-dialog modal-lg modal-dialog-scrollable">
        <div class="modal-content">
          <div class="modal-header">
            <h5 class="modal-title"><i class="bi bi-database me-2"></i>Session pool</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
          </div>
          <div class="modal-body">
            <p class="text-muted mb-0">Loading…</p>
          </div>
          <div class="modal-footer">
            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  const modalEl = document.getElementById('sessionPoolDumpModal');
  const bodyEl = modalEl.querySelector('.modal-body');
  const modal = new bootstrap.Modal(modalEl);
  modalEl.addEventListener('hidden.bs.modal', () => modalEl.closest('.modal')?.remove(), { once: true });
  try {
    const res = await api.sessions.getPoolDump(session.id);
    if (!res.assigned) {
      bodyEl.innerHTML = `<p class="text-muted mb-0">${escapeHtml(res.message || 'Session pool is not assigned to any agent in this session.')}</p>`;
    } else {
      const dump = res.data || {};
      window._sessionPoolBaselineVersion[session.id] = dump.pool_version ?? 0;
      const json = JSON.stringify(dump, null, 2);
      bodyEl.innerHTML = `<pre class="mb-0 p-3 bg-light rounded small" style="max-height: 70vh; overflow: auto; white-space: pre-wrap; word-break: break-word;">${escapeHtml(json)}</pre>`;
    }
  } catch (err) {
    bodyEl.innerHTML = `<p class="text-danger mb-0">${escapeHtml(err?.message || 'Failed to load session pool')}</p>`;
  }
  modal.show();
}

function showPromptingRecommendationsPanel() {
  const panel = createPromptingRecommendationsPanel();
  const isVisible = panel.style.display === 'flex';
  if (isVisible) {
    hidePromptingRecommendationsPanel();
    return;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = 380;
  const h = Math.min(520, vh - 80);
  const left = vw - w - 24;
  const top = Math.max(20, (vh - h) / 2);
  panel.style.width = w + 'px';
  panel.style.height = h + 'px';
  panel.style.left = left + 'px';
  panel.style.top = top + 'px';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
  panel.style.display = 'flex';
}

function hidePromptingRecommendationsPanel() {
  if (_promptingRecommendationsPanel) {
    _promptingRecommendationsPanel.style.display = 'none';
  }
}

/**
 * Toggle chat textarea expanded state (more rows for long prompts).
 * @param {HTMLElement} btn - The expand/collapse button
 */
function toggleChatTextareaExpand(btn) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const isExpanded = input.classList.toggle('chat-input-expanded');
  const icon = btn.querySelector('i');
  if (icon) {
    icon.className = isExpanded ? 'bi bi-arrows-collapse' : 'bi bi-arrows-expand';
    icon.style.fontSize = '1.1rem';
  }
  btn.title = isExpanded ? 'Collapse textarea' : 'Expand textarea';
}

// Event delegation for main app actions
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;

  switch (action) {
    // Navigation
    case 'show-view':
      e.preventDefault();
      showView(target.dataset.view);
      break;

    // User menu
    case 'show-settings':
      e.preventDefault();
      showSettings();
      break;
    case 'logout':
      e.preventDefault();
      logout();
      break;

    // Session management
    case 'create-session':
      createSession();
      break;
    case 'import-session':
      e.preventDefault();
      e.stopPropagation();
      sessionManager.importSession();
      break;
    case 'pin-session':
      e.preventDefault();
      sessionManager.togglePin();
      break;
    case 'delete-session-sidebar':
      e.preventDefault();
      sessionManager.deleteSession();
      break;
    case 'configure-session':
      configureSession();
      break;
    case 'export-session-sidebar':
      exportSession();
      break;
    case 'share-session-link':
      e.preventDefault();
      sessionManager.showShareLinkModal();
      break;
    case 'clear-session':
      e.preventDefault();
      chatInterface.clearSession();
      break;
    case 'export-pdf':
      e.preventDefault();
      chatInterface.exportAsPDF();
      break;
    case 'export-image':
      e.preventDefault();
      chatInterface.exportAsImage();
      break;
    case 'show-bookmarks':
      e.preventDefault();
      chatInterface.showBookmarksModal();
      break;

    // Tasks
    case 'show-create-task-modal':
      taskManager.showCreateModal();
      break;
    case 'task-filter':
      const filter = target.dataset.filter || null;
      taskManager.setStatusFilter(filter);
      // Update active state on filter buttons
      target.closest('.btn-group').querySelectorAll('.btn').forEach(btn => btn.classList.remove('active'));
      target.classList.add('active');
      break;

    // Documents
    case 'show-search-modal':
      documentManager.showSearchModal();
      break;
    case 'show-chat-upload-modal':
      e.preventDefault();
      if (!window.sessionManager?.currentSession) {
        showToast('Select a session first', 'warning');
        return;
      }
      if (window.documentManager && window.chatInterface) {
        documentManager.showUploadModal({
          onUploadComplete: (doc) => chatInterface.addPendingDocument(doc),
        });
      }
      break;

    case 'show-prompting-recommendations':
      e.preventDefault();
      showPromptingRecommendationsPanel();
      break;

    case 'show-session-pool-dump':
      e.preventDefault();
      showSessionPoolDumpModal();
      break;

    case 'toggle-chat-textarea-expand':
      e.preventDefault();
      toggleChatTextareaExpand(target);
      break;
  }
});

// Event delegation for change events (streaming toggle, brainstorming toggle)
document.addEventListener('change', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  if (target.dataset.action === 'toggle-streaming') {
    chatInterface.toggleStreaming(target.checked);
  }
  if (target.dataset.action === 'toggle-brainstorming') {
    toggleBrainstorming(target.checked);
  }
});

/**
 * Toggle conversation mode (AI Brainstorming) for the current session
 */
async function toggleBrainstorming(enabled) {
  const session = window.sessionManager?.currentSession;
  if (!session) return;
  try {
    await api.sessions.update(session.id, { conversation_mode_enabled: enabled ? 1 : 0 });
    session.conversation_mode_enabled = enabled ? 1 : 0;
    if (window.chatInterface) {
      window.chatInterface.updateConversationModeBadge();
    }
    showToast(enabled ? 'AI Brainstorming enabled' : 'AI Brainstorming disabled', 'success');
  } catch (err) {
    const toggle = document.getElementById('brainstorming-toggle');
    if (toggle) toggle.checked = !enabled;
    showToast(err?.message || 'Failed to update setting', 'danger');
  }
}
