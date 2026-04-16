/**
 * Conversation Mode Component
 * Handles autonomous multi-agent brainstorming sessions
 */

class ConversationMode {
  constructor() {
    this.eventSource = null;
    this.isActive = false;
    this.isPaused = false;
    this.currentAgent = null;
    this.currentRound = 0;
    this.maxRounds = 10;
    this.tokensUsed = 0;
    this.tokenBudget = 50000;
    this.bindEvents();
  }

  /**
   * Bind event listeners using event delegation
   */
  bindEvents() {
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) return;

      const action = target.dataset.action;

      switch (action) {
        case 'start-conversation':
          this.startConversation();
          break;
        case 'pause-conversation':
          this.pauseConversation();
          break;
        case 'resume-conversation':
          this.resumeConversation();
          break;
        case 'stop-conversation':
          this.stopConversation();
          break;
        case 'send-interjection':
          this.sendInterjection();
          break;
      }
    });
  }

  /**
   * Check if conversation mode is available for the current session
   */
  isAvailable() {
    const session = window.chatInterface?.getCurrentSession();
    return session?.conversation_mode_enabled === 1;
  }

  /**
   * Get current session ID
   */
  getSessionId() {
    return window.chatInterface?.getCurrentSession()?.id;
  }

  /**
   * Start a new brainstorming conversation
   */
  async startConversation() {
    const sessionId = this.getSessionId();
    if (!sessionId) {
      showToast('Please select a session first', 'warning');
      return;
    }

    if (!this.isAvailable()) {
      showToast('Conversation mode is not enabled for this session. Enable it in Configure Session.', 'warning');
      return;
    }

    const input = document.getElementById('chat-input');
    const prompt = input?.value?.trim();

    if (!prompt) {
      showToast('Please enter a topic for the brainstorming session', 'warning');
      return;
    }

    try {
      // Get settings from session
      const session = window.chatInterface.getCurrentSession();
      this.maxRounds = session.conversation_max_rounds || 10;
      this.tokenBudget = session.conversation_token_budget || 50000;

      // Start conversation via API
      const response = await api.post(`/conversation/${sessionId}/start`, {
        prompt,
        maxRounds: this.maxRounds,
        tokenBudget: this.tokenBudget,
      });

      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to start conversation');
      }

      // Show controls and update state
      this.isActive = true;
      this.isPaused = false;
      this.currentRound = 0;
      this.tokensUsed = 0;
      this.showControls();

      // Clear input
      input.value = '';
      if (window.chatInterface) {
        window.chatInterface.updateCharCount();
      }

      // Add user message to chat
      window.chatInterface.addMessage({
        role: 'user',
        content: prompt,
      });

      // Start streaming
      this.streamConversation(sessionId);

      showToast('Brainstorming session started', 'success');
    } catch (error) {
      console.error('Failed to start conversation:', error);
      showToast(error.message || 'Failed to start brainstorming session', 'danger');
    }
  }

  /**
   * Stream conversation events via SSE
   */
  streamConversation(sessionId) {
    // Close any existing connection
    if (this.eventSource) {
      this.eventSource.close();
    }

    // Get auth token for SSE
    const token = localStorage.getItem('token');

    // Create EventSource with auth
    // Note: EventSource doesn't support custom headers, so we pass token as query param
    const url = `/api/conversation/${sessionId}/stream?token=${encodeURIComponent(token)}`;
    this.eventSource = new EventSource(url);

    this.currentAgent = null;

    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.handleStreamEvent(data);
      } catch (error) {
        console.error('Error parsing stream event:', error);
      }
    };

    this.eventSource.onerror = (error) => {
      console.error('EventSource error:', error);
      if (this.isActive) {
        this.handleConversationEnd({ reason: 'error', message: 'Connection lost' });
      }
    };
  }

  /**
   * Handle streaming events
   */
  handleStreamEvent(data) {
    switch (data.type) {
      case 'connected':
        console.log('Connected to conversation stream');
        break;

      case 'chunk':
        this.handleChunk(data);
        break;

      case 'round_complete':
        this.handleRoundComplete(data);
        break;

      case 'round_error':
        this.handleRoundError(data);
        break;

      case 'done':
        this.handleConversationEnd(data);
        break;

      case 'error':
        console.error('Conversation error:', data.message);
        showToast(`Error: ${data.message}`, 'danger');
        this.handleConversationEnd(data);
        break;
    }
  }

  /**
   * Handle incoming chunk
   */
  handleChunk(data) {
    const { agent, content, chunk } = data;
    const text = chunk || content || '';

    if (agent !== this.currentAgent) {
      // New agent speaking - finalize previous and start new message
      if (this.currentAgent) {
        window.chatInterface.finalizeStreamingMessage();
      }
      this.currentAgent = agent;
      window.chatInterface.startStreamingMessage(agent);
    }

    window.chatInterface.appendToStreamingMessage(text);
  }

  /**
   * Handle round completion
   */
  handleRoundComplete(data) {
    // Finalize the current streaming message
    if (this.currentAgent) {
      window.chatInterface.finalizeStreamingMessage();
      this.currentAgent = null;
    }

    this.currentRound = data.round || (this.currentRound + 1);
    this.tokensUsed = data.tokensUsed || this.tokensUsed;
    this.updateStatusDisplay();
  }

  /**
   * Handle round error
   */
  handleRoundError(data) {
    console.error(`Round ${data.round} error:`, data.error);

    // Finalize any streaming message
    if (this.currentAgent) {
      window.chatInterface.finalizeStreamingMessage();
      this.currentAgent = null;
    }

    // Add error indicator
    window.chatInterface.addMessage({
      role: 'assistant',
      content: `*Round ${data.round} encountered an error: ${data.error}*`,
      agent_name: 'System',
    });

    this.currentRound = data.round;
    this.updateStatusDisplay();
  }

  /**
   * Handle conversation end
   */
  handleConversationEnd(data) {
    // Finalize any pending message
    if (this.currentAgent) {
      window.chatInterface.finalizeStreamingMessage();
      this.currentAgent = null;
    }

    this.isActive = false;
    this.isPaused = false;

    // Close EventSource
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }

    // Update status
    this.updateStatusDisplay(data.reason || 'completed');

    // Add conclusion message if provided
    if (data.conclusion) {
      window.chatInterface.addMessage({
        role: 'assistant',
        content: `**Conversation Summary:**\n\n${data.conclusion}`,
        agent_name: 'Orchestrator',
      });
    }

    // Show completion message based on reason
    const reasonMessages = {
      'max_rounds': `Brainstorming completed after ${this.maxRounds} rounds`,
      'token_budget': 'Brainstorming completed (token budget reached)',
      'orchestrator_concluded': 'The orchestrator concluded the discussion',
      'stopped': 'Brainstorming stopped by user',
      'error': 'Brainstorming ended due to an error',
      'not_found': 'Session not found',
      'not_running': 'Conversation is not running',
    };

    const message = reasonMessages[data.reason] || 'Brainstorming session ended';
    showToast(message, data.reason === 'error' ? 'warning' : 'info');
  }

  /**
   * Pause the conversation
   */
  async pauseConversation() {
    const sessionId = this.getSessionId();
    if (!sessionId || !this.isActive) return;

    try {
      await api.post(`/conversation/${sessionId}/pause`);
      this.isPaused = true;
      this.updateStatusDisplay('paused');
      showToast('Brainstorming paused', 'info');
    } catch (error) {
      console.error('Error pausing conversation:', error);
      showToast('Failed to pause conversation', 'danger');
    }
  }

  /**
   * Resume the conversation
   */
  async resumeConversation() {
    const sessionId = this.getSessionId();
    if (!sessionId || !this.isPaused) return;

    try {
      await api.post(`/conversation/${sessionId}/resume`);
      this.isPaused = false;
      this.updateStatusDisplay('running');

      // Reconnect to stream
      this.streamConversation(sessionId);

      showToast('Brainstorming resumed', 'success');
    } catch (error) {
      console.error('Error resuming conversation:', error);
      showToast('Failed to resume conversation', 'danger');
    }
  }

  /**
   * Stop the conversation
   */
  async stopConversation() {
    const sessionId = this.getSessionId();
    if (!sessionId) return;

    try {
      await api.post(`/conversation/${sessionId}/stop`);

      // Close EventSource
      if (this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }

      this.isActive = false;
      this.isPaused = false;
      this.updateStatusDisplay('stopped');

      showToast('Brainstorming stopped', 'info');
    } catch (error) {
      console.error('Error stopping conversation:', error);
      showToast('Failed to stop conversation', 'danger');
    }
  }

  /**
   * Send a user interjection during the conversation
   */
  async sendInterjection() {
    const sessionId = this.getSessionId();
    if (!sessionId || !this.isActive) {
      // If not in conversation mode, use regular send
      window.chatInterface.sendMessage();
      return;
    }

    const input = document.getElementById('chat-input');
    const message = input?.value?.trim();

    if (!message) return;

    try {
      await api.post(`/conversation/${sessionId}/interjection`, { message });

      // Add to chat
      window.chatInterface.addMessage({
        role: 'user',
        content: message,
      });

      // Clear input
      input.value = '';
      if (window.chatInterface) {
        window.chatInterface.updateCharCount();
      }

      showToast('Interjection added to conversation', 'success');
    } catch (error) {
      console.error('Error sending interjection:', error);
      showToast(error.message || 'Failed to send interjection', 'danger');
    }
  }

  /**
   * Show conversation controls
   */
  showControls() {
    const controlsDiv = document.getElementById('conversation-controls');
    if (controlsDiv) {
      controlsDiv.classList.remove('d-none');
    }
    this.updateStatusDisplay('running');
  }

  /**
   * Hide conversation controls
   */
  hideControls() {
    const controlsDiv = document.getElementById('conversation-controls');
    if (controlsDiv) {
      controlsDiv.classList.add('d-none');
    }
  }

  /**
   * Update status display
   */
  updateStatusDisplay(status = null) {
    const statusBadge = document.getElementById('conversation-status');
    const roundDisplay = document.getElementById('current-round');
    const maxRoundsDisplay = document.getElementById('max-rounds');
    const pauseBtn = document.getElementById('pause-conversation-btn');
    const resumeBtn = document.getElementById('resume-conversation-btn');
    const stopBtn = document.getElementById('stop-conversation-btn');

    // Update round counter
    if (roundDisplay) {
      roundDisplay.textContent = this.currentRound;
    }
    if (maxRoundsDisplay) {
      maxRoundsDisplay.textContent = this.maxRounds;
    }

    // Update status badge
    if (statusBadge && status) {
      const statusConfig = {
        running: { text: 'Running', class: 'bg-success' },
        paused: { text: 'Paused', class: 'bg-warning' },
        stopped: { text: 'Stopped', class: 'bg-danger' },
        completed: { text: 'Completed', class: 'bg-secondary' },
        error: { text: 'Error', class: 'bg-danger' },
      };

      const config = statusConfig[status] || statusConfig.completed;
      statusBadge.textContent = config.text;
      statusBadge.className = `badge ${config.class}`;
    }

    // Update button visibility
    if (pauseBtn && resumeBtn && stopBtn) {
      if (this.isActive && !this.isPaused) {
        pauseBtn.classList.remove('d-none');
        resumeBtn.classList.add('d-none');
        stopBtn.classList.remove('d-none');
      } else if (this.isActive && this.isPaused) {
        pauseBtn.classList.add('d-none');
        resumeBtn.classList.remove('d-none');
        stopBtn.classList.remove('d-none');
      } else {
        // Not active
        pauseBtn.classList.add('d-none');
        resumeBtn.classList.add('d-none');
        stopBtn.classList.add('d-none');
      }
    }
  }

  /**
   * Get conversation state from server
   */
  async getState() {
    const sessionId = this.getSessionId();
    if (!sessionId) return null;

    try {
      const response = await api.get(`/conversation/${sessionId}/state`);
      return response.data;
    } catch (error) {
      console.error('Error getting conversation state:', error);
      return null;
    }
  }

  /**
   * Reset state when session changes
   */
  reset() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.isActive = false;
    this.isPaused = false;
    this.currentAgent = null;
    this.currentRound = 0;
    this.hideControls();
  }

  /**
   * Check if conversation is currently active
   */
  isConversationActive() {
    return this.isActive;
  }
}

// Create global instance
window.conversationMode = new ConversationMode();

// Ensure conversation mode resets when session changes
document.addEventListener('sessionChanged', () => {
  window.conversationMode?.reset();
});
