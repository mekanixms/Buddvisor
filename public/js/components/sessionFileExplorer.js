/**
 * Session storage file explorer
 * Browse, upload, download, create folders, delete, and view files
 * under the current session's storage folder.
 */

class SessionFileExplorer {
  constructor() {
    this.sessionId = null;
    this.currentPath = '';
    this.previewUrl = null;
    this.modalInstance = null;
  }

  static hasLocalWorkingFolder(session) {
    if (!session) return false;
    const hasFolder = (row) =>
      row?.tool_name === 'local_working_folder' &&
      !!(row.tool_config && String(row.tool_config.folder_name || '').trim());
    const agents = (session.tool_agent_assignments || []).some(hasFolder);
    const orch = (session.orchestrator_tool_assignments || []).some(hasFolder);
    return agents || orch;
  }

  async open() {
    const session = window.sessionManager?.currentSession;
    if (!session) {
      showToast('Please select a session first', 'warning');
      return;
    }
    if (!SessionFileExplorer.hasLocalWorkingFolder(session)) {
      showToast('No working folder is enabled for this session', 'warning');
      return;
    }
    this.sessionId = session.id;
    this.currentPath = '';
    this.ensureModal();
    this.modalInstance.show();
    await this.refresh();
  }

  ensureModal() {
    let modalEl = document.getElementById('sessionFileExplorerModal');
    if (!modalEl) {
      document.body.insertAdjacentHTML('beforeend', this.buildModalHtml());
      modalEl = document.getElementById('sessionFileExplorerModal');
      modalEl.addEventListener('hidden.bs.modal', () => {
        this.disposeOwnerTooltips();
        this.revokePreview();
      });
      modalEl.querySelector('#sfe-file-input').addEventListener('change', (e) => {
        this.handleUpload(e.target.files);
        e.target.value = '';
      });
    }
    this.modalInstance = bootstrap.Modal.getOrCreateInstance(modalEl);
  }

  buildModalHtml() {
    return `
      <div class="modal fade" id="sessionFileExplorerModal" tabindex="-1">
        <div class="modal-dialog modal-xl modal-dialog-scrollable">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-folder2-open me-2"></i>Session file explorer</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <p class="small text-muted mb-2">
                Working folders are <code>workspace_{id}</code> (agents) and <code>workspace_orchestrator</code>.
                Upload files there for agents to use. You cannot leave this session folder.
              </p>
              <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
                <nav aria-label="Path" class="flex-grow-1 overflow-auto">
                  <ol class="breadcrumb mb-0 small" id="sfe-breadcrumb"></ol>
                </nav>
                <div class="btn-group btn-group-sm">
                  <button type="button" class="btn btn-outline-secondary" data-action="sfe-refresh" title="Refresh">
                    <i class="bi bi-arrow-clockwise"></i>
                  </button>
                  <button type="button" class="btn btn-outline-primary" data-action="sfe-upload" title="Upload files">
                    <i class="bi bi-upload"></i> Upload
                  </button>
                  <button type="button" class="btn btn-outline-success" data-action="sfe-mkdir" title="New folder">
                    <i class="bi bi-folder-plus"></i> New folder
                  </button>
                </div>
              </div>
              <div class="input-group input-group-sm mb-2 d-none" id="sfe-mkdir-row">
                <input type="text" class="form-control" id="sfe-mkdir-input" placeholder="Folder name" maxlength="255">
                <button type="button" class="btn btn-success" data-action="sfe-mkdir-confirm">Create</button>
                <button type="button" class="btn btn-outline-secondary" data-action="sfe-mkdir-cancel">Cancel</button>
              </div>
              <input type="file" id="sfe-file-input" class="d-none" multiple>
              <div class="row g-3">
                <div class="col-lg-7">
                  <div class="table-responsive border rounded" style="max-height: 50vh;">
                    <table class="table table-sm table-hover mb-0 align-middle">
                      <thead class="table-light sticky-top">
                        <tr>
                          <th>Name</th>
                          <th style="width: 7rem;">Size</th>
                          <th style="width: 11rem;">Modified</th>
                          <th style="width: 7rem;"></th>
                        </tr>
                      </thead>
                      <tbody id="sfe-tbody">
                        <tr><td colspan="4" class="text-muted text-center py-4">Loading…</td></tr>
                      </tbody>
                    </table>
                  </div>
                </div>
                <div class="col-lg-5">
                  <div class="border rounded p-2 sfe-preview-pane" id="sfe-preview">
                    <div class="text-muted small text-center py-5">Select a file to preview (view only)</div>
                  </div>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  async refresh() {
    if (!this.sessionId) return;
    this.disposeOwnerTooltips();
    const tbody = document.getElementById('sfe-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-muted text-center py-4">Loading…</td></tr>`;
    }
    this.renderBreadcrumb();
    try {
      const response = await api.sessions.listStorage(this.sessionId, this.currentPath);
      const entries = response.data?.entries || [];
      this.renderEntries(entries);
    } catch (error) {
      console.error('Error listing session storage:', error);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="4" class="text-danger text-center py-4">${escapeHtml(error.message || 'Failed to list files')}</td></tr>`;
      }
      showToast(error.message || 'Failed to list files', 'danger');
    }
  }

  renderBreadcrumb() {
    const ol = document.getElementById('sfe-breadcrumb');
    if (!ol) return;
    const parts = (this.currentPath || '').split('/').filter(Boolean);
    let acc = '';
    let html = `<li class="breadcrumb-item"><a href="#" data-action="sfe-navigate" data-path="">session</a></li>`;
    parts.forEach((part, i) => {
      acc = acc ? `${acc}/${part}` : part;
      if (i === parts.length - 1) {
        html += `<li class="breadcrumb-item active">${escapeHtml(part)}</li>`;
      } else {
        html += `<li class="breadcrumb-item"><a href="#" data-action="sfe-navigate" data-path="${escapeHtml(acc)}">${escapeHtml(part)}</a></li>`;
      }
    });
    ol.innerHTML = html;
  }

  renderEntries(entries) {
    const tbody = document.getElementById('sfe-tbody');
    if (!tbody) return;
    this.disposeOwnerTooltips();
    if (!entries.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="text-muted text-center py-4">This folder is empty</td></tr>`;
      return;
    }
    tbody.innerHTML = entries.map((ent) => {
      const isDir = ent.type === 'directory' || ent.target_type === 'directory';
      const icon = isDir ? 'bi-folder-fill text-warning' : (ent.type === 'symlink' ? 'bi-link-45deg' : 'bi-file-earmark');
      const size = isDir ? '—' : this.formatSize(ent.size);
      const mtime = ent.mtime ? new Date(ent.mtime).toLocaleString() : '—';
      const badge = ent.type === 'symlink' ? ' <span class="badge text-bg-light border">link</span>' : '';
      const locked = ent.protected
        ? ' <i class="bi bi-lock text-muted" title="Managed workspace link"></i>'
        : '';
      const ownerLabel = (ent.owner_label || '').trim();
      const ownerTip = ownerLabel
        ? ` title="${escapeHtml(ownerLabel)}" data-bs-toggle="tooltip" data-bs-placement="right" data-sfe-owner-tip="1"`
        : '';
      const actions = [];
      if (!isDir) {
        actions.push(`<button type="button" class="btn btn-outline-secondary" data-action="sfe-download" data-path="${escapeHtml(ent.path)}" title="Download"><i class="bi bi-download"></i></button>`);
      }
      if (!ent.protected) {
        actions.push(`<button type="button" class="btn btn-outline-danger" data-action="sfe-delete" data-path="${escapeHtml(ent.path)}" data-name="${escapeHtml(ent.name)}" title="Delete"><i class="bi bi-trash"></i></button>`);
      }
      return `
        <tr>
          <td>
            <a href="#" class="text-decoration-none text-body"
               data-action="sfe-open-entry"
               data-path="${escapeHtml(ent.path)}"
               data-isdir="${isDir ? '1' : '0'}"${ownerTip}>
              <i class="bi ${icon} me-1"></i>${escapeHtml(ent.name)}${badge}${locked}
            </a>
          </td>
          <td class="small text-muted">${size}</td>
          <td class="small text-muted">${escapeHtml(mtime)}</td>
          <td class="text-end">
            <div class="btn-group btn-group-sm">${actions.join('')}</div>
          </td>
        </tr>
      `;
    }).join('');
    this.initOwnerTooltips();
  }

  disposeOwnerTooltips() {
    document.querySelectorAll('#sfe-tbody [data-sfe-owner-tip]').forEach((el) => {
      const tip = bootstrap.Tooltip.getInstance(el);
      if (tip) tip.dispose();
    });
    const modal = document.getElementById('sessionFileExplorerModal');
    (modal || document).querySelectorAll('.tooltip').forEach((node) => node.remove());
  }

  initOwnerTooltips() {
    const modal = document.getElementById('sessionFileExplorerModal');
    document.querySelectorAll('#sfe-tbody [data-sfe-owner-tip]').forEach((el) => {
      bootstrap.Tooltip.getOrCreateInstance(el, {
        container: modal || 'body',
        placement: 'right',
        trigger: 'hover',
      });
    });
  }

  formatSize(bytes) {
    const n = Number(bytes) || 0;
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  navigate(storagePath) {
    this.currentPath = storagePath || '';
    this.clearPreview();
    return this.refresh();
  }

  async openEntry(storagePath, isDir) {
    if (isDir) {
      return this.navigate(storagePath);
    }
    await this.preview(storagePath);
  }

  revokePreview() {
    if (this.previewUrl) {
      URL.revokeObjectURL(this.previewUrl);
      this.previewUrl = null;
    }
  }

  clearPreview() {
    this.revokePreview();
    const pane = document.getElementById('sfe-preview');
    if (pane) {
      pane.innerHTML = `<div class="text-muted small text-center py-5">Select a file to preview (view only)</div>`;
    }
  }

  async preview(storagePath) {
    const pane = document.getElementById('sfe-preview');
    if (!pane) return;
    pane.innerHTML = `<div class="text-muted small text-center py-5">Loading preview…</div>`;
    this.revokePreview();
    try {
      const { blob, contentType } = await api.sessions.fetchStorageFile(this.sessionId, storagePath, 'inline');
      this.previewUrl = URL.createObjectURL(blob);
      const type = (contentType || blob.type || '').split(';')[0].trim().toLowerCase();
      const name = storagePath.split('/').pop() || 'file';
      let inner = '';
      if (type.startsWith('image/')) {
        inner = `<img src="${this.previewUrl}" alt="${escapeHtml(name)}" class="img-fluid">`;
      } else if (type === 'application/pdf') {
        inner = `<iframe src="${this.previewUrl}" title="${escapeHtml(name)}" class="w-100" style="min-height: 45vh; border: 0;" sandbox></iframe>`;
      } else if (type.startsWith('audio/')) {
        inner = `<audio controls class="w-100" src="${this.previewUrl}"></audio>`;
      } else if (type.startsWith('video/')) {
        inner = `<video controls class="w-100" src="${this.previewUrl}" style="max-height: 45vh;"></video>`;
      } else if (type.startsWith('text/') || type === 'application/json' || type === 'application/xml') {
        const text = await blob.text();
        inner = `<pre class="small mb-0 sfe-preview-text">${escapeHtml(text)}</pre>`;
      } else {
        inner = `<div class="text-muted small text-center py-4">Cannot preview this file type. Use Download.</div>`;
      }
      pane.innerHTML = `<div class="small fw-semibold mb-2 text-truncate">${escapeHtml(name)}</div>${inner}`;
    } catch (error) {
      console.error('Error previewing file:', error);
      pane.innerHTML = `<div class="text-danger small text-center py-4">${escapeHtml(error.message || 'Failed to preview')}</div>`;
    }
  }

  async download(storagePath) {
    try {
      const { blob } = await api.sessions.fetchStorageFile(this.sessionId, storagePath, 'attachment');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = storagePath.split('/').pop() || 'download';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      console.error('Error downloading file:', error);
      showToast(error.message || 'Failed to download', 'danger');
    }
  }

  async deletePath(storagePath, name) {
    const label = name || storagePath;
    if (!confirm(`Delete "${label}"? This cannot be undone.`)) return;
    try {
      await api.sessions.deleteStorage(this.sessionId, storagePath);
      showToast('Deleted', 'success');
      if (this.currentPath === storagePath || (this.currentPath && this.currentPath.startsWith(`${storagePath}/`))) {
        this.currentPath = '';
      }
      this.clearPreview();
      await this.refresh();
    } catch (error) {
      console.error('Error deleting:', error);
      showToast(error.message || 'Failed to delete', 'danger');
    }
  }

  triggerUpload() {
    document.getElementById('sfe-file-input')?.click();
  }

  async handleUpload(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    try {
      await api.sessions.uploadStorage(this.sessionId, this.currentPath, files);
      showToast(files.length === 1 ? 'File uploaded' : `${files.length} files uploaded`, 'success');
      await this.refresh();
    } catch (error) {
      console.error('Error uploading:', error);
      showToast(error.message || 'Failed to upload', 'danger');
    }
  }

  showMkdirRow(show) {
    const row = document.getElementById('sfe-mkdir-row');
    const input = document.getElementById('sfe-mkdir-input');
    if (!row) return;
    if (show) {
      row.classList.remove('d-none');
      if (input) {
        input.value = '';
        input.focus();
      }
    } else {
      row.classList.add('d-none');
    }
  }

  async confirmMkdir() {
    const input = document.getElementById('sfe-mkdir-input');
    const name = (input?.value || '').trim();
    if (!name) {
      showToast('Enter a folder name', 'warning');
      return;
    }
    try {
      await api.sessions.mkdirStorage(this.sessionId, this.currentPath, name);
      this.showMkdirRow(false);
      showToast('Folder created', 'success');
      await this.refresh();
    } catch (error) {
      console.error('Error creating folder:', error);
      showToast(error.message || 'Failed to create folder', 'danger');
    }
  }
}

window.sessionFileExplorer = new SessionFileExplorer();

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (!action || !action.startsWith('sfe-')) return;
  const explorer = window.sessionFileExplorer;
  if (!explorer) return;

  switch (action) {
    case 'sfe-refresh':
      e.preventDefault();
      explorer.refresh();
      break;
    case 'sfe-navigate':
      e.preventDefault();
      explorer.navigate(target.dataset.path || '');
      break;
    case 'sfe-open-entry':
      e.preventDefault();
      explorer.openEntry(target.dataset.path || '', target.dataset.isdir === '1');
      break;
    case 'sfe-download':
      e.preventDefault();
      explorer.download(target.dataset.path || '');
      break;
    case 'sfe-delete':
      e.preventDefault();
      explorer.deletePath(target.dataset.path || '', target.dataset.name || '');
      break;
    case 'sfe-upload':
      e.preventDefault();
      explorer.triggerUpload();
      break;
    case 'sfe-mkdir':
      e.preventDefault();
      explorer.showMkdirRow(true);
      break;
    case 'sfe-mkdir-confirm':
      e.preventDefault();
      explorer.confirmMkdir();
      break;
    case 'sfe-mkdir-cancel':
      e.preventDefault();
      explorer.showMkdirRow(false);
      break;
    default:
      break;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = document.getElementById('sfe-mkdir-input');
  if (document.activeElement === input) {
    e.preventDefault();
    window.sessionFileExplorer?.confirmMkdir();
  }
});
