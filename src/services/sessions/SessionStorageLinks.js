/**
 * Session storage symlinks: for each session, maintain a folder under storage/sessions/<name_id>/
 * containing symlinks to each assigned agent's local_working_folder workspace and sqlite_local_db file.
 * Links are created/updated when the user sets local working folder path or sqlite db name;
 * links are removed when agents are removed from the session.
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { dbAll } = require('../../../config/database');
const WorkSession = require('../../models/WorkSession');
const { getWorkspacePath } = require('../tools/localWorkingFolderTool');
const { getDatabasePath } = require('../tools/sqliteLocalDbTool');
const logger = require('../../utils/logger');

const SESSIONS_STORAGE_DIR = path.join(process.cwd(), 'storage', 'sessions');

/** Prefix for workspace directory symlinks: workspace_<agentId> */
const WORKSPACE_LINK_PREFIX = 'workspace_';
/** Suffix for db file symlinks: <agentId>.db */
const DB_LINK_SUFFIX = '.db';

/**
 * Sanitize session name for use as directory name (alphanumeric, underscore, hyphen; max 80 chars).
 * @param {string} name - Session name
 * @returns {string}
 */
function sanitizeSessionName(name) {
  if (!name || typeof name !== 'string') return 'session';
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80).trim() || 'session';
}

/**
 * Get tool assignments for a session (agent_id, tool_name, tool_config).
 * @param {number} sessionId
 * @returns {Promise<Array<{agent_id: number, tool_name: string, tool_config: object|null}>>}
 */
async function getSessionToolAssignments(sessionId) {
  const rows = await dbAll(
    `SELECT agent_id, tool_name, tool_config FROM session_agent_tools WHERE session_id = ?`,
    [sessionId]
  );
  return (rows || []).map((row) => {
    let toolConfig = row.tool_config;
    if (toolConfig && typeof toolConfig === 'string') {
      try {
        toolConfig = JSON.parse(toolConfig);
      } catch {
        toolConfig = null;
      }
    }
    return {
      agent_id: row.agent_id,
      tool_name: row.tool_name,
      tool_config: toolConfig,
    };
  });
}

/**
 * Sync the session's storage folder: create storage/sessions/<safeName>_<sessionId>/ and
 * symlink each assigned agent's working folder and sqlite db. Remove symlinks for agents
 * no longer in the session or no longer having those tools configured.
 * @param {number} sessionId - Session ID
 * @returns {Promise<void>}
 */
async function syncSessionStorageLinks(sessionId) {
  if (!Number.isFinite(sessionId)) return;

  const session = await WorkSession.findById(sessionId);
  if (!session) return;

  const agents = await WorkSession.getAgents(sessionId);
  const agentIds = new Set((agents || []).map((a) => a.id));
  if (agentIds.size === 0) {
    // No agents: remove session folder if it exists (optional), or leave it and only remove links
    const safeName = sanitizeSessionName(session.name);
    const sessionDir = path.join(SESSIONS_STORAGE_DIR, `${safeName}_${sessionId}`);
    if (fsSync.existsSync(sessionDir)) {
      const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
      for (const ent of entries) {
        const full = path.join(sessionDir, ent.name);
        try {
          await fs.unlink(full);
        } catch (e) {
          logger.warn(`[SessionStorageLinks] Could not remove ${ent.name}: ${e.message}`);
        }
      }
    }
    return;
  }

  const assignments = await getSessionToolAssignments(sessionId);
  const workspaceCfgByAgent = {};
  const dbByAgent = {};
  for (const a of assignments) {
    if (!agentIds.has(a.agent_id)) continue;
    if (a.tool_name === 'local_working_folder' && a.tool_config?.folder_name?.trim()) {
      workspaceCfgByAgent[a.agent_id] = a.tool_config;
    }
    if (a.tool_name === 'sqlite_local_db' && a.tool_config?.database_name?.trim()) {
      dbByAgent[a.agent_id] = a.tool_config.database_name.trim();
    }
  }

  const safeName = sanitizeSessionName(session.name);
  const sessionDir = path.join(SESSIONS_STORAGE_DIR, `${safeName}_${sessionId}`);
  await fs.mkdir(sessionDir, { recursive: true });

  const expectedLinks = new Set();

  for (const agentId of Object.keys(workspaceCfgByAgent)) {
    const cfg = workspaceCfgByAgent[agentId] || {};
    const folderName = String(cfg.folder_name || '').trim();
    if (!folderName) continue;
    const randomizeName = cfg.randomize_name !== false;
    const workspacePath = getWorkspacePath(folderName, sessionId, Number(agentId), randomizeName);
    const linkName = `${WORKSPACE_LINK_PREFIX}${agentId}`;
    expectedLinks.add(linkName);
    const linkPath = path.join(sessionDir, linkName);
    try {
      if (!fsSync.existsSync(workspacePath)) {
        await fs.mkdir(workspacePath, { recursive: true });
      }
      const stat = await fs.lstat(linkPath).catch(() => null);
      if (stat?.isSymbolicLink()) {
        const current = await fs.realpath(linkPath).catch(() => '');
        if (path.resolve(current) === path.resolve(workspacePath)) continue;
        await fs.unlink(linkPath);
      } else if (stat) {
        await fs.unlink(linkPath).catch(() => {});
      }
      await fs.symlink(workspacePath, linkPath, 'dir');
      logger.debug(`[SessionStorageLinks] Linked workspace ${agentId} -> ${linkName}`);
    } catch (e) {
      logger.warn(`[SessionStorageLinks] Failed to symlink workspace for agent ${agentId}: ${e.message}`);
    }
  }

  for (const agentId of Object.keys(dbByAgent)) {
    const dbName = dbByAgent[agentId];
    const dbFilePath = getDatabasePath(dbName, sessionId, Number(agentId));
    const linkName = `${agentId}${DB_LINK_SUFFIX}`;
    expectedLinks.add(linkName);
    const linkPath = path.join(sessionDir, linkName);
    try {
      const stat = await fs.lstat(linkPath).catch(() => null);
      if (stat?.isSymbolicLink()) {
        const current = await fs.realpath(linkPath).catch(() => '');
        if (path.resolve(current) === path.resolve(dbFilePath)) continue;
        await fs.unlink(linkPath);
      } else if (stat) {
        await fs.unlink(linkPath).catch(() => {});
      }
      await fs.symlink(dbFilePath, linkPath);
      logger.debug(`[SessionStorageLinks] Linked db ${agentId} -> ${linkName}`);
    } catch (e) {
      logger.warn(`[SessionStorageLinks] Failed to symlink db for agent ${agentId}: ${e.message}`);
    }
  }

  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    if (!expectedLinks.has(ent.name)) {
      const full = path.join(sessionDir, ent.name);
      try {
        await fs.unlink(full);
        logger.debug(`[SessionStorageLinks] Removed stale link: ${ent.name}`);
      } catch (e) {
        logger.warn(`[SessionStorageLinks] Could not remove ${ent.name}: ${e.message}`);
      }
    }
  }
}

module.exports = {
  syncSessionStorageLinks,
  SESSIONS_STORAGE_DIR,
};
