/**
 * State Persist Tool
 * Fast in-memory key-value storage for session-specific variables
 * Provides low-latency access without file I/O or full DB queries
 */

const { toolRegistry } = require('./ToolRegistry');
const logger = require('../../utils/logger');

// In-memory storage: Map<sessionAgentKey, Map<key, {value, expiresAt, size}>>
// sessionAgentKey = `${sessionId}:${agentId}`
const stateStore = new Map();

// Configuration limits
const MAX_KEYS_PER_SESSION = 100;
const MAX_TOTAL_SIZE_BYTES = 10 * 1024; // 10KB
const MAX_VALUE_SIZE_BYTES = 1024; // 1KB per value

// Cleanup interval for expired keys (run every 5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupInterval = null;

/**
 * Get session-agent storage key
 */
function getSessionAgentKey(sessionId, agentId) {
  return `${sessionId}:${agentId}`;
}

/**
 * Get storage for a session-agent pair
 */
function getSessionStorage(sessionId, agentId) {
  const key = getSessionAgentKey(sessionId, agentId);
  if (!stateStore.has(key)) {
    stateStore.set(key, new Map());
  }
  return stateStore.get(key);
}

/**
 * Calculate size of a value when serialized
 */
function calculateValueSize(value) {
  try {
    const serialized = JSON.stringify(value);
    return Buffer.byteLength(serialized, 'utf8');
  } catch (error) {
    // Fallback: estimate size
    return String(value).length;
  }
}

/**
 * Get total size of all values in a session storage
 */
function getTotalSize(storage) {
  let total = 0;
  for (const entry of storage.values()) {
    total += entry.size;
  }
  return total;
}

/**
 * Clean up expired keys for a session storage
 */
function cleanupExpiredKeys(storage) {
  const now = Date.now();
  const keysToDelete = [];
  
  for (const [key, entry] of storage.entries()) {
    if (entry.expiresAt && entry.expiresAt < now) {
      keysToDelete.push(key);
    }
  }
  
  for (const key of keysToDelete) {
    storage.delete(key);
  }
  
  return keysToDelete.length;
}

/**
 * Clean up all expired keys across all sessions
 */
function cleanupAllExpiredKeys() {
  let totalCleaned = 0;
  for (const storage of stateStore.values()) {
    totalCleaned += cleanupExpiredKeys(storage);
  }
  
  // Remove empty session storages
  for (const [key, storage] of stateStore.entries()) {
    if (storage.size === 0) {
      stateStore.delete(key);
    }
  }
  
  if (totalCleaned > 0) {
    logger.debug(`[state_persist] Cleaned up ${totalCleaned} expired keys`);
  }
}

/**
 * Start cleanup interval if not already running
 */
function startCleanupInterval() {
  if (cleanupInterval) return;
  
  cleanupInterval = setInterval(() => {
    cleanupAllExpiredKeys();
  }, CLEANUP_INTERVAL_MS);
  
  logger.debug('[state_persist] Started cleanup interval');
}

/**
 * Stop cleanup interval
 */
function stopCleanupInterval() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.debug('[state_persist] Stopped cleanup interval');
  }
}

/**
 * Register State Persist tool
 */
function registerStatePersistTool() {
  toolRegistry.register({
    name: 'state_persist',
    description: 'Fast in-memory key-value storage for session-specific variables. Provides low-latency access without file I/O or database queries. Ideal for tracking transient states, counters, or configs that don\'t need permanent storage. Data persists across tool calls but resets on new sessions.',
    category: 'storage',
    parameters: {
      operation: {
        type: 'string',
        description: 'Operation to perform',
        required: true,
        enum: ['set', 'get', 'delete', 'list', 'clear'],
      },
      key: {
        type: 'string',
        description: 'Key name (required for set/get/delete operations)',
        required: false,
        maxLength: 200,
      },
      value: {
        type: 'string',
        description: 'Value to store (for set operation). Supports string, number, boolean, or JSON object. Max size: 1KB.',
        required: false,
      },
      ttl_ms: {
        type: 'number',
        description: 'Time-to-live in milliseconds (for set operation). Key will auto-expire after this duration. Example: 3600000 for 1 hour.',
        required: false,
        minimum: 1000, // Minimum 1 second
        maximum: 86400000 * 7, // Maximum 7 days
      },
    },
    handler: async (params, context) => {
      const { operation, key, value, ttl_ms } = params;

      if (!context.sessionId || !context.agentId) {
        throw new Error('sessionId and agentId are required in context');
      }

      // Start cleanup interval on first use
      startCleanupInterval();

      const storage = getSessionStorage(context.sessionId, context.agentId);
      
      // Clean up expired keys before operations
      cleanupExpiredKeys(storage);

      switch (operation) {
        case 'set':
          return await handleSet(storage, key, value, ttl_ms);
        case 'get':
          return await handleGet(storage, key);
        case 'delete':
          return await handleDelete(storage, key);
        case 'list':
          return await handleList(storage);
        case 'clear':
          return await handleClear(storage);
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    },
    examples: [
      {
        description: 'Set a session variable',
        parameters: {
          operation: 'set',
          key: 'session_start_time',
          value: '2026-01-25 08:00:00',
        },
      },
      {
        description: 'Get a stored value',
        parameters: {
          operation: 'get',
          key: 'session_start_time',
        },
      },
      {
        description: 'Set a value with expiration (1 hour)',
        parameters: {
          operation: 'set',
          key: 'temp_threshold',
          value: 25.5,
          ttl_ms: 3600000,
        },
      },
      {
        description: 'List all keys',
        parameters: {
          operation: 'list',
        },
      },
    ],
  });
}

/**
 * Handle set operation
 */
function handleSet(storage, key, value, ttl_ms) {
  if (!key || typeof key !== 'string' || key.trim() === '') {
    throw new Error('key is required and must be a non-empty string');
  }

  if (value === undefined || value === null) {
    throw new Error('value is required for set operation');
  }

  // Parse value if it's a JSON string
  let parsedValue = value;
  if (typeof value === 'string') {
    // Try to parse as JSON if it looks like JSON
    if ((value.startsWith('{') && value.endsWith('}')) || 
        (value.startsWith('[') && value.endsWith(']'))) {
      try {
        parsedValue = JSON.parse(value);
      } catch (e) {
        // Not JSON, use as string
        parsedValue = value;
      }
    }
  }

  // Calculate value size
  const valueSize = calculateValueSize(parsedValue);
  
  if (valueSize > MAX_VALUE_SIZE_BYTES) {
    throw new Error(`Value size (${valueSize} bytes) exceeds maximum (${MAX_VALUE_SIZE_BYTES} bytes)`);
  }

  // Check if key already exists
  const existingEntry = storage.get(key);
  const existingSize = existingEntry ? existingEntry.size : 0;
  const currentTotalSize = getTotalSize(storage);
  const newTotalSize = currentTotalSize - existingSize + valueSize;

  // Check limits
  if (!existingEntry && storage.size >= MAX_KEYS_PER_SESSION) {
    throw new Error(`Maximum number of keys (${MAX_KEYS_PER_SESSION}) reached for this session`);
  }

  if (newTotalSize > MAX_TOTAL_SIZE_BYTES) {
    throw new Error(`Total storage size (${newTotalSize} bytes) would exceed maximum (${MAX_TOTAL_SIZE_BYTES} bytes)`);
  }

  // Calculate expiration time
  let expiresAt = null;
  if (ttl_ms && Number.isFinite(ttl_ms) && ttl_ms > 0) {
    expiresAt = Date.now() + ttl_ms;
  }

  // Store value
  storage.set(key, {
    value: parsedValue,
    expiresAt,
    size: valueSize,
    updatedAt: Date.now(),
  });

  return {
    success: true,
    key,
    value: parsedValue,
    size: valueSize,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    total_keys: storage.size,
    total_size: newTotalSize,
    message: existingEntry ? 'Value updated' : 'Value stored',
  };
}

/**
 * Handle get operation
 */
function handleGet(storage, key) {
  if (!key || typeof key !== 'string' || key.trim() === '') {
    throw new Error('key is required and must be a non-empty string');
  }

  const entry = storage.get(key);
  
  if (!entry) {
    return {
      success: false,
      key,
      value: null,
      message: 'Key not found',
    };
  }

  // Check if expired
  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    storage.delete(key);
    return {
      success: false,
      key,
      value: null,
      message: 'Key expired',
    };
  }

  return {
    success: true,
    key,
    value: entry.value,
    expires_at: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null,
    updated_at: new Date(entry.updatedAt).toISOString(),
    size: entry.size,
  };
}

/**
 * Handle delete operation
 */
function handleDelete(storage, key) {
  if (!key || typeof key !== 'string' || key.trim() === '') {
    throw new Error('key is required and must be a non-empty string');
  }

  const existed = storage.has(key);
  if (existed) {
    storage.delete(key);
  }

  return {
    success: true,
    key,
    deleted: existed,
    total_keys: storage.size,
    message: existed ? 'Key deleted' : 'Key not found',
  };
}

/**
 * Handle list operation
 */
function handleList(storage) {
  const keys = Array.from(storage.keys());
  const totalSize = getTotalSize(storage);

  return {
    success: true,
    keys,
    count: keys.length,
    total_size: totalSize,
    max_keys: MAX_KEYS_PER_SESSION,
    max_size: MAX_TOTAL_SIZE_BYTES,
  };
}

/**
 * Handle clear operation
 */
function handleClear(storage) {
  const count = storage.size;
  storage.clear();

  return {
    success: true,
    cleared: count,
    message: `Cleared ${count} key(s)`,
  };
}

/**
 * Get statistics for all sessions (for debugging/monitoring)
 */
function getStatistics() {
  let totalSessions = 0;
  let totalKeys = 0;
  let totalSize = 0;

  for (const storage of stateStore.values()) {
    totalSessions++;
    totalKeys += storage.size;
    totalSize += getTotalSize(storage);
  }

  return {
    total_sessions: totalSessions,
    total_keys: totalKeys,
    total_size: totalSize,
  };
}

module.exports = {
  registerStatePersistTool,
  getStatistics,
  stopCleanupInterval,
};
