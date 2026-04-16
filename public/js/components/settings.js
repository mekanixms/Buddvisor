/**
 * Settings Component
 * Handles user preferences and application settings
 */

class Settings {
  constructor() {
    this.storageKey = 'tax-advisor-settings';
    this.defaults = {
      defaultProvider: 'claude',
      theme: 'light',
      chatStreaming: true,
      showToolIndicators: true,
      contextLength: 50,
      compactMode: false,
      notifications: true,
    };
    this.settings = this.load();
    this.currentUser = null;
    this.isSuperuser = false;
  }

  /**
   * Load settings from localStorage
   */
  load() {
    try {
      const stored = localStorage.getItem(this.storageKey);
      if (stored) {
        return { ...this.defaults, ...JSON.parse(stored) };
      }
    } catch (error) {
      console.error('Error loading settings:', error);
    }
    return { ...this.defaults };
  }

  /**
   * Save settings to localStorage
   */
  save() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(this.settings));
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  /**
   * Get a setting value
   */
  get(key) {
    return this.settings[key] ?? this.defaults[key];
  }

  /**
   * Set a setting value
   */
  set(key, value) {
    this.settings[key] = value;
    this.save();
    this.applySettings();
  }

  /**
   * Reset settings to defaults
   */
  reset() {
    this.settings = { ...this.defaults };
    this.save();
    this.applySettings();
  }

  /**
   * Apply settings to the UI
   */
  applySettings() {
    // Apply theme
    if (this.settings.theme === 'dark') {
      document.body.classList.add('dark-theme');
    } else {
      document.body.classList.remove('dark-theme');
    }

    // Apply compact mode
    if (this.settings.compactMode) {
      document.body.classList.add('compact-mode');
    } else {
      document.body.classList.remove('compact-mode');
    }

    // Apply streaming toggle if chat interface exists
    const streamingToggle = document.getElementById('streaming-toggle');
    if (streamingToggle) {
      streamingToggle.checked = this.settings.chatStreaming;
    }
  }

  /**
   * Show settings modal
   */
  async showModal() {
    // Remove existing modal if any
    const existingModal = document.getElementById('settingsModal');
    if (existingModal) {
      existingModal.remove();
    }

    const modalHtml = `
      <div class="modal fade" id="settingsModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-gear me-2"></i>Settings</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <ul class="nav nav-tabs" id="settingsTabs" role="tablist">
                <li class="nav-item" role="presentation">
                  <button class="nav-link active" id="general-tab" data-bs-toggle="tab" data-bs-target="#general-pane" type="button">
                    General
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="providers-tab" data-bs-toggle="tab" data-bs-target="#providers-pane" type="button">
                    LLM Providers
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="appearance-tab" data-bs-toggle="tab" data-bs-target="#appearance-pane" type="button">
                    Appearance
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="data-tab" data-bs-toggle="tab" data-bs-target="#data-pane" type="button">
                    Data
                  </button>
                </li>
                <li class="nav-item" role="presentation">
                  <button class="nav-link" id="user-tab" data-bs-toggle="tab" data-bs-target="#user-pane" type="button">
                    User
                  </button>
                </li>
                <li class="nav-item" role="presentation" id="user-management-tab-item" style="display: none;">
                  <button class="nav-link" id="user-management-tab" data-bs-toggle="tab" data-bs-target="#user-management-pane" type="button">
                    User Management
                  </button>
                </li>
              </ul>

              <div class="tab-content mt-3" id="settingsTabContent">
                <!-- General Settings -->
                <div class="tab-pane fade show active" id="general-pane" role="tabpanel">
                  <div class="mb-3">
                    <label class="form-label">Default LLM Provider</label>
                    <select class="form-select" id="setting-defaultProvider">
                      <option value="claude" ${this.settings.defaultProvider === 'claude' ? 'selected' : ''}>Claude (Anthropic)</option>
                      <option value="openai" ${this.settings.defaultProvider === 'openai' ? 'selected' : ''}>OpenAI (GPT-4)</option>
                      <option value="gemini" ${this.settings.defaultProvider === 'gemini' ? 'selected' : ''}>Google Gemini</option>
                      <option value="xai" ${this.settings.defaultProvider === 'xai' ? 'selected' : ''}>xAI (Grok)</option>
                      <option value="ollama" ${this.settings.defaultProvider === 'ollama' ? 'selected' : ''}>Ollama (Local)</option>
                    </select>
                    <div class="form-text">Provider used for new agents and sessions</div>
                  </div>

                  <div class="mb-3">
                    <label class="form-label">Default Context Length</label>
                    <input type="number" class="form-control" id="setting-contextLength"
                           value="${this.settings.contextLength}" min="5" max="200">
                    <div class="form-text">Number of recent messages to include in context</div>
                  </div>

                  <div class="form-check form-switch mb-3">
                    <input class="form-check-input" type="checkbox" id="setting-chatStreaming"
                           ${this.settings.chatStreaming ? 'checked' : ''}>
                    <label class="form-check-label" for="setting-chatStreaming">Enable streaming responses</label>
                  </div>

                  <div class="form-check form-switch mb-3">
                    <input class="form-check-input" type="checkbox" id="setting-showToolIndicators"
                           ${this.settings.showToolIndicators ? 'checked' : ''}>
                    <label class="form-check-label" for="setting-showToolIndicators">Show tool usage indicators</label>
                  </div>

                  <div class="form-check form-switch mb-3">
                    <input class="form-check-input" type="checkbox" id="setting-notifications"
                           ${this.settings.notifications ? 'checked' : ''}>
                    <label class="form-check-label" for="setting-notifications">Enable notifications</label>
                  </div>
                </div>

                <!-- LLM Providers -->
                <div class="tab-pane fade" id="providers-pane" role="tabpanel">
                  <div class="alert alert-info">
                    <i class="bi bi-info-circle me-2"></i>
                    API keys are stored securely on the server. Configure them in the <code>.env</code> file for production use.
                  </div>

                  <div class="mb-3">
                    <label class="form-label"><i class="bi bi-robot me-1"></i>Anthropic (Claude)</label>
                    <div class="input-group">
                      <input type="password" class="form-control" id="provider-claude-key"
                             placeholder="sk-ant-api..." disabled>
                      <button class="btn btn-outline-secondary" type="button" disabled>
                        <i class="bi bi-check"></i> Test
                      </button>
                    </div>
                    <div class="form-text">Set ANTHROPIC_API_KEY in .env</div>
                  </div>

                  <div class="mb-3">
                    <label class="form-label"><i class="bi bi-stars me-1"></i>OpenAI</label>
                    <div class="input-group">
                      <input type="password" class="form-control" id="provider-openai-key"
                             placeholder="sk-..." disabled>
                      <button class="btn btn-outline-secondary" type="button" disabled>
                        <i class="bi bi-check"></i> Test
                      </button>
                    </div>
                    <div class="form-text">Set OPENAI_API_KEY in .env</div>
                  </div>

                  <div class="mb-3">
                    <label class="form-label"><i class="bi bi-google me-1"></i>Google Gemini</label>
                    <div class="input-group">
                      <input type="password" class="form-control" id="provider-gemini-key"
                             placeholder="AIza..." disabled>
                      <button class="btn btn-outline-secondary" type="button" disabled>
                        <i class="bi bi-check"></i> Test
                      </button>
                    </div>
                    <div class="form-text">Set GOOGLE_API_KEY in .env</div>
                  </div>

                  <div class="mb-3">
                    <label class="form-label"><i class="bi bi-lightning me-1"></i>xAI (Grok)</label>
                    <div class="input-group">
                      <input type="password" class="form-control" id="provider-xai-key"
                             placeholder="xai-..." disabled>
                      <button class="btn btn-outline-secondary" type="button" disabled>
                        <i class="bi bi-check"></i> Test
                      </button>
                    </div>
                    <div class="form-text">Set XAI_API_KEY in .env</div>
                  </div>

                  <div class="mb-3">
                    <label class="form-label"><i class="bi bi-hdd-network me-1"></i>Ollama (Local)</label>
                    <div class="input-group">
                      <input type="text" class="form-control" id="provider-ollama-url"
                             placeholder="http://localhost:11434" disabled>
                      <button class="btn btn-outline-secondary" type="button" disabled>
                        <i class="bi bi-check"></i> Test
                      </button>
                    </div>
                    <div class="form-text">Set OLLAMA_BASE_URL in .env</div>
                  </div>
                </div>

                <!-- Appearance -->
                <div class="tab-pane fade" id="appearance-pane" role="tabpanel">
                  <div class="mb-3">
                    <label class="form-label">Theme</label>
                    <select class="form-select" id="setting-theme">
                      <option value="light" ${this.settings.theme === 'light' ? 'selected' : ''}>Light</option>
                      <option value="dark" ${this.settings.theme === 'dark' ? 'selected' : ''}>Dark (Coming Soon)</option>
                    </select>
                  </div>

                  <div class="form-check form-switch mb-3">
                    <input class="form-check-input" type="checkbox" id="setting-compactMode"
                           ${this.settings.compactMode ? 'checked' : ''}>
                    <label class="form-check-label" for="setting-compactMode">Compact mode</label>
                    <div class="form-text">Reduce spacing and padding throughout the UI</div>
                  </div>
                </div>

                <!-- Data Management -->
                <div class="tab-pane fade" id="data-pane" role="tabpanel">
                  <div class="card mb-3">
                    <div class="card-body">
                      <h6>Session Import</h6>
                      <p class="text-muted small">Import a previously exported session</p>
                      <button class="btn btn-outline-primary" data-action="import-session-from-settings">
                        <i class="bi bi-upload me-2"></i>Import Session
                      </button>
                    </div>
                  </div>

                  <div class="card mb-3">
                    <div class="card-body">
                      <h6>Clear Local Settings</h6>
                      <p class="text-muted small">Reset all local settings to defaults</p>
                      <button class="btn btn-outline-warning" data-action="reset-settings">
                        <i class="bi bi-arrow-counterclockwise me-2"></i>Reset Settings
                      </button>
                    </div>
                  </div>

                  <div class="card border-danger">
                    <div class="card-body">
                      <h6 class="text-danger">Clear All Local Data</h6>
                      <p class="text-muted small">Clear all locally stored data (settings, cache). Server data is not affected.</p>
                      <button class="btn btn-outline-danger" data-action="clear-local-data">
                        <i class="bi bi-trash me-2"></i>Clear Local Data
                      </button>
                    </div>
                  </div>
                </div>

                <!-- User Settings -->
                <div class="tab-pane fade" id="user-pane" role="tabpanel">
                  <div class="card mb-3">
                    <div class="card-body">
                      <h6><i class="bi bi-person-circle me-2"></i>Account Information</h6>
                      <div class="mb-3">
                        <label class="form-label">Account ID</label>
                        <input type="text" class="form-control" id="user-account-id" readonly>
                        <div class="form-text">Your unique account identifier</div>
                      </div>
                      <div class="mb-3">
                        <label class="form-label">Username</label>
                        <input type="text" class="form-control" id="user-username" readonly>
                      </div>
                    </div>
                  </div>

                  <div class="card">
                    <div class="card-body">
                      <h6><i class="bi bi-key me-2"></i>Change Password</h6>
                      <form id="change-password-form">
                        <div class="mb-3">
                          <label for="user-old-password" class="form-label">Current Password</label>
                          <input type="password" class="form-control" id="user-old-password" required>
                        </div>
                        <div class="mb-3">
                          <label for="user-new-password" class="form-label">New Password</label>
                          <input type="password" class="form-control" id="user-new-password" required minlength="6">
                          <div class="form-text">Password must be at least 6 characters long</div>
                        </div>
                        <div class="mb-3">
                          <label for="user-confirm-password" class="form-label">Confirm New Password</label>
                          <input type="password" class="form-control" id="user-confirm-password" required minlength="6">
                        </div>
                        <div id="password-change-error" class="alert alert-danger d-none" role="alert"></div>
                        <div id="password-change-success" class="alert alert-success d-none" role="alert"></div>
                        <button type="submit" class="btn btn-primary" data-action="change-password">
                          <i class="bi bi-check me-1"></i>Change Password
                        </button>
                      </form>
                    </div>
                  </div>
                </div>

                <!-- User Management (Superuser Only) -->
                <div class="tab-pane fade" id="user-management-pane" role="tabpanel">
                  <div class="alert alert-info">
                    <i class="bi bi-info-circle me-2"></i>
                    Manage all users in the system. You can delete users or reset their passwords.
                  </div>
                  <div id="user-management-loading" class="text-center py-3">
                    <div class="spinner-border text-primary" role="status">
                      <span class="visually-hidden">Loading...</span>
                    </div>
                  </div>
                  <div id="user-management-error" class="alert alert-danger d-none" role="alert"></div>
                  <div id="user-management-list" class="table-responsive">
                    <table class="table table-hover">
                      <thead>
                        <tr>
                          <th>ID</th>
                          <th>Username</th>
                          <th>Role</th>
                          <th>Status</th>
                          <th>Created</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody id="user-management-tbody">
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Close</button>
              <button type="button" class="btn btn-primary" data-action="save-settings">
                <i class="bi bi-check me-1"></i>Save Changes
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    const modal = new bootstrap.Modal(document.getElementById('settingsModal'));
    modal.show();

    // Load user information when modal is shown
    await this.loadUserInfo();
    
    // Show/hide User Management tab based on superuser status
    const userManagementTabItem = document.getElementById('user-management-tab-item');
    if (userManagementTabItem && this.isSuperuser) {
      userManagementTabItem.style.display = '';
    }
  }

  /**
   * Load and display current user information
   */
  async loadUserInfo() {
    try {
      const response = await api.auth.getCurrentUser();
      const user = response.data.user;

      // Store current user info
      this.currentUser = user;
      this.isSuperuser = user.isSuperuser || false;

      // Display user information
      const accountIdInput = document.getElementById('user-account-id');
      const usernameInput = document.getElementById('user-username');

      if (accountIdInput) {
        accountIdInput.value = user.id;
      }
      if (usernameInput) {
        usernameInput.value = user.username;
      }

      // Load user management data if superuser
      if (this.isSuperuser) {
        this.loadUserManagement();
      }
    } catch (error) {
      console.error('Error loading user info:', error);
      // Don't show error to user, just log it
    }
  }

  /**
   * Load and display all users (superuser only)
   */
  async loadUserManagement() {
    const loadingDiv = document.getElementById('user-management-loading');
    const errorDiv = document.getElementById('user-management-error');
    const listDiv = document.getElementById('user-management-list');
    const tbody = document.getElementById('user-management-tbody');

    if (!loadingDiv || !errorDiv || !listDiv || !tbody) {
      return;
    }

    try {
      loadingDiv.classList.remove('d-none');
      errorDiv.classList.add('d-none');
      listDiv.classList.add('d-none');

      const response = await api.auth.getAllUsers();
      const users = response.data.users;

      // Clear existing rows
      tbody.innerHTML = '';

      // Add rows for each user
      users.forEach(user => {
        const row = document.createElement('tr');
        const isCurrentUser = user.id === this.currentUser.id;
        const isActive = user.is_active === 1 || user.is_active === true;
        
        row.innerHTML = `
          <td>${user.id}</td>
          <td>${user.username}${isCurrentUser ? ' <span class="badge bg-primary">You</span>' : ''}</td>
          <td>${user.isSuperuser ? '<span class="badge bg-danger">Superuser</span>' : '<span class="badge bg-secondary">User</span>'}</td>
          <td>
            ${isActive 
              ? '<span class="badge bg-success">Active</span>' 
              : '<span class="badge bg-warning">Pending</span>'}
          </td>
          <td>${new Date(user.created_at).toLocaleDateString()}</td>
          <td>
            <button class="btn btn-sm ${isActive ? 'btn-outline-secondary' : 'btn-outline-success'} me-1" 
                    data-action="toggle-user-active" 
                    data-user-id="${user.id}" 
                    data-username="${user.username}" 
                    data-is-active="${isActive}"
                    ${isCurrentUser ? 'disabled' : ''}>
              <i class="bi bi-${isActive ? 'x-circle' : 'check-circle'}"></i> ${isActive ? 'Deactivate' : 'Activate'}
            </button>
            <button class="btn btn-sm btn-outline-warning me-1" data-action="reset-user-password" data-user-id="${user.id}" data-username="${user.username}" ${isCurrentUser ? 'disabled' : ''}>
              <i class="bi bi-key"></i> Reset Password
            </button>
            <button class="btn btn-sm btn-outline-danger" data-action="delete-user" data-user-id="${user.id}" data-username="${user.username}" ${isCurrentUser ? 'disabled' : ''}>
              <i class="bi bi-trash"></i> Delete
            </button>
          </td>
        `;
        tbody.appendChild(row);
      });

      loadingDiv.classList.add('d-none');
      listDiv.classList.remove('d-none');
    } catch (error) {
      loadingDiv.classList.add('d-none');
      errorDiv.textContent = error.message || 'Failed to load users';
      errorDiv.classList.remove('d-none');
    }
  }

  /**
   * Reset a user's password (superuser only)
   */
  async resetUserPassword(userId, username) {
    const newPassword = prompt(`Enter new password for user "${username}" (minimum 6 characters):`);
    
    if (!newPassword) {
      return; // User cancelled
    }

    if (newPassword.length < 6) {
      showToast('Password must be at least 6 characters long', 'danger');
      return;
    }

    if (!confirm(`Are you sure you want to reset the password for user "${username}"?`)) {
      return;
    }

    try {
      await api.auth.resetUserPassword(userId, newPassword);
      showToast(`Password reset successfully for user "${username}"`, 'success');
      // Reload user list
      this.loadUserManagement();
    } catch (error) {
      showToast(error.message || 'Failed to reset password', 'danger');
    }
  }

  /**
   * Delete a user (superuser only)
   */
  async deleteUser(userId, username) {
    if (!confirm(`Are you sure you want to delete user "${username}"? This action cannot be undone and will delete all associated data.`)) {
      return;
    }

    if (!confirm(`FINAL CONFIRMATION: Delete user "${username}"?`)) {
      return;
    }

    try {
      await api.auth.deleteUser(userId);
      showToast(`User "${username}" deleted successfully`, 'success');
      // Reload user list
      this.loadUserManagement();
    } catch (error) {
      showToast(error.message || 'Failed to delete user', 'danger');
    }
  }

  /**
   * Toggle user active status (superuser only)
   */
  async toggleUserActiveStatus(userId, username, currentStatus) {
    const newStatus = !currentStatus;
    const action = newStatus ? 'activate' : 'deactivate';
    
    if (!confirm(`Are you sure you want to ${action} user "${username}"?`)) {
      return;
    }

    try {
      await api.auth.setUserActiveStatus(userId, newStatus);
      showToast(`User "${username}" ${action}d successfully`, 'success');
      // Reload user list
      this.loadUserManagement();
    } catch (error) {
      showToast(error.message || `Failed to ${action} user`, 'danger');
    }
  }

  /**
   * Save settings from modal form
   */
  saveFromModal() {
    // General settings
    this.settings.defaultProvider = document.getElementById('setting-defaultProvider').value;
    this.settings.contextLength = parseInt(document.getElementById('setting-contextLength').value) || 50;
    this.settings.chatStreaming = document.getElementById('setting-chatStreaming').checked;
    this.settings.showToolIndicators = document.getElementById('setting-showToolIndicators').checked;
    this.settings.notifications = document.getElementById('setting-notifications').checked;

    // Appearance
    this.settings.theme = document.getElementById('setting-theme').value;
    this.settings.compactMode = document.getElementById('setting-compactMode').checked;

    this.save();
    this.applySettings();

    showToast('Settings saved', 'success');

    // Close modal
    const modal = bootstrap.Modal.getInstance(document.getElementById('settingsModal'));
    if (modal) {
      modal.hide();
    }
  }

  /**
   * Clear all local data
   */
  clearAllLocalData() {
    if (!confirm('Are you sure you want to clear all local data? This cannot be undone.')) {
      return;
    }

    // Clear localStorage
    localStorage.clear();

    // Reset settings
    this.settings = { ...this.defaults };

    showToast('Local data cleared', 'success');

    // Reload page
    setTimeout(() => {
      window.location.reload();
    }, 1000);
  }

  /**
   * Handle password change
   */
  async changePassword() {
    const oldPassword = document.getElementById('user-old-password').value;
    const newPassword = document.getElementById('user-new-password').value;
    const confirmPassword = document.getElementById('user-confirm-password').value;
    const errorDiv = document.getElementById('password-change-error');
    const successDiv = document.getElementById('password-change-success');

    // Clear previous messages
    errorDiv.classList.add('d-none');
    successDiv.classList.add('d-none');
    errorDiv.textContent = '';

    // Validate passwords match
    if (newPassword !== confirmPassword) {
      errorDiv.textContent = 'New passwords do not match';
      errorDiv.classList.remove('d-none');
      return;
    }

    // Validate password length
    if (newPassword.length < 6) {
      errorDiv.textContent = 'New password must be at least 6 characters long';
      errorDiv.classList.remove('d-none');
      return;
    }

    try {
      await api.auth.changePassword(oldPassword, newPassword);

      // Show success message
      successDiv.textContent = 'Password changed successfully. Please log in again.';
      successDiv.classList.remove('d-none');

      // Clear form
      document.getElementById('user-old-password').value = '';
      document.getElementById('user-new-password').value = '';
      document.getElementById('user-confirm-password').value = '';

      // Redirect to login after a delay
      setTimeout(() => {
        api.clearToken();
        window.location.href = '/login.html';
      }, 2000);
    } catch (error) {
      errorDiv.textContent = error.message || 'Failed to change password. Please try again.';
      errorDiv.classList.remove('d-none');
    }
  }
}

// Create global instance
window.settings = new Settings();

// Apply settings on load
document.addEventListener('DOMContentLoaded', () => {
  settings.applySettings();
});

// Event delegation for settings actions
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;

  switch (action) {
    case 'import-session-from-settings':
      sessionManager.importSession();
      break;
    case 'reset-settings':
      settings.reset();
      showToast('Settings reset to defaults', 'success');
      break;
    case 'clear-local-data':
      settings.clearAllLocalData();
      break;
    case 'save-settings':
      settings.saveFromModal();
      break;
    case 'change-password':
      e.preventDefault();
      settings.changePassword();
      break;
    case 'reset-user-password':
      e.preventDefault();
      const userId = parseInt(target.dataset.userId);
      const username = target.dataset.username;
      settings.resetUserPassword(userId, username);
      break;
    case 'delete-user':
      e.preventDefault();
      const deleteUserId = parseInt(target.dataset.userId);
      const deleteUsername = target.dataset.username;
      settings.deleteUser(deleteUserId, deleteUsername);
      break;
    case 'toggle-user-active':
      e.preventDefault();
      const toggleUserId = parseInt(target.dataset.userId);
      const toggleUsername = target.dataset.username;
      const currentIsActive = target.dataset.isActive === 'true';
      settings.toggleUserActiveStatus(toggleUserId, toggleUsername, currentIsActive);
      break;
  }
});

// Handle password change form submission
document.addEventListener('submit', (e) => {
  if (e.target.id === 'change-password-form') {
    e.preventDefault();
    settings.changePassword();
  }
});
