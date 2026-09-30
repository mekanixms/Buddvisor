/**
 * Helpers that turn a Telegram message carrying media (photo, video, file, ...)
 * into a normalized attachment descriptor the document pipeline can ingest.
 */

const path = require('path');

const MIME_BY_EXTENSION = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

const MIME_ALIASES = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'text/x-markdown': 'text/markdown',
  'application/x-pdf': 'application/pdf',
};

const EXTENSION_BY_MIME = Object.entries(MIME_BY_EXTENSION).reduce((acc, [ext, mime]) => {
  if (!acc[mime] || ext.length < acc[mime].length) acc[mime] = ext;
  return acc;
}, {});
EXTENSION_BY_MIME['image/jpeg'] = '.jpg';
EXTENSION_BY_MIME['text/html'] = '.html';

const GENERIC_MIME = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

function normalizeMime(mime) {
  const value = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_ALIASES[value] || value;
}

function sanitizeFilename(name) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(name || '').replace(/[\\/\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
  if (cleaned.length <= 120) return cleaned;
  const ext = path.extname(cleaned);
  return cleaned.slice(0, 120 - ext.length) + ext;
}

function timestampLabel(unixSeconds) {
  const date = Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000) : new Date();
  return date.toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
}

function shortId(uniqueId) {
  return String(uniqueId || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
}

function generatedName(prefix, message, media, extension) {
  const parts = [prefix, timestampLabel(message.date)];
  const id = shortId(media.file_unique_id);
  if (id) parts.push(id);
  return `${parts.join('_')}${extension}`;
}

function resolveMime(declared, filename, fallback) {
  const mime = normalizeMime(declared);
  const byExtension = MIME_BY_EXTENSION[path.extname(filename || '').toLowerCase()];
  if (GENERIC_MIME.has(mime)) return byExtension || fallback || mime;
  return mime;
}

function ensureExtension(filename, mime) {
  if (path.extname(filename)) return filename;
  const extension = EXTENSION_BY_MIME[mime];
  return extension ? `${filename}${extension}` : filename;
}

function build(kind, message, media, { name, prefix, defaultExt, defaultMime }) {
  const provided = sanitizeFilename(name);
  const mime = resolveMime(media.mime_type, provided, defaultMime);
  const filename = provided
    ? ensureExtension(provided, mime)
    : generatedName(prefix, message, media, EXTENSION_BY_MIME[mime] || defaultExt || '');
  return {
    kind,
    fileId: media.file_id,
    fileSize: Number.isFinite(media.file_size) ? media.file_size : null,
    filename,
    mimeType: mime,
  };
}

/**
 * Describe the media in a Telegram message, or return null when there is none.
 * @returns {{kind:string,fileId:string,fileSize:number|null,filename:string,mimeType:string}|null}
 */
function extractAttachment(message) {
  if (!message || typeof message !== 'object') return null;

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const sizes = message.photo.filter((p) => p && p.file_id);
    if (sizes.length === 0) return null;
    const largest = sizes.reduce((best, p) => {
      const area = (p.width || 0) * (p.height || 0);
      const bestArea = (best.width || 0) * (best.height || 0);
      if (area !== bestArea) return area > bestArea ? p : best;
      return (p.file_size || 0) > (best.file_size || 0) ? p : best;
    });
    return build('photo', message, { ...largest, mime_type: 'image/jpeg' }, {
      prefix: 'photo', defaultExt: '.jpg', defaultMime: 'image/jpeg',
    });
  }

  if (message.document && message.document.file_id) {
    return build('document', message, message.document, {
      name: message.document.file_name, prefix: 'file', defaultExt: '',
    });
  }
  if (message.video && message.video.file_id) {
    return build('video', message, message.video, {
      name: message.video.file_name, prefix: 'video', defaultExt: '.mp4', defaultMime: 'video/mp4',
    });
  }
  if (message.animation && message.animation.file_id) {
    return build('animation', message, message.animation, {
      name: message.animation.file_name, prefix: 'animation', defaultExt: '.mp4', defaultMime: 'video/mp4',
    });
  }
  if (message.video_note && message.video_note.file_id) {
    return build('video_note', message, { ...message.video_note, mime_type: 'video/mp4' }, {
      prefix: 'video_note', defaultExt: '.mp4', defaultMime: 'video/mp4',
    });
  }
  if (message.audio && message.audio.file_id) {
    return build('audio', message, message.audio, {
      name: message.audio.file_name, prefix: 'audio', defaultExt: '.mp3', defaultMime: 'audio/mpeg',
    });
  }
  if (message.voice && message.voice.file_id) {
    return build('voice', message, message.voice, {
      prefix: 'voice', defaultExt: '.ogg', defaultMime: 'audio/ogg',
    });
  }
  return null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

module.exports = {
  extractAttachment,
  normalizeMime,
  sanitizeFilename,
  formatBytes,
  MIME_BY_EXTENSION,
};
