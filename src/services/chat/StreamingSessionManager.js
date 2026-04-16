/**
 * Streaming Session Manager
 * Tracks active streaming sessions and buffers content for reconnection
 */

const logger = require('../../utils/logger');

class StreamingSessionManager {
  constructor() {
    // Map of sessionId -> streaming state
    this.activeSessions = new Map();
    
    // Cleanup old sessions periodically (every 5 minutes)
    setInterval(() => this.cleanup(), 5 * 60 * 1000);
  }

  /**
   * Start tracking a streaming session
   * @param {number} sessionId - Session ID
   * @param {string} userMessage - The user message being processed
   */
  startStreaming(sessionId, userMessage) {
    this.activeSessions.set(sessionId, {
      sessionId,
      userMessage,
      content: '',
      chunks: [],
      agentName: null,
      status: 'streaming', // 'streaming', 'done', 'error'
      startedAt: Date.now(),
      updatedAt: Date.now(),
      subscribers: new Set(), // Response objects for SSE
    });
    
    logger.info(`Streaming started for session ${sessionId}`);
  }

  /**
   * Add a chunk to the streaming buffer
   * @param {number} sessionId - Session ID
   * @param {string} chunk - Content chunk
   */
  addChunk(sessionId, chunk) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    
    session.content += chunk;
    session.chunks.push({
      content: chunk,
      timestamp: Date.now(),
    });
    session.updatedAt = Date.now();
    
    // Notify all subscribers
    for (const res of session.subscribers) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'chunk', content: chunk })}\n\n`);
      } catch (e) {
        // Remove dead subscribers
        session.subscribers.delete(res);
      }
    }
  }

  /**
   * Mark streaming as complete
   * @param {number} sessionId - Session ID
   * @param {object} result - Final result with agentName, etc.
   */
  completeStreaming(sessionId, result) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    
    session.status = 'done';
    session.agentName = result.agentName;
    session.routedTo = result.routedTo;
    session.tokensUsed = result.tokensUsed;
    session.updatedAt = Date.now();
    
    // Notify all subscribers
    for (const res of session.subscribers) {
      try {
        res.write(`data: ${JSON.stringify({
          type: 'done',
          agentName: result.agentName,
          routedTo: result.routedTo,
          tokensUsed: result.tokensUsed,
        })}\n\n`);
        res.end();
      } catch (e) {
        // Ignore errors on completion
      }
    }
    session.subscribers.clear();
    
    logger.info(`Streaming completed for session ${sessionId}`);
    
    // Keep the session around for 30 seconds for late reconnects
    setTimeout(() => {
      if (this.activeSessions.get(sessionId)?.status === 'done') {
        this.activeSessions.delete(sessionId);
      }
    }, 30000);
  }

  /**
   * Mark streaming as errored
   * @param {number} sessionId - Session ID
   * @param {string} error - Error message
   */
  errorStreaming(sessionId, error) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    
    session.status = 'error';
    session.error = error;
    session.updatedAt = Date.now();
    
    // Notify all subscribers
    for (const res of session.subscribers) {
      try {
        res.write(`data: ${JSON.stringify({ type: 'error', message: error })}\n\n`);
        res.end();
      } catch (e) {
        // Ignore errors
      }
    }
    session.subscribers.clear();
    
    logger.error(`Streaming error for session ${sessionId}: ${error}`);
    
    // Remove after a short delay
    setTimeout(() => {
      this.activeSessions.delete(sessionId);
    }, 5000);
  }

  /**
   * Check if a session has an active stream
   * @param {number} sessionId - Session ID
   * @returns {object|null} - Streaming state or null
   */
  getStreamingState(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return null;
    
    return {
      sessionId: session.sessionId,
      status: session.status,
      content: session.content,
      agentName: session.agentName,
      routedTo: session.routedTo,
      tokensUsed: session.tokensUsed,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      error: session.error,
    };
  }

  /**
   * Subscribe to streaming updates
   * @param {number} sessionId - Session ID
   * @param {object} res - Express response object for SSE
   * @returns {boolean} - True if subscribed, false if no active stream
   */
  subscribe(sessionId, res) {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;
    
    // If already done, send final state
    if (session.status === 'done') {
      res.write(`data: ${JSON.stringify({ type: 'reconnected', content: session.content })}\n\n`);
      res.write(`data: ${JSON.stringify({
        type: 'done',
        agentName: session.agentName,
        routedTo: session.routedTo,
        tokensUsed: session.tokensUsed,
      })}\n\n`);
      res.end();
      return true;
    }
    
    // If error, send error
    if (session.status === 'error') {
      res.write(`data: ${JSON.stringify({ type: 'error', message: session.error })}\n\n`);
      res.end();
      return true;
    }
    
    // Send current buffered content first
    if (session.content) {
      res.write(`data: ${JSON.stringify({ type: 'reconnected', content: session.content })}\n\n`);
    }
    
    // Subscribe to future updates
    session.subscribers.add(res);
    
    logger.info(`Client subscribed to streaming session ${sessionId}`);
    return true;
  }

  /**
   * Unsubscribe from streaming updates
   * @param {number} sessionId - Session ID
   * @param {object} res - Express response object
   */
  unsubscribe(sessionId, res) {
    const session = this.activeSessions.get(sessionId);
    if (session) {
      session.subscribers.delete(res);
    }
  }

  /**
   * Cleanup old sessions
   */
  cleanup() {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutes
    
    for (const [sessionId, session] of this.activeSessions) {
      if (now - session.updatedAt > maxAge) {
        // Notify subscribers before cleanup
        for (const res of session.subscribers) {
          try {
            res.write(`data: ${JSON.stringify({ type: 'error', message: 'Stream timeout' })}\n\n`);
            res.end();
          } catch (e) {
            // Ignore
          }
        }
        this.activeSessions.delete(sessionId);
        logger.info(`Cleaned up stale streaming session ${sessionId}`);
      }
    }
  }
}

// Singleton instance
const streamingSessionManager = new StreamingSessionManager();

module.exports = { streamingSessionManager };
