/**
 * Session Pool Tool
 * Shared in-memory key-value storage for teammates in the same session
 * Read access: all assigned teammates
 * Write access: own namespace only
 */

const { toolRegistry } = require('./ToolRegistry');
const { dbAll } = require('../../../config/database');
const logger = require('../../utils/logger');

// In-memory storage: Map<sessionId, { version, changes, namespaces }>
// namespaces: Map<ownerAgentId, Map<key, {value, expiresAt, size, updatedAt, updatedBy}>>
const poolStore = new Map();

// Configuration limits
const MAX_KEYS_PER_NAMESPACE = 100;
const MAX_TOTAL_SIZE_BYTES = 10 * 1024; // 10KB per owner namespace
const MAX_VALUE_SIZE_BYTES = 1024; // 1KB per value
const MAX_CHANGE_EVENTS = 500;

// Cleanup interval for expired keys (run every 5 minutes)
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
let cleanupInterval = null;

function getSessionPool(sessionId) {
  const key = String(sessionId);
  if (!poolStore.has(key)) {
    poolStore.set(key, {
      version: 0,
      changes: [],
      namespaces: new Map(),
    });
  }
  return poolStore.get(key);
}

function getNamespace(pool, ownerAgentId) {
  const ownerKey = String(ownerAgentId);
  if (!pool.namespaces.has(ownerKey)) {
    pool.namespaces.set(ownerKey, new Map());
  }
  return pool.namespaces.get(ownerKey);
}

function calculateValueSize(value) {
  try {
    const serialized = JSON.stringify(value);
    return Buffer.byteLength(serialized, 'utf8');
  } catch (error) {
    return String(value).length;
  }
}

function getTotalSize(namespaceStore) {
  let total = 0;
  for (const entry of namespaceStore.values()) {
    total += entry.size;
  }
  return total;
}

function cleanupExpiredKeys(namespaceStore) {
  const now = Date.now();
  const keysToDelete = [];

  for (const [key, entry] of namespaceStore.entries()) {
    if (entry.expiresAt && entry.expiresAt < now) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    namespaceStore.delete(key);
  }

  return keysToDelete.length;
}

function cleanupAllExpiredKeys() {
  let totalCleaned = 0;

  for (const pool of poolStore.values()) {
    for (const [ownerAgentId, namespaceStore] of pool.namespaces.entries()) {
      totalCleaned += cleanupExpiredKeys(namespaceStore);
      if (namespaceStore.size === 0) {
        pool.namespaces.delete(ownerAgentId);
      }
    }
  }

  for (const [sessionId, pool] of poolStore.entries()) {
    if (pool.namespaces.size === 0 && pool.changes.length === 0) {
      poolStore.delete(sessionId);
    }
  }

  if (totalCleaned > 0) {
    logger.debug(`[session_pool] Cleaned up ${totalCleaned} expired keys`);
  }
}

function startCleanupInterval() {
  if (cleanupInterval) return;

  cleanupInterval = setInterval(() => {
    cleanupAllExpiredKeys();
  }, CLEANUP_INTERVAL_MS);

  logger.debug('[session_pool] Started cleanup interval');
}

function stopCleanupInterval() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
    logger.debug('[session_pool] Stopped cleanup interval');
  }
}

function parseIncomingValue(value) {
  if (typeof value !== 'string') {
    return value;
  }

  if ((value.startsWith('{') && value.endsWith('}')) ||
      (value.startsWith('[') && value.endsWith(']'))) {
    try {
      return JSON.parse(value);
    } catch (error) {
      return value;
    }
  }

  return value;
}

async function getAssignedAgentIds(sessionId) {
  const rows = await dbAll(
    `SELECT agent_id FROM session_agent_tools
     WHERE session_id = ? AND tool_name = ?
     ORDER BY agent_id ASC`,
    [sessionId, 'session_pool']
  );

  return rows.map((row) => String(row.agent_id));
}

async function assertAgentAssigned(sessionId, agentId) {
  const rows = await dbAll(
    `SELECT 1 FROM session_agent_tools
     WHERE session_id = ? AND agent_id = ? AND tool_name = ?
     LIMIT 1`,
    [sessionId, agentId, 'session_pool']
  );

  if (!rows || rows.length === 0) {
    throw new Error('session_pool is not assigned to this agent');
  }
}

function recordChange(pool, actorAgentId, operation, ownerAgentId, key) {
  pool.version += 1;
  const event = {
    version: pool.version,
    actorAgentId: String(actorAgentId),
    ownerAgentId: String(ownerAgentId),
    operation,
    key: key || null,
    timestamp: new Date().toISOString(),
  };
  pool.changes.push(event);
  if (pool.changes.length > MAX_CHANGE_EVENTS) {
    pool.changes.splice(0, pool.changes.length - MAX_CHANGE_EVENTS);
  }
  return event;
}

function ensureOwnerAccess(callerAgentId, ownerAgentId) {
  if (String(callerAgentId) !== String(ownerAgentId)) {
    throw new Error('Agents can only modify their own namespace');
  }
}

function handleSet(namespaceStore, key, value, ttl_ms) {
  if (!key || typeof key !== 'string' || key.trim() === '') {
    throw new Error('key is required and must be a non-empty string');
  }

  if (value === undefined || value === null) {
    throw new Error('value is required for set operation');
  }

  const parsedValue = parseIncomingValue(value);
  const valueSize = calculateValueSize(parsedValue);
  if (valueSize > MAX_VALUE_SIZE_BYTES) {
    throw new Error(`Value size (${valueSize} bytes) exceeds maximum (${MAX_VALUE_SIZE_BYTES} bytes)`);
  }

  const existingEntry = namespaceStore.get(key);
  const existingSize = existingEntry ? existingEntry.size : 0;
  const currentTotalSize = getTotalSize(namespaceStore);
  const newTotalSize = currentTotalSize - existingSize + valueSize;

  if (!existingEntry && namespaceStore.size >= MAX_KEYS_PER_NAMESPACE) {
    throw new Error(`Maximum number of keys (${MAX_KEYS_PER_NAMESPACE}) reached for this namespace`);
  }

  if (newTotalSize > MAX_TOTAL_SIZE_BYTES) {
    throw new Error(`Total storage size (${newTotalSize} bytes) would exceed maximum (${MAX_TOTAL_SIZE_BYTES} bytes)`);
  }

  let expiresAt = null;
  if (ttl_ms && Number.isFinite(ttl_ms) && ttl_ms > 0) {
    expiresAt = Date.now() + ttl_ms;
  }

  namespaceStore.set(key, {
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
    total_keys: namespaceStore.size,
    total_size: newTotalSize,
    message: existingEntry ? 'Value updated' : 'Value stored',
  };
}

function handleGet(namespaceStore, key) {
  if (!key || typeof key !== 'string' || key.trim() === '') {
    throw new Error('key is required and must be a non-empty string');
  }

  const entry = namespaceStore.get(key);
  if (!entry) {
    return {
      success: false,
      key,
      value: null,
      message: 'Key not found',
    };
  }

  if (entry.expiresAt && entry.expiresAt < Date.now()) {
    namespaceStore.delete(key);
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

function handleDelete(namespaceStore, key) {
  if (!key || typeof key !== 'string' || key.trim() === '') {
    throw new Error('key is required and must be a non-empty string');
  }

  const existed = namespaceStore.has(key);
  if (existed) {
    namespaceStore.delete(key);
  }

  return {
    success: true,
    key,
    deleted: existed,
    total_keys: namespaceStore.size,
    message: existed ? 'Key deleted' : 'Key not found',
  };
}

function handleList(namespaceStore) {
  const keys = Array.from(namespaceStore.keys());
  const totalSize = getTotalSize(namespaceStore);
  return {
    success: true,
    keys,
    count: keys.length,
    total_size: totalSize,
    max_keys: MAX_KEYS_PER_NAMESPACE,
    max_size: MAX_TOTAL_SIZE_BYTES,
  };
}

function handleClear(namespaceStore) {
  const count = namespaceStore.size;
  namespaceStore.clear();
  return {
    success: true,
    cleared: count,
    message: `Cleared ${count} key(s)`,
  };
}

function buildPoolSummary(pool, assignedAgentIds) {
  const namespaces = assignedAgentIds.map((agentId) => {
    const namespaceStore = pool.namespaces.get(agentId) || new Map();
    cleanupExpiredKeys(namespaceStore);
    return {
      owner_agent_id: Number(agentId),
      keys: Array.from(namespaceStore.keys()),
      count: namespaceStore.size,
      total_size: getTotalSize(namespaceStore),
    };
  });

  return {
    success: true,
    pool_version: pool.version,
    assigned_agents: assignedAgentIds.map((id) => Number(id)),
    namespaces,
  };
}

/**
 * Get a read-only dump of the session pool for UI/admin. Returns null if no agent has session_pool assigned.
 * @param {string|number} sessionId
 * @returns {Promise<{ success: boolean, pool_version: number, assigned_agents: number[], namespaces: object[] }|null>}
 */
async function getPoolDumpForSession(sessionId) {
  const assignedAgentIds = await getAssignedAgentIds(String(sessionId));
  if (!assignedAgentIds || assignedAgentIds.length === 0) {
    return null;
  }
  const key = String(sessionId);
  if (!poolStore.has(key)) {
    return {
      success: true,
      pool_version: 0,
      assigned_agents: assignedAgentIds.map((id) => Number(id)),
      namespaces: assignedAgentIds.map((agentId) => ({
        owner_agent_id: Number(agentId),
        keys: [],
        count: 0,
        total_size: 0,
      })),
    };
  }
  const pool = poolStore.get(key);
  return buildPoolSummary(pool, assignedAgentIds);
}

function registerSessionPoolTool() {
  toolRegistry.register({
    name: 'session_pool',
    description: 'Shared in-memory key-value storage for agents in the same session who are assigned this tool. Agents can read teammates\' namespaces and only modify their own namespace. Includes version-based change polling for synchronization.',
    category: 'storage',
    parameters: {
      operation: {
        type: 'string',
        description: 'Operation to perform',
        required: true,
        enum: ['set', 'get', 'delete', 'list', 'clear', 'list_pool', 'get_from', 'changes_since'],
      },
      key: {
        type: 'string',
        description: 'Key name (required for set/get/delete/get_from)',
        required: false,
        maxLength: 200,
      },
      value: {
        type: 'string',
        description: 'Value to store (for set). Supports string, number, boolean, or JSON object. Max size: 1KB.',
        required: false,
      },
      ttl_ms: {
        type: 'number',
        description: 'Time-to-live in milliseconds for set operation.',
        required: false,
        minimum: 1000,
        maximum: 86400000 * 7,
      },
      owner_agent_id: {
        type: 'number',
        description: 'Namespace owner agent id (required for get_from operation).',
        required: false,
      },
      since_version: {
        type: 'number',
        description: 'Return change events with version greater than this value (for changes_since).',
        required: false,
        minimum: 0,
      },
    },
    handler: async (params, context) => {
      const { operation, key, value, ttl_ms, owner_agent_id, since_version } = params;

      if (!context.sessionId || !context.agentId) {
        throw new Error('sessionId and agentId are required in context');
      }

      const sessionId = String(context.sessionId);
      const callerAgentId = String(context.agentId);

      await assertAgentAssigned(sessionId, callerAgentId);
      const assignedAgentIds = await getAssignedAgentIds(sessionId);
      const allowedSet = new Set(assignedAgentIds);

      if (!allowedSet.has(callerAgentId)) {
        throw new Error('session_pool is not assigned to this agent');
      }

      startCleanupInterval();
      const pool = getSessionPool(sessionId);
      const ownNamespace = getNamespace(pool, callerAgentId);
      cleanupExpiredKeys(ownNamespace);

      switch (operation) {
        case 'set': {
          ensureOwnerAccess(callerAgentId, callerAgentId);
          const result = handleSet(ownNamespace, key, value, ttl_ms);
          const change = recordChange(pool, callerAgentId, 'set', callerAgentId, key);
          return {
            ...result,
            owner_agent_id: Number(callerAgentId),
            pool_version: pool.version,
            change,
          };
        }
        case 'get': {
          const result = handleGet(ownNamespace, key);
          return {
            ...result,
            owner_agent_id: Number(callerAgentId),
            pool_version: pool.version,
          };
        }
        case 'delete': {
          ensureOwnerAccess(callerAgentId, callerAgentId);
          const result = handleDelete(ownNamespace, key);
          const change = recordChange(pool, callerAgentId, 'delete', callerAgentId, key);
          return {
            ...result,
            owner_agent_id: Number(callerAgentId),
            pool_version: pool.version,
            change,
          };
        }
        case 'list': {
          const result = handleList(ownNamespace);
          return {
            ...result,
            owner_agent_id: Number(callerAgentId),
            pool_version: pool.version,
          };
        }
        case 'clear': {
          ensureOwnerAccess(callerAgentId, callerAgentId);
          const result = handleClear(ownNamespace);
          const change = recordChange(pool, callerAgentId, 'clear', callerAgentId, null);
          return {
            ...result,
            owner_agent_id: Number(callerAgentId),
            pool_version: pool.version,
            change,
          };
        }
        case 'list_pool': {
          return buildPoolSummary(pool, assignedAgentIds);
        }
        case 'get_from': {
          if (!Number.isFinite(owner_agent_id)) {
            throw new Error('owner_agent_id is required for get_from operation');
          }
          const ownerId = String(owner_agent_id);
          if (!allowedSet.has(ownerId)) {
            throw new Error('owner_agent_id is not assigned to session_pool in this session');
          }
          const ownerNamespace = getNamespace(pool, ownerId);
          cleanupExpiredKeys(ownerNamespace);
          const result = handleGet(ownerNamespace, key);
          return {
            ...result,
            owner_agent_id: Number(ownerId),
            reader_agent_id: Number(callerAgentId),
            pool_version: pool.version,
          };
        }
        case 'changes_since': {
          const since = Number.isFinite(since_version) ? Number(since_version) : 0;
          const events = pool.changes.filter((entry) => entry.version > since);
          return {
            success: true,
            changed: events.length > 0,
            since_version: since,
            current_version: pool.version,
            change_count: events.length,
            changes: events,
          };
        }
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    },
    examples: [
      {
        description: 'Set own namespace key',
        parameters: {
          operation: 'set',
          key: 'task_status',
          value: '{"stage":"research","done":false}',
        },
      },
      {
        description: 'Read teammate key',
        parameters: {
          operation: 'get_from',
          owner_agent_id: 2,
          key: 'task_status',
        },
      },
      {
        description: 'Poll for pool changes',
        parameters: {
          operation: 'changes_since',
          since_version: 0,
        },
      },
      {
        description: 'List all pool namespaces',
        parameters: {
          operation: 'list_pool',
        },
      },
    ],
  });
}

function getStatistics() {
  let totalSessions = 0;
  let totalNamespaces = 0;
  let totalKeys = 0;
  let totalSize = 0;

  for (const pool of poolStore.values()) {
    totalSessions++;
    totalNamespaces += pool.namespaces.size;
    for (const namespaceStore of pool.namespaces.values()) {
      totalKeys += namespaceStore.size;
      totalSize += getTotalSize(namespaceStore);
    }
  }

  return {
    total_sessions: totalSessions,
    total_namespaces: totalNamespaces,
    total_keys: totalKeys,
    total_size: totalSize,
  };
}

module.exports = {
  registerSessionPoolTool,
  getStatistics,
  getPoolDumpForSession,
  stopCleanupInterval,
};
