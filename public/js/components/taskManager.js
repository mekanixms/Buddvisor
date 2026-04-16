/**
 * Task Manager Component
 * Handles formal task creation, monitoring, and result viewing
 */

class TaskManager {
  constructor() {
    this.tasks = [];
    this.stats = null;
    this.selectedTask = null;
    this.currentSessionId = null;
    this.statusFilter = null;
    this.pollInterval = null;
  }

  /**
   * Initialize task manager
   */
  async init() {
    await this.loadTasks();
    await this.loadStats();
    this.startPolling();
  }

  /**
   * Set current session for filtering tasks
   */
  setSession(sessionId) {
    this.currentSessionId = sessionId;
    this.loadTasks();
  }

  /**
   * Load tasks for the current user
   */
  async loadTasks() {
    try {
      const options = {};
      if (this.currentSessionId) {
        options.sessionId = this.currentSessionId;
      }
      if (this.statusFilter) {
        options.status = this.statusFilter;
      }

      const response = await api.tasks.list(options);
      this.tasks = response.data.tasks || [];
      this.renderTasksList();
    } catch (error) {
      console.error('Error loading tasks:', error);
      showToast('Failed to load tasks', 'danger');
    }
  }

  /**
   * Load task statistics
   */
  async loadStats() {
    try {
      const response = await api.tasks.getStats();
      this.stats = response.data.stats;
      this.renderStats();
    } catch (error) {
      console.error('Error loading stats:', error);
    }
  }

  /**
   * Start polling for task updates
   */
  startPolling() {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(async () => {
      // Only poll if there are pending or running tasks
      const hasActiveTasks = this.tasks.some(t =>
        t.status === 'pending' || t.status === 'running'
      );

      if (hasActiveTasks) {
        await this.loadTasks();
        await this.loadStats();
      }
    }, 5000);
  }

  /**
   * Stop polling
   */
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Render tasks list
   */
  renderTasksList() {
    const tasksList = document.getElementById('tasks-list');
    if (!tasksList) return;

    if (this.tasks.length === 0) {
      tasksList.innerHTML = `
        <div class="text-center p-4 text-muted">
          <i class="bi bi-list-task" style="font-size: 2rem;"></i>
          <p class="mt-2 mb-0">No tasks yet</p>
          <p class="small">Create a formal task to get comprehensive analysis</p>
          <button class="btn btn-primary btn-sm mt-2" data-action="show-create-modal">
            <i class="bi bi-plus-lg"></i> Create Task
          </button>
        </div>
      `;
      return;
    }

    tasksList.innerHTML = this.tasks.map(task => `
      <div class="card mb-2 task-card ${task.id === this.selectedTask?.id ? 'border-primary' : ''}"
           data-action="select-task" data-task-id="${task.id}" style="cursor: pointer;">
        <div class="card-body p-3">
          <div class="d-flex align-items-start">
            <div class="me-3">
              ${this.getStatusIcon(task.status)}
            </div>
            <div class="flex-grow-1 overflow-hidden">
              <p class="mb-1 text-truncate">${escapeHtml(task.task_description.substring(0, 100))}${task.task_description.length > 100 ? '...' : ''}</p>
              <small class="text-muted">
                ${this.getStatusBadge(task.status)}
                <span class="ms-2">${this.formatDate(task.created_at)}</span>
              </small>
            </div>
            <div class="dropdown">
              <button class="btn btn-sm btn-link text-muted" type="button"
                      data-bs-toggle="dropdown" data-action="stop-propagation">
                <i class="bi bi-three-dots-vertical"></i>
              </button>
              <ul class="dropdown-menu dropdown-menu-end">
                ${task.status === 'failed' || task.status === 'cancelled' ? `
                  <li><a class="dropdown-item" href="#" data-action="retry-task" data-task-id="${task.id}">
                    <i class="bi bi-arrow-clockwise me-2"></i>Retry
                  </a></li>
                ` : ''}
                ${task.status === 'pending' || task.status === 'running' ? `
                  <li><a class="dropdown-item" href="#" data-action="cancel-task" data-task-id="${task.id}">
                    <i class="bi bi-x-circle me-2"></i>Cancel
                  </a></li>
                ` : ''}
                ${task.status !== 'running' ? `
                  <li><hr class="dropdown-divider"></li>
                  <li><a class="dropdown-item text-danger" href="#" data-action="delete-task" data-task-id="${task.id}">
                    <i class="bi bi-trash me-2"></i>Delete
                  </a></li>
                ` : ''}
              </ul>
            </div>
          </div>
        </div>
      </div>
    `).join('');
  }

  /**
   * Get status icon
   */
  getStatusIcon(status) {
    const icons = {
      pending: '<i class="bi bi-clock text-warning" style="font-size: 1.5rem;"></i>',
      running: '<div class="spinner-border spinner-border-sm text-primary" role="status"></div>',
      completed: '<i class="bi bi-check-circle text-success" style="font-size: 1.5rem;"></i>',
      failed: '<i class="bi bi-x-circle text-danger" style="font-size: 1.5rem;"></i>',
      cancelled: '<i class="bi bi-slash-circle text-secondary" style="font-size: 1.5rem;"></i>',
    };
    return icons[status] || icons.pending;
  }

  /**
   * Get status badge
   */
  getStatusBadge(status) {
    const badges = {
      pending: '<span class="badge bg-warning">Pending</span>',
      running: '<span class="badge bg-primary">Running</span>',
      completed: '<span class="badge bg-success">Completed</span>',
      failed: '<span class="badge bg-danger">Failed</span>',
      cancelled: '<span class="badge bg-secondary">Cancelled</span>',
    };
    return badges[status] || badges.pending;
  }

  /**
   * Format date
   */
  formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  /**
   * Render statistics
   */
  renderStats() {
    const statsPanel = document.getElementById('task-stats');
    if (!statsPanel || !this.stats) return;

    statsPanel.innerHTML = `
      <div class="row text-center">
        <div class="col-3">
          <h5 class="mb-0">${this.stats.total}</h5>
          <small class="text-muted">Total</small>
        </div>
        <div class="col-3">
          <h5 class="mb-0 text-warning">${this.stats.pending + this.stats.running}</h5>
          <small class="text-muted">Active</small>
        </div>
        <div class="col-3">
          <h5 class="mb-0 text-success">${this.stats.completed}</h5>
          <small class="text-muted">Done</small>
        </div>
        <div class="col-3">
          <h5 class="mb-0 text-danger">${this.stats.failed}</h5>
          <small class="text-muted">Failed</small>
        </div>
      </div>
    `;
  }

  /**
   * Select a task
   */
  async selectTask(taskId) {
    try {
      const response = await api.tasks.get(taskId);
      this.selectedTask = response.data.task;
      this.renderTasksList();
      this.showTaskDetails();
    } catch (error) {
      console.error('Error loading task:', error);
      showToast('Failed to load task details', 'danger');
    }
  }

  /**
   * Show task details panel
   */
  showTaskDetails() {
    const detailsPanel = document.getElementById('task-details');
    if (!detailsPanel || !this.selectedTask) return;

    const task = this.selectedTask;

    detailsPanel.innerHTML = `
      <div class="card">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">
            ${this.getStatusIcon(task.status)}
            <span class="ms-2">Task Details</span>
          </h6>
          ${this.getStatusBadge(task.status)}
        </div>
        <div class="card-body">
          <h6>Description</h6>
          <p class="mb-3">${escapeHtml(task.task_description)}</p>

          <dl class="row mb-3">
            <dt class="col-sm-4">Created</dt>
            <dd class="col-sm-8">${this.formatDate(task.created_at)}</dd>

            ${task.started_at ? `
              <dt class="col-sm-4">Started</dt>
              <dd class="col-sm-8">${this.formatDate(task.started_at)}</dd>
            ` : ''}

            ${task.completed_at ? `
              <dt class="col-sm-4">Completed</dt>
              <dd class="col-sm-8">${this.formatDate(task.completed_at)}</dd>
            ` : ''}

            <dt class="col-sm-4">Mode</dt>
            <dd class="col-sm-8">${task.execution_mode || 'adaptive'}</dd>

            <dt class="col-sm-4">Priority</dt>
            <dd class="col-sm-8">${task.priority || 'normal'}</dd>
          </dl>

          ${task.error_message ? `
            <div class="alert alert-danger">
              <strong>Error:</strong> ${escapeHtml(task.error_message)}
            </div>
          ` : ''}

          ${task.results && task.results.length > 0 ? `
            <h6>Results</h6>
            <div class="task-results">
              ${task.results.map(result => `
                <div class="card mb-2">
                  <div class="card-header py-2">
                    <strong>${result.agent_name || 'Agent'}</strong>
                    <small class="text-muted ms-2">${result.tokens_used || 0} tokens</small>
                  </div>
                  <div class="card-body">
                    <div class="result-content" style="max-height: 200px; overflow-y: auto;">
                      ${this.formatContent(result.result_text)}
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          ` : ''}

          ${task.summary ? `
            <div class="mt-3 p-2 bg-light rounded">
              <small class="text-muted">
                ${task.summary.result_count} result(s) |
                ${task.summary.total_tokens || 0} tokens |
                ${task.summary.agents_used || 0} agent(s)
              </small>
            </div>
          ` : ''}
        </div>
        <div class="card-footer">
          ${task.status === 'completed' ? `
            <button class="btn btn-sm btn-primary" data-action="copy-output" data-task-id="${task.id}">
              <i class="bi bi-clipboard me-1"></i>Copy Output
            </button>
          ` : ''}
          ${task.status === 'failed' || task.status === 'cancelled' ? `
            <button class="btn btn-sm btn-warning" data-action="retry-task" data-task-id="${task.id}">
              <i class="bi bi-arrow-clockwise me-1"></i>Retry
            </button>
          ` : ''}
          ${task.status === 'pending' ? `
            <button class="btn btn-sm btn-success" data-action="run-task" data-task-id="${task.id}">
              <i class="bi bi-play me-1"></i>Run Now
            </button>
          ` : ''}
        </div>
      </div>
    `;
  }

  /**
   * Format content with basic markdown
   */
  formatContent(content) {
    if (!content) return '';
    let formatted = escapeHtml(content);
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    formatted = formatted.replace(/\n/g, '<br>');
    return formatted;
  }

  /**
   * Show create task modal
   */
  showCreateModal() {
    const currentSession = window.sessionManager?.getCurrentSession();
    if (!currentSession) {
      showToast('Please select a session first', 'warning');
      return;
    }

    const agents = currentSession.agents || [];

    const modalHtml = `
      <div class="modal fade" id="createTaskModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title"><i class="bi bi-plus-lg me-2"></i>Create Formal Task</h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <form id="create-task-form">
                <div class="mb-3">
                  <label class="form-label">Task Description *</label>
                  <textarea class="form-control" id="task-description" rows="4"
                            placeholder="Describe what you want the agents to analyze or produce..."
                            required minlength="10" maxlength="5000"></textarea>
                  <div class="form-text">Be specific about what you need. The more context, the better the results.</div>
                </div>

                <div class="row">
                  <div class="col-md-6">
                    <div class="mb-3">
                      <label class="form-label">Execution Mode</label>
                      <select class="form-select" id="task-execution-mode">
                        <option value="adaptive" selected>Adaptive (Recommended)</option>
                        <option value="single">Single Agent</option>
                        <option value="sequential">Sequential (One by One)</option>
                        <option value="parallel">Parallel (All at Once)</option>
                      </select>
                      <div class="form-text">How agents should work on this task</div>
                    </div>
                  </div>
                  <div class="col-md-6">
                    <div class="mb-3">
                      <label class="form-label">Priority</label>
                      <select class="form-select" id="task-priority">
                        <option value="low">Low</option>
                        <option value="normal" selected>Normal</option>
                        <option value="high">High</option>
                      </select>
                    </div>
                  </div>
                </div>

                ${agents.length > 0 ? `
                  <div class="mb-3">
                    <label class="form-label">Assign Specific Agents (Optional)</label>
                    <div class="agent-checkboxes">
                      ${agents.map(agent => `
                        <div class="form-check">
                          <input class="form-check-input task-agent-checkbox" type="checkbox"
                                 value="${agent.id}" id="task-agent-${agent.id}">
                          <label class="form-check-label" for="task-agent-${agent.id}">
                            ${escapeHtml(agent.name)} (${agent.role})
                          </label>
                        </div>
                      `).join('')}
                    </div>
                    <div class="form-text">Leave unchecked to use all session agents</div>
                  </div>
                ` : `
                  <div class="alert alert-warning">
                    <i class="bi bi-exclamation-triangle me-2"></i>
                    No agents assigned to this session. Please assign agents first.
                  </div>
                `}
              </form>
            </div>
            <div class="modal-footer">
              <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
              <button type="button" class="btn btn-primary" data-action="create-task" ${agents.length === 0 ? 'disabled' : ''}>
                <i class="bi bi-plus-lg me-1"></i>Create Task
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    // Remove existing modal
    const existing = document.getElementById('createTaskModal');
    if (existing) existing.remove();

    document.body.insertAdjacentHTML('beforeend', modalHtml);

    const modal = new bootstrap.Modal(document.getElementById('createTaskModal'));
    modal.show();
  }

  /**
   * Create a new task
   */
  async createTask() {
    const currentSession = window.sessionManager?.getCurrentSession();
    if (!currentSession) return;

    const description = document.getElementById('task-description')?.value?.trim();
    const executionMode = document.getElementById('task-execution-mode')?.value;
    const priority = document.getElementById('task-priority')?.value;

    if (!description || description.length < 10) {
      showToast('Task description must be at least 10 characters', 'warning');
      return;
    }

    // Get selected agents
    const selectedAgents = Array.from(document.querySelectorAll('.task-agent-checkbox:checked'))
      .map(cb => parseInt(cb.value));

    try {
      const response = await api.tasks.create({
        session_id: currentSession.id,
        task_description: description,
        execution_mode: executionMode,
        priority: priority,
        assigned_agents: selectedAgents.length > 0 ? selectedAgents : null,
      });

      showToast('Task created and queued for execution', 'success');

      // Close modal
      const modal = bootstrap.Modal.getInstance(document.getElementById('createTaskModal'));
      modal?.hide();

      // Reload tasks
      await this.loadTasks();
      await this.loadStats();
    } catch (error) {
      console.error('Error creating task:', error);
      showToast(error.message || 'Failed to create task', 'danger');
    }
  }

  /**
   * Retry a failed task
   */
  async retryTask(taskId) {
    try {
      await api.tasks.retry(taskId);
      showToast('Task queued for retry', 'success');
      await this.loadTasks();
      await this.loadStats();
    } catch (error) {
      console.error('Error retrying task:', error);
      showToast(error.message || 'Failed to retry task', 'danger');
    }
  }

  /**
   * Cancel a task
   */
  async cancelTask(taskId) {
    if (!confirm('Are you sure you want to cancel this task?')) return;

    try {
      await api.tasks.cancel(taskId);
      showToast('Task cancelled', 'success');
      await this.loadTasks();
      await this.loadStats();
    } catch (error) {
      console.error('Error cancelling task:', error);
      showToast(error.message || 'Failed to cancel task', 'danger');
    }
  }

  /**
   * Run a pending task immediately
   */
  async runTask(taskId) {
    try {
      await api.tasks.run(taskId);
      showToast('Task execution started', 'success');
      await this.loadTasks();
    } catch (error) {
      console.error('Error running task:', error);
      showToast(error.message || 'Failed to run task', 'danger');
    }
  }

  /**
   * Delete a task
   */
  async deleteTask(taskId) {
    if (!confirm('Are you sure you want to delete this task?')) return;

    try {
      await api.tasks.delete(taskId);
      showToast('Task deleted', 'success');

      if (this.selectedTask?.id === taskId) {
        this.selectedTask = null;
      }

      await this.loadTasks();
      await this.loadStats();
    } catch (error) {
      console.error('Error deleting task:', error);
      showToast(error.message || 'Failed to delete task', 'danger');
    }
  }

  /**
   * Copy task output to clipboard
   */
  async copyOutput(taskId) {
    try {
      const response = await api.tasks.getOutput(taskId);
      const output = response.data.output;

      if (output && output.text) {
        await navigator.clipboard.writeText(output.text);
        showToast('Output copied to clipboard', 'success');
      } else {
        showToast('No output to copy', 'warning');
      }
    } catch (error) {
      console.error('Error copying output:', error);
      showToast('Failed to copy output', 'danger');
    }
  }

  /**
   * Filter tasks by status
   */
  setStatusFilter(status) {
    this.statusFilter = status;
    this.loadTasks();
  }

  /**
   * Get all tasks (for external access)
   */
  getTasks() {
    return this.tasks;
  }
}

// Create global instance
window.taskManager = new TaskManager();

// Event delegation for task manager actions
document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const taskId = target.dataset.taskId ? parseInt(target.dataset.taskId) : null;

  switch (action) {
    case 'show-create-modal':
      taskManager.showCreateModal();
      break;
    case 'select-task':
      taskManager.selectTask(taskId);
      break;
    case 'stop-propagation':
      e.stopPropagation();
      break;
    case 'retry-task':
      e.preventDefault();
      e.stopPropagation();
      taskManager.retryTask(taskId);
      break;
    case 'cancel-task':
      e.preventDefault();
      e.stopPropagation();
      taskManager.cancelTask(taskId);
      break;
    case 'delete-task':
      e.preventDefault();
      e.stopPropagation();
      taskManager.deleteTask(taskId);
      break;
    case 'copy-output':
      taskManager.copyOutput(taskId);
      break;
    case 'run-task':
      taskManager.runTask(taskId);
      break;
    case 'create-task':
      taskManager.createTask();
      break;
  }
});
