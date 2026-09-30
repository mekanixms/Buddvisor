/**
 * send_to_telegram
 * Uploads a workspace file or a session document to every Telegram chat linked
 * to the session. This is how an agent actually attaches a file; embedding it
 * as HTML or a base64 image only shows a fake card in the web chat.
 */

const fs = require('fs').promises;
const path = require('path');

const { toolRegistry } = require('./ToolRegistry');
const Document = require('../../models/Document');
const { matchDocuments } = require('./agentDocumentsTool');
const {
  getWorkspacePathForOrchestrator,
  getWorkspacePathForSessionAgent,
  resolveWorkspacePath,
} = require('./localWorkingFolderTool');
const TelegramService = require('../telegram/TelegramService');
const {
  formatBytes,
  mimeForFilename,
  normalizeMime,
  UPLOAD_LIMIT_BYTES,
} = require('../telegram/TelegramMedia');

const TOOL_NAME = 'send_to_telegram';
const MAX_FILES = 10;

function stripDecorations(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

function toFileList(value) {
  if (Array.isArray(value)) return value.map(stripDecorations).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [stripDecorations(value)];
  return [];
}

async function accessibleDocuments(sessionId, agentId) {
  if (agentId != null && await Document.hasAgentAssignments(sessionId)) {
    return Document.getBySessionAndAgent(sessionId, agentId);
  }
  return Document.getBySession(sessionId);
}

async function fileFromWorkspace(workspace, raw) {
  const normalized = raw.replace(/^\.\//, '');
  const relatives = [normalized];
  if (!normalized.includes('/') && !normalized.includes('\\')) {
    relatives.push(`assigned_documents/${normalized}`, `TelegramDownloads/${normalized}`);
  }

  let traversal = null;
  for (const relative of relatives) {
    let absolute;
    try {
      absolute = resolveWorkspacePath(relative, workspace);
    } catch (err) {
      traversal = err.message;
      continue;
    }

    let stat;
    try {
      stat = await fs.stat(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > UPLOAD_LIMIT_BYTES) {
      return {
        error: `"${path.basename(absolute)}" is ${formatBytes(stat.size)}, above the ${formatBytes(UPLOAD_LIMIT_BYTES)} Telegram limit.`,
      };
    }
    return {
      file: {
        buffer: await fs.readFile(absolute),
        filename: path.basename(absolute),
        mimeType: mimeForFilename(absolute),
      },
    };
  }

  if (traversal && relatives.length === 1) return { error: traversal };
  return null;
}

async function fileFromDocument(doc) {
  let stat;
  try {
    stat = await fs.stat(doc.file_path);
  } catch {
    return { error: `"${doc.filename}" is in the session but the file is missing on disk.` };
  }
  if (stat.size > UPLOAD_LIMIT_BYTES) {
    return {
      error: `"${doc.filename}" is ${formatBytes(stat.size)}, above the ${formatBytes(UPLOAD_LIMIT_BYTES)} Telegram limit.`,
    };
  }
  let mimeType = normalizeMime(doc.file_type);
  if (!mimeType || mimeType === 'application/octet-stream') mimeType = mimeForFilename(doc.filename);
  return {
    file: {
      buffer: await fs.readFile(doc.file_path),
      filename: doc.filename,
      mimeType,
    },
  };
}

async function deliver(sessionId, file, caption) {
  const result = await TelegramService.sendFileToLinkedChats(sessionId, {
    ...file,
    caption: caption || file.filename,
  });
  if (!result.success) {
    return { success: false, filename: file.filename, error: result.error || 'Telegram did not accept the file.' };
  }
  const chats = result.chats_sent;
  return {
    success: true,
    filename: file.filename,
    bytes: file.buffer.length,
    chats_sent: chats,
    method: result.method,
    message: `Sent "${file.filename}" to ${chats} linked Telegram chat${chats === 1 ? '' : 's'}.`,
  };
}

async function resolveAndSend(sessionId, agentId, raw, caption) {
  const name = stripDecorations(raw);
  if (!name) return { success: false, error: 'Provide a file path or document filename.' };

  const workspace = agentId != null
    ? await getWorkspacePathForSessionAgent(Number(sessionId), Number(agentId))
    : await getWorkspacePathForOrchestrator(Number(sessionId));

  if (workspace && !/[*?]/.test(name)) {
    const found = await fileFromWorkspace(workspace, name);
    if (found && found.error) return { success: false, error: found.error };
    if (found && found.file) return deliver(sessionId, found.file, caption);
  }

  const docs = await accessibleDocuments(sessionId, agentId);
  const { matches, ambiguous } = matchDocuments(name, docs);
  if (ambiguous) {
    return {
      success: false,
      error: `Several documents match "${name}": ${matches.map((doc) => doc.filename).join(', ')}. Use the exact filename.`,
    };
  }
  if (matches.length === 0) {
    return {
      success: false,
      error: `Could not find "${name}" in the working folder or in the session documents you can access.`,
    };
  }

  const limited = matches.slice(0, MAX_FILES);
  const sent = [];
  const errors = [];
  for (const doc of limited) {
    const loaded = await fileFromDocument(doc);
    if (loaded.error) {
      errors.push(loaded.error);
      continue;
    }
    const result = await deliver(sessionId, loaded.file, limited.length === 1 ? caption : null);
    if (result.success) sent.push(result);
    else errors.push(result.error);
  }

  if (sent.length === 0) {
    return { success: false, error: errors[0] || `Could not send "${name}".` };
  }

  return {
    success: true,
    sent: sent.map(({ filename, bytes, chats_sent, method, message }) => ({
      filename, bytes, chats_sent, method, message,
    })),
    not_sent: errors,
    omitted: matches.length > limited.length ? matches.slice(MAX_FILES).map((doc) => doc.filename) : [],
    message: sent.map((item) => item.message).join(' '),
  };
}

function registerTelegramSendTool() {
  toolRegistry.register({
    name: TOOL_NAME,
    description: 'Send a file to every Telegram chat linked to this session. Use this whenever the user asks to upload, send, or attach a file, image, audio, or video to Telegram. Pass a workspace-relative path (for example assigned_documents/report.pdf or TelegramDownloads/audio_20260101_120000.ogg) or a session document filename. This delivers the actual file. Do not embed the file in your reply as HTML, a base64 data-URI image, or a card that only says the file is attached.',
    category: 'session',
    parameters: {
      file: {
        type: 'string',
        required: true,
        description: 'Workspace-relative path or session document filename (wildcards * and ? match session documents).',
      },
      caption: {
        type: 'string',
        description: 'Optional caption shown with the file in Telegram (max 1024 characters). For a single file; ignored when several files match.',
      },
    },
    handler: async (params, context = {}) => {
      if (!context.sessionId) {
        return { success: false, error: 'No session is available for this request.' };
      }
      const names = toFileList(params && params.file);
      if (names.length === 0) {
        return { success: false, error: 'Provide a file path or document filename in "file".' };
      }
      const caption = params && params.caption ? String(params.caption).slice(0, 1024) : '';
      if (names.length === 1) {
        return resolveAndSend(context.sessionId, context.agentId != null ? context.agentId : null, names[0], caption);
      }

      const sent = [];
      const errors = [];
      for (const name of names.slice(0, MAX_FILES)) {
        const result = await resolveAndSend(
          context.sessionId,
          context.agentId != null ? context.agentId : null,
          name,
          ''
        );
        if (result.success) sent.push(result.message || result.filename);
        else errors.push(result.error);
      }
      if (sent.length === 0) return { success: false, error: errors[0] || 'Could not send the files.' };
      return { success: true, message: sent.join(' '), not_sent: errors };
    },
    examples: [
      { description: 'Send a session document to the linked Telegram chats', parameters: { file: 'trigRatios.jpeg' } },
      { description: 'Send a file from the working folder with a caption', parameters: { file: 'assigned_documents/report.pdf', caption: 'The report you asked for' } },
    ],
  });
}

module.exports = {
  registerTelegramSendTool,
  TOOL_NAME,
};
