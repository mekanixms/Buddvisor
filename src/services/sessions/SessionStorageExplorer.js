/**
 * Session storage file explorer: list / mkdir / upload / delete / view files
 * under storage/sessions/<name>_<id>/, following workspace and db symlinks
 * but never escaping the session root lexically or allowed realpath targets.
 */

const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const SessionService = require('./SessionService');
const {
  ensureSessionStorageDir,
  sessionHasLocalWorkingFolder,
  getSessionStorageTargets,
  isManagedLinkName,
} = require('./SessionStorageLinks');
const logger = require('../../utils/logger');

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const DOCUMENTS_DIR = path.resolve(process.cwd(), process.env.DOCUMENTS_PATH || './storage/documents');

const FORCE_TEXT_EXTS = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.svg']);

const MIME_BY_EXT = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.log': 'text/plain',
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.py': 'text/x-python',
  '.sql': 'text/plain',
  '.sh': 'text/plain',
};

class StorageExplorerError extends Error {
  constructor(message, statusCode = 400, code = 'STORAGE_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.name = 'StorageExplorerError';
  }
}

function isPathInside(resolved, root) {
  const r = path.resolve(root);
  const c = path.resolve(resolved);
  return c === r || c.startsWith(r + path.sep);
}

function toPosixRelative(rel) {
  if (!rel || rel === '.' || rel === '/') return '';
  return String(rel).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function isValidEntryName(name) {
  if (!name || typeof name !== 'string') return false;
  const n = name.trim();
  if (!n || n === '.' || n === '..') return false;
  if (/[/\\]/.test(n) || n.includes('\0')) return false;
  return true;
}

function sanitizeFileName(original) {
  const base = path.basename(String(original || '')).trim();
  if (!isValidEntryName(base)) {
    throw new StorageExplorerError('Invalid file name', 400, 'INVALID_NAME');
  }
  return base.replace(/[\x00-\x1f]/g, '_');
}

function mimeFor(filePath, { inline = false } = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (inline && FORCE_TEXT_EXTS.has(ext)) return 'text/plain; charset=utf-8';
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function isInlinePreviewable(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return false;
  if (FORCE_TEXT_EXTS.has(ext)) return true;
  return (
    mime.startsWith('text/') ||
    mime.startsWith('image/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    mime === 'application/json' ||
    mime === 'application/pdf' ||
    mime === 'application/xml'
  );
}

/**
 * Prepare session root for explorer operations.
 * @param {number} sessionId
 * @param {number} userId
 * @returns {Promise<{ session: object, sessionDir: string, targets: { workspaces: string[], dbFiles: string[] } }>}
 */
async function prepareSession(sessionId, userId) {
  const session = await SessionService.getSession(sessionId, userId);
  const enabled = await sessionHasLocalWorkingFolder(sessionId);
  if (!enabled) {
    throw new StorageExplorerError(
      'Working folder is not enabled for this session',
      404,
      'WORKING_FOLDER_DISABLED'
    );
  }
  const sessionDir = await ensureSessionStorageDir(sessionId);
  if (!sessionDir) {
    throw new StorageExplorerError('Session storage folder not found', 404, 'NOT_FOUND');
  }
  const targets = await getSessionStorageTargets(sessionId);
  const sessionRoots = [path.resolve(sessionDir)];
  try {
    sessionRoots.push(await fs.realpath(sessionDir));
  } catch {
    // dangling alias; lexical root still applies
  }
  targets.sessionRoots = [...new Set(sessionRoots)];
  return { session, sessionDir, targets };
}

/**
 * Lexical resolve of a client relative path against the session folder.
 * Does not follow symlinks for the containment check.
 */
function resolveLexical(sessionDir, relativePath) {
  const posix = toPosixRelative(relativePath);
  if (path.isAbsolute(posix) || posix.includes('\0')) {
    throw new StorageExplorerError('Invalid path', 400, 'INVALID_PATH');
  }
  const resolved = path.resolve(sessionDir, posix || '.');
  const root = path.resolve(sessionDir);
  if (!isPathInside(resolved, root)) {
    throw new StorageExplorerError(
      `Path traversal detected: ${relativePath || ''} resolves outside session folder`,
      400,
      'PATH_TRAVERSAL'
    );
  }
  return { abs: resolved, rel: posix };
}

function isProtectedRootEntry(relPosix) {
  if (!relPosix || relPosix.includes('/')) return false;
  return isManagedLinkName(relPosix);
}

/**
 * After lexical resolve, require that the real path (if it exists) stays in
 * the session dir, a known workspace, a known db file, or documents storage.
 */
async function assertRealPathAllowed(absPath, sessionDir, targets, { mustExist = false } = {}) {
  let real;
  try {
    real = await fs.realpath(absPath);
  } catch (err) {
    if (mustExist) {
      throw new StorageExplorerError('Path not found', 404, 'NOT_FOUND');
    }
    // Parent may exist (upload/mkdir into existing dir). Check parent if this path does not exist.
    const parent = path.dirname(absPath);
    if (parent === absPath) {
      throw new StorageExplorerError('Invalid path', 400, 'INVALID_PATH');
    }
    try {
      real = await fs.realpath(parent);
    } catch {
      throw new StorageExplorerError('Path not found', 404, 'NOT_FOUND');
    }
    if (!isAllowedReal(real, sessionDir, targets)) {
      throw new StorageExplorerError('Path is outside the allowed session storage area', 403, 'FORBIDDEN_PATH');
    }
    return { real: null, parentReal: real };
  }
  if (!isAllowedReal(real, sessionDir, targets)) {
    throw new StorageExplorerError('Path is outside the allowed session storage area', 403, 'FORBIDDEN_PATH');
  }
  return { real, parentReal: null };
}

function isAllowedReal(real, sessionDir, targets) {
  if (isPathInside(real, sessionDir)) return true;
  for (const root of targets.sessionRoots || []) {
    if (root && isPathInside(real, root)) return true;
  }
  if (isPathInside(real, DOCUMENTS_DIR)) return true;
  for (const ws of targets.workspaces || []) {
    if (ws && isPathInside(real, ws)) return true;
  }
  for (const db of targets.dbFiles || []) {
    if (db && path.resolve(db) === path.resolve(real)) return true;
  }
  return false;
}

async function resolveExisting(sessionDir, relativePath, targets, { mustExist = true } = {}) {
  const { abs, rel } = resolveLexical(sessionDir, relativePath);
  const check = await assertRealPathAllowed(abs, sessionDir, targets, { mustExist });
  return { abs, rel, real: check.real };
}

async function lstatSafe(abs) {
  try {
    return await fs.lstat(abs);
  } catch {
    return null;
  }
}

/**
 * List a directory under the session storage root.
 */
async function list(sessionId, userId, relativePath = '') {
  const { sessionDir, targets } = await prepareSession(sessionId, userId);
  const { abs, rel } = await resolveExisting(sessionDir, relativePath, targets, { mustExist: true });

  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    throw new StorageExplorerError('Path not found', 404, 'NOT_FOUND');
  }
  if (!st.isDirectory()) {
    throw new StorageExplorerError('Path is not a directory', 400, 'NOT_A_DIRECTORY');
  }

  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const ent of dirents) {
    const childAbs = path.join(abs, ent.name);
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    const lst = await lstatSafe(childAbs);
    let type = 'file';
    let size = lst?.size || 0;
    let mtime = lst?.mtimeMs ? new Date(lst.mtimeMs).toISOString() : null;
    let targetType = null;
    if (lst?.isSymbolicLink()) {
      type = 'symlink';
      try {
        const followed = await fs.stat(childAbs);
        targetType = followed.isDirectory() ? 'directory' : 'file';
        size = followed.size;
        mtime = followed.mtime ? followed.mtime.toISOString() : mtime;
      } catch {
        targetType = null;
      }
    } else if (lst?.isDirectory()) {
      type = 'directory';
    } else if (lst?.isFile()) {
      type = 'file';
    }
    entries.push({
      name: ent.name,
      path: childRel,
      type,
      target_type: targetType,
      size,
      mtime,
      protected: isProtectedRootEntry(childRel),
    });
  }

  entries.sort((a, b) => {
    const aDir = a.type === 'directory' || a.target_type === 'directory';
    const bDir = b.type === 'directory' || b.target_type === 'directory';
    if (aDir !== bDir) return aDir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    path: rel,
    entries,
  };
}

async function mkdir(sessionId, userId, relativeDir, name) {
  if (!isValidEntryName(name)) {
    throw new StorageExplorerError('Invalid folder name', 400, 'INVALID_NAME');
  }
  const folderName = name.trim();
  const { sessionDir, targets } = await prepareSession(sessionId, userId);
  const parent = toPosixRelative(relativeDir);
  const childRel = parent ? `${parent}/${folderName}` : folderName;
  if (isProtectedRootEntry(childRel)) {
    throw new StorageExplorerError('Cannot replace a managed session workspace link', 403, 'PROTECTED_PATH');
  }
  const { abs } = resolveLexical(sessionDir, childRel);
  await assertRealPathAllowed(abs, sessionDir, targets, { mustExist: false });
  const existing = await lstatSafe(abs);
  if (existing) {
    throw new StorageExplorerError('A file or folder with that name already exists', 409, 'ALREADY_EXISTS');
  }
  await fs.mkdir(abs);
  logger.info(`[SessionStorageExplorer] mkdir ${childRel} (session ${sessionId})`);
  return { path: childRel, name: folderName };
}

async function uploadFile(sessionId, userId, relativeDir, file) {
  if (!file) {
    throw new StorageExplorerError('No file uploaded', 400, 'NO_FILE');
  }
  const size = file.size != null ? file.size : (file.path && fsSync.existsSync(file.path) ? fsSync.statSync(file.path).size : 0);
  if (size > MAX_UPLOAD_BYTES) {
    if (file.path) await fs.unlink(file.path).catch(() => {});
    throw new StorageExplorerError(
      `File too large. Maximum size is ${MAX_UPLOAD_BYTES / 1024 / 1024}MB`,
      400,
      'FILE_TOO_LARGE'
    );
  }
  const destName = sanitizeFileName(file.originalname || file.filename || 'upload');
  const { sessionDir, targets } = await prepareSession(sessionId, userId);
  const parent = toPosixRelative(relativeDir);
  const childRel = parent ? `${parent}/${destName}` : destName;
  if (isProtectedRootEntry(childRel)) {
    if (file.path) await fs.unlink(file.path).catch(() => {});
    throw new StorageExplorerError('Cannot replace a managed session workspace link', 403, 'PROTECTED_PATH');
  }

  const { abs: parentAbs } = await resolveExisting(sessionDir, parent, targets, { mustExist: true });
  let parentSt;
  try {
    parentSt = await fs.stat(parentAbs);
  } catch {
    if (file.path) await fs.unlink(file.path).catch(() => {});
    throw new StorageExplorerError('Destination folder not found', 404, 'NOT_FOUND');
  }
  if (!parentSt.isDirectory()) {
    if (file.path) await fs.unlink(file.path).catch(() => {});
    throw new StorageExplorerError('Destination is not a folder', 400, 'NOT_A_DIRECTORY');
  }

  const destAbs = path.join(parentAbs, destName);
  const destLex = resolveLexical(sessionDir, childRel);
  await assertRealPathAllowed(destLex.abs, sessionDir, targets, { mustExist: false });

  const existing = await lstatSafe(destAbs);
  if (existing) {
    if (existing.isDirectory() || (existing.isSymbolicLink() && isProtectedRootEntry(childRel))) {
      if (file.path) await fs.unlink(file.path).catch(() => {});
      throw new StorageExplorerError('Cannot overwrite an existing folder or protected link', 409, 'ALREADY_EXISTS');
    }
    await fs.unlink(destAbs);
  }

  if (file.path) {
    try {
      await fs.copyFile(file.path, destAbs);
    } finally {
      await fs.unlink(file.path).catch(() => {});
    }
  } else if (file.buffer) {
    await fs.writeFile(destAbs, file.buffer);
  } else {
    throw new StorageExplorerError('No file uploaded', 400, 'NO_FILE');
  }

  logger.info(`[SessionStorageExplorer] upload ${childRel} (session ${sessionId})`);
  return { path: childRel, name: destName, size };
}

async function remove(sessionId, userId, relativePath) {
  const rel = toPosixRelative(relativePath);
  if (!rel) {
    throw new StorageExplorerError('Cannot delete the session folder root', 403, 'PROTECTED_PATH');
  }
  if (isProtectedRootEntry(rel)) {
    throw new StorageExplorerError('Cannot delete a managed session workspace link', 403, 'PROTECTED_PATH');
  }
  const { sessionDir, targets } = await prepareSession(sessionId, userId);
  const { abs } = resolveLexical(sessionDir, rel);
  const lst = await lstatSafe(abs);
  if (!lst) {
    throw new StorageExplorerError('Path not found', 404, 'NOT_FOUND');
  }
  // For delete, allow unlinking a symlink even if its target is dangling.
  if (lst.isSymbolicLink()) {
    await fs.unlink(abs);
  } else {
    await assertRealPathAllowed(abs, sessionDir, targets, { mustExist: true });
    if (lst.isDirectory()) {
      await fs.rm(abs, { recursive: true, force: true });
    } else {
      await fs.unlink(abs);
    }
  }
  logger.info(`[SessionStorageExplorer] delete ${rel} (session ${sessionId})`);
  return { path: rel };
}

/**
 * Resolve a file for view/download. Returns absolute path and response headers.
 */
async function getFile(sessionId, userId, relativePath) {
  const rel = toPosixRelative(relativePath);
  if (!rel) {
    throw new StorageExplorerError('Path is not a file', 400, 'NOT_A_FILE');
  }
  const { sessionDir, targets } = await prepareSession(sessionId, userId);
  const { abs } = await resolveExisting(sessionDir, rel, targets, { mustExist: true });
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    throw new StorageExplorerError('Path not found', 404, 'NOT_FOUND');
  }
  if (st.isDirectory()) {
    throw new StorageExplorerError('Path is not a file', 400, 'NOT_A_FILE');
  }
  return {
    abs,
    name: path.basename(abs),
    size: st.size,
    mimeInline: mimeFor(abs, { inline: true }),
    mimeDownload: mimeFor(abs, { inline: false }),
    previewable: isInlinePreviewable(abs),
  };
}

module.exports = {
  list,
  mkdir,
  uploadFile,
  remove,
  getFile,
  StorageExplorerError,
  MAX_UPLOAD_BYTES,
};
