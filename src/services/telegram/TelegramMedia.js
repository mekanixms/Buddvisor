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
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.zip': 'application/zip',
  '.svg': 'image/svg+xml',
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
      prefix: 'audio', defaultExt: '.ogg', defaultMime: 'audio/ogg',
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

function mimeForFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
}

const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const UPLOAD_LIMIT_BYTES = 50 * 1024 * 1024;
const PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;

/**
 * Bot API method for an outbound file. Images that Telegram can show inline go
 * out as photos; everything else keeps its filename as a document, video, or audio.
 */
function telegramUploadMethod(mimeType, size) {
  const mime = normalizeMime(mimeType);
  const bytes = Number(size) || 0;
  if (PHOTO_TYPES.has(mime) && bytes > 0 && bytes <= PHOTO_LIMIT_BYTES) {
    return { method: 'sendPhoto', field: 'photo' };
  }
  if (mime.startsWith('video/') && bytes <= UPLOAD_LIMIT_BYTES) {
    return { method: 'sendVideo', field: 'video' };
  }
  if ((mime.startsWith('audio/') || mime === 'application/ogg') && bytes <= UPLOAD_LIMIT_BYTES) {
    return { method: 'sendAudio', field: 'audio' };
  }
  return { method: 'sendDocument', field: 'document' };
}

const DATA_URI_RE = /data:([a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+);base64,([A-Za-z0-9+/=\r\n]+)/g;
const MIN_EMBEDDED_BYTES = 32;

function filenameBefore(before) {
  const headings = [...before.matchAll(/<h[1-6][^>]*>\s*([^<]{1,120}?)\s*<\/h[1-6]>/gi)];
  if (headings.length > 0) {
    const name = sanitizeFilename(headings[headings.length - 1][1]);
    if (name && path.extname(name)) return name;
  }
  const matches = before.match(/[A-Za-z0-9][\w .()-]{0,80}\.[A-Za-z0-9]{2,8}/g);
  if (!matches) return null;
  const name = sanitizeFilename(matches[matches.length - 1].trim());
  if (!name || !path.extname(name)) return null;
  return name;
}

function uniqueFilename(name, used) {
  const key = name.toLowerCase();
  if (!used.has(key)) {
    used.add(key);
    return name;
  }
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  let n = 2;
  let candidate = `${stem}_${n}${ext}`;
  while (used.has(candidate.toLowerCase())) {
    n += 1;
    candidate = `${stem}_${n}${ext}`;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Pull embedded data-URI files out of assistant text (the HTML "attached" card
 * an agent writes when it has no way to upload). Returns the text with those
 * payloads removed, plus the decoded files.
 */
function pullDataUris(text, used) {
  const files = [];
  let changed = false;
  let out = '';
  let last = 0;
  const re = new RegExp(DATA_URI_RE.source, 'g');
  let match = re.exec(text);
  while (match) {
    const cleaned = match[2].replace(/\s/g, '');
    out += text.slice(last, match.index);
    last = match.index + match[0].length;

    const invalid = cleaned.length < 16 || cleaned.length % 4 === 1;
    const buffer = invalid ? null : Buffer.from(cleaned, 'base64');
    if (!buffer || buffer.length < MIN_EMBEDDED_BYTES) {
      out += match[0];
    } else {
      changed = true;
      const mimeType = normalizeMime(match[1]) || 'application/octet-stream';
      const hinted = filenameBefore(text.slice(Math.max(0, match.index - 2000), match.index));
      const fallback = `file${EXTENSION_BY_MIME[mimeType] || ''}` || 'file';
      const filename = uniqueFilename(hinted || fallback, used);
      if (buffer.length > UPLOAD_LIMIT_BYTES) {
        out += `[${filename} is too large to send on Telegram]`;
      } else {
        files.push({ filename, mimeType, buffer });
      }
    }
    match = re.exec(text);
  }
  out += text.slice(last);
  return { text: out, files, changed };
}

function stripTags(text) {
  return String(text || '').replace(/<[^>]+>/g, ' ');
}

function cardCaptionOnly(text, files) {
  let rest = String(text || '');
  for (const file of files) {
    const escaped = file.filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rest = rest.replace(new RegExp(escaped, 'ig'), '');
  }
  rest = rest.replace(/rendered directly from assigned session storage\.?/ig, '');
  return rest.replace(/\s+/g, '') === '';
}

function extractOutboundMedia(content) {
  const used = new Set();
  const files = [];
  let text = String(content == null ? '' : content);

  text = text.replace(/```(?:html|iframe)[^\n]*\r?\n?([\s\S]*?)```/gi, (full, inner) => {
    const pulled = pullDataUris(inner, used);
    if (!pulled.changed) return full;
    files.push(...pulled.files);
    if (pulled.files.length === 0) return stripTags(pulled.text).trim();
    return '';
  });

  const rest = pullDataUris(text, used);
  files.push(...rest.files);
  text = rest.text;

  if (files.length > 0 || rest.changed) {
    const sentNames = new Set(files.map((file) => file.filename.toLowerCase()));
    text = stripTags(text)
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^rendered directly from assigned session storage\.?$/i.test(line))
      .filter((line) => !sentNames.has(line.toLowerCase()))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (files.length > 0 && cardCaptionOnly(text, files)) text = '';
  } else {
    text = text.trim();
  }

  return { text, files };
}

module.exports = {
  extractAttachment,
  extractOutboundMedia,
  normalizeMime,
  sanitizeFilename,
  formatBytes,
  mimeForFilename,
  telegramUploadMethod,
  MIME_BY_EXTENSION,
  UPLOAD_LIMIT_BYTES,
};
