/**
 * Document Manager Component
 * Handles document upload, viewing, and management
 */

class DocumentManager {
  constructor() {
    this.documents = [];
    this.supportedTypes = [];
    this.maxFileSize = 50 * 1024 * 1024; // Default 50MB
    this.selectedDocument = null;
    this.stats = null;
  }

  /**
   * Initialize the document manager
   */
  async init() {
    try {
      // Load supported types
      const typesResponse = await api.documents.getSupportedTypes();
      this.supportedTypes = typesResponse.data.supportedTypes;
      this.maxFileSize = typesResponse.data.maxFileSize;

      await this.loadDocuments();
      await this.loadStats();
    } catch (error) {
      console.error('Error initializing document manager:', error);
      showToast('Failed to initialize document manager', 'danger');
    }
  }

  /**
   * Load all documents for the current user
   */
  async loadDocuments() {
    try {
      const response = await api.documents.list({ orderBy: 'uploaded_at', order: 'DESC' });
      this.documents = response.data.documents;
      this.renderDocumentsList();
      return this.documents;
    } catch (error) {
      console.error('Error loading documents:', error);
      showToast('Failed to load documents', 'danger');
      return [];
    }
  }

  /**
   * Load document statistics
   */
  async loadStats() {
    try {
      const response = await api.documents.getStats();
      this.stats = response.data;
      this.renderStats();
    } catch (error) {
      console.error('Error loading stats:', error);
    }
  }

  /**
   * Render documents list
   */
  renderDocumentsList() {
    const documentsList = document.getElementById('documents-list');
    if (!documentsList) return;

    if (this.documents.length === 0) {
      documentsList.innerHTML = `
        <div class="text-center p-4 text-muted">
          <i class="bi bi-file-earmark-text" style="font-size: 2rem;"></i>
          <p class="mt-2 mb-0">No documents yet</p>
          <p class="small">Upload your first document to get started</p>
          <button class="btn btn-primary btn-sm mt-2" data-action="show-upload-modal">
            <i class="bi bi-upload"></i> Upload Document
          </button>
        </div>
      `;
      return;
    }

    documentsList.innerHTML = this.documents.map(doc => `
      <div class="card mb-2 document-card ${doc.id === this.selectedDocument?.id ? 'border-primary' : ''}"
           data-action="select-document" data-document-id="${doc.id}" style="cursor: pointer;">
        <div class="card-body p-2">
          <div class="d-flex align-items-center">
            <div class="me-3">
              ${this.getFileIcon(doc.file_type)}
            </div>
            <div class="flex-grow-1 overflow-hidden">
              <h6 class="mb-0 text-truncate">${escapeHtml(doc.filename)}</h6>
              <small class="text-muted">
                ${this.formatFileSize(doc.file_size)}
                ${doc.chunk_count > 0 ? `• ${doc.chunk_count} chunks` : '• Processing...'}
              </small>
            </div>
            <div class="dropdown">
              <button class="btn btn-sm btn-link text-muted" type="button"
                      data-bs-toggle="dropdown" data-action="stop-propagation">
                <i class="bi bi-three-dots-vertical"></i>
              </button>
              <ul class="dropdown-menu dropdown-menu-end">
                <li><a class="dropdown-item" href="${api.documents.download(doc.id)}" target="_blank"
                       data-action="download-stop-propagation">
                  <i class="bi bi-download me-2"></i>Download
                </a></li>
                <li><a class="dropdown-item" href="#" data-action="reprocess-document" data-document-id="${doc.id}">
                  <i class="bi bi-arrow-clockwise me-2"></i>Reprocess
                </a></li>
                <li><hr class="dropdown-divider"></li>
                <li><a class="dropdown-item text-danger" href="#" data-action="delete-document" data-document-id="${doc.id}">
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
   * Get file icon based on type
   */
  getFileIcon(fileType) {
    const icons = {
      'application/pdf': '<i class="bi bi-file-earmark-pdf text-danger" style="font-size: 1.5rem;"></i>',
      'application/msword': '<i class="bi bi-file-earmark-word text-primary" style="font-size: 1.5rem;"></i>',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '<i class="bi bi-file-earmark-word text-primary" style="font-size: 1.5rem;"></i>',
      'application/vnd.ms-excel': '<i class="bi bi-file-earmark-excel text-success" style="font-size: 1.5rem;"></i>',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '<i class="bi bi-file-earmark-excel text-success" style="font-size: 1.5rem;"></i>',
      'text/csv': '<i class="bi bi-file-earmark-spreadsheet text-success" style="font-size: 1.5rem;"></i>',
      'text/plain': '<i class="bi bi-file-earmark-text text-secondary" style="font-size: 1.5rem;"></i>',
      'text/markdown': '<i class="bi bi-file-earmark-text text-info" style="font-size: 1.5rem;"></i>',
      'application/json': '<i class="bi bi-file-earmark-code text-warning" style="font-size: 1.5rem;"></i>',
      'image/png': '<i class="bi bi-file-earmark-image text-info" style="font-size: 1.5rem;"></i>',
      'image/jpeg': '<i class="bi bi-file-earmark-image text-info" style="font-size: 1.5rem;"></i>',
    };
    return icons[fileType] || '<i class="bi bi-file-earmark text-muted" style="font-size: 1.5rem;"></i>';
  }

  /**
   * Format file size
   */
  formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  /**
   * Render statistics
   */
  renderStats() {
    const statsPanel = document.getElementById('document-stats');
    if (!statsPanel || !this.stats) return;

    statsPanel.innerHTML = `
      <div class="row text-center">
        <div class="col-4">
          <h4 class="mb-0">${this.stats.totalDocuments}</h4>
          <small class="text-muted">Documents</small>
        </div>
        <div class="col-4">
          <h4 class="mb-0">${this.stats.totalChunks}</h4>
          <small class="text-muted">Chunks</small>
        </div>
        <div class="col-4">
          <h4 class="mb-0">${this.stats.totalStorageFormatted}</h4>
          <small class="text-muted">Storage</small>
        </div>
      </div>
    `;
  }

  /**
   * Select a document
   */
  async selectDocument(documentId) {
    try {
      const response = await api.documents.get(documentId);
      this.selectedDocument = response.data.document;
      this.renderDocumentsList();
      this.showDocumentDetails();
    } catch (error) {
      console.error('Error loading document:', error);
      showToast('Failed to load document details', 'danger');
    }
  }

  /**
   * Show document details panel
   */
  showDocumentDetails() {
    const detailsPanel = document.getElementById('document-details');
    if (!detailsPanel || !this.selectedDocument) return;

    const doc = this.selectedDocument;

    detailsPanel.innerHTML = `
      <div class="card">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0 text-truncate">
            ${this.getFileIcon(doc.file_type)}
            <span class="ms-2">${escapeHtml(doc.filename)}</span>
          </h6>
        </div>
        <div class="card-body">
          <dl class="row mb-0">
            <dt class="col-sm-4">Size</dt>
            <dd class="col-sm-8">${this.formatFileSize(doc.file_size)}</dd>

            <dt class="col-sm-4">Type</dt>
            <dd class="col-sm-8">${doc.file_type}</dd>

            <dt class="col-sm-4">Uploaded</dt>
            <dd class="col-sm-8">${new Date(doc.uploaded_at).toLocaleString()}</dd>

            <dt class="col-sm-4">Chunks</dt>
            <dd class="col-sm-8">
              ${doc.chunk_count > 0
                ? `<span class="badge bg-success">${doc.chunk_count} chunks</span>`
                : '<span class="badge bg-warning">Processing...</span>'
              }
            </dd>

            <dt class="col-sm-4">Embeddings</dt>
            <dd class="col-sm-8">
              ${doc.embedding_path
                ? '<span class="badge bg-success">Generated</span>'
                : '<span class="badge bg-secondary">Pending</span>'
              }
            </dd>
          </dl>
        </div>
        <div class="card-footer">
          <a href="${api.documents.download(doc.id)}" class="btn btn-sm btn-primary" target="_blank">
            <i class="bi bi-download me-1"></i>Download
          </a>
          <button class="btn btn-sm btn-outline-secondary" data-action="reprocess-document" data-document-id="${doc.id}">
            <i class="bi bi-arrow-clockwise me-1"></i>Reprocess
          </button>
          <button class="btn btn-sm btn-outline-danger" data-action="delete-document" data-document-id="${doc.id}">
            <i class="bi bi-trash me-1"></i>Delete
          </button>
        </div>
      </div>
    `;
  }

  /**
   * Show upload modal
   * @param {object} options - Optional: { onUploadComplete: (document) => void }
   */
  showUploadModal(options = {}) {
    this._uploadModalOnComplete = options.onUploadComplete || null;
    const acceptTypes = this.supportedTypes
      .map(t => t.extension)
      .join(',');

    const modalHtml = `
      <div class="modal fade" id="uploadModal" tabindex="-1">
        <div class="modal-dialog">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-upload me-2"></i>Upload Document</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="mb-3">
                <label class="form-label">Select File</label>
                <input type="file" class="form-control" id="upload-file"
                       accept="${acceptTypes}">
                <div class="form-text">
                  Supported: PDF, Word, Excel, CSV, TXT, HTML, MD, JSON, Images
                  <br>Max size: ${this.formatFileSize(this.maxFileSize)}
                </div>
              </div>

              <div class="mb-3">
                <div class="form-check">
                  <input class="form-check-input" type="checkbox" id="generate-embeddings" checked>
                  <label class="form-check-label" for="generate-embeddings">
                    Generate embeddings for semantic search
                  </label>
                </div>
              </div>

              <div id="upload-preview" class="d-none">
                <div class="card bg-light">
                  <div class="card-body">
                    <div class="d-flex align-items-center">
                      <div id="preview-icon" class="me-3"></div>
                      <div>
                        <strong id="preview-name"></strong>
                        <br>
                        <small class="text-muted" id="preview-size"></small>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <div id="upload-progress" class="d-none mt-3">
                <div class="progress">
                  <div class="progress-bar progress-bar-striped progress-bar-animated"
                       role="progressbar" style="width: 100%"></div>
                </div>
                <small class="text-muted">Uploading and processing...</small>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-primary" id="upload-btn" data-action="upload-file">
                <i class="bi bi-upload me-1"></i>Upload
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById('uploadModal');
    if (existingModal) {
      existingModal.remove();
    }

    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Set up file input change handler
    document.getElementById('upload-file').addEventListener('change', (e) => {
      this.handleFileSelect(e.target.files[0]);
    });

    // Clear callback when modal is hidden (e.g. user cancels)
    const modalEl = document.getElementById('uploadModal');
    const modal = new bootstrap.Modal(modalEl);
    modalEl.addEventListener('hidden.bs.modal', () => {
      this._uploadModalOnComplete = null;
    }, { once: true });

    modal.show();
  }

  /**
   * Handle file selection
   */
  handleFileSelect(file) {
    const preview = document.getElementById('upload-preview');
    const uploadBtn = document.getElementById('upload-btn');

    if (!file) {
      preview.classList.add('d-none');
      uploadBtn.disabled = true;
      return;
    }

    // Check file size
    if (file.size > this.maxFileSize) {
      showToast(`File too large. Maximum size is ${this.formatFileSize(this.maxFileSize)}`, 'danger');
      return;
    }

    // Show preview
    document.getElementById('preview-icon').innerHTML = this.getFileIcon(file.type);
    document.getElementById('preview-name').textContent = file.name;
    document.getElementById('preview-size').textContent = this.formatFileSize(file.size);
    preview.classList.remove('d-none');
    uploadBtn.disabled = false;
  }

  /**
   * Upload file
   */
  async uploadFile() {
    const fileInput = document.getElementById('upload-file');
    const file = fileInput.files[0];

    if (!file) {
      showToast('Please select a file', 'warning');
      return;
    }

    const generateEmbeddings = document.getElementById('generate-embeddings').checked;
    const progressDiv = document.getElementById('upload-progress');
    const uploadBtn = document.getElementById('upload-btn');

    // Show progress
    progressDiv.classList.remove('d-none');
    uploadBtn.disabled = true;

    try {
      const response = await api.documents.upload(file, generateEmbeddings);

      if (response.success) {
        showToast(response.message || 'Document uploaded successfully', 'success');

        // Callback for chat upload flow (e.g. add to pending documents)
        if (typeof this._uploadModalOnComplete === 'function') {
          const doc = response.data?.document;
          if (doc) this._uploadModalOnComplete(doc);
          this._uploadModalOnComplete = null;
        }

        // Close modal
        const modal = bootstrap.Modal.getInstance(document.getElementById('uploadModal'));
        modal.hide();

        // Reload documents
        await this.loadDocuments();
        await this.loadStats();
      } else {
        throw new Error(response.error || 'Upload failed');
      }
    } catch (error) {
      console.error('Error uploading file:', error);
      showToast(error.message || 'Failed to upload document', 'danger');
    } finally {
      progressDiv.classList.add('d-none');
      uploadBtn.disabled = false;
    }
  }

  /**
   * Delete a document
   */
  async deleteDocument(documentId) {
    const doc = this.documents.find(d => d.id === documentId);
    if (!doc) return;

    if (!confirm(`Are you sure you want to delete "${doc.filename}"?`)) {
      return;
    }

    try {
      await api.documents.delete(documentId);
      showToast('Document deleted successfully', 'success');

      if (this.selectedDocument?.id === documentId) {
        this.selectedDocument = null;
      }

      await this.loadDocuments();
      await this.loadStats();
    } catch (error) {
      console.error('Error deleting document:', error);
      showToast(error.message || 'Failed to delete document', 'danger');
    }
  }

  /**
   * Reprocess a document
   */
  async reprocessDocument(documentId) {
    const doc = this.documents.find(d => d.id === documentId);
    if (!doc) return;

    showToast('Reprocessing document...', 'info');

    try {
      await api.documents.reprocess(documentId);
      showToast('Document reprocessing started', 'success');

      // Reload documents after a delay
      setTimeout(() => this.loadDocuments(), 2000);
    } catch (error) {
      console.error('Error reprocessing document:', error);
      showToast(error.message || 'Failed to reprocess document', 'danger');
    }
  }

  /**
   * Search documents
   */
  async searchDocuments(query) {
    if (!query || query.trim().length === 0) {
      return [];
    }

    try {
      const response = await api.documents.search(query.trim());
      return response.data.results;
    } catch (error) {
      console.error('Error searching documents:', error);
      showToast('Search failed', 'danger');
      return [];
    }
  }

  /**
   * Show search modal
   */
  showSearchModal() {
    const modalHtml = `
      <div class="modal fade" id="searchModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-search me-2"></i>Search Documents</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="input-group mb-3">
                <input type="text" class="form-control" id="search-query"
                       placeholder="Enter your search query...">
                <button class="btn btn-primary" data-action="perform-search">
                  <i class="bi bi-search"></i> Search
                </button>
              </div>

              <div id="search-results">
                <p class="text-muted text-center">Enter a query to search your documents semantically.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    // Remove existing modal if any
    const existingModal = document.getElementById('searchModal');
    if (existingModal) {
      existingModal.remove();
    }

    // Add modal to body
    document.body.insertAdjacentHTML('beforeend', modalHtml);

    // Handle enter key
    document.getElementById('search-query').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        this.performSearch();
      }
    });

    // Show modal
    const modal = new bootstrap.Modal(document.getElementById('searchModal'));
    modal.show();
  }

  /**
   * Perform search
   */
  async performSearch() {
    const query = document.getElementById('search-query').value;
    const resultsDiv = document.getElementById('search-results');

    if (!query.trim()) {
      return;
    }

    resultsDiv.innerHTML = '<div class="text-center"><div class="spinner-border" role="status"></div></div>';

    const results = await this.searchDocuments(query);

    if (results.length === 0) {
      resultsDiv.innerHTML = '<p class="text-muted text-center">No relevant results found.</p>';
      return;
    }

    resultsDiv.innerHTML = results.map(result => `
      <div class="card mb-2">
        <div class="card-header">
          <strong>${escapeHtml(result.filename)}</strong>
        </div>
        <div class="card-body">
          ${result.chunks.map(chunk => `
            <div class="mb-2 p-2 bg-light rounded">
              <small class="text-muted">Score: ${(chunk.score * 100).toFixed(1)}%</small>
              <p class="mb-0 small">${escapeHtml(chunk.text.substring(0, 200))}${chunk.text.length > 200 ? '...' : ''}</p>
            </div>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  /**
   * Get all documents (for session assignment)
   */
  getDocuments() {
    return this.documents;
  }
}

// Create global instance
window.documentManager = new DocumentManager();

// Event delegation for document manager actions
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const documentId = target.dataset.documentId ? parseInt(target.dataset.documentId) : null;

  switch (action) {
    case 'show-upload-modal':
      if (target.closest('#documents-list') || target.closest('#documents-view')) {
        documentManager.showUploadModal();
      }
      break;
    case 'select-document':
      documentManager.selectDocument(documentId);
      break;
    case 'stop-propagation':
      e.stopPropagation();
      break;
    case 'download-stop-propagation':
      e.stopPropagation();
      // Allow default link behavior
      break;
    case 'reprocess-document':
      e.preventDefault();
      e.stopPropagation();
      documentManager.reprocessDocument(documentId);
      break;
    case 'delete-document':
      e.preventDefault();
      e.stopPropagation();
      documentManager.deleteDocument(documentId);
      break;
    case 'upload-file':
      documentManager.uploadFile();
      break;
    case 'perform-search':
      documentManager.performSearch();
      break;
  }
});
