/**
 * Chat Interface Component
 * Handles chat display and user interactions for multi-agent conversations
 */

class ChatInterface {
  constructor() {
    this.currentSession = null;
    this.messages = [];
    this.isStreaming = false;
    this.abortStream = null;
    this.useStreaming = true;
    this.autocompleteVisible = false;
    this.autocompleteMatches = [];
    this.autocompleteSelectedIndex = 0;
    this.autocompleteStartPos = -1;
    this.pollInterval = null;
    this.lastMessageCount = 0;
    this.reconnectPollInterval = null;
    this.lastMessageHash = null; // Track message content to detect updates
    // Pagination state for archived messages
    this.messageOffset = 0; // Number of messages already loaded from the end
    this.hasMoreMessages = false; // Whether there are more older messages to load
    this.totalMessages = 0; // Total message count in the session
    this.isLoadingOlder = false; // Flag to prevent multiple simultaneous loads
    this.initialLoadLimit = 100; // Number of messages to load initially
    // Bookmarks state
    this.bookmarks = new Map(); // Map of sessionId -> Set of messageIds
    // Pending documents uploaded via chat upload button (for @-mention assignment)
    this.pendingDocuments = [];
  }

  /**
   * Initialize chat interface
   */
  async init() {
    this.bindEvents();
    const uploadBtn = document.getElementById('chat-upload-btn');
    if (uploadBtn) uploadBtn.disabled = !this.currentSession;
  }

  /**
   * Bind event listeners
   */
  bindEvents() {
    // Send button click
    document.addEventListener('click', (e) => {
      if (e.target.closest('#send-btn')) {
        e.preventDefault();
        this.sendMessage();
      }
      if (e.target.closest('#stop-stream-btn')) {
        this.stopStream();
      }
      // Close autocomplete when clicking outside
      if (!e.target.closest('#chat-autocomplete') && !e.target.closest('#chat-input')) {
        this.hideAutocomplete();
      }
    });

    // Enter key to send (Shift+Enter for new line)
    document.addEventListener('keydown', (e) => {
      const chatInput = document.getElementById('chat-input');
      if (e.target.id === 'chat-input') {
        if (e.key === 'Enter' && !e.shiftKey) {
          if (this.autocompleteVisible) {
            e.preventDefault();
            this.selectAutocompleteItem(this.autocompleteSelectedIndex);
          } else {
            e.preventDefault();
            this.sendMessage();
          }
        } else if (e.key === 'Tab' && this.autocompleteVisible) {
          e.preventDefault();
          this.selectAutocompleteItem(this.autocompleteSelectedIndex);
        } else if (e.key === 'ArrowDown' && this.autocompleteVisible) {
          e.preventDefault();
          this.autocompleteSelectedIndex = Math.min(
            this.autocompleteSelectedIndex + 1,
            this.autocompleteMatches.length - 1
          );
          this.updateAutocompleteSelection();
        } else if (e.key === 'ArrowUp' && this.autocompleteVisible) {
          e.preventDefault();
          this.autocompleteSelectedIndex = Math.max(this.autocompleteSelectedIndex - 1, 0);
          this.updateAutocompleteSelection();
        } else if (e.key === 'Escape' && this.autocompleteVisible) {
          e.preventDefault();
          this.hideAutocomplete();
        }
      }
    });

    // Listen for input changes to detect @ mentions
    const chatInput = document.getElementById('chat-input');
    if (chatInput) {
      chatInput.addEventListener('input', (e) => {
        this.handleAutocompleteInput(e);
        this.updateCharCount();
      });
    }

    // Listen for session changes to update conversation mode badge and upload button
    document.addEventListener('sessionChanged', (e) => {
      if (e.detail) {
        this.currentSession = e.detail.session || null;
        this.updateConversationModeBadge();
      }
      const uploadBtn = document.getElementById('chat-upload-btn');
      if (uploadBtn) uploadBtn.disabled = !this.currentSession;
    });
  }

  /**
   * Set the current session for chat
   */
  async setSession(session) {
    // Stop polling for previous session
    this.stopPolling();
    this.stopReconnectPolling();

    // Clean up scroll handler for previous session
    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages && this.scrollHandler) {
      chatMessages.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }

    // Abort any active stream when switching sessions (but don't stop backend processing)
    if (this.abortStream) {
      this.abortStream();
      this.abortStream = null;
      this.isStreaming = false;
    }

    this.currentSession = session;
    this.messages = [];
    this.pendingDocuments = [];
    this.updateUploadBadge();
    const uploadBtn = document.getElementById('chat-upload-btn');
    if (uploadBtn) uploadBtn.disabled = !session;
    // Reset pagination state
    this.messageOffset = 0;
    this.hasMoreMessages = false;
    this.totalMessages = 0;
    // Load bookmarks for this session
    this.loadBookmarks();

    if (session) {
      await this.loadHistory();
      this.lastMessageCount = this.messages.length;
      this.lastMessageHash = this.getMessageHash();

      // Check if there's an active stream on the backend we can reconnect to
      const reconnected = await this.tryReconnectToStream();

      if (!reconnected) {
        // No active stream - check if there's an incomplete message
        const hasIncompleteMessage = this.checkForIncompleteMessage();

        if (hasIncompleteMessage) {
          // Start aggressive polling to catch streaming updates
          this.startReconnectPolling();
        } else {
          // Start normal polling for new messages from external sources
          this.startPolling();
        }
      }
    }

    this.renderMessages();
    this.updateConversationModeBadge();
    this.loadContextTokenEstimates();
  }

  /**
   * Try to reconnect to an active streaming session on the backend
   * @returns {Promise<boolean>} - True if reconnected, false if no active stream
   */
  async tryReconnectToStream() {
    if (!this.currentSession) return false;

    try {
      // Check if there's an active stream
      const response = await api.chat.getStreamStatus(this.currentSession.id);

      if (!response.data.isStreaming) {
        return false;
      }

      // There's an active stream - reconnect to it
      console.log('Reconnecting to active stream for session', this.currentSession.id);

      // Create a placeholder message for the streaming response
      const assistantMessage = {
        id: 'reconnect-' + Date.now(),
        role: 'assistant',
        content: '',
        created_at: new Date().toISOString(),
        isReconnecting: true,
      };

      this.messages.push(assistantMessage);
      this.renderMessages();
      this.setStreaming(true);

      return new Promise((resolve) => {
        this.abortStream = api.chat.reconnectStream(
          this.currentSession.id,
          {
            onReconnected: (content) => {
              // Got buffered content from before disconnect
              assistantMessage.content = typeof content === 'string' ? content : (content && (content.content ?? content.text)) ?? String(content ?? '');
              assistantMessage.isReconnecting = false;
              this.updateStreamingMessage(assistantMessage);
            },
            onChunk: (chunk) => {
              // Got new streaming chunk
              const text = typeof chunk === 'string' ? chunk : (chunk && (chunk.content ?? chunk.text)) ?? String(chunk ?? '');
              assistantMessage.content += text;
              this.updateStreamingMessage(assistantMessage);
            },
            onDone: async (data) => {
              // Stream completed
              assistantMessage.agent_name = data.agentName;
              assistantMessage.isReconnecting = false;
              this.setStreaming(false);
              this.renderMessages();

              // Refresh history to get the saved message with proper ID
              await this.loadHistory();
              this.renderMessages();

              // Start normal polling
              this.startPolling();
              resolve(true);
            },
            onNotFound: () => {
              // No active stream found
              console.log('No active stream found for session', this.currentSession.id);
              this.messages = this.messages.filter(m => m.id !== assistantMessage.id);
              this.setStreaming(false);
              this.renderMessages();
              resolve(false);
            },
            onError: (error) => {
              console.error('Error reconnecting to stream:', error);
              this.messages = this.messages.filter(m => m.id !== assistantMessage.id);
              this.setStreaming(false);
              this.renderMessages();
              resolve(false);
            },
          }
        );
      });
    } catch (error) {
      console.error('Error checking stream status:', error);
      return false;
    }
  }

  /**
   * Check if there's an incomplete message (user message without assistant response)
   */
  checkForIncompleteMessage() {
    if (this.messages.length === 0) return false;

    // Get the last message
    const lastMessage = this.messages[this.messages.length - 1];

    // If last message is a user message, it might be waiting for a response
    if (lastMessage.role === 'user') {
      // Check if it's very recent (within last 60 seconds) - likely still processing
      const messageTime = new Date(lastMessage.created_at).getTime();
      const now = Date.now();
      const timeDiff = now - messageTime;

      // If message is less than 60 seconds old, assume it might still be processing
      // This gives more time for longer agent responses
      return timeDiff < 60000;
    }

    // If last message is assistant but very short or empty, might still be streaming
    if (lastMessage.role === 'assistant') {
      const messageTime = new Date(lastMessage.created_at).getTime();
      const now = Date.now();
      const timeDiff = now - messageTime;

      // If assistant message is very recent (within 10 seconds) and very short,
      // it might still be streaming
      if (timeDiff < 10000 && (!lastMessage.content || lastMessage.content.length < 50)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Generate a hash of the last message to detect content changes
   * @param {Array} messages - Optional messages array, defaults to this.messages
   */
  getMessageHash(messages = null) {
    const msgs = messages || this.messages;
    if (!msgs || msgs.length === 0) return null;
    const lastMessage = msgs[msgs.length - 1];
    if (!lastMessage) return null;
    // Create a simple hash based on message content and count
    const content = lastMessage.content || '';
    return `${msgs.length}-${lastMessage.id || 'unknown'}-${content.substring(0, 50)}`;
  }

  /**
   * Start polling for new messages (to detect external messages from n8n, etc.)
   */
  startPolling() {
    // Poll every 5 seconds for new messages
    this.pollInterval = setInterval(async () => {
      if (!this.currentSession || this.isStreaming) return;

      try {
        // Get the most recent messages to check for new ones
        // We only need to check the last few messages, not all of them
        const response = await api.chat.getHistory(this.currentSession.id, 50, 0);
        const recentMessages = response.data.messages || [];
        const totalCount = response.data.total || 0;

        // Update total count and hasMore status
        this.totalMessages = totalCount;

        // Check if we have new messages at the end
        if (recentMessages.length > 0 && this.messages.length > 0) {
          const lastLoadedMessageId = this.messages[this.messages.length - 1]?.id;
          const lastRecentMessageId = recentMessages[recentMessages.length - 1]?.id;

          // If there are new messages (newer than what we have loaded)
          if (lastRecentMessageId && lastRecentMessageId !== lastLoadedMessageId) {
            // Find where new messages start
            const newMessagesStartIndex = recentMessages.findIndex(
              msg => msg.id === lastLoadedMessageId
            );

            if (newMessagesStartIndex >= 0) {
              // Add only the new messages
              const newMessages = recentMessages.slice(newMessagesStartIndex + 1);
              this.messages = [...this.messages, ...newMessages];
              this.lastMessageCount = this.messages.length;
              this.renderMessages();
            } else {
              // Last message not found in recent, might have been many new messages
              // Reload from current offset to get all new messages
              const currentOffset = this.messageOffset;
              const checkResponse = await api.chat.getHistory(
                this.currentSession.id,
                this.messages.length - currentOffset + 50,
                0
              );
              const allMessages = checkResponse.data.messages || [];
              if (allMessages.length > this.messages.length) {
                this.messages = allMessages;
                this.messageOffset = this.messages.length;
                this.lastMessageCount = this.messages.length;
                this.hasMoreMessages = checkResponse.data.hasMore || false;
                this.renderMessages();
              }
            }
          }
        } else if (recentMessages.length > this.messages.length) {
          // If we have fewer messages loaded than recent, update
          this.messages = recentMessages;
          this.messageOffset = this.messages.length;
          this.lastMessageCount = this.messages.length;
          this.hasMoreMessages = response.data.hasMore || false;
          this.renderMessages();
        }
      } catch (error) {
        // Silently fail polling errors to avoid spamming console
        console.debug('Error polling for new messages:', error);
      }
    }, 5000); // Poll every 5 seconds
  }

  /**
   * Start aggressive polling to reconnect to an active stream
   * This polls more frequently to catch streaming updates
   */
  startReconnectPolling() {
    // Poll every 1 second to catch streaming updates quickly
    this.reconnectPollInterval = setInterval(async () => {
      if (!this.currentSession) {
        this.stopReconnectPolling();
        return;
      }

      // If we're actively streaming now, stop reconnect polling
      if (this.isStreaming) {
        this.stopReconnectPolling();
        // Normal polling will start when streaming completes
        return;
      }

      try {
        // Get recent messages to check for updates (only need the last batch)
        const response = await api.chat.getHistory(this.currentSession.id, 50, 0);
        const recentMessages = response.data.messages || [];

        // Check if we have new messages at the end
        if (recentMessages.length > 0 && this.messages.length > 0) {
          const lastLoadedMessageId = this.messages[this.messages.length - 1]?.id;
          const lastRecentMessageId = recentMessages[recentMessages.length - 1]?.id;

          // If there are new messages or content changed
          if (lastRecentMessageId && lastRecentMessageId !== lastLoadedMessageId) {
            // Find where new messages start and add them
            const newMessagesStartIndex = recentMessages.findIndex(
              msg => msg.id === lastLoadedMessageId
            );

            if (newMessagesStartIndex >= 0) {
              const newMessages = recentMessages.slice(newMessagesStartIndex + 1);
              this.messages = [...this.messages, ...newMessages];
            } else {
              // Reload all messages if structure changed significantly
              this.messages = recentMessages;
            }

            this.lastMessageCount = this.messages.length;
            this.lastMessageHash = this.getMessageHash();
            this.renderMessages();
          } else {
            // Check if content of last message changed (streaming update)
            const lastLoadedMessage = this.messages[this.messages.length - 1];
            const lastRecentMessage = recentMessages[recentMessages.length - 1];

            if (lastLoadedMessage && lastRecentMessage &&
              lastLoadedMessage.id === lastRecentMessage.id &&
              lastLoadedMessage.content !== lastRecentMessage.content) {
              // Update the last message content
              this.messages[this.messages.length - 1] = lastRecentMessage;
              this.lastMessageHash = this.getMessageHash();
              this.renderMessages();
            }
          }
        } else if (recentMessages.length !== this.messages.length) {
          // Message count changed
          this.messages = recentMessages;
          this.lastMessageCount = this.messages.length;
          this.lastMessageHash = this.getMessageHash();
          this.renderMessages();
        }

        // Check if we now have a complete message (user + assistant)
        const hasIncompleteMessage = this.checkForIncompleteMessage();
        if (!hasIncompleteMessage) {
          // Message is complete, switch to normal polling
          this.stopReconnectPolling();
          this.startPolling();
        }
      } catch (error) {
        // Silently fail polling errors to avoid spamming console
        console.debug('Error reconnecting to stream:', error);
        // If we get repeated errors, stop reconnect polling and switch to normal
        this.stopReconnectPolling();
        this.startPolling();
      }
    }, 1000); // Poll every 1 second for reconnection
  }

  /**
   * Stop aggressive reconnect polling
   */
  stopReconnectPolling() {
    if (this.reconnectPollInterval) {
      clearInterval(this.reconnectPollInterval);
      this.reconnectPollInterval = null;
    }
  }

  /**
   * Stop polling for new messages
   */
  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  /**
   * Update conversation mode badge visibility
   */
  updateConversationModeBadge() {
    const badge = document.getElementById('conversation-mode-badge');
    const clearBtn = document.getElementById('clear-session-btn');
    const brainstormingToggle = document.getElementById('brainstorming-toggle');

    if (badge) {
      if (this.currentSession && this.currentSession.conversation_mode_enabled) {
        badge.classList.remove('d-none');
      } else {
        badge.classList.add('d-none');
      }
    }

    if (brainstormingToggle) {
      brainstormingToggle.disabled = !this.currentSession;
      brainstormingToggle.checked = !!(this.currentSession && (this.currentSession.conversation_mode_enabled === 1 || this.currentSession.conversation_mode_enabled === true));
    }

    // Show Clear Session button when a session is active
    if (clearBtn) {
      if (this.currentSession) {
        clearBtn.classList.remove('d-none');
      } else {
        clearBtn.classList.add('d-none');
      }
    }

    // Show Export PDF button when a session is active
    const exportPdfBtn = document.getElementById('export-pdf-btn');
    if (exportPdfBtn) {
      if (this.currentSession) {
        exportPdfBtn.classList.remove('d-none');
      } else {
        exportPdfBtn.classList.add('d-none');
      }
    }

    // Show Export Image button when a session is active
    const exportImageBtn = document.getElementById('export-image-btn');
    if (exportImageBtn) {
      if (this.currentSession) {
        exportImageBtn.classList.remove('d-none');
      } else {
        exportImageBtn.classList.add('d-none');
      }
    }

    // Show Bookmarks button when a session is active
    const bookmarksBtn = document.getElementById('bookmarks-btn');
    if (bookmarksBtn) {
      if (this.currentSession) {
        bookmarksBtn.classList.remove('d-none');
      } else {
        bookmarksBtn.classList.add('d-none');
      }
    }
  }

  /**
   * Clear session conversation history
   */
  async clearSession() {
    if (!this.currentSession) {
      showToast('No active session', 'warning');
      return;
    }

    // Confirmation dialog
    const confirmed = confirm(
      `Are you sure you want to clear all messages in "${this.currentSession.name}"?\n\n` +
      'This action cannot be undone. The session settings and assigned agents/documents will be preserved.'
    );

    if (!confirmed) return;

    try {
      await api.sessions.clearMessages(this.currentSession.id);

      // Clear local messages
      this.messages = [];
      this.lastMessageCount = 0;
      // Reset pagination state
      this.messageOffset = 0;
      this.hasMoreMessages = false;
      this.totalMessages = 0;
      // Remove indicators
      const chatMessages = document.getElementById('chat-messages');
      if (chatMessages) {
        const loader = document.getElementById('older-messages-loader');
        const indicator = document.getElementById('more-messages-indicator');
        if (loader) loader.remove();
        if (indicator) indicator.remove();
      }
      this.renderMessages();

      showToast('Session conversation history cleared', 'success');
    } catch (error) {
      console.error('Error clearing session:', error);
      showToast(error.message || 'Failed to clear session', 'danger');
    }
  }

  /**
   * Load chat history for current session
   */
  async loadHistory() {
    if (!this.currentSession) return;

    try {
      // Reset pagination state when loading a new session
      this.messageOffset = 0;
      this.hasMoreMessages = false;
      this.totalMessages = 0;

      // Load initial batch of messages (most recent 100)
      const response = await api.chat.getHistory(
        this.currentSession.id,
        this.initialLoadLimit,
        0
      );

      const serverMessages = response.data.messages || [];
      // Preserve local attachment info for user messages (e.g. just-sent message with attached docs)
      const prevWithAttach = (this.messages || []).filter(m => m.role === 'user' && m.attachedDocumentsInfo && m.attachedDocumentsInfo.documentNames && m.attachedDocumentsInfo.documentNames.length);
      this.messages = serverMessages;
      prevWithAttach.forEach(prev => {
        const match = this.messages.find(m => m.role === 'user' && m.content === prev.content && !m.attachedDocumentsInfo);
        if (match) match.attachedDocumentsInfo = prev.attachedDocumentsInfo;
      });
      this.totalMessages = response.data.total || 0;
      this.hasMoreMessages = response.data.hasMore || false;
      this.messageOffset = this.messages.length;
      this.lastMessageCount = this.messages.length;
      this.lastMessageHash = this.getMessageHash();

      // Setup scroll detection for loading older messages
      this.setupScrollDetection();
    } catch (error) {
      console.error('Error loading chat history:', error);
      showToast('Failed to load chat history', 'danger');
    }
  }

  /**
   * Setup scroll detection to load older messages when scrolling to top
   */
  setupScrollDetection() {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    // Remove existing scroll listener if any
    if (this.scrollHandler) {
      chatMessages.removeEventListener('scroll', this.scrollHandler);
    }

    // Create new scroll handler
    this.scrollHandler = () => {
      // Check if scrolled near the top (within 200px)
      if (chatMessages.scrollTop < 200 && this.hasMoreMessages && !this.isLoadingOlder) {
        this.loadOlderMessages();
      }
    };

    chatMessages.addEventListener('scroll', this.scrollHandler);
  }

  /**
   * Load older archived messages
   */
  async loadOlderMessages() {
    if (!this.currentSession || this.isLoadingOlder || !this.hasMoreMessages) {
      return;
    }

    this.isLoadingOlder = true;
    const chatMessages = document.getElementById('chat-messages');
    const scrollHeightBefore = chatMessages ? chatMessages.scrollHeight : 0;

    try {
      // Show loading indicator
      this.showOlderMessagesLoader(true);

      // Load next batch of older messages
      const loadBatchSize = 50; // Load 50 older messages at a time
      const response = await api.chat.getHistory(
        this.currentSession.id,
        loadBatchSize,
        this.messageOffset
      );

      const olderMessages = response.data.messages || [];

      if (olderMessages.length > 0) {
        // Prepend older messages to the beginning
        this.messages = [...olderMessages, ...this.messages];
        this.messageOffset += olderMessages.length;
        this.hasMoreMessages = response.data.hasMore || false;
        this.lastMessageCount = this.messages.length;

        // Render messages without scrolling to bottom
        this.renderMessages(false);

        // Restore scroll position to maintain user's view
        if (chatMessages) {
          const scrollHeightAfter = chatMessages.scrollHeight;
          const scrollDifference = scrollHeightAfter - scrollHeightBefore;
          chatMessages.scrollTop = scrollDifference;
        }
      } else {
        this.hasMoreMessages = false;
      }

      // Hide loading indicator
      this.showOlderMessagesLoader(false);
    } catch (error) {
      console.error('Error loading older messages:', error);
      showToast('Failed to load older messages', 'danger');
      this.showOlderMessagesLoader(false);
    } finally {
      this.isLoadingOlder = false;
    }
  }

  /**
   * Show/hide loading indicator for older messages
   */
  showOlderMessagesLoader(show) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    let loader = document.getElementById('older-messages-loader');

    if (show) {
      if (!loader) {
        loader = document.createElement('div');
        loader.id = 'older-messages-loader';
        loader.className = 'text-center py-3';
        loader.innerHTML = `
          <div class="spinner-border spinner-border-sm text-primary" role="status">
            <span class="visually-hidden">Loading older messages...</span>
          </div>
          <small class="text-muted d-block mt-2">Loading older messages...</small>
        `;
        chatMessages.insertBefore(loader, chatMessages.firstChild);
      }
      loader.style.display = 'block';
    } else {
      if (loader) {
        loader.style.display = 'none';
      }
    }
  }

  /**
   * Show indicator when more messages are available
   */
  showMoreMessagesIndicator() {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    let indicator = document.getElementById('more-messages-indicator');

    if (this.hasMoreMessages) {
      if (!indicator) {
        indicator = document.createElement('div');
        indicator.id = 'more-messages-indicator';
        indicator.className = 'text-center py-2 border-bottom bg-light';
        indicator.style.cursor = 'pointer';
        indicator.style.transition = 'background-color 0.2s';
        indicator.innerHTML = `
          <small class="text-muted">
            <i class="bi bi-arrow-up"></i> Scroll up to load older messages
          </small>
        `;
        indicator.addEventListener('click', () => this.loadOlderMessages());
        indicator.addEventListener('mouseenter', () => {
          indicator.style.backgroundColor = '#e9ecef';
        });
        indicator.addEventListener('mouseleave', () => {
          indicator.style.backgroundColor = '#f8f9fa';
        });
        // Insert at the beginning, but after any loader
        const firstChild = chatMessages.firstChild;
        if (firstChild && firstChild.id === 'older-messages-loader') {
          chatMessages.insertBefore(indicator, firstChild.nextSibling);
        } else {
          chatMessages.insertBefore(indicator, firstChild);
        }
      }
      indicator.style.display = 'block';
    } else {
      if (indicator) {
        indicator.style.display = 'none';
      }
    }
  }

  /**
   * Render messages in chat area
   * @param {boolean} scrollToBottom - Whether to scroll to bottom after rendering (default: true)
   */
  renderMessages(scrollToBottom = true) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    if (!this.currentSession) {
      chatMessages.innerHTML = `
        <div class="text-center text-muted mt-5">
          <i class="bi bi-chat-dots" style="font-size: 3rem;"></i>
          <p class="mt-3">Select a session to start chatting</p>
        </div>
      `;
      return;
    }

    if (this.messages.length === 0) {
      chatMessages.innerHTML = `
        <div class="text-center text-muted mt-5">
          <i class="bi bi-chat-left-text" style="font-size: 3rem;"></i>
          <p class="mt-3">No messages yet. Start the conversation!</p>
          <p class="small">${this.getAgentSummary()}</p>
        </div>
      `;
      return;
    }

    // Determine which messages are in active context vs archived
    // Active context = most recent context_length messages (default 50)
    const contextLength = this.currentSession.context_length || 50;
    const activeContextStartIndex = Math.max(0, this.messages.length - contextLength);
    let archivedBoundaryShown = false;

    // Render messages with archived indicators
    const messagesHtml = this.messages.map((msg, index) => {
      const isArchived = index < activeContextStartIndex;

      // Add separator before first archived message
      let separator = '';
      if (isArchived && !archivedBoundaryShown && activeContextStartIndex > 0) {
        archivedBoundaryShown = true;
        separator = this.renderArchivedBoundary();
      }

      return separator + this.renderMessage(msg, isArchived);
    }).join('');

    chatMessages.innerHTML = messagesHtml;
    this.attachArtifactHandlers();
    this.attachDeleteHandlers();
    this.attachCopyHandlers();
    this.attachBookmarkHandlers();

    // Show indicator for more messages if available
    this.showMoreMessagesIndicator();

    // Only scroll to bottom if not loading older messages
    if (scrollToBottom && !this.isLoadingOlder) {
      this.scrollToBottom();
    }
  }

  /**
   * Render the boundary separator between active context and archived messages
   */
  renderArchivedBoundary() {
    return `
      <div class="archived-boundary my-3 py-2 border-top border-bottom bg-light">
        <div class="text-center">
          <small class="text-muted">
            <i class="bi bi-archive"></i> Archived Messages (Reference Only)
          </small>
          <br>
          <small class="text-muted" style="font-size: 0.7rem;">
            These messages are not included in the agent's context to save tokens
          </small>
        </div>
      </div>
    `;
  }

  /**
   * Attach event handlers for artifact iframe controls and set iframe content
   */
  attachArtifactHandlers() {
    // Set iframe src for persisted artifacts (from metadata)
    document.querySelectorAll('.iframe-artifact-container iframe[data-artifact-url]').forEach((iframe) => {
      const url = iframe.getAttribute('data-artifact-url');
      const artifactId = iframe.getAttribute('data-artifact-id');

      if (url) {
        // Use persisted artifact URL
        iframe.src = url;
        if (artifactId) {
          iframe.dataset.artifactId = artifactId;
        }
        iframe.removeAttribute('data-artifact-url');
        iframe.removeAttribute('data-artifact-id');
      }
    });

    // Create artifacts via API for new artifacts (not persisted yet)
    // Now uses Base64 encoding to preserve newlines
    document.querySelectorAll('.iframe-artifact-container iframe[data-artifact-code-base64]').forEach(async (iframe) => {
      const base64Code = iframe.getAttribute('data-artifact-code-base64');

      if (base64Code) {
        // Decode the Base64-encoded code
        let decodedCode;
        try {
          decodedCode = decodeURIComponent(escape(atob(base64Code)));
        } catch (e) {
          console.error('Error decoding Base64 artifact code:', e);
          iframe.removeAttribute('data-artifact-code-base64');
          return;
        }

        try {
          // Create artifact via API
          const result = await api.artifacts.create(decodedCode);
          if (result.success && result.url) {
            // Set iframe src to the artifact URL
            iframe.src = result.url;
            // Store artifact ID for reload
            iframe.dataset.artifactId = result.artifactId;
          } else {
            console.error('Failed to create artifact:', result);
            // Fallback to blob URL
            const blob = new Blob([decodedCode], { type: 'text/html' });
            iframe.src = URL.createObjectURL(blob);
          }
        } catch (error) {
          console.error('Error creating artifact:', error);
          // Fallback to blob URL
          try {
            const blob = new Blob([decodedCode], { type: 'text/html' });
            iframe.src = URL.createObjectURL(blob);
          } catch (blobError) {
            console.error('Error creating blob URL:', blobError);
            // Last resort: use srcdoc
            iframe.srcdoc = decodedCode;
          }
        }

        iframe.removeAttribute('data-artifact-code-base64');
      }
    });

    // Reload buttons
    document.querySelectorAll('.artifact-reload-btn').forEach(btn => {
      // Remove existing listeners to avoid duplicates
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      newBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const iframeId = newBtn.dataset.iframeId;
        const iframe = document.getElementById(iframeId);
        if (iframe) {
          // Reload iframe
          if (iframe.dataset.artifactId) {
            // Reload server-hosted artifact
            const artifactId = iframe.dataset.artifactId;
            iframe.src = `/api/artifacts/${artifactId}?t=${Date.now()}`;
          } else if (iframe.src && iframe.src.startsWith('blob:')) {
            // Reload blob URL by creating a new one
            // Note: We'd need to store the original content, but for now just reload
            iframe.src = iframe.src;
          } else if (iframe.srcdoc) {
            // Fallback for srcdoc approach
            const currentContent = iframe.srcdoc;
            iframe.srcdoc = '';
            setTimeout(() => {
              iframe.srcdoc = currentContent;
            }, 10);
          }
        }
      });
    });

    // Toggle height buttons
    document.querySelectorAll('.artifact-toggle-height-btn').forEach(btn => {
      // Remove existing listeners to avoid duplicates
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      newBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const iframeId = newBtn.dataset.iframeId;
        const iframe = document.getElementById(iframeId);
        if (iframe) {
          const currentHeight = iframe.style.height;
          if (currentHeight === '400px' || currentHeight === '') {
            iframe.style.height = 'auto';
            iframe.style.minHeight = '400px';
          } else {
            iframe.style.height = '400px';
            iframe.style.minHeight = '';
          }
        }
      });
    });

    // Open in new window buttons
    document.querySelectorAll('.artifact-open-window-btn').forEach(btn => {
      // Remove existing listeners to avoid duplicates
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      newBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const iframeId = newBtn.dataset.iframeId;
        const iframe = document.getElementById(iframeId);
        if (iframe) {
          // Get the artifact URL
          let artifactUrl = null;

          if (iframe.dataset.artifactId) {
            // Persisted artifact - use the API URL
            artifactUrl = `/api/artifacts/${iframe.dataset.artifactId}`;
          } else if (iframe.src && iframe.src.startsWith('blob:')) {
            // Blob URL - open directly
            artifactUrl = iframe.src;
          } else if (iframe.srcdoc) {
            // srcdoc - create a blob URL for it
            try {
              const blob = new Blob([iframe.srcdoc], { type: 'text/html' });
              artifactUrl = URL.createObjectURL(blob);
            } catch (error) {
              console.error('Error creating blob URL for new window:', error);
              return;
            }
          } else if (iframe.src) {
            // Fallback: iframe.src is set (e.g. http/https artifact URL) but dataset.artifactId missing
            artifactUrl = iframe.src;
          }

          if (artifactUrl) {
            // Open in new window
            window.open(artifactUrl, '_blank', 'noopener,noreferrer');
          } else {
            console.warn('Could not determine artifact URL to open in new window');
          }
        }
      });
    });
  }

  /**
   * Attach event handlers for message delete buttons
   */
  attachDeleteHandlers() {
    // Handle delete button clicks
    document.querySelectorAll('.message-delete-btn[data-action="delete-message"]').forEach(btn => {
      // Remove existing listeners to avoid duplicates
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      // Handle both click and touch events for mobile support
      const handleDelete = async (e) => {
        e.stopPropagation();
        e.preventDefault();

        const messageId = parseInt(newBtn.dataset.messageId);
        if (!messageId || !this.currentSession) {
          return;
        }

        // Confirm deletion
        const confirmed = confirm('Are you sure you want to delete this message?');
        if (!confirmed) {
          return;
        }

        try {
          await api.chat.deleteMessage(this.currentSession.id, messageId);

          // Remove message from local array
          this.messages = this.messages.filter(msg => msg.id !== messageId);
          this.lastMessageCount = this.messages.length;

          // Re-render messages
          this.renderMessages(false);

          showToast('Message deleted successfully', 'success');
        } catch (error) {
          console.error('Error deleting message:', error);
          showToast(error.message || 'Failed to delete message', 'danger');
        }
      };

      newBtn.addEventListener('click', handleDelete);
      newBtn.addEventListener('touchend', handleDelete);
    });
  }

  /**
   * Attach event handlers for message copy buttons
   */
  attachCopyHandlers() {
    // Handle copy button clicks
    document.querySelectorAll('.message-copy-btn[data-action="copy-message"]').forEach(btn => {
      // Remove existing listeners to avoid duplicates
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      // Handle both click and touch events for mobile support
      const handleCopy = async (e) => {
        e.stopPropagation();
        e.preventDefault();

        const messageId = parseInt(newBtn.dataset.messageId);
        if (!messageId) {
          return;
        }

        // Find the message in the messages array
        const message = this.messages.find(msg => msg.id === messageId);
        if (!message || !message.content) {
          showToast('Message not found', 'warning');
          return;
        }

        // Get the raw message content (plain text)
        let messageContent = message.content;

        // If content contains HTML, try to extract plain text
        // This handles cases where content might be formatted
        if (messageContent.includes('<') || messageContent.includes('&')) {
          // Create a temporary element to extract text
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = messageContent;
          messageContent = tempDiv.textContent || tempDiv.innerText || messageContent;
        }

        try {
          // Use the Clipboard API if available
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(messageContent);
            showToast('Message copied to clipboard', 'success');
          } else {
            // Fallback for older browsers
            const textArea = document.createElement('textarea');
            textArea.value = messageContent;
            textArea.style.position = 'fixed';
            textArea.style.left = '-999999px';
            textArea.style.top = '-999999px';
            document.body.appendChild(textArea);
            textArea.focus();
            textArea.select();

            try {
              const successful = document.execCommand('copy');
              if (successful) {
                showToast('Message copied to clipboard', 'success');
              } else {
                throw new Error('Copy command failed');
              }
            } finally {
              document.body.removeChild(textArea);
            }
          }
        } catch (error) {
          console.error('Error copying message:', error);
          showToast('Failed to copy message to clipboard', 'danger');
        }
      };

      newBtn.addEventListener('click', handleCopy);
      newBtn.addEventListener('touchend', handleCopy);
    });
  }

  /**
   * Get agent summary text
   */
  getAgentSummary() {
    if (!this.currentSession) return '';
    const agents = this.currentSession.agents || [];
    if (agents.length === 0) {
      return 'No agents assigned - responses will be general';
    }
    if (agents.length <= 3) {
      return `Available agents: ${agents.map(a => a.name).join(', ')}`;
    }
    return `${agents.length} agents available for specialized advice`;
  }

  /**
   * Render a single message
   * @param {object} message - Message object
   * @param {boolean} isArchived - Whether this message is archived (not in active context)
   */
  renderMessage(message, isArchived = false) {
    const isUser = message.role === 'user';
    const timestamp = message.created_at
      ? new Date(message.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : '';

    // Check if this is a task-related message
    const isTaskMessage = !isUser && (
      message.content?.startsWith('Task created for') ||
      message.content?.startsWith('Task completed by') ||
      message.metadata?.task_id ||
      message.metadata?.is_task_result
    );

    // Add archived styling classes
    const archivedClass = isArchived ? ' archived-message' : '';
    const archivedStyle = isArchived ? ' opacity-75' : '';

    if (isUser) {
      // Get username from metadata or fall back to current user
      let username = null;
      if (message.metadata) {
        try {
          const metadata = typeof message.metadata === 'string'
            ? JSON.parse(message.metadata)
            : message.metadata;
          username = metadata?.username || null;
        } catch (e) {
          // Invalid JSON, ignore
        }
      }

      // Fall back to current user if no username in metadata
      if (!username && window.currentUser) {
        username = window.currentUser.username;
      }

      const userBadge = username
        ? `<span class="badge bg-info me-2">${escapeHtml(username)}</span>`
        : '';

      const archivedBadge = isArchived
        ? '<span class="badge bg-secondary ms-2" title="This message is archived and not included in agent context"><i class="bi bi-archive"></i> Archived</span>'
        : '';

      const deleteBtn = `
        <button class="message-delete-btn btn btn-sm ms-2 btn-warning" 
                data-message-id="${message.id || ''}" 
                data-action="delete-message"
                style="border: 1px solid #dee2e6;"
                title="Delete message">
          <i class="bi bi-trash"></i>
        </button>
      `;

      const copyBtn = `
        <button class="message-copy-btn btn btn-sm ms-2 btn-light" 
                data-message-id="${message.id || ''}" 
                data-action="copy-message"
                style="border: 1px solid #dee2e6;
                title="Copy message to clipboard">
          <i class="bi bi-clipboard"></i>
        </button>
      `;

      const isBookmarked = this.isBookmarked(message.id);
      const bookmarkBtn = `
        <button class="message-bookmark-btn btn btn-sm ms-2 ${isBookmarked ? 'btn-warning' : 'btn-light'}" 
                data-message-id="${message.id || ''}" 
                data-action="toggle-bookmark"
                style="border: 1px solid #dee2e6;"
                title="${isBookmarked ? 'Remove bookmark' : 'Bookmark this message'}">
          <i class="bi ${isBookmarked ? 'bi-bookmark-fill' : 'bi-bookmark'}"></i>
        </button>
      `;

      const attachedLine = (message.attachedDocumentsInfo && message.attachedDocumentsInfo.documentNames && message.attachedDocumentsInfo.documentNames.length)
        ? (() => {
          const names = message.attachedDocumentsInfo.documentNames.map(n => escapeHtml(n)).join(', ');
          const assigned = message.attachedDocumentsInfo.assignedToAgentNames && message.attachedDocumentsInfo.assignedToAgentNames.length
            ? ' — assigned to: ' + message.attachedDocumentsInfo.assignedToAgentNames.map(n => escapeHtml(n)).join(', ')
            : ' — not assigned';
          return `<div class="small mt-2 opacity-90"><i class="bi bi-paperclip me-1"></i>Attached: ${names}${assigned}</div>`;
        })()
        : '';

      return `
        <div class="chat-message user mb-3${archivedClass}" data-message-id="${message.id || ''}">
          <div class="d-flex justify-content-end">
            <div class="message-bubble bg-primary text-white px-3 py-2 rounded-3${archivedStyle}" style="max-width: 75%;">
              <div class="message-content">
                ${this.formatContent(message.content, message.metadata)}
                ${attachedLine}
              </div>
              <div class="message-footer d-flex align-items-center justify-content-between mt-2">
                <div class="d-flex align-items-center">
                  ${userBadge}
                  ${archivedBadge}
                </div>
                <div class="d-flex align-items-center">
                  ${bookmarkBtn}
                  ${copyBtn}
                  ${deleteBtn}
                  <small class="opacity-75">${timestamp}</small>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    const agentBadge = message.agent_name
      ? `<span class="badge bg-info me-2">${escapeHtml(message.agent_name)}</span>`
      : '';

    const archivedBadge = isArchived
      ? '<span class="badge bg-secondary ms-2" title="This message is archived and not included in agent context"><i class="bi bi-archive"></i> Archived</span>'
      : '';

    const taskMessageClass = isTaskMessage ? ' task-message' : '';

    // Format task messages with badge highlighting
    let formattedContent = this.formatTaskMessage(message.content, isTaskMessage, message.metadata);

    const deleteBtn = `
      <button class="message-delete-btn btn btn-sm btn-danger ms-2" 
              data-message-id="${message.id || ''}" 
              data-action="delete-message"
              title="Delete message">
        <i class="bi bi-trash"></i>
      </button>
    `;

    const copyBtn = `
      <button class="message-copy-btn btn btn-sm btn-light ms-2" 
              data-message-id="${message.id || ''}" 
              data-action="copy-message"
              title="Copy message to clipboard">
        <i class="bi bi-clipboard"></i>
      </button>
    `;

    const isBookmarked = this.isBookmarked(message.id);
    const bookmarkBtn = `
      <button class="message-bookmark-btn btn btn-sm ${isBookmarked ? 'btn-warning' : 'btn-light'} ms-2" 
              data-message-id="${message.id || ''}" 
              data-action="toggle-bookmark"
              title="${isBookmarked ? 'Remove bookmark' : 'Bookmark this message'}">
        <i class="bi ${isBookmarked ? 'bi-bookmark-fill' : 'bi-bookmark'}"></i>
      </button>
    `;

    return `
      <div class="chat-message assistant mb-3${archivedClass}" data-message-id="${message.id || ''}">
        <div class="d-flex justify-content-start">
          <div class="message-bubble bg-light px-3 py-2 rounded-3${taskMessageClass}${archivedStyle}" style="max-width: 85%;">
            <div class="message-header d-flex align-items-center mb-2">
              <div class="d-flex align-items-center">
                ${agentBadge}
                ${archivedBadge}
              </div>
              <div class="d-flex align-items-center ms-auto">
                ${bookmarkBtn}
                ${copyBtn}
                ${deleteBtn}
                <small class="text-muted">${timestamp}</small>
              </div>
            </div>
            <div class="message-content">
              ${formattedContent}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Format task messages with badge highlighting
   */
  formatTaskMessage(content, isTaskMessage, messageMetadata = null) {
    if (!content) return '';

    if (isTaskMessage) {
      // Extract the task prefix (e.g., "Task created for agent-name:" or "Task completed by agent-name:")
      const taskPrefixMatch = content.match(/^(Task (?:created for|completed by) [^:]+:)/);
      if (taskPrefixMatch) {
        const taskPrefix = taskPrefixMatch[1];
        const restOfContent = content.substring(taskPrefix.length);

        // Format the rest of the content normally
        const formattedRest = this.formatContent(restOfContent, messageMetadata);

        // Return badge + formatted content
        return `<span class="badge bg-info me-2">${escapeHtml(taskPrefix)}</span>${formattedRest}`;
      }
    }

    // Not a task message or no match, format normally
    return this.formatContent(content, messageMetadata);
  }

  /**
   * Format message content with basic markdown and iframe artifacts
   * @param {string} content - Message content
   * @param {object} messageMetadata - Optional message metadata containing artifact info
   */
  formatContent(content, messageMetadata = null) {
    if (!content) return '';

    // Check if message has persisted artifacts in metadata
    const persistedArtifacts = messageMetadata?.artifacts || [];
    const artifactMap = new Map();
    persistedArtifacts.forEach((artifact, idx) => {
      artifactMap.set(idx, artifact);
    });

    // Use a placeholder for iframe artifacts to avoid escaping issues
    const iframePlaceholders = [];
    let placeholderIndex = 0;

    // Detect HTML/JS code blocks for iframe rendering (must be processed first)
    // Pattern: ```html or ```iframe followed by HTML/JS code
    let formatted = content.replace(/```(?:html|iframe)\n([\s\S]*?)```/g, (match, code) => {
      const codeId = `iframe-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const trimmedCode = code.trim();

      // Check if we have a persisted artifact for this index
      const persistedArtifact = artifactMap.get(placeholderIndex);

      // Store the code content separately to create artifact via API (if not persisted)
      iframePlaceholders.push({
        id: codeId,
        code: trimmedCode,
        persistedArtifact: persistedArtifact || null
      });

      // Use a unique placeholder that won't be escaped
      const placeholder = `__IFRAME_ARTIFACT_${placeholderIndex}__`;
      placeholderIndex++;
      return placeholder;
    });

    // Now escape the rest of the content
    formatted = escapeHtml(formatted);

    // Replace placeholders with iframe HTML
    // We need to insert raw HTML, so we'll use a temporary DOM element
    iframePlaceholders.forEach((placeholderData, index) => {
      const codeId = placeholderData.id;
      const trimmedCode = placeholderData.code;
      const persistedArtifact = placeholderData.persistedArtifact;

      // Use persisted artifact URL if available, otherwise store code for API creation
      const artifactUrl = persistedArtifact ? persistedArtifact.url : null;
      const artifactId = persistedArtifact ? persistedArtifact.artifactId : null;

      // Use Base64 encoding for the artifact code to prevent newlines from being converted to <br>
      // by the markdown formatter at the end of formatContent
      let dataAttribute;
      if (artifactUrl) {
        dataAttribute = `data-artifact-url="${artifactUrl}" data-artifact-id="${artifactId}"`;
      } else {
        // Base64 encode the code to preserve newlines and special characters
        const base64Code = btoa(unescape(encodeURIComponent(trimmedCode)));
        dataAttribute = `data-artifact-code-base64="${base64Code}"`;
      }

      // Create a temporary container to build the HTML
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = `
        <div class="iframe-artifact-container my-3 border rounded" style="position: relative; background: white; width: 100%; max-width: 100%;">
          <div class="artifact-controls-overlay" style="position: absolute; top: 8px; left: 8px; z-index: 10; display: flex; gap: 2px;">
            <button class="btn btn-sm btn-outline-secondary artifact-reload-btn" data-iframe-id="${codeId}" title="Reload" style="padding: 2px 4px; font-size: 0.75rem; line-height: 1;">
              <i class="bi bi-arrow-clockwise"></i>
            </button>
            <button class="btn btn-sm btn-outline-secondary artifact-toggle-height-btn" data-iframe-id="${codeId}" title="Toggle height" style="padding: 2px 4px; font-size: 0.75rem; line-height: 1;">
              <i class="bi bi-arrows-expand"></i>
            </button>
            <button class="btn btn-sm btn-outline-secondary artifact-open-window-btn" data-iframe-id="${codeId}" title="Open in new window" style="padding: 2px 4px; font-size: 0.75rem; line-height: 1;">
              <i class="bi bi-box-arrow-up-right"></i>
            </button>
          </div>
          <iframe 
            id="${codeId}" 
            ${dataAttribute}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals" 
            style="width: 100%; height: 400px; border: none; display: block;">
          </iframe>
          <details class="p-2 border-top bg-light" style="max-height: 200px; overflow-y: auto;">
            <summary class="small text-muted" style="cursor: pointer;">View Code</summary>
            <pre class="bg-dark text-light p-2 rounded mt-2 small" style="max-height: 200px; overflow-y: auto; margin-bottom: 0;"><code>${escapeHtml(trimmedCode)}</code></pre>
          </details>
        </div>
      `;

      const iframeHtml = tempDiv.innerHTML;

      // Replace placeholder with the HTML (already properly escaped by innerHTML)
      formatted = formatted.replace(`__IFRAME_ARTIFACT_${index}__`, iframeHtml);
    });

    // Regular code blocks (non-HTML/iframe)
    formatted = formatted.replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
      // Skip if it was already processed as HTML/iframe
      if (lang && (lang.toLowerCase() === 'html' || lang.toLowerCase() === 'iframe')) {
        return `\`\`\`${lang}\n${code}\`\`\``; // Return original if already processed
      }
      return `<pre class="bg-dark text-light p-2 rounded my-2"><code>${code.trim()}</code></pre>`;
    });

    // Bold
    formatted = formatted.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    formatted = formatted.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Inline code
    formatted = formatted.replace(/`([^`]+)`/g, '<code class="bg-secondary-subtle px-1 rounded">$1</code>');

    // Line breaks
    formatted = formatted.replace(/\n/g, '<br>');

    return formatted;
  }

  /**
   * Send a message
   */
  async sendMessage() {
    const input = document.getElementById('chat-input');
    const message = input?.value?.trim();

    if (!message || !this.currentSession || this.isStreaming) return;

    // Check if conversation mode should handle this
    if (window.conversationMode && this.isConversationModeEnabled()) {
      if (window.conversationMode.isConversationActive()) {
        // Active conversation - send as interjection
        window.conversationMode.sendInterjection();
        return;
      } else {
        // Conversation mode enabled but not active - start new conversation
        window.conversationMode.startConversation();
        return;
      }
    }

    // Assign pending documents only when message contains @agentName or @team
    const attachmentInfo = await this.assignPendingDocumentsToMentionedAgents(message);

    // Add user message to UI immediately (include attachment info for display)
    const userMessage = {
      id: 'temp-' + Date.now(),
      role: 'user',
      content: message,
      created_at: new Date().toISOString(),
      attachedDocumentsInfo: attachmentInfo,
    };
    this.messages.push(userMessage);
    this.renderMessages();

    // Clear input
    input.value = '';
    this.updateCharCount();

    // Show streaming state
    this.setStreaming(true);

    try {
      if (this.useStreaming) {
        await this.sendStreamingMessage(message, attachmentInfo);
      } else {
        await this.sendNonStreamingMessage(message, attachmentInfo);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      showToast(error.message || 'Failed to send message', 'danger');

      // Remove the user message on error
      this.messages = this.messages.filter(m => m.id !== userMessage.id);
      this.renderMessages();
    } finally {
      this.setStreaming(false);
    }
  }

  /**
   * Send message with streaming response
   * @param {string} message - User message text
   * @param {{ documentNames: string[], assignedToAgentNames: string[] }|null} attachmentInfo - Optional attachment info for persistence
   */
  sendStreamingMessage(message, attachmentInfo = null) {
    return new Promise((resolve, reject) => {
      const assistantMessage = {
        id: 'temp-' + (Date.now() + 1),
        role: 'assistant',
        content: '',
        created_at: new Date().toISOString(),
      };

      this.messages.push(assistantMessage);
      this.renderMessages();

      this.abortStream = api.chat.streamMessage(
        this.currentSession.id,
        message,
        {
          onChunk: (chunk) => {
            const text = typeof chunk === 'string' ? chunk : (chunk && (chunk.content ?? chunk.text)) ?? String(chunk ?? '');
            assistantMessage.content += text;
            this.updateStreamingMessage(assistantMessage);
          },
          onDone: async (data) => {
            assistantMessage.agent_name = data.agentName;
            this.renderMessages();
            // Refresh history to include any messages added externally (e.g., from n8n)
            await this.loadHistory();
            this.renderMessages();
            // Stop reconnect polling if active, switch to normal polling
            this.stopReconnectPolling();
            if (!this.pollInterval) {
              this.startPolling();
            }
            if (typeof window.checkSessionPoolModified === 'function') {
              window.checkSessionPoolModified();
            }
            resolve();
          },
          onError: (error) => {
            this.messages = this.messages.filter(m => m.id !== assistantMessage.id);
            this.renderMessages();
            reject(error);
          },
        },
        attachmentInfo && attachmentInfo.documentNames && attachmentInfo.documentNames.length ? attachmentInfo : null
      );
    });
  }

  /**
   * Update streaming message in place
   */
  updateStreamingMessage(message) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    const messageElements = chatMessages.querySelectorAll('.chat-message.assistant');
    const lastElement = messageElements[messageElements.length - 1];

    if (lastElement) {
      const contentDiv = lastElement.querySelector('.message-content');
      if (contentDiv) {
        contentDiv.innerHTML = this.formatContent(message.content);
        this.attachArtifactHandlers();
      }
    }

    this.scrollToBottom();
  }

  /**
   * Send message without streaming
   * @param {string} message - User message text
   * @param {{ documentNames: string[], assignedToAgentNames: string[] }|null} attachmentInfo - Optional attachment info for persistence
   */
  async sendNonStreamingMessage(message, attachmentInfo = null) {
    const payload = attachmentInfo && attachmentInfo.documentNames && attachmentInfo.documentNames.length
      ? attachmentInfo
      : null;
    const response = await api.chat.sendMessage(this.currentSession.id, message, payload);

    const assistantMessage = {
      id: 'temp-' + (Date.now() + 1),
      role: 'assistant',
      content: response.data.message,
      agent_name: response.data.agentName,
      created_at: new Date().toISOString(),
    };

    this.messages.push(assistantMessage);
    this.renderMessages();

    // Refresh history to include any messages added externally (e.g., from n8n)
    await this.loadHistory();
    this.renderMessages();
    if (typeof window.checkSessionPoolModified === 'function') {
      window.checkSessionPoolModified();
    }
  }

  /**
   * Set streaming state
   */
  setStreaming(isStreaming) {
    this.isStreaming = isStreaming;

    const input = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const stopBtn = document.getElementById('stop-stream-btn');

    if (input) input.disabled = isStreaming;

    if (sendBtn) {
      if (isStreaming) {
        sendBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';
        sendBtn.disabled = true;
      } else {
        sendBtn.innerHTML = '<i class="bi bi-send"></i>';
        sendBtn.disabled = false;
      }
    }

    if (stopBtn) {
      stopBtn.classList.toggle('d-none', !isStreaming);
    }
  }

  /**
   * Stop the current stream
   */
  stopStream() {
    if (this.abortStream) {
      this.abortStream();
      this.abortStream = null;
    }
    this.setStreaming(false);
  }

  /**
   * Toggle streaming mode
   */
  toggleStreaming(enabled) {
    this.useStreaming = enabled;
  }

  /**
   * Scroll chat to bottom
   */
  scrollToBottom() {
    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) {
      chatMessages.scrollTop = chatMessages.scrollHeight;
    }
  }

  /**
   * Update character count
   */
  updateCharCount() {
    const input = document.getElementById('chat-input');
    const charCount = document.getElementById('char-count');
    if (input && charCount) {
      charCount.textContent = input.value.length;
    }
  }

  /**
   * Load and display approximate context token estimates for Orchestrator and each agent.
   * Renders inline with char-count (same small text).
   */
  async loadContextTokenEstimates() {
    const el = document.getElementById('context-token-estimates');
    if (!el) return;
    if (!this.currentSession) {
      el.textContent = '';
      return;
    }
    el.textContent = '…';
    try {
      const res = await api.sessions.getContextTokenEstimates(this.currentSession.id);
      if (!res.success || !res.data) {
        el.textContent = '';
        return;
      }
      const { orchestrator, agents } = res.data;
      const parts = [];
      const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
      parts.push(`Orchestrator ~${fmt(orchestrator?.tokens ?? 0)}`);
      (agents || []).forEach((a) => {
        parts.push(`${a.name} ~${fmt(a.tokens ?? 0)}`);
      });
      el.textContent = parts.length ? parts.join(' · ') : '';
    } catch {
      el.textContent = '';
    }
  }

  /**
   * Clear all messages from UI
   */
  clearMessages() {
    this.messages = [];
    this.currentSession = null;
    this.renderMessages();
    this.loadContextTokenEstimates();
  }

  /**
   * Clear conversation history (delete from database)
   */
  async clearHistory() {
    if (!this.currentSession) {
      showToast('Please select a session first', 'warning');
      return;
    }

    if (!confirm('Are you sure you want to clear the conversation history? This cannot be undone.')) {
      return;
    }

    try {
      await api.chat.clearHistory(this.currentSession.id);
      this.messages = [];
      this.renderMessages();
      showToast('Conversation history cleared', 'success');
    } catch (error) {
      console.error('Error clearing history:', error);
      showToast(error.message || 'Failed to clear history', 'danger');
    }
  }

  /**
   * Load messages for a session (called by sessionManager)
   */
  async loadMessages(sessionId) {
    // Get session from sessionManager
    const session = window.sessionManager?.sessions?.find(s => s.id === sessionId);
    if (session) {
      await this.setSession(session);
    }
  }

  /**
   * Handle Enter key press (legacy support)
   */
  handleKeyPress(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  /**
   * Add a message directly (used by conversation mode)
   * @param {object} message - Message object with role, content, agent_name, metadata
   */
  addMessage(message) {
    this.messages.push({
      id: message.id || 'temp-' + Date.now(),
      role: message.role,
      content: message.content,
      agent_name: message.agent_name || null,
      created_at: message.created_at || new Date().toISOString(),
      metadata: message.metadata || null,
    });
    this.renderMessages();
  }

  /**
   * Start a new streaming message for conversation mode
   * @param {string} agentName - Name of the agent speaking
   * @returns {string} - ID of the streaming message
   */
  startStreamingMessage(agentName) {
    const messageId = 'stream-' + Date.now();
    const streamingMessage = {
      id: messageId,
      role: 'assistant',
      content: '',
      agent_name: agentName,
      created_at: new Date().toISOString(),
      isStreaming: true,
    };
    this.messages.push(streamingMessage);
    this.currentStreamingMessageId = messageId;
    this.renderMessages();
    return messageId;
  }

  /**
   * Append chunk to the current streaming message
   * @param {string} chunk - Text chunk to append
   */
  appendToStreamingMessage(chunk) {
    if (!this.currentStreamingMessageId) return;

    const message = this.messages.find(m => m.id === this.currentStreamingMessageId);
    if (message) {
      const text = typeof chunk === 'string' ? chunk : (chunk && (chunk.content ?? chunk.text)) ?? String(chunk ?? '');
      message.content += text;
      this.updateStreamingMessage(message);
    }
  }

  /**
   * Finalize the streaming message
   * @param {string} content - Optional final content (if not provided, uses accumulated content)
   */
  finalizeStreamingMessage(content = null) {
    if (!this.currentStreamingMessageId) return;

    const message = this.messages.find(m => m.id === this.currentStreamingMessageId);
    if (message) {
      if (content !== null) {
        message.content = content;
      }
      message.isStreaming = false;
    }
    this.currentStreamingMessageId = null;
    this.renderMessages();
  }

  /**
   * Get the current session
   * @returns {object|null} - Current session or null
   */
  getCurrentSession() {
    return this.currentSession;
  }

  /**
   * Check if conversation mode is enabled for current session
   * @returns {boolean}
   */
  isConversationModeEnabled() {
    return this.currentSession?.conversation_mode_enabled === 1;
  }

  /**
   * Export chat conversation as PDF
   */
  exportAsPDF() {
    if (!this.currentSession) {
      showToast('No active session to export', 'warning');
      return;
    }

    if (this.messages.length === 0) {
      showToast('No messages to export', 'warning');
      return;
    }

    // Check if jsPDF is loaded
    if (typeof window.jspdf === 'undefined') {
      showToast('PDF library not loaded. Please refresh the page and try again.', 'danger');
      console.error('jsPDF library not found. Make sure the script is loaded from cdn.jsdelivr.net');
      return;
    }

    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF();

      // Page dimensions
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 15;
      const maxWidth = pageWidth - (2 * margin);
      let yPosition = margin;

      // Set consistent font family (Helvetica)
      doc.setFont('helvetica');

      // Header section with title
      const sessionName = this.currentSession.name || 'Chat Conversation';
      doc.setFontSize(20);
      doc.setFont('helvetica', 'bold');
      const titleLines = doc.splitTextToSize(sessionName, maxWidth);
      doc.text(titleLines, margin, yPosition);
      yPosition += titleLines.length * 8 + 5;

      // Export date
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(100, 100, 100);
      const exportDate = new Date().toLocaleString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      doc.text(`Exported: ${exportDate}`, margin, yPosition);
      yPosition += 8;

      // Separator line
      doc.setDrawColor(200, 200, 200);
      doc.setLineWidth(0.5);
      doc.line(margin, yPosition, pageWidth - margin, yPosition);
      yPosition += 12;

      // Process messages
      doc.setFontSize(10);
      doc.setTextColor(0, 0, 0); // Reset to black

      this.messages.forEach((message, index) => {
        // Check if we need a new page (leave space for at least 3 lines)
        if (yPosition > pageHeight - 50) {
          doc.addPage();
          yPosition = margin;
        }

        const isUser = message.role === 'user';
        const timestamp = message.created_at
          ? new Date(message.created_at).toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
          })
          : '';

        // Message header with sender name
        const sender = isUser
          ? 'You'
          : (message.agent_name ? message.agent_name : 'Assistant');

        // Sender name (bold, colored)
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        if (isUser) {
          doc.setTextColor(13, 110, 253); // Bootstrap primary blue
        } else {
          doc.setTextColor(25, 135, 84); // Bootstrap success green
        }
        doc.text(sender, margin, yPosition);

        // Timestamp (right-aligned, smaller, gray)
        if (timestamp) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(128, 128, 128);
          const timestampX = pageWidth - margin - doc.getTextWidth(timestamp);
          doc.text(timestamp, timestampX, yPosition);
        }
        yPosition += 6;

        // Message content box
        const content = message.content || '';
        const textContent = this.stripHtml(content);
        // Calculate available width for text (accounting for padding on both sides)
        const textPadding = 6;
        const availableTextWidth = maxWidth - (textPadding * 2);
        const lines = doc.splitTextToSize(textContent, availableTextWidth);

        // Calculate content height
        const lineHeight = 5;
        const padding = 4;
        const contentHeight = (lines.length * lineHeight) + (padding * 2);

        // Draw message box background
        if (isUser) {
          doc.setFillColor(13, 110, 253); // Blue background for user
          doc.setDrawColor(13, 110, 253);
        } else {
          doc.setFillColor(248, 249, 250); // Light gray for assistant
          doc.setDrawColor(220, 220, 220);
        }
        // Use rect with fill and draw (FD = Fill + Draw)
        doc.rect(margin, yPosition - 2, maxWidth, contentHeight, 'FD');

        // Message text
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(10);
        if (isUser) {
          doc.setTextColor(255, 255, 255); // White text on blue background
        } else {
          doc.setTextColor(0, 0, 0); // Black text on gray background
        }

        lines.forEach((line, lineIndex) => {
          if (yPosition > pageHeight - 30) {
            doc.addPage();
            yPosition = margin;
            // Redraw box on new page if needed
            if (lineIndex < lines.length - 1) {
              const remainingLines = lines.slice(lineIndex);
              const remainingHeight = (remainingLines.length * lineHeight) + (padding * 2);
              if (isUser) {
                doc.setFillColor(13, 110, 253);
                doc.setDrawColor(13, 110, 253);
              } else {
                doc.setFillColor(248, 249, 250);
                doc.setDrawColor(220, 220, 220);
              }
              doc.rect(margin, yPosition - 2, maxWidth, remainingHeight, 'FD');
              if (isUser) {
                doc.setTextColor(255, 255, 255);
              } else {
                doc.setTextColor(0, 0, 0);
              }
            }
          }
          // Ensure text doesn't exceed page boundaries
          const textX = margin + textPadding;
          // Verify the line fits within page width
          const lineWidth = doc.getTextWidth(line);
          if (lineWidth > availableTextWidth) {
            // If somehow the line is still too wide, split it again
            const subLines = doc.splitTextToSize(line, availableTextWidth);
            subLines.forEach(subLine => {
              if (yPosition > pageHeight - margin - lineHeight) {
                doc.addPage();
                yPosition = margin + padding;
              }
              doc.text(subLine, textX, yPosition);
              yPosition += lineHeight;
            });
          } else {
            doc.text(line, textX, yPosition);
            yPosition += lineHeight;
          }
        });

        yPosition += 10; // Space between messages
      });

      // Save the PDF
      const fileName = `${sessionName.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.pdf`;
      doc.save(fileName);

      showToast('Chat exported as PDF successfully', 'success');
    } catch (error) {
      console.error('Error exporting PDF:', error);
      showToast('Failed to export PDF: ' + (error.message || 'Unknown error'), 'danger');
    }
  }

  /**
   * Strip HTML tags and decode HTML entities from text
   */
  stripHtml(html) {
    if (!html) return '';

    // Create a temporary div element
    const tmp = document.createElement('div');
    tmp.innerHTML = html;

    // Get text content and decode entities
    let text = tmp.textContent || tmp.innerText || '';

    // Replace common HTML entities
    text = text.replace(/&nbsp;/g, ' ');
    text = text.replace(/&amp;/g, '&');
    text = text.replace(/&lt;/g, '<');
    text = text.replace(/&gt;/g, '>');
    text = text.replace(/&quot;/g, '"');
    text = text.replace(/&#39;/g, "'");

    return text;
  }

  /**
   * Export chat conversation as Image (screenshot)
   */
  async exportAsImage() {
    if (!this.currentSession) {
      showToast('No active session to export', 'warning');
      return;
    }

    if (this.messages.length === 0) {
      showToast('No messages to export', 'warning');
      return;
    }

    // Check if html2canvas is loaded
    if (typeof html2canvas === 'undefined') {
      showToast('Image export library not loaded. Please refresh the page and try again.', 'danger');
      console.error('html2canvas library not found. Make sure the script is loaded from cdn.jsdelivr.net');
      return;
    }

    let originalCursor = '';
    try {
      // Find the chat messages container
      const chatMessages = document.getElementById('chat-messages');
      if (!chatMessages) {
        showToast('Chat container not found', 'danger');
        return;
      }

      // Show loading indicator
      originalCursor = document.body.style.cursor;
      document.body.style.cursor = 'wait';
      showToast('Capturing chat as image...', 'info');

      // Capture the chat messages area
      const canvas = await html2canvas(chatMessages, {
        backgroundColor: '#ffffff',
        scale: 2, // Higher quality
        logging: false,
        useCORS: true,
        allowTaint: false,
        width: chatMessages.scrollWidth,
        height: chatMessages.scrollHeight,
        windowWidth: chatMessages.scrollWidth,
        windowHeight: chatMessages.scrollHeight,
      });

      // Convert canvas to image and download
      const sessionName = this.currentSession.name || 'Chat Conversation';
      const fileName = `${sessionName.replace(/[^a-z0-9]/gi, '_')}_${new Date().toISOString().split('T')[0]}.png`;

      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = fileName;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(url);

          document.body.style.cursor = originalCursor;
          showToast('Chat exported as image successfully', 'success');
        } else {
          document.body.style.cursor = originalCursor;
          showToast('Failed to create image', 'danger');
        }
      }, 'image/png', 1.0);

    } catch (error) {
      console.error('Error exporting image:', error);
      if (originalCursor !== undefined) {
        document.body.style.cursor = originalCursor || 'default';
      }
      showToast('Failed to export image: ' + (error.message || 'Unknown error'), 'danger');
    }
  }

  /**
   * Handle autocomplete input for @ mentions
   */
  handleAutocompleteInput(e) {
    const input = e.target;
    const text = input.value;
    const cursorPos = input.selectionStart;

    // Find the last @ before cursor
    const textBeforeCursor = text.substring(0, cursorPos);
    const lastAtPos = textBeforeCursor.lastIndexOf('@');

    if (lastAtPos === -1 || textBeforeCursor.substring(lastAtPos + 1).includes(' ')) {
      this.hideAutocomplete();
      return;
    }

    // Get the query after @
    const query = textBeforeCursor.substring(lastAtPos + 1).toLowerCase();

    // Get agent names
    const agentNames = this.getAgentNames();

    // Filter agents (case insensitive)
    const matches = agentNames.filter(name =>
      name.toLowerCase().includes(query)
    );

    if (matches.length === 0) {
      this.hideAutocomplete();
      return;
    }

    // Show autocomplete
    this.autocompleteStartPos = lastAtPos;
    this.autocompleteMatches = matches;
    this.autocompleteSelectedIndex = 0;
    this.showAutocomplete(input, matches, lastAtPos);
  }

  /**
   * Get list of agent names including orchestrator (for @-mention and document assignment)
   */
  getAgentNames() {
    const names = [];

    // Orchestrator / Assistant: assign documents to session (orchestrator context)
    if (this.currentSession) {
      names.push('Orchestrator');
      names.push('Assistant');
    }

    // Add team (assign to all agents)
    if (this.currentSession?.agents?.length > 1) {
      names.push('team');
    }

    // Add session agents
    if (this.currentSession && this.currentSession.agents) {
      this.currentSession.agents.forEach(agent => {
        if (agent.name) {
          names.push(agent.name);
        }
      });
    }

    return names;
  }

  /**
   * Add a document to pending list (uploaded via chat upload button)
   */
  addPendingDocument(doc) {
    if (!doc || !doc.id) return;
    this.pendingDocuments.push({ id: doc.id, filename: doc.filename || 'Document' });
    this.updateUploadBadge();
  }

  /**
   * Update the upload button badge with pending document count
   */
  updateUploadBadge() {
    const badge = document.getElementById('chat-upload-badge');
    const btn = document.getElementById('chat-upload-btn');
    if (!badge || !btn) return;
    if (this.pendingDocuments.length > 0) {
      badge.textContent = String(this.pendingDocuments.length);
      badge.classList.remove('d-none');
      badge.title = this.pendingDocuments.map(d => d.filename).join(', ');
    } else {
      badge.classList.add('d-none');
    }
  }

  /**
   * Parse @mentions from message text. Supports multi-word agent names (e.g. @kimi k2.5),
   * and special mentions: @Orchestrator, @Assistant, @team.
   * @param {string} text - Message text
   * @param {Array<{ name: string }>} [agents] - Optional session agents for multi-word matching
   * @returns {{ agentNames: string[], isTeam: boolean, orchestratorMentioned: boolean }}
   */
  parseMentionsFromMessage(text, agents = []) {
    const str = (text || '').trim();
    const mentions = [];
    const agentNamesList = (agents || [])
      .map(a => a.name)
      .filter(Boolean);
    // Orchestrator/Assistant assign docs to session; team and agent names to agents. Longest names first.
    const candidates = [...new Set(['Orchestrator', 'Assistant', 'team', ...agentNamesList])].sort((a, b) => (b.length - a.length));
    let i = 0;
    while (i < str.length) {
      const atIdx = str.indexOf('@', i);
      if (atIdx === -1) break;
      const afterAt = str.slice(atIdx + 1);
      let matched = null;
      for (const name of candidates) {
        const nameLower = name.toLowerCase();
        const len = name.length;
        const prefix = afterAt.slice(0, len);
        if (prefix.length === len && prefix.toLowerCase() === nameLower) {
          const nextChar = afterAt[len];
          if (nextChar === undefined || /[\s,.]/.test(nextChar)) {
            matched = name;
            break;
          }
        }
      }
      if (matched) {
        mentions.push(matched);
        i = atIdx + 1 + matched.length;
      } else {
        i = atIdx + 1;
      }
    }
    const isTeam = mentions.some(m => m.toLowerCase() === 'team');
    const orchestratorMentioned = mentions.some(m => ['orchestrator', 'assistant'].includes(m.toLowerCase()));
    const agentNames = [...new Set(mentions.filter(m => m.toLowerCase() !== 'team' && !['orchestrator', 'assistant'].includes(m.toLowerCase())))];
    return { agentNames, isTeam, orchestratorMentioned };
  }

  /**
   * Assign pending documents when the message contains @Orchestrator/@Assistant (session) or @agentName/@team (agents).
   * @Orchestrator assigns docs to the session (orchestrator context); @agentName/@team to per-agent assignment.
   * @returns {{ documentNames: string[], assignedToAgentNames: string[] }}
   */
  async assignPendingDocumentsToMentionedAgents(message) {
    const empty = { documentNames: [], assignedToAgentNames: [] };
    if (this.pendingDocuments.length === 0 || !this.currentSession) return empty;

    const documentNames = this.pendingDocuments.map(d => d.filename || 'Document');
    const agents = this.currentSession.agents || [];
    const { agentNames, isTeam, orchestratorMentioned } = this.parseMentionsFromMessage(message, agents);

    const hasMentions = isTeam || agentNames.length > 0 || orchestratorMentioned;
    if (!hasMentions) {
      this.pendingDocuments = [];
      this.updateUploadBadge();
      return { documentNames, assignedToAgentNames: [] };
    }

    const pendingDocIds = this.pendingDocuments.map(d => d.id).filter(id => Number.isFinite(id));

    // Only @Orchestrator / @Assistant (no agents): assign documents to session so orchestrator can use them
    if (orchestratorMentioned && !isTeam && agentNames.length === 0) {
      try {
        if (pendingDocIds.length > 0) {
          await api.sessions.assignDocuments(this.currentSession.id, pendingDocIds);
        }
        this.pendingDocuments = [];
        this.updateUploadBadge();
        if (this.currentSession.documents) {
          const allDocs = window.documentManager?.getDocuments() || [];
          for (const id of pendingDocIds) {
            const doc = allDocs.find(d => d.id === id);
            if (doc && !this.currentSession.documents.some(d => d.id === id)) {
              this.currentSession.documents.push(doc);
            }
          }
        }
        return { documentNames, assignedToAgentNames: ['Orchestrator'] };
      } catch (err) {
        console.error('Failed to assign documents to session (orchestrator):', err);
        showToast(err?.message || 'Failed to assign documents to session', 'danger');
        this.pendingDocuments = [];
        this.updateUploadBadge();
        return { documentNames, assignedToAgentNames: [] };
      }
    }

    // Per-agent (and optionally orchestrator): use document–agent assignments
    let targetAgentIds;
    if (isTeam) {
      targetAgentIds = (agents || []).map(a => a.id);
    } else {
      const namesLower = agentNames.map(n => n.toLowerCase());
      targetAgentIds = (agents || [])
        .filter(a => a.name && namesLower.includes(a.name.toLowerCase()))
        .map(a => a.id);
    }

    let assignedToAgentNames = targetAgentIds.length
      ? agents.filter(a => targetAgentIds.includes(a.id)).map(a => a.name).filter(Boolean)
      : [];
    if (orchestratorMentioned) assignedToAgentNames = ['Orchestrator', ...assignedToAgentNames];

    if (targetAgentIds.length === 0 && !orchestratorMentioned) {
      this.pendingDocuments = [];
      this.updateUploadBadge();
      return { documentNames, assignedToAgentNames: [] };
    }

    try {
      const res = await api.sessions.get(this.currentSession.id);
      const session = res?.data?.session;
      if (!session) {
        this.pendingDocuments = [];
        this.updateUploadBadge();
        return { documentNames, assignedToAgentNames: [] };
      }

      const assignmentsRaw = session.document_agent_assignments || [];
      const docToAgents = new Map();
      for (const { document_id, agent_id } of assignmentsRaw) {
        if (!docToAgents.has(document_id)) docToAgents.set(document_id, new Set());
        docToAgents.get(document_id).add(agent_id);
      }

      for (const doc of this.pendingDocuments) {
        const agentSet = docToAgents.get(doc.id) || new Set();
        targetAgentIds.forEach(id => agentSet.add(id));
        docToAgents.set(doc.id, agentSet);
      }

      const assignments = Array.from(docToAgents.entries()).map(([documentId, agentSet]) => ({
        documentId: parseInt(documentId, 10),
        agentIds: Array.from(agentSet),
      }));

      await api.sessions.setDocumentAgentAssignments(this.currentSession.id, assignments);
      this.pendingDocuments = [];
      this.updateUploadBadge();
      return { documentNames, assignedToAgentNames };
    } catch (err) {
      console.error('Failed to assign documents to agents:', err);
      showToast(err?.message || 'Failed to assign documents', 'danger');
      this.pendingDocuments = [];
      this.updateUploadBadge();
      return { documentNames, assignedToAgentNames: [] };
    }
  }

  /**
   * Show autocomplete dropdown
   */
  showAutocomplete(input, matches, startPos) {
    // Create or get autocomplete container
    let autocompleteContainer = document.getElementById('chat-autocomplete');
    if (!autocompleteContainer) {
      autocompleteContainer = document.createElement('div');
      autocompleteContainer.id = 'chat-autocomplete';
      autocompleteContainer.className = 'position-fixed bg-white border rounded shadow-sm';
      autocompleteContainer.style.zIndex = '1050';
      autocompleteContainer.style.maxHeight = '200px';
      autocompleteContainer.style.overflowY = 'auto';
      autocompleteContainer.style.display = 'none';
      document.body.appendChild(autocompleteContainer);
    }

    // Build list items
    autocompleteContainer.innerHTML = matches.map((name, index) => `
      <div class="autocomplete-item px-3 py-2 ${index === 0 ? 'bg-light' : ''}" 
           data-index="${index}" 
           data-name="${escapeHtml(name)}"
           style="cursor: pointer; border-bottom: 1px solid #dee2e6;">
        ${escapeHtml(name)}
      </div>
    `).join('');

    // Position dropdown relative to input
    const inputRect = input.getBoundingClientRect();

    // First, make it visible (but potentially off-screen) to measure its height
    autocompleteContainer.style.display = 'block';
    autocompleteContainer.style.visibility = 'hidden';
    autocompleteContainer.style.top = '0px';
    autocompleteContainer.style.left = `${inputRect.left + window.scrollX}px`;
    autocompleteContainer.style.minWidth = `${inputRect.width}px`;

    // Measure the height
    const autocompleteHeight = autocompleteContainer.offsetHeight;

    // Position it above the textarea
    autocompleteContainer.style.top = `${inputRect.top + window.scrollY - autocompleteHeight}px`;
    autocompleteContainer.style.visibility = 'visible';

    // Add click handlers
    autocompleteContainer.querySelectorAll('.autocomplete-item').forEach(item => {
      item.addEventListener('click', (e) => {
        const index = parseInt(item.dataset.index);
        this.selectAutocompleteItem(index);
      });

      // Add hover effect
      item.addEventListener('mouseenter', () => {
        const index = parseInt(item.dataset.index);
        this.autocompleteSelectedIndex = index;
        this.updateAutocompleteSelection();
      });
    });

    this.autocompleteVisible = true;
  }

  /**
   * Hide autocomplete dropdown
   */
  hideAutocomplete() {
    const autocompleteContainer = document.getElementById('chat-autocomplete');
    if (autocompleteContainer) {
      autocompleteContainer.style.display = 'none';
    }
    this.autocompleteVisible = false;
    this.autocompleteMatches = [];
    this.autocompleteSelectedIndex = 0;
    this.autocompleteStartPos = -1;
  }

  /**
   * Update autocomplete selection highlight
   */
  updateAutocompleteSelection() {
    const autocompleteContainer = document.getElementById('chat-autocomplete');
    if (!autocompleteContainer) return;

    const items = autocompleteContainer.querySelectorAll('.autocomplete-item');
    items.forEach((item, index) => {
      if (index === this.autocompleteSelectedIndex) {
        item.classList.add('bg-light');
      } else {
        item.classList.remove('bg-light');
      }
    });
  }

  /**
   * Select an autocomplete item and insert it
   */
  selectAutocompleteItem(index) {
    if (index < 0 || index >= this.autocompleteMatches.length) return;

    const input = document.getElementById('chat-input');
    if (!input || this.autocompleteStartPos === -1) return;

    const selectedName = this.autocompleteMatches[index];
    const text = input.value;
    const textBefore = text.substring(0, this.autocompleteStartPos);
    const textAfter = text.substring(input.selectionStart);
    // Insert @name, so the mention is clearly delimited (comma = end of agent name)
    const suffix = ', ';
    const newText = `${textBefore}@${selectedName}${suffix}${textAfter}`;

    input.value = newText;
    input.focus();

    // Set cursor position after inserted name and ", "
    const newCursorPos = this.autocompleteStartPos + 1 + selectedName.length + suffix.length;
    input.setSelectionRange(newCursorPos, newCursorPos);

    this.hideAutocomplete();

    // Trigger input event to update char count
    input.dispatchEvent(new Event('input'));
  }

  /**
   * Load bookmarks from localStorage for current session
   */
  loadBookmarks() {
    if (!this.currentSession) {
      this.bookmarks.delete(null);
      return;
    }

    const sessionId = this.currentSession.id;
    const storageKey = `bookmarks_${sessionId}`;

    try {
      const stored = localStorage.getItem(storageKey);
      if (stored) {
        const bookmarkIds = JSON.parse(stored);
        this.bookmarks.set(sessionId, new Set(bookmarkIds));
      } else {
        this.bookmarks.set(sessionId, new Set());
      }
    } catch (error) {
      console.error('Error loading bookmarks:', error);
      this.bookmarks.set(sessionId, new Set());
    }
  }

  /**
   * Save bookmarks to localStorage for current session
   */
  saveBookmarks() {
    if (!this.currentSession) return;

    const sessionId = this.currentSession.id;
    const storageKey = `bookmarks_${sessionId}`;
    const bookmarkSet = this.bookmarks.get(sessionId);

    if (bookmarkSet) {
      const bookmarkIds = Array.from(bookmarkSet);
      localStorage.setItem(storageKey, JSON.stringify(bookmarkIds));
    }
  }

  /**
   * Check if a message is bookmarked
   * @param {number|string} messageId - Message ID
   * @returns {boolean}
   */
  isBookmarked(messageId) {
    if (!this.currentSession || !messageId) return false;

    const sessionId = this.currentSession.id;
    const bookmarkSet = this.bookmarks.get(sessionId);
    return bookmarkSet ? bookmarkSet.has(Number(messageId)) : false;
  }

  /**
   * Toggle bookmark for a message
   * @param {number|string} messageId - Message ID
   */
  toggleBookmark(messageId) {
    if (!this.currentSession || !messageId) return;

    const sessionId = this.currentSession.id;
    let bookmarkSet = this.bookmarks.get(sessionId);

    if (!bookmarkSet) {
      bookmarkSet = new Set();
      this.bookmarks.set(sessionId, bookmarkSet);
    }

    const messageIdNum = Number(messageId);
    if (bookmarkSet.has(messageIdNum)) {
      bookmarkSet.delete(messageIdNum);
    } else {
      bookmarkSet.add(messageIdNum);
    }

    this.saveBookmarks();
    this.renderMessages(false); // Re-render to update bookmark button states
  }

  /**
   * Attach event handlers for bookmark buttons
   */
  attachBookmarkHandlers() {
    document.querySelectorAll('.message-bookmark-btn[data-action="toggle-bookmark"]').forEach(btn => {
      // Remove existing listeners to avoid duplicates
      const newBtn = btn.cloneNode(true);
      btn.parentNode.replaceChild(newBtn, btn);

      const handleBookmark = (e) => {
        e.stopPropagation();
        e.preventDefault();

        const messageId = parseInt(newBtn.dataset.messageId);
        if (!messageId) return;

        this.toggleBookmark(messageId);
      };

      newBtn.addEventListener('click', handleBookmark);
      newBtn.addEventListener('touchend', handleBookmark);
    });
  }

  /**
   * Show bookmarks modal
   */
  showBookmarksModal() {
    if (!this.currentSession) {
      showToast('No active session', 'warning');
      return;
    }

    const sessionId = this.currentSession.id;
    const bookmarkSet = this.bookmarks.get(sessionId);

    if (!bookmarkSet || bookmarkSet.size === 0) {
      showToast('No bookmarked messages in this session', 'info');
      return;
    }

    // Get bookmarked messages
    const bookmarkedMessages = this.messages.filter(msg =>
      msg.id && bookmarkSet.has(Number(msg.id))
    );

    // Sort by creation time (newest first)
    bookmarkedMessages.sort((a, b) => {
      const timeA = new Date(a.created_at || 0).getTime();
      const timeB = new Date(b.created_at || 0).getTime();
      return timeB - timeA;
    });

    // Remove existing modal if any
    const existingModal = document.getElementById('bookmarksModal');
    if (existingModal) {
      existingModal.remove();
    }

    // Generate bookmark items HTML
    const bookmarkItemsHtml = bookmarkedMessages.map(msg => {
      const isUser = msg.role === 'user';
      const timestamp = msg.created_at
        ? new Date(msg.created_at).toLocaleString('en-US', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
        : '';

      // Get preview of content (first 150 chars, strip HTML)
      let preview = msg.content || '';
      if (preview.includes('<') || preview.includes('&')) {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = preview;
        preview = tempDiv.textContent || tempDiv.innerText || preview;
      }
      preview = preview.substring(0, 150);
      if (msg.content && msg.content.length > 150) {
        preview += '...';
      }

      const sender = isUser
        ? 'You'
        : (msg.agent_name ? msg.agent_name : 'Assistant');

      return `
        <div class="list-group-item list-group-item-action" 
             data-message-id="${msg.id}" 
             style="cursor: pointer;">
          <div class="d-flex w-100 justify-content-between align-items-start">
            <div class="flex-grow-1">
              <div class="d-flex align-items-center mb-1">
                <span class="badge ${isUser ? 'bg-primary' : 'bg-info'} me-2">${escapeHtml(sender)}</span>
                <small class="text-muted">${escapeHtml(timestamp)}</small>
              </div>
              <p class="mb-1 text-muted small">${escapeHtml(preview)}</p>
            </div>
            <button class="btn btn-sm btn-outline-danger ms-2" 
                    data-action="remove-bookmark" 
                    data-message-id="${msg.id}"
                    title="Remove bookmark">
              <i class="bi bi-bookmark-x"></i>
            </button>
          </div>
        </div>
      `;
    }).join('');

    const modalHtml = `
      <div class="modal fade" id="bookmarksModal" tabindex="-1">
        <div class="modal-dialog modal-lg">
          <div class="modal-content">
            <div class="modal-header">
              <h5 class="modal-title">
                <i class="bi bi-bookmark-fill me-2"></i>Bookmarked Messages
              </h5>
              <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
            </div>
            <div class="modal-body">
              <div class="list-group" id="bookmarks-list">
                ${bookmarkItemsHtml}
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
    const modal = new bootstrap.Modal(document.getElementById('bookmarksModal'));
    modal.show();

    // Attach click handlers for bookmark items
    document.querySelectorAll('#bookmarks-list .list-group-item').forEach(item => {
      const messageId = item.dataset.messageId;
      if (!messageId) return;

      item.addEventListener('click', (e) => {
        // Don't trigger if clicking the remove button
        if (e.target.closest('[data-action="remove-bookmark"]')) {
          return;
        }

        // Close modal
        modal.hide();

        // Scroll to message
        setTimeout(() => {
          this.scrollToMessage(Number(messageId));
        }, 300);
      });
    });

    // Attach remove bookmark handlers
    document.querySelectorAll('[data-action="remove-bookmark"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const messageId = parseInt(btn.dataset.messageId);
        if (messageId) {
          this.toggleBookmark(messageId);
          // Remove the item from the list
          const item = btn.closest('.list-group-item');
          if (item) {
            item.remove();
          }
          // If no more bookmarks, close modal
          if (document.querySelectorAll('#bookmarks-list .list-group-item').length === 0) {
            modal.hide();
            showToast('All bookmarks removed', 'info');
          }
        }
      });
    });
  }

  /**
   * Scroll to a specific message by ID
   * @param {number} messageId - Message ID to scroll to
   */
  scrollToMessage(messageId) {
    const chatMessages = document.getElementById('chat-messages');
    if (!chatMessages) return;

    // Find the message element
    const messageElement = chatMessages.querySelector(`[data-message-id="${messageId}"]`);
    if (!messageElement) {
      // Message might not be loaded yet (archived), try to load it
      this.loadMessageIfNeeded(messageId).then(() => {
        // Retry scrolling after loading
        setTimeout(() => {
          const retryElement = chatMessages.querySelector(`[data-message-id="${messageId}"]`);
          if (retryElement) {
            retryElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
            // Highlight the message briefly
            retryElement.style.transition = 'background-color 0.3s';
            retryElement.style.backgroundColor = '#fff3cd';
            setTimeout(() => {
              retryElement.style.backgroundColor = '';
            }, 2000);
          }
        }, 100);
      });
      return;
    }

    // Scroll to message
    messageElement.scrollIntoView({ behavior: 'smooth', block: 'center' });

    // Highlight the message briefly
    messageElement.style.transition = 'background-color 0.3s';
    messageElement.style.backgroundColor = '#fff3cd';
    setTimeout(() => {
      messageElement.style.backgroundColor = '';
    }, 2000);
  }

  /**
   * Load a message if it's not currently loaded (e.g., archived)
   * @param {number} messageId - Message ID to load
   * @returns {Promise}
   */
  async loadMessageIfNeeded(messageId) {
    if (!this.currentSession) return;

    // Check if message is already loaded
    const isLoaded = this.messages.some(msg => msg.id && Number(msg.id) === Number(messageId));
    if (isLoaded) {
      return;
    }

    try {
      // Load all messages to find the one we need
      // This is a simple approach - in a production app, you might want to load just the specific message
      const response = await api.chat.getHistory(this.currentSession.id, 10000, 0);
      const allMessages = response.data.messages || [];

      // Find the message index
      const messageIndex = allMessages.findIndex(msg =>
        msg.id && Number(msg.id) === Number(messageId)
      );

      if (messageIndex >= 0) {
        // Load enough messages to include this one
        const messagesToLoad = Math.max(messageIndex + 50, 200);
        const loadResponse = await api.chat.getHistory(
          this.currentSession.id,
          messagesToLoad,
          0
        );

        this.messages = loadResponse.data.messages || [];
        this.messageOffset = this.messages.length;
        this.hasMoreMessages = loadResponse.data.hasMore || false;
        this.totalMessages = loadResponse.data.total || 0;
        this.renderMessages(false);
      }
    } catch (error) {
      console.error('Error loading message:', error);
    }
  }
}

// Create global instance
window.chatInterface = new ChatInterface();

// Set up event listeners when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  window.chatInterface.init();

  // Character count update
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.addEventListener('input', () => {
      window.chatInterface.updateCharCount();
    });

    chatInput.addEventListener('keypress', (e) => {
      window.chatInterface.handleKeyPress(e);
    });
  }
});
