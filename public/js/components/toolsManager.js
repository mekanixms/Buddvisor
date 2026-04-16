/**
 * Tools Manager Component
 * Displays available MCP tools and allows manual execution
 */

class ToolsManager {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.tools = [];
    this.categories = [];
    this.selectedCategory = null;
    this.selectedTool = null;
    this.executionHistory = [];
  }

  async init() {
    await this.loadTools();
    this.render();
  }

  async loadTools() {
    try {
      const [toolsResponse, categoriesResponse] = await Promise.all([
        api.tools.list(),
        api.tools.getCategories(),
      ]);

      if (toolsResponse.success) {
        this.tools = toolsResponse.data.tools;
      }

      if (categoriesResponse.success) {
        this.categories = categoriesResponse.data.categories;
      }
    } catch (error) {
      console.error('Failed to load tools:', error);
      this.showError('Failed to load tools');
    }
  }

  render() {
    this.container.innerHTML = `
      <div class="tools-manager">
        <div class="row">
          <!-- Tools List -->
          <div class="col-md-4">
            <div class="card">
              <div class="card-header d-flex justify-content-between align-items-center">
                <h5 class="mb-0">Available Tools</h5>
                <span class="badge bg-primary">${this.tools.length}</span>
              </div>
              <div class="card-body p-0">
                <!-- Category Filter -->
                <div class="p-3 border-bottom">
                  <select class="form-select form-select-sm" id="categoryFilter">
                    <option value="">All Categories</option>
                    ${this.categories.map(cat => `
                      <option value="${cat}" ${this.selectedCategory === cat ? 'selected' : ''}>
                        ${this.formatCategoryName(cat)}
                      </option>
                    `).join('')}
                  </select>
                </div>
                <!-- Tools List -->
                <div class="tools-list" style="max-height: 500px; overflow-y: auto;">
                  ${this.renderToolsList()}
                </div>
              </div>
            </div>
          </div>

          <!-- Tool Details & Execution -->
          <div class="col-md-8">
            ${this.selectedTool ? this.renderToolDetails() : this.renderNoSelection()}
          </div>
        </div>

        <!-- Execution History -->
        <div class="row mt-4">
          <div class="col-12">
            <div class="card">
              <div class="card-header">
                <h5 class="mb-0">Recent Executions</h5>
              </div>
              <div class="card-body">
                ${this.renderExecutionHistory()}
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    this.attachEventListeners();
  }

  renderToolsList() {
    const filteredTools = this.selectedCategory
      ? this.tools.filter(t => t.category === this.selectedCategory)
      : this.tools;

    if (filteredTools.length === 0) {
      return `
        <div class="p-3 text-center text-muted">
          <i class="bi bi-tools"></i>
          <p class="mb-0 mt-2">No tools available</p>
        </div>
      `;
    }

    return filteredTools.map(tool => `
      <div class="tool-item p-3 border-bottom ${this.selectedTool?.name === tool.name ? 'bg-light' : ''}"
           data-tool-name="${tool.name}" style="cursor: pointer;">
        <div class="d-flex justify-content-between align-items-start">
          <div>
            <h6 class="mb-1">${this.formatToolName(tool.name)}</h6>
            <small class="text-muted">${tool.description.substring(0, 60)}${tool.description.length > 60 ? '...' : ''}</small>
          </div>
          <span class="badge bg-secondary">${this.formatCategoryName(tool.category)}</span>
        </div>
      </div>
    `).join('');
  }

  renderNoSelection() {
    return `
      <div class="card h-100">
        <div class="card-body d-flex flex-column justify-content-center align-items-center text-muted">
          <i class="bi bi-arrow-left-circle" style="font-size: 3rem;"></i>
          <p class="mt-3 mb-0">Select a tool from the list to view details and execute</p>
        </div>
      </div>
    `;
  }

  renderToolDetails() {
    const tool = this.selectedTool;
    const params = tool.parameters?.properties || {};
    const required = tool.parameters?.required || [];

    return `
      <div class="card">
        <div class="card-header">
          <h5 class="mb-0">${this.formatToolName(tool.name)}</h5>
        </div>
        <div class="card-body">
          <p class="text-muted">${tool.description}</p>

          <div class="mb-4">
            <span class="badge bg-info me-2">${this.formatCategoryName(tool.category)}</span>
            ${tool.requiresAuth ? '<span class="badge bg-warning">Requires Auth</span>' : ''}
          </div>

          <!-- Parameters Form -->
          <h6>Parameters</h6>
          <form id="toolExecutionForm">
            ${Object.keys(params).length === 0 ? `
              <p class="text-muted small">This tool has no parameters</p>
            ` : Object.entries(params).map(([name, schema]) => `
              <div class="mb-3">
                <label class="form-label">
                  ${this.formatParamName(name)}
                  ${required.includes(name) ? '<span class="text-danger">*</span>' : ''}
                </label>
                ${this.renderParameterInput(name, schema, required.includes(name))}
                ${schema.description ? `<div class="form-text">${schema.description}</div>` : ''}
              </div>
            `).join('')}

            <button type="submit" class="btn btn-primary" id="executeToolBtn">
              <i class="bi bi-play-fill"></i> Execute Tool
            </button>
          </form>

          <!-- Examples -->
          ${tool.examples && tool.examples.length > 0 ? `
            <hr>
            <h6>Examples</h6>
            <div class="examples-list">
              ${tool.examples.map((example, idx) => `
                <div class="example-item mb-2">
                  <button class="btn btn-outline-secondary btn-sm load-example-btn" data-example-idx="${idx}">
                    Load Example ${idx + 1}
                  </button>
                  <code class="ms-2">${JSON.stringify(example.input)}</code>
                </div>
              `).join('')}
            </div>
          ` : ''}
        </div>
      </div>

      <!-- Execution Result -->
      <div class="card mt-3" id="executionResultCard" style="display: none;">
        <div class="card-header d-flex justify-content-between align-items-center">
          <h6 class="mb-0">Execution Result</h6>
          <span class="badge" id="executionStatusBadge"></span>
        </div>
        <div class="card-body">
          <pre id="executionResult" class="mb-0 p-3 bg-light rounded" style="max-height: 300px; overflow: auto;"></pre>
        </div>
      </div>
    `;
  }

  renderParameterInput(name, schema, isRequired) {
    const requiredAttr = isRequired ? 'required' : '';
    const dataName = `data-param="${name}"`;

    if (schema.enum) {
      return `
        <select class="form-select param-input" ${dataName} ${requiredAttr}>
          <option value="">Select ${this.formatParamName(name)}</option>
          ${schema.enum.map(opt => `<option value="${opt}">${opt}</option>`).join('')}
        </select>
      `;
    }

    switch (schema.type) {
      case 'number':
      case 'integer':
        return `
          <input type="number" class="form-control param-input" ${dataName} ${requiredAttr}
                 ${schema.minimum !== undefined ? `min="${schema.minimum}"` : ''}
                 ${schema.maximum !== undefined ? `max="${schema.maximum}"` : ''}
                 step="${schema.type === 'integer' ? '1' : 'any'}"
                 placeholder="${schema.default !== undefined ? `Default: ${schema.default}` : ''}">
        `;

      case 'boolean':
        return `
          <select class="form-select param-input" ${dataName}>
            <option value="">Select</option>
            <option value="true">True</option>
            <option value="false">False</option>
          </select>
        `;

      case 'array':
        return `
          <textarea class="form-control param-input" ${dataName} ${requiredAttr}
                    placeholder="Enter as JSON array, e.g., [1, 2, 3]" rows="2"></textarea>
        `;

      case 'object':
        return `
          <textarea class="form-control param-input" ${dataName} ${requiredAttr}
                    placeholder="Enter as JSON object" rows="3"></textarea>
        `;

      default:
        return `
          <input type="text" class="form-control param-input" ${dataName} ${requiredAttr}
                 placeholder="${schema.default !== undefined ? `Default: ${schema.default}` : ''}">
        `;
    }
  }

  renderExecutionHistory() {
    if (this.executionHistory.length === 0) {
      return `
        <p class="text-muted text-center mb-0">No recent executions</p>
      `;
    }

    return `
      <div class="table-responsive">
        <table class="table table-sm table-hover mb-0">
          <thead>
            <tr>
              <th>Tool</th>
              <th>Status</th>
              <th>Time</th>
              <th>Duration</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${this.executionHistory.map((exec, idx) => `
              <tr>
                <td>${this.formatToolName(exec.toolName)}</td>
                <td>
                  <span class="badge ${exec.success ? 'bg-success' : 'bg-danger'}">
                    ${exec.success ? 'Success' : 'Failed'}
                  </span>
                </td>
                <td>${new Date(exec.timestamp).toLocaleTimeString()}</td>
                <td>${exec.duration}ms</td>
                <td>
                  <button class="btn btn-sm btn-outline-secondary view-result-btn" data-exec-idx="${idx}">
                    View
                  </button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  attachEventListeners() {
    // Category filter
    const categoryFilter = document.getElementById('categoryFilter');
    if (categoryFilter) {
      categoryFilter.addEventListener('change', (e) => {
        this.selectedCategory = e.target.value || null;
        this.render();
      });
    }

    // Tool selection
    const toolItems = this.container.querySelectorAll('.tool-item');
    toolItems.forEach(item => {
      item.addEventListener('click', () => {
        const toolName = item.dataset.toolName;
        this.selectedTool = this.tools.find(t => t.name === toolName);
        this.render();
      });
    });

    // Tool execution form
    const form = document.getElementById('toolExecutionForm');
    if (form) {
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        this.executeTool();
      });
    }

    // Load example buttons
    const exampleBtns = this.container.querySelectorAll('.load-example-btn');
    exampleBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.exampleIdx);
        this.loadExample(idx);
      });
    });

    // View result buttons
    const viewResultBtns = this.container.querySelectorAll('.view-result-btn');
    viewResultBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.execIdx);
        this.showExecutionResult(this.executionHistory[idx]);
      });
    });
  }

  loadExample(idx) {
    if (!this.selectedTool?.examples?.[idx]) return;

    const example = this.selectedTool.examples[idx];
    const inputs = this.container.querySelectorAll('.param-input');

    inputs.forEach(input => {
      const paramName = input.dataset.param;
      if (example.input[paramName] !== undefined) {
        const value = example.input[paramName];
        if (typeof value === 'object') {
          input.value = JSON.stringify(value);
        } else {
          input.value = value;
        }
      }
    });
  }

  async executeTool() {
    if (!this.selectedTool) return;

    const btn = document.getElementById('executeToolBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Executing...';
    btn.disabled = true;

    try {
      // Collect parameters
      const parameters = {};
      const inputs = this.container.querySelectorAll('.param-input');
      const schema = this.selectedTool.parameters?.properties || {};

      inputs.forEach(input => {
        const paramName = input.dataset.param;
        let value = input.value.trim();

        if (value === '') return;

        const paramSchema = schema[paramName];
        if (paramSchema) {
          // Type conversion
          if (paramSchema.type === 'number' || paramSchema.type === 'integer') {
            value = Number(value);
          } else if (paramSchema.type === 'boolean') {
            value = value === 'true';
          } else if (paramSchema.type === 'array' || paramSchema.type === 'object') {
            try {
              value = JSON.parse(value);
            } catch (e) {
              throw new Error(`Invalid JSON for parameter ${paramName}`);
            }
          }
        }

        parameters[paramName] = value;
      });

      const startTime = Date.now();
      const response = await api.tools.execute(this.selectedTool.name, parameters);
      const duration = Date.now() - startTime;

      // Add to history
      this.executionHistory.unshift({
        toolName: this.selectedTool.name,
        parameters,
        success: response.success && response.data?.success,
        result: response.data,
        timestamp: new Date().toISOString(),
        duration,
      });

      // Keep only last 10 executions
      if (this.executionHistory.length > 10) {
        this.executionHistory.pop();
      }

      // Show result
      this.showExecutionResult(this.executionHistory[0]);
      this.render();

    } catch (error) {
      console.error('Tool execution error:', error);
      this.showError(error.message || 'Failed to execute tool');
    } finally {
      btn.innerHTML = originalText;
      btn.disabled = false;
    }
  }

  showExecutionResult(execution) {
    const card = document.getElementById('executionResultCard');
    const resultPre = document.getElementById('executionResult');
    const badge = document.getElementById('executionStatusBadge');

    if (!card || !resultPre || !badge) return;

    card.style.display = 'block';
    badge.className = `badge ${execution.success ? 'bg-success' : 'bg-danger'}`;
    badge.textContent = execution.success ? 'Success' : 'Failed';
    resultPre.textContent = JSON.stringify(execution.result, null, 2);
  }

  formatToolName(name) {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  formatCategoryName(category) {
    return category
      .split('-')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  formatParamName(name) {
    return name
      .split('_')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  showError(message) {
    // Use toast or alert
    if (typeof showToast === 'function') {
      showToast(message, 'error');
    } else {
      alert(message);
    }
  }
}

// Export for use
window.ToolsManager = ToolsManager;
