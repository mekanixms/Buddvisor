/**
 * Session storage symlinks: for each session, maintain a folder under storage/sessions/<name_id>/
 * containing symlinks to each assigned agent's (and the orchestrator's) local_working_folder
 * workspace and sqlite_local_db file.
 * Links are created/updated when the user sets local working folder path or sqlite db name;
 * links are removed when agents are removed from the session or tools are disabled.
 * On session rename, <newName>_<id> is a directory symlink to the original folder so the
 * explorer keeps seeing the same files.
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
/** Orchestrator workspace / db link names (not numeric, so they cannot collide with agent ids). */
const ORCHESTRATOR_WORKSPACE_LINK = 'workspace_orchestrator';
const ORCHESTRATOR_DB_LINK = 'orchestrator.db';

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
 * @param {string|object|null} raw
 * @returns {object|null}
 */
function parseToolConfig(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * True if the name is a managed index symlink (workspace_* / *.db created by this module).
 * @param {string} name
 * @returns {boolean}
 */
function isManagedLinkName(name) {
  if (!name || typeof name !== 'string') return false;
  if (name === ORCHESTRATOR_WORKSPACE_LINK || name === ORCHESTRATOR_DB_LINK) return true;
  if (name.startsWith(WORKSPACE_LINK_PREFIX)) {
    return /^\d+$/.test(name.slice(WORKSPACE_LINK_PREFIX.length));
  }
  if (name.endsWith(DB_LINK_SUFFIX)) {
    return /^\d+$/.test(name.slice(0, -DB_LINK_SUFFIX.length));
  }
  return false;
}

/**
 * Absolute path of the session storage folder for the given session row
 * (current sanitized name + id). After a rename this path may be a
 * directory symlink to the original folder.
 * @param {{ id: number, name?: string }} session
 * @returns {string}
 */
function getSessionStorageDir(session) {
  const safeName = sanitizeSessionName(session?.name);
  return path.join(SESSIONS_STORAGE_DIR, `${safeName}_${session.id}`);
}

function sessionDirSuffix(sessionId) {
  return `_${sessionId}`;
}

/**
 * True if dir contains nothing except managed workspace/db index links (or is empty).
 * @param {string} dirPath
 * @returns {Promise<boolean>}
 */
async function dirHasOnlyManagedLinks(dirPath) {
  const ents = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => null);
  if (!ents) return false;
  return ents.every((e) => isManagedLinkName(e.name));
}

/**
 * Find the original real session folder (not a rename alias) under storage/sessions.
 * @param {number} sessionId
 * @returns {Promise<string|null>}
 */
async function findCanonicalSessionStorageDir(sessionId) {
  if (!Number.isFinite(sessionId)) return null;
  if (!fsSync.existsSync(SESSIONS_STORAGE_DIR)) return null;
  const suffix = sessionDirSuffix(sessionId);
  const entries = await fs.readdir(SESSIONS_STORAGE_DIR, { withFileTypes: true }).catch(() => []);
  const realDirs = [];
  for (const ent of entries) {
    if (!ent.name.endsWith(suffix)) continue;
    const full = path.join(SESSIONS_STORAGE_DIR, ent.name);
    const lst = await fs.lstat(full).catch(() => null);
    if (lst && lst.isDirectory() && !lst.isSymbolicLink()) {
      realDirs.push(full);
    }
  }
  if (realDirs.length === 0) return null;
  if (realDirs.length === 1) return realDirs[0];
  realDirs.sort();
  return realDirs[0];
}

/**
 * Make storage/sessions/<currentName>_<id> a real folder or a dir symlink to the
 * original folder created before any rename. Avoids empty duplicate folders on rename.
 * @param {{ id: number, name?: string }} session
 * @returns {Promise<string>} current-name path (dir or symlink)
 */
async function ensureCurrentNamePointsAtOriginal(session) {
  const expected = getSessionStorageDir(session);
  await fs.mkdir(SESSIONS_STORAGE_DIR, { recursive: true });

  const canonical = await findCanonicalSessionStorageDir(session.id);
  const expectedStat = await fs.lstat(expected).catch(() => null);

  if (!canonical) {
    if (!expectedStat) {
      await fs.mkdir(expected, { recursive: true });
    }
    return expected;
  }

  if (path.resolve(canonical) === path.resolve(expected)) {
    return expected;
  }

  const linkToOriginal = async () => {
    await fs.symlink(canonical, expected, 'dir');
    logger.info(
      `[SessionStorageLinks] Aliased ${path.basename(expected)} -> ${path.basename(canonical)}`
    );
  };

  if (!expectedStat) {
    await linkToOriginal();
    return expected;
  }

  if (expectedStat.isSymbolicLink()) {
    const current = await fs.realpath(expected).catch(() => '');
    if (!current || path.resolve(current) !== path.resolve(canonical)) {
      await fs.unlink(expected);
      await linkToOriginal();
    }
    return expected;
  }

  // Legacy: sync already mkdir'd a real folder at the new name. If it only
  // holds managed index links, replace it with an alias to the original.
  if (expectedStat.isDirectory() && (await dirHasOnlyManagedLinks(expected))) {
    await fs.rm(expected, { recursive: true, force: true });
    await linkToOriginal();
    return expected;
  }

  logger.warn(
    `[SessionStorageLinks] ${path.basename(expected)} is a real folder with extra files; ` +
      `leaving it in place instead of aliasing to ${path.basename(canonical)}`
  );
  return expected;
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
  return (rows || []).map((row) => ({
    agent_id: row.agent_id,
    tool_name: row.tool_name,
    tool_config: parseToolConfig(row.tool_config),
  }));
}

async function getOrchestratorToolAssignments(sessionId) {
  const rows = await dbAll(
    `SELECT tool_name, tool_config FROM session_orchestrator_tools WHERE session_id = ?`,
    [sessionId]
  );
  return (rows || []).map((row) => ({
    tool_name: row.tool_name,
    tool_config: parseToolConfig(row.tool_config),
  }));
}

function hasFolderName(toolConfig) {
  return !!(toolConfig?.folder_name && String(toolConfig.folder_name).trim());
}

function hasDatabaseName(toolConfig) {
  return !!(toolConfig?.database_name && String(toolConfig.database_name).trim());
}

/**
 * True if any session agent or the orchestrator has local_working_folder with a folder name.
 * @param {number} sessionId
 * @returns {Promise<boolean>}
 */
async function sessionHasLocalWorkingFolder(sessionId) {
  if (!Number.isFinite(sessionId)) return false;
  const [agentRows, orchRows] = await Promise.all([
    dbAll(
      `SELECT tool_config FROM session_agent_tools WHERE session_id = ? AND tool_name = ?`,
      [sessionId, 'local_working_folder']
    ),
    dbAll(
      `SELECT tool_config FROM session_orchestrator_tools WHERE session_id = ? AND tool_name = ?`,
      [sessionId, 'local_working_folder']
    ),
  ]);
  const any = (rows) => (rows || []).some((r) => hasFolderName(parseToolConfig(r.tool_config)));
  return any(agentRows) || any(orchRows);
}

/**
 * Known real workspace directories and sqlite files this session's index may point at.
 * Used by the file explorer sandbox after following symlinks.
 * @param {number} sessionId
 * @returns {Promise<{ workspaces: string[], dbFiles: string[] }>}
 */
async function getSessionStorageTargets(sessionId) {
  const workspaces = [];
  const dbFiles = [];
  if (!Number.isFinite(sessionId)) return { workspaces, dbFiles };

  const session = await WorkSession.findById(sessionId);
  if (!session) return { workspaces, dbFiles };

  const agents = await WorkSession.getAgents(sessionId);
  const agentIds = new Set((agents || []).map((a) => a.id));
  const assignments = await getSessionToolAssignments(sessionId);
  for (const a of assignments) {
    if (!agentIds.has(a.agent_id)) continue;
    if (a.tool_name === 'local_working_folder' && hasFolderName(a.tool_config)) {
      const folderName = String(a.tool_config.folder_name).trim();
      const randomizeName = a.tool_config.randomize_name !== false;
      workspaces.push(getWorkspacePath(folderName, sessionId, Number(a.agent_id), randomizeName));
    }
    if (a.tool_name === 'sqlite_local_db' && hasDatabaseName(a.tool_config)) {
      dbFiles.push(getDatabasePath(String(a.tool_config.database_name).trim(), sessionId, Number(a.agent_id)));
    }
  }

  const orch = await getOrchestratorToolAssignments(sessionId);
  for (const a of orch) {
    if (a.tool_name === 'local_working_folder' && hasFolderName(a.tool_config)) {
      const folderName = String(a.tool_config.folder_name).trim();
      const randomizeName = a.tool_config.randomize_name !== false;
      workspaces.push(getWorkspacePath(folderName, sessionId, null, randomizeName));
    }
    if (a.tool_name === 'sqlite_local_db' && hasDatabaseName(a.tool_config)) {
      dbFiles.push(getDatabasePath(String(a.tool_config.database_name).trim(), sessionId, null));
    }
  }

  return { workspaces, dbFiles };
}

/**
 * Create or replace a symlink if the target differs.
 * @param {string} linkPath
 * @param {string} targetPath
 * @param {'dir'|null} type
 */
async function ensureSymlink(linkPath, targetPath, type = null) {
  const stat = await fs.lstat(linkPath).catch(() => null);
  if (stat?.isSymbolicLink()) {
    const current = await fs.realpath(linkPath).catch(() => '');
    if (current && path.resolve(current) === path.resolve(targetPath)) return;
    await fs.unlink(linkPath);
  } else if (stat) {
    await fs.unlink(linkPath).catch(() => {});
  }
  if (type) {
    await fs.symlink(targetPath, linkPath, type);
  } else {
    await fs.symlink(targetPath, linkPath);
  }
}

/**
 * Sync the session's storage folder: create storage/sessions/<safeName>_<sessionId>/ and
 * symlink each assigned agent's and the orchestrator's working folder and sqlite db.
 * Remove stale managed symlinks only (user-created files at root are left alone).
 * @param {number} sessionId - Session ID
 * @returns {Promise<void>}
 */
async function syncSessionStorageLinks(sessionId) {
  if (!Number.isFinite(sessionId)) return;

  const session = await WorkSession.findById(sessionId);
  if (!session) return;

  const agents = await WorkSession.getAgents(sessionId);
  const agentIds = new Set((agents || []).map((a) => a.id));

  const assignments = await getSessionToolAssignments(sessionId);
  const orchAssignments = await getOrchestratorToolAssignments(sessionId);

  const workspaceCfgByAgent = {};
  const dbByAgent = {};
  for (const a of assignments) {
    if (!agentIds.has(a.agent_id)) continue;
    if (a.tool_name === 'local_working_folder' && hasFolderName(a.tool_config)) {
      workspaceCfgByAgent[a.agent_id] = a.tool_config;
    }
    if (a.tool_name === 'sqlite_local_db' && hasDatabaseName(a.tool_config)) {
      dbByAgent[a.agent_id] = String(a.tool_config.database_name).trim();
    }
  }

  let orchWorkspaceCfg = null;
  let orchDbName = null;
  for (const a of orchAssignments) {
    if (a.tool_name === 'local_working_folder' && hasFolderName(a.tool_config)) {
      orchWorkspaceCfg = a.tool_config;
    }
    if (a.tool_name === 'sqlite_local_db' && hasDatabaseName(a.tool_config)) {
      orchDbName = String(a.tool_config.database_name).trim();
    }
  }

  const sessionDir = await ensureCurrentNamePointsAtOriginal(session);

  const expectedLinks = new Set();

  for (const agentId of Object.keys(workspaceCfgByAgent)) {
    const cfg = workspaceCfgByAgent[agentId] || {};
    const folderName = String(cfg.folder_name || '').trim();
    if (!folderName) continue;
    const randomizeName = cfg.randomize_name !== false;
    const workspacePath = getWorkspacePath(folderName, sessionId, Number(agentId), randomizeName);
    const linkName = `${WORKSPACE_LINK_PREFIX}${agentId}`;
    expectedLinks.add(linkName);
    try {
      if (!fsSync.existsSync(workspacePath)) {
        await fs.mkdir(workspacePath, { recursive: true });
      }
      await ensureSymlink(path.join(sessionDir, linkName), workspacePath, 'dir');
      logger.debug(`[SessionStorageLinks] Linked workspace ${agentId} -> ${linkName}`);
    } catch (e) {
      logger.warn(`[SessionStorageLinks] Failed to symlink workspace for agent ${agentId}: ${e.message}`);
    }
  }

  if (orchWorkspaceCfg) {
    const folderName = String(orchWorkspaceCfg.folder_name || '').trim();
    if (folderName) {
      const randomizeName = orchWorkspaceCfg.randomize_name !== false;
      const workspacePath = getWorkspacePath(folderName, sessionId, null, randomizeName);
      expectedLinks.add(ORCHESTRATOR_WORKSPACE_LINK);
      try {
        if (!fsSync.existsSync(workspacePath)) {
          await fs.mkdir(workspacePath, { recursive: true });
        }
        await ensureSymlink(path.join(sessionDir, ORCHESTRATOR_WORKSPACE_LINK), workspacePath, 'dir');
        logger.debug(`[SessionStorageLinks] Linked orchestrator workspace -> ${ORCHESTRATOR_WORKSPACE_LINK}`);
      } catch (e) {
        logger.warn(`[SessionStorageLinks] Failed to symlink orchestrator workspace: ${e.message}`);
      }
    }
  }

  for (const agentId of Object.keys(dbByAgent)) {
    const dbName = dbByAgent[agentId];
    const dbFilePath = getDatabasePath(dbName, sessionId, Number(agentId));
    const linkName = `${agentId}${DB_LINK_SUFFIX}`;
    expectedLinks.add(linkName);
    try {
      await ensureSymlink(path.join(sessionDir, linkName), dbFilePath);
      logger.debug(`[SessionStorageLinks] Linked db ${agentId} -> ${linkName}`);
    } catch (e) {
      logger.warn(`[SessionStorageLinks] Failed to symlink db for agent ${agentId}: ${e.message}`);
    }
  }

  if (orchDbName) {
    const dbFilePath = getDatabasePath(orchDbName, sessionId, null);
    expectedLinks.add(ORCHESTRATOR_DB_LINK);
    try {
      await ensureSymlink(path.join(sessionDir, ORCHESTRATOR_DB_LINK), dbFilePath);
      logger.debug(`[SessionStorageLinks] Linked orchestrator db -> ${ORCHESTRATOR_DB_LINK}`);
    } catch (e) {
      logger.warn(`[SessionStorageLinks] Failed to symlink orchestrator db: ${e.message}`);
    }
  }

  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  for (const ent of entries) {
    if (!isManagedLinkName(ent.name) || expectedLinks.has(ent.name)) continue;
    const full = path.join(sessionDir, ent.name);
    try {
      await fs.unlink(full);
      logger.debug(`[SessionStorageLinks] Removed stale link: ${ent.name}`);
    } catch (e) {
      logger.warn(`[SessionStorageLinks] Could not remove ${ent.name}: ${e.message}`);
    }
  }
}

/**
 * Sync links and return the session storage directory path.
 * @param {number} sessionId
 * @returns {Promise<string|null>}
 */
async function ensureSessionStorageDir(sessionId) {
  if (!Number.isFinite(sessionId)) return null;
  const session = await WorkSession.findById(sessionId);
  if (!session) return null;
  await syncSessionStorageLinks(sessionId);
  return getSessionStorageDir(session);
}

module.exports = {
  syncSessionStorageLinks,
  ensureSessionStorageDir,
  getSessionStorageDir,
  findCanonicalSessionStorageDir,
  sessionHasLocalWorkingFolder,
  getSessionStorageTargets,
  isManagedLinkName,
  sanitizeSessionName,
  SESSIONS_STORAGE_DIR,
  WORKSPACE_LINK_PREFIX,
  ORCHESTRATOR_WORKSPACE_LINK,
  ORCHESTRATOR_DB_LINK,
};
