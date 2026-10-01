/**
 * Chat-window uploads. Types the document pipeline accepts become session
 * documents. Every other type is written to the orchestrator's working folder
 * under Uploads and recorded as a context message assigned to the orchestrator.
 */

const path = require('path');
const fs = require('fs').promises;
const Document = require('../../models/Document');
const DocumentProcessor = require('../documents/DocumentProcessor');
const DocumentService = require('../documents/DocumentService');
const SessionService = require('../sessions/SessionService');
const Message = require('../../models/Message');
const AutoSaveService = require('../sessions/AutoSaveService');
const {
  getWorkspacePathForOrchestrator,
  resolveWorkspacePath,
} = require('../tools/localWorkingFolderTool');
const logger = require('../../utils/logger');

const UPLOADS_DIR = 'Uploads';

function fail(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / (1024 ** index);
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function mimeForExtension(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (!ext) return null;
  const match = Document.getSupportedFileTypes().find((type) => type.extension === ext);
  return match ? match.mimeType : null;
}

/**
 * Browser uploads often arrive as application/octet-stream or with an empty
 * type. Prefer a supported MIME the extension maps to.
 */
function effectiveMime(file) {
  const declared = String(file.mimetype || '').toLowerCase();
  if (DocumentProcessor.isSupported(declared)) return declared;
  return mimeForExtension(file.originalname);
}

function safeFileName(original) {
  const base = path.basename(String(original || '')).replace(/[\u0000-\u001f]/g, '_').trim();
  if (!base || base === '.' || base === '..') return 'upload';
  return base;
}

async function writeOrchestratorUpload(sessionId, file) {
  const workspace = await getWorkspacePathForOrchestrator(sessionId);
  if (!workspace) {
    throw fail(
      `This file type is not a session document, so it would be saved in the orchestrator working folder (${UPLOADS_DIR}), but local_working_folder is not configured for the orchestrator. Set a folder name in Configure Session > Tools, then upload the file again.`,
      400,
      'WORKING_FOLDER_DISABLED'
    );
  }

  await fs.mkdir(resolveWorkspacePath(UPLOADS_DIR, workspace), { recursive: true });

  const safeName = safeFileName(file.originalname);
  const extension = path.extname(safeName);
  const stem = extension ? safeName.slice(0, -extension.length) : safeName;
  let filename = safeName;
  let absolutePath;
  for (let n = 2; ; n += 1) {
    absolutePath = resolveWorkspacePath(path.join(UPLOADS_DIR, filename), workspace);
    try {
      await fs.access(absolutePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      break;
    }
    if (n > 1000) {
      throw fail('Too many files with the same name in Uploads.', 409, 'TOO_MANY_FILES');
    }
    filename = `${stem}_${n}${extension}`;
  }

  await fs.writeFile(absolutePath, file.buffer);
  return {
    filename,
    relativePath: `${UPLOADS_DIR}/${filename}`,
    bytes: file.buffer.length,
  };
}

class ChatUploadService {
  /**
   * @param {number} sessionId
   * @param {number} userId
   * @param {object} file - Multer memory file
   * @param {{ generateEmbeddings?: boolean }} [options]
   */
  static async save(sessionId, userId, file, options = {}) {
    if (!file || !file.buffer) {
      throw fail('No file uploaded', 400, 'NO_FILE');
    }
    if (file.size > DocumentProcessor.getMaxFileSize()) {
      throw fail(
        `File too large. Maximum size is ${DocumentProcessor.getMaxFileSize() / 1024 / 1024}MB`,
        413,
        'FILE_TOO_LARGE'
      );
    }

    let session;
    try {
      session = await SessionService.getSession(sessionId, userId);
    } catch (err) {
      if (err.message === 'Session not found' || err.message === 'Unauthorized access to session') {
        throw fail('Session not found or access denied', 404, 'SESSION_NOT_FOUND');
      }
      throw err;
    }

    const mime = effectiveMime(file);
    if (mime && DocumentProcessor.isSupported(mime)) {
      const result = await DocumentService.uploadDocument(session.user_id, {
        ...file,
        mimetype: mime,
      }, {
        generateEmbeddings: options.generateEmbeddings !== false,
      });
      return {
        kind: 'document',
        document: result.document,
        message: result.message,
      };
    }

    const saved = await writeOrchestratorUpload(sessionId, file);
    const sizeLabel = formatBytes(saved.bytes);
    const content = `Uploaded "${saved.filename}" (${sizeLabel}) to ${saved.relativePath} in the orchestrator working folder. Assigned to the orchestrator.`;
    const message = await Message.create({
      session_id: sessionId,
      role: 'user',
      content,
      metadata: {
        channel: 'chat_upload',
        filename: saved.filename,
        download_path: saved.relativePath,
      },
    });
    await AutoSaveService.autoSave(sessionId, 'message').catch(() => {});
    logger.info(`Chat upload saved to orchestrator workspace (session ${sessionId}): ${saved.relativePath}`);

    return {
      kind: 'workspace',
      filename: saved.filename,
      relativePath: saved.relativePath,
      bytes: saved.bytes,
      message: content,
      chatMessage: message,
    };
  }
}

module.exports = ChatUploadService;
module.exports.UPLOADS_DIR = UPLOADS_DIR;
