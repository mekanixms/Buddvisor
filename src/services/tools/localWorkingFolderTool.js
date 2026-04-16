/**
 * Local Working Folder Tool
 * Allows agents to interact with a local working folder assigned per agent per session
 */

const { toolRegistry } = require('./ToolRegistry');
const logger = require('../../utils/logger');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');

// Ensure storage directory exists
const STORAGE_DIR = path.join(process.cwd(), 'storage', 'agents-workspaces');

/** Subfolder inside workspace where symlinks to assigned documents are created */
const ASSIGNED_DOCUMENTS_DIR = 'assigned_documents';

/** File extensions for document types the agent can work on (read or process_media) */
const ASSIGNED_DOC_LINK_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'csv', 'json', 'md',
  'mp3', 'wav', 'm4a', 'mp4', 'mov', 'webm',
]);

async function ensureStorageDir() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (error) {
    logger.error('Error creating storage directory:', error);
    throw error;
  }
}

/**
 * Get workspace path for a given folder name.
 * By default, workspaces are randomized (hashed) per session+agent to ensure isolation.
 * If randomizeName is false, the workspace is the exact folder under storage/agents-workspaces/,
 * enabling shared folders across agents.
 * @param {string} folderName - User-provided folder name
 * @param {number} sessionId - Session ID
 * @param {number|null} agentId - Agent ID (or null for orchestrator)
 * @param {boolean} randomizeName - Whether to randomize workspace folder name (default: true)
 * @returns {string} - Full path to workspace directory
 */
function getWorkspacePath(folderName, sessionId, agentId, randomizeName = true) {
  const raw = String(folderName || '').trim();
  if (!raw) {
    throw new Error('folderName is required');
  }

  // Shared mode: user controls the folder name under STORAGE_DIR.
  if (randomizeName === false) {
    // Allow nested paths but keep them strictly inside STORAGE_DIR.
    // Disallow absolute paths and any traversal.
    if (path.isAbsolute(raw)) {
      throw new Error('Folder name must be a relative path under storage/agents-workspaces');
    }
    const normalized = path.normalize(raw).replace(/^[./\\]+/, ''); // remove leading ./ or slashes
    if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.includes(`..${path.sep}`)) {
      throw new Error('Invalid folder name: path traversal is not allowed');
    }
    const resolved = path.resolve(STORAGE_DIR, normalized);
    const root = path.resolve(STORAGE_DIR);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error('Invalid folder name: resolves outside storage/agents-workspaces');
    }
    return resolved;
  }

  // Randomized mode: unique per session+agent.
  const entityId = agentId !== null && agentId !== undefined ? agentId : 'orchestrator';
  const uniqueId = crypto
    .createHash('sha256')
    .update(`${sessionId}-${entityId}-${raw}`)
    .digest('hex')
    .substring(0, 16);

  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
  const dirName = `${sanitized}_${uniqueId}`;
  return path.resolve(STORAGE_DIR, dirName);
}

/**
 * Get workspace path and ensure it exists
 * @param {object} context - Execution context (sessionId, agentId, toolConfig)
 * @returns {string} - Full path to workspace directory
 */
function getWorkspace(context) {
  const { sessionId } = context;
  const agentId = context.agentId !== undefined ? context.agentId : null;
  
  if (!sessionId) {
    throw new Error('sessionId is required in context');
  }

  const toolConfig = context.toolConfig || {};
  const folderName = toolConfig?.folder_name;
  const randomizeName = toolConfig?.randomize_name !== false;

  if (!folderName || typeof folderName !== 'string' || folderName.trim() === '') {
    const entity = agentId !== null ? 'agent' : 'orchestrator';
    throw new Error(`Folder name not configured for this ${entity}. Please configure the folder name in Session Settings → Tools.`);
  }

  const workspacePath = getWorkspacePath(folderName.trim(), sessionId, agentId, randomizeName);
  
  // Ensure workspace directory exists
  if (!fsSync.existsSync(workspacePath)) {
    fsSync.mkdirSync(workspacePath, { recursive: true });
    logger.info(`[local_working_folder] Created workspace: ${workspacePath}`);
  }

  return workspacePath;
}

/**
 * Resolve a path relative to the workspace and validate it stays within workspace
 * @param {string} relativePath - Path relative to workspace (e.g., './data/file.txt' or 'data/file.txt')
 * @param {string} workspacePath - Absolute path to workspace
 * @returns {string} - Resolved absolute path
 */
function resolveWorkspacePath(relativePath, workspacePath) {
  if (!relativePath || typeof relativePath !== 'string') {
    throw new Error('Path must be a non-empty string');
  }

  // Normalize the relative path (handle './', '../', etc.)
  const normalized = path.normalize(relativePath);
  
  // Remove leading './' or '.' if present
  let cleanPath = normalized.replace(/^\.\//, '').replace(/^\.$/, '');
  if (cleanPath === '') cleanPath = '.';
  
  // Resolve to absolute path
  const resolved = path.resolve(workspacePath, cleanPath);
  
  // Ensure the resolved path is within the workspace (prevent directory traversal)
  const workspaceReal = path.resolve(workspacePath);
  const resolvedReal = path.resolve(resolved);
  
  if (!resolvedReal.startsWith(workspaceReal + path.sep) && resolvedReal !== workspaceReal) {
    throw new Error(`Path traversal detected: ${relativePath} resolves outside workspace`);
  }
  
  return resolvedReal;
}

/**
 * Get file stats or null if doesn't exist
 */
async function getFileStats(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return {
      exists: true,
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      size: stats.size,
      mode: stats.mode.toString(8).slice(-3), // Last 3 digits for permissions
      modifiedTime: stats.mtime.toISOString(),
    };
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { exists: false };
    }
    throw error;
  }
}

/**
 * Register Local Working Folder tool
 */
function registerLocalWorkingFolderTool() {
  toolRegistry.register({
    name: 'local_working_folder',
    description: 'Manage files and directories in a local working folder assigned to this agent. Supports creating, editing, deleting files, listing directories, and managing permissions. All paths are relative to the agent\'s workspace folder.',
    category: 'filesystem',
    parameters: {
      operation: {
        type: 'string',
        description: 'Operation to perform',
        required: true,
        enum: [
          'create_file',
          'edit_file',
          'delete_file',
          'chmod',
          'list_dir',
          'mkdir',
          'read_file',
          'pwd',
          'cd',
          'exists',
        ],
      },
      path: {
        type: 'string',
        description: 'File or directory path (relative to workspace, e.g., "./data/file.txt" or "logs/app.log")',
        required: false,
      },
      content: {
        type: 'string',
        description: 'File content (text or base64-encoded for binary files)',
        required: false,
      },
      mode: {
        type: 'string',
        description: 'File permissions mode (e.g., "644", "755") or file creation mode',
        required: false,
      },
      overwrite: {
        type: 'boolean',
        description: 'Whether to overwrite existing file when creating (default: false)',
        required: false,
      },
      edit_mode: {
        type: 'string',
        description: 'Edit mode: "append" to append content, "overwrite" to replace, or "insert" to insert at offset',
        required: false,
        enum: ['append', 'overwrite', 'insert'],
      },
      offset: {
        type: 'number',
        description: 'Byte offset for insert operation (default: 0)',
        required: false,
        minimum: 0,
      },
      recursive: {
        type: 'boolean',
        description: 'Whether to delete directories recursively (default: false)',
        required: false,
      },
      dry_run: {
        type: 'boolean',
        description: 'If true, show what would be deleted without actually deleting (default: false)',
        required: false,
      },
      details: {
        type: 'string',
        description: 'Level of detail for list_dir: "basic" (filenames only) or "full" (with size, permissions, etc.)',
        required: false,
        enum: ['basic', 'full'],
      },
      max_size: {
        type: 'number',
        description: 'Maximum file size to read in bytes (default: 1024, max: 10485760 for 10MB)',
        required: false,
        minimum: 1,
        maximum: 10485760,
      },
      new_path: {
        type: 'string',
        description: 'New path for cd operation (relative to workspace)',
        required: false,
      },
    },
    handler: async (params, context) => {
      const { operation } = params;
      
      if (!context.sessionId) {
        throw new Error('sessionId is required in context');
      }

      // Get tool config from database
      // Check orchestrator tools if agentId is not present, otherwise check agent tools
      const { dbAll } = require('../../../config/database');
      let toolAssignments;
      
      if (!context.agentId) {
        // Orchestrator tool config
        toolAssignments = await dbAll(
          `SELECT tool_config FROM session_orchestrator_tools 
           WHERE session_id = ? AND tool_name = ?`,
          [context.sessionId, 'local_working_folder']
        );
      } else {
        // Agent tool config
        toolAssignments = await dbAll(
          `SELECT tool_config FROM session_agent_tools 
           WHERE session_id = ? AND agent_id = ? AND tool_name = ?`,
          [context.sessionId, context.agentId, 'local_working_folder']
        );
      }

      if (!toolAssignments || toolAssignments.length === 0) {
        const entity = context.agentId ? 'agent' : 'orchestrator';
        throw new Error(`local_working_folder tool is not configured for this ${entity}. Please configure it in Session Settings → Tools.`);
      }

      let toolConfig = toolAssignments[0].tool_config;
      if (typeof toolConfig === 'string') {
        try {
          toolConfig = JSON.parse(toolConfig);
        } catch (e) {
          throw new Error('Invalid tool configuration. Please reconfigure the folder name in Session Settings → Tools.');
        }
      }

      if (!toolConfig || !toolConfig.folder_name || toolConfig.folder_name.trim() === '') {
        const entity = context.agentId ? 'agent' : 'orchestrator';
        throw new Error(`Folder name not configured for this ${entity}. Please configure the folder name in Session Settings → Tools.`);
      }

      // Add toolConfig to context
      context.toolConfig = toolConfig;

      await ensureStorageDir();
      const workspacePath = getWorkspace(context);

      switch (operation) {
        case 'create_file':
          return await handleCreateFile(workspacePath, params);
        case 'edit_file':
          return await handleEditFile(workspacePath, params);
        case 'delete_file':
          return await handleDeleteFile(workspacePath, params);
        case 'chmod':
          return await handleChmod(workspacePath, params);
        case 'list_dir':
          return await handleListDir(workspacePath, params);
        case 'mkdir':
          return await handleMkdir(workspacePath, params);
        case 'read_file':
          return await handleReadFile(workspacePath, params);
        case 'pwd':
          return await handlePwd(workspacePath);
        case 'cd':
          return await handleCd(workspacePath, params);
        case 'exists':
          return await handleExists(workspacePath, params);
        default:
          throw new Error(`Unknown operation: ${operation}`);
      }
    },
    examples: [
      {
        description: 'Create a new CSV file with data',
        parameters: {
          operation: 'create_file',
          path: './data/temps.csv',
          content: 'timestamp,temperature\n2024-01-01,25.5\n2024-01-02,26.0',
          overwrite: false,
        },
      },
      {
        description: 'List files in a directory',
        parameters: {
          operation: 'list_dir',
          path: './data',
          details: 'full',
        },
      },
      {
        description: 'Read a file',
        parameters: {
          operation: 'read_file',
          path: './data/temps.csv',
          max_size: 10485760,
        },
      },
    ],
  });
}

/**
 * Handle create_file operation
 */
async function handleCreateFile(workspacePath, params) {
  const { path: filePath, content, overwrite = false, mode = '644' } = params;

  if (!filePath) {
    throw new Error('path parameter is required for create_file');
  }
  if (content === undefined || content === null) {
    throw new Error('content parameter is required for create_file');
  }

  const resolvedPath = resolveWorkspacePath(filePath, workspacePath);
  const stats = await getFileStats(resolvedPath);

  if (stats.exists && !overwrite) {
    throw new Error(`File already exists: ${filePath}. Use overwrite=true to replace it.`);
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(resolvedPath);
  if (!fsSync.existsSync(parentDir)) {
    await fs.mkdir(parentDir, { recursive: true });
  }

  // Determine if content is base64
  let fileContent;
  let isBinary = false;
  if (typeof content === 'string' && content.match(/^[A-Za-z0-9+/=]+$/)) {
    // Might be base64, but we'll treat all strings as text unless explicitly marked
    // For now, assume text content
    fileContent = content;
  } else {
    fileContent = content;
  }

  // Write file
  await fs.writeFile(resolvedPath, fileContent, { encoding: 'utf8', mode: parseInt(mode, 8) });

  const newStats = await getFileStats(resolvedPath);
  return {
    success: true,
    path: filePath,
    absolute_path: resolvedPath,
    created: !stats.exists,
    overwritten: stats.exists && overwrite,
    size: newStats.size,
    mode: newStats.mode,
  };
}

/**
 * Handle edit_file operation
 */
async function handleEditFile(workspacePath, params) {
  const { path: filePath, content, edit_mode = 'append', offset = 0 } = params;

  if (!filePath) {
    throw new Error('path parameter is required for edit_file');
  }
  if (content === undefined || content === null) {
    throw new Error('content parameter is required for edit_file');
  }

  const resolvedPath = resolveWorkspacePath(filePath, workspacePath);
  const stats = await getFileStats(resolvedPath);

  if (!stats.exists) {
    throw new Error(`File does not exist: ${filePath}. Use create_file to create new files.`);
  }
  if (!stats.isFile) {
    throw new Error(`Path is not a file: ${filePath}`);
  }

  let newContent;
  if (edit_mode === 'overwrite') {
    newContent = content;
  } else if (edit_mode === 'append') {
    const existingContent = await fs.readFile(resolvedPath, 'utf8');
    newContent = existingContent + content;
  } else if (edit_mode === 'insert') {
    const existingContent = await fs.readFile(resolvedPath, 'utf8');
    const before = existingContent.slice(0, offset);
    const after = existingContent.slice(offset);
    newContent = before + content + after;
  } else {
    throw new Error(`Invalid edit_mode: ${edit_mode}. Must be 'append', 'overwrite', or 'insert'`);
  }

  await fs.writeFile(resolvedPath, newContent, 'utf8');
  const newStats = await getFileStats(resolvedPath);

  return {
    success: true,
    path: filePath,
    edit_mode,
    offset: edit_mode === 'insert' ? offset : undefined,
    new_size: newStats.size,
    previous_size: stats.size,
  };
}

/**
 * Handle delete_file operation
 */
async function handleDeleteFile(workspacePath, params) {
  const { path: filePath, recursive = false, dry_run = false } = params;

  if (!filePath) {
    throw new Error('path parameter is required for delete_file');
  }

  const resolvedPath = resolveWorkspacePath(filePath, workspacePath);
  const stats = await getFileStats(resolvedPath);

  if (!stats.exists) {
    return {
      success: true,
      path: filePath,
      deleted: false,
      message: 'File or directory does not exist',
    };
  }

  if (dry_run) {
    // Calculate what would be deleted
    const toDelete = [];
    if (stats.isDirectory) {
      if (recursive) {
        // Walk directory tree
        async function walkDir(dir) {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            toDelete.push(fullPath);
            if (entry.isDirectory()) {
              await walkDir(fullPath);
            }
          }
        }
        await walkDir(resolvedPath);
        toDelete.push(resolvedPath); // Add the directory itself
      } else {
        toDelete.push(resolvedPath);
      }
    } else {
      toDelete.push(resolvedPath);
    }

    return {
      success: true,
      path: filePath,
      dry_run: true,
      would_delete: toDelete.map(p => path.relative(workspacePath, p)),
      count: toDelete.length,
    };
  }

  // Actually delete
  if (stats.isDirectory) {
    if (recursive) {
      await fs.rm(resolvedPath, { recursive: true, force: true });
    } else {
      await fs.rmdir(resolvedPath);
    }
  } else {
    await fs.unlink(resolvedPath);
  }

  return {
    success: true,
    path: filePath,
    deleted: true,
    was_directory: stats.isDirectory,
    recursive: stats.isDirectory ? recursive : undefined,
  };
}

/**
 * Handle chmod operation
 */
async function handleChmod(workspacePath, params) {
  const { path: filePath, mode } = params;

  if (!filePath) {
    throw new Error('path parameter is required for chmod');
  }
  if (!mode) {
    throw new Error('mode parameter is required for chmod');
  }

  const resolvedPath = resolveWorkspacePath(filePath, workspacePath);
  const stats = await getFileStats(resolvedPath);

  if (!stats.exists) {
    throw new Error(`File or directory does not exist: ${filePath}`);
  }

  const modeNum = parseInt(mode, 8);
  if (isNaN(modeNum) || modeNum < 0 || modeNum > 0o777) {
    throw new Error(`Invalid mode: ${mode}. Must be an octal number (e.g., "644", "755")`);
  }

  await fs.chmod(resolvedPath, modeNum);
  const newStats = await getFileStats(resolvedPath);

  return {
    success: true,
    path: filePath,
    previous_mode: stats.mode,
    new_mode: newStats.mode,
  };
}

/**
 * Handle list_dir operation
 */
async function handleListDir(workspacePath, params) {
  const { path: dirPath = '.', details = 'basic' } = params;

  const resolvedPath = resolveWorkspacePath(dirPath, workspacePath);
  const stats = await getFileStats(resolvedPath);

  if (!stats.exists) {
    throw new Error(`Directory does not exist: ${dirPath}`);
  }
  if (!stats.isDirectory) {
    throw new Error(`Path is not a directory: ${dirPath}`);
  }

  const entries = await fs.readdir(resolvedPath, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const entryPath = path.join(resolvedPath, entry.name);
    const relativePath = path.relative(workspacePath, entryPath);

    if (details === 'basic') {
      results.push({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        path: relativePath,
      });
    } else {
      const entryStats = await getFileStats(entryPath);
      results.push({
        name: entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
        path: relativePath,
        size: entryStats.size,
        mode: entryStats.mode,
        modified_time: entryStats.modifiedTime,
      });
    }
  }

  // Sort by name
  results.sort((a, b) => a.name.localeCompare(b.name));

  return {
    success: true,
    path: dirPath,
    absolute_path: resolvedPath,
    entries: results,
    count: results.length,
  };
}

/**
 * Handle mkdir operation
 */
async function handleMkdir(workspacePath, params) {
  const { path: dirPath, mode = '755' } = params;

  if (!dirPath) {
    throw new Error('path parameter is required for mkdir');
  }

  const resolvedPath = resolveWorkspacePath(dirPath, workspacePath);
  const stats = await getFileStats(resolvedPath);

  if (stats.exists) {
    if (stats.isDirectory) {
      return {
        success: true,
        path: dirPath,
        created: false,
        message: 'Directory already exists',
      };
    } else {
      throw new Error(`Path exists but is not a directory: ${dirPath}`);
    }
  }

  const modeNum = parseInt(mode, 8);
  if (isNaN(modeNum) || modeNum < 0 || modeNum > 0o777) {
    throw new Error(`Invalid mode: ${mode}. Must be an octal number (e.g., "755")`);
  }

  await fs.mkdir(resolvedPath, { recursive: true, mode: modeNum });
  const newStats = await getFileStats(resolvedPath);

  return {
    success: true,
    path: dirPath,
    absolute_path: resolvedPath,
    created: true,
    mode: newStats.mode,
  };
}

/**
 * Handle read_file operation
 */
async function handleReadFile(workspacePath, params) {
  const { path: filePath, max_size = 10485760 } = params;

  if (!filePath) {
    throw new Error('path parameter is required for read_file');
  }

  const resolvedPath = resolveWorkspacePath(filePath, workspacePath);
  const stats = await getFileStats(resolvedPath);

  if (!stats.exists) {
    throw new Error(`File does not exist: ${filePath}`);
  }
  if (!stats.isFile) {
    throw new Error(`Path is not a file: ${filePath}`);
  }

  if (stats.size > max_size) {
    throw new Error(`File size (${stats.size} bytes) exceeds max_size (${max_size} bytes). Use a larger max_size or read in chunks.`);
  }

  const content = await fs.readFile(resolvedPath, 'utf8');

  return {
    success: true,
    path: filePath,
    absolute_path: resolvedPath,
    size: stats.size,
    content,
    truncated: false,
  };
}

/**
 * Handle pwd operation
 */
async function handlePwd(workspacePath) {
  return {
    success: true,
    workspace_path: workspacePath,
    relative_path: '.',
  };
}

/**
 * Handle cd operation (returns new path, but doesn't actually change state since tool is stateless)
 */
async function handleCd(workspacePath, params) {
  const { new_path = '.' } = params;

  const resolvedPath = resolveWorkspacePath(new_path, workspacePath);
  const stats = await getFileStats(resolvedPath);

  if (!stats.exists) {
    throw new Error(`Path does not exist: ${new_path}`);
  }
  if (!stats.isDirectory) {
    throw new Error(`Path is not a directory: ${new_path}`);
  }

  // Note: This tool is stateless, so we just return the path
  // The agent can use this path in subsequent operations
  return {
    success: true,
    path: new_path,
    absolute_path: resolvedPath,
    message: 'Note: This tool is stateless. Use the returned path in subsequent operations.',
  };
}

/**
 * Handle exists operation
 */
async function handleExists(workspacePath, params) {
  const { path: filePath } = params;

  if (!filePath) {
    throw new Error('path parameter is required for exists');
  }

  const resolvedPath = resolveWorkspacePath(filePath, workspacePath);
  const stats = await getFileStats(resolvedPath);

  return {
    success: true,
    path: filePath,
    exists: stats.exists,
    is_file: stats.isFile || false,
    is_directory: stats.isDirectory || false,
    size: stats.size,
    mode: stats.mode,
    modified_time: stats.modifiedTime,
  };
}

/**
 * Get workspace path for a session+agent if local_working_folder is configured.
 * Used by process_media for cache and by callers that need to list cache locations.
 * @param {number} sessionId - Session ID
 * @param {number} agentId - Agent ID
 * @returns {Promise<string|null>} - Absolute workspace path or null if not configured
 */
async function getWorkspacePathForSessionAgent(sessionId, agentId) {
  if (!Number.isFinite(sessionId) || !Number.isFinite(agentId)) return null;
  const { dbAll } = require('../../../config/database');
  const rows = await dbAll(
    `SELECT tool_config FROM session_agent_tools
     WHERE session_id = ? AND agent_id = ? AND tool_name = ?`,
    [sessionId, agentId, 'local_working_folder']
  );
  if (!rows || rows.length === 0) return null;
  let toolConfig = rows[0].tool_config;
  if (typeof toolConfig === 'string') {
    try {
      toolConfig = JSON.parse(toolConfig);
    } catch {
      return null;
    }
  }
  const folderName = toolConfig?.folder_name?.trim();
  if (!folderName) return null;
  const randomizeName = toolConfig?.randomize_name !== false;
  const workspacePath = getWorkspacePath(folderName, sessionId, agentId, randomizeName);
  if (!fsSync.existsSync(workspacePath)) {
    fsSync.mkdirSync(workspacePath, { recursive: true });
  }
  return workspacePath;
}

/**
 * Resolve workspace path for the orchestrator from session_orchestrator_tools.
 */
async function getWorkspacePathForOrchestrator(sessionId) {
  if (!Number.isFinite(sessionId)) return null;
  const { dbAll } = require('../../../config/database');
  const rows = await dbAll(
    `SELECT tool_config FROM session_orchestrator_tools
     WHERE session_id = ? AND tool_name = ?`,
    [sessionId, 'local_working_folder']
  );
  if (!rows || rows.length === 0) return null;
  let toolConfig = rows[0].tool_config;
  if (typeof toolConfig === 'string') {
    try { toolConfig = JSON.parse(toolConfig); } catch { return null; }
  }
  const folderName = toolConfig?.folder_name?.trim();
  if (!folderName) return null;
  const randomizeName = toolConfig?.randomize_name !== false;
  const workspacePath = getWorkspacePath(folderName, sessionId, null, randomizeName);
  if (!fsSync.existsSync(workspacePath)) {
    fsSync.mkdirSync(workspacePath, { recursive: true });
  }
  return workspacePath;
}

/**
 * Sync symlinks to assigned session documents into a workspace.
 * Works for both agents (agentId is a number) and the orchestrator (agentId is null).
 * @param {number} sessionId - Session ID
 * @param {number|null} agentId - Agent ID, or null for orchestrator
 * @returns {Promise<void>}
 */
async function syncAssignedDocumentsToWorkspace(sessionId, agentId) {
  if (!Number.isFinite(sessionId)) return;

  let workspacePath;
  if (agentId != null && Number.isFinite(agentId)) {
    workspacePath = await getWorkspacePathForSessionAgent(sessionId, agentId);
  } else {
    workspacePath = await getWorkspacePathForOrchestrator(sessionId);
  }
  if (!workspacePath) return;

  const Document = require('../../models/Document');
  const isOrchestrator = agentId == null || !Number.isFinite(agentId);
  let docs;
  if (isOrchestrator) {
    docs = await Document.getBySession(sessionId);
  } else {
    const hasPerAgent = await Document.hasAgentAssignments(sessionId);
    docs = hasPerAgent
      ? await Document.getBySessionAndAgent(sessionId, agentId)
      : await Document.getBySession(sessionId);
  }

  const linkDir = path.join(workspacePath, ASSIGNED_DOCUMENTS_DIR);
  await fs.mkdir(linkDir, { recursive: true });

  const allowed = docs.filter((d) => {
    const fp = d.file_path || d.filename || '';
    const ext = path.extname(fp).toLowerCase().slice(1);
    return ASSIGNED_DOC_LINK_EXTENSIONS.has(ext);
  });

  const targetResolved = (filePath) => path.resolve(process.cwd(), filePath || '');
  const usedNames = new Set();

  for (const doc of allowed) {
    const targetPath = targetResolved(doc.file_path);
    try {
      if (!fsSync.existsSync(targetPath)) continue;
    } catch {
      continue;
    }
    const ext = path.extname(doc.filename || doc.file_path || '');
    const base = path.basename(doc.filename || doc.file_path || '', ext) || `doc_${doc.id}`;
    let finalLinkName = `${base}${ext}`;
    if (usedNames.has(finalLinkName)) {
      finalLinkName = `${base}_${doc.id}${ext}`;
    }
    usedNames.add(finalLinkName);
    const finalLinkPath = path.join(linkDir, finalLinkName);

    try {
      const stat = await fs.lstat(finalLinkPath).catch(() => null);
      if (stat?.isSymbolicLink()) {
        const currentTarget = await fs.realpath(finalLinkPath).catch(() => '');
        if (currentTarget === targetPath) continue;
        await fs.unlink(finalLinkPath);
      } else if (stat) {
        await fs.unlink(finalLinkPath).catch(() => {});
      }
      await fs.symlink(targetPath, finalLinkPath);
      logger.debug(`[local_working_folder] Linked assigned doc: ${doc.filename} -> ${finalLinkName}`);
    } catch (err) {
      logger.warn(`[local_working_folder] Failed to symlink ${doc.filename}: ${err.message}`);
    }
  }

  const currentTargets = new Set(allowed.map((d) => targetResolved(d.file_path)));
  let entries = [];
  try {
    entries = await fs.readdir(linkDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (!ent.isSymbolicLink()) continue;
    const full = path.join(linkDir, ent.name);
    try {
      const real = await fs.realpath(full);
      if (!currentTargets.has(real)) {
        await fs.unlink(full);
        logger.debug(`[local_working_folder] Removed stale link: ${ent.name}`);
      }
    } catch {
      try {
        await fs.unlink(full);
      } catch {}
    }
  }
}

module.exports = {
  registerLocalWorkingFolderTool,
  getWorkspacePath,
  getWorkspace,
  resolveWorkspacePath,
  getWorkspacePathForSessionAgent,
  getWorkspacePathForOrchestrator,
  syncAssignedDocumentsToWorkspace,
};
