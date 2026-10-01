/**
 * TelegramService
 *
 * Connects a Telegram bot (one per session, token supplied by the session owner)
 * to the normal chat pipeline. Chats are linked with one-time deep-link codes
 * (https://t.me/<bot>?start=<code>), so a QR code or a tg:// link is enough.
 * Updates are received with long polling; no public HTTPS endpoint is needed.
 */

const axios = require('axios');
const crypto = require('crypto');
const FormData = require('form-data');
const QRCode = require('qrcode');

const WorkSession = require('../../models/WorkSession');
const SessionTelegram = require('../../models/SessionTelegram');
const { AppError } = require('../../middleware/errorHandler');
const { encrypt, decrypt } = require('../../utils/crypto');
const logger = require('../../utils/logger');
const messageEvents = require('../../utils/messageEvents');
const {
  extractAttachment,
  extractOutboundMedia,
  formatBytes,
  normalizeMime,
  telegramUploadMethod,
} = require('./TelegramMedia');

const TELEGRAM_DOWNLOADS_DIR = 'TelegramDownloads';

const MIRROR_ROLES = new Set(['user', 'assistant', 'system']);
const MIRROR_MAX_PENDING = 200;
const MAX_RETRY_AFTER_SECONDS = 30;

const API_BASE = () => process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const MESSAGE_LIMIT = 4096;
const TOKEN_PATTERN = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

const pairingTtlMs = () => {
  const minutes = parseInt(process.env.TELEGRAM_PAIRING_TTL_MINUTES, 10);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 10) * 60 * 1000;
};

const pollTimeoutSeconds = () => {
  const seconds = parseInt(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : 25;
};

// The public Bot API lets bots download files up to 20 MB (a self-hosted Bot API server allows more)
const maxDownloadBytes = () => {
  const megabytes = parseFloat(process.env.TELEGRAM_MAX_DOWNLOAD_MB);
  return (Number.isFinite(megabytes) && megabytes > 0 ? megabytes : 20) * 1024 * 1024;
};

const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

/**
 * Split text into chunks of at most `limit` characters, preferring paragraph,
 * line and word boundaries.
 */
function splitMessage(text, limit = MESSAGE_LIMIT) {
  const source = String(text == null ? '' : text);
  if (source.length <= limit) return [source];

  const chunks = [];
  let rest = source;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = window.lastIndexOf('\n\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf('\n');
    if (cut < limit * 0.5) cut = window.lastIndexOf(' ');
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

function describeError(err, token) {
  let message = String((err && err.message) || err || 'Unknown error');
  if (token) message = message.split(token).join('***');
  return message;
}

function botApiError(method, err, token) {
  const status = err && err.response && err.response.status;
  const description = err && err.response && err.response.data && err.response.data.description;
  const error = new Error(`Telegram ${method} failed: ${description || describeError(err, token)}`);
  error.status = status || null;
  const retryAfter = err && err.response && err.response.data && err.response.data.parameters
    && err.response.data.parameters.retry_after;
  error.retryAfter = Number.isFinite(retryAfter) ? retryAfter : null;
  error.cancelled = !!(err && (err.code === 'ERR_CANCELED' || err.name === 'CanceledError' || err.name === 'AbortError'));
  return error;
}

class TelegramPoller {
  constructor(sessionId, token, botUsername, lastUpdateId) {
    this.sessionId = sessionId;
    this.token = token;
    this.botUsername = botUsername;
    this.offset = (lastUpdateId || 0) + 1;
    this.running = false;
    this.abort = null;
    this.queue = Promise.resolve();
    this.backoffMs = 1000;
    this.sleepTimer = null;
    this.wake = null;
  }

  sleep(ms) {
    return new Promise((resolve) => {
      this.wake = resolve;
      this.sleepTimer = setTimeout(resolve, ms);
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.loop().catch((err) => {
      logger.error(`Telegram poller for session ${this.sessionId} crashed: ${describeError(err, this.token)}`);
      this.running = false;
    });
  }

  stop() {
    this.running = false;
    if (this.abort) this.abort.abort();
    if (this.sleepTimer) clearTimeout(this.sleepTimer);
    if (this.wake) this.wake();
  }

  async loop() {
    while (this.running) {
      try {
        const config = await SessionTelegram.getConfig(this.sessionId);
        if (!config || !config.enabled) {
          this.running = false;
          break;
        }

        this.abort = new AbortController();
        const timeout = pollTimeoutSeconds();
        const updates = await TelegramService.api(
          this.token,
          'getUpdates',
          { offset: this.offset, timeout, allowed_updates: ['message'] },
          { timeoutMs: (timeout + 10) * 1000, signal: this.abort.signal }
        );
        this.backoffMs = 1000;

        if (Array.isArray(updates) && updates.length > 0) {
          const lastId = updates.reduce((max, u) => Math.max(max, u.update_id), 0);
          this.offset = lastId + 1;
          await SessionTelegram.setLastUpdateId(this.sessionId, lastId);
          for (const update of updates) {
            if (update.message) this.enqueue(update.message);
          }
        }
      } catch (err) {
        if (!this.running || err.cancelled) break;

        if (err.status === 401) {
          logger.warn(`Telegram bot token for session ${this.sessionId} was rejected; disabling`);
          await SessionTelegram.setEnabled(
            this.sessionId,
            false,
            'Telegram rejected the bot token (it may have been revoked). Reconnect the bot.'
          ).catch(() => {});
          this.running = false;
          break;
        }

        if (err.status === 409) {
          await SessionTelegram.setLastError(
            this.sessionId,
            'Another process is polling this bot (or a webhook is set). Only one consumer per bot is allowed.'
          ).catch(() => {});
          this.backoffMs = Math.max(this.backoffMs, 30000);
        }

        logger.warn(`Telegram poll error (session ${this.sessionId}): ${err.message}`);
        await this.sleep(this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, 60000);
      }
    }
  }

  enqueue(message) {
    this.queue = this.queue
      .then(() => TelegramService.handleMessage(this, message))
      .catch((err) => {
        logger.error(`Telegram message handling failed (session ${this.sessionId}): ${describeError(err, this.token)}`);
      });
  }
}

class TelegramService {
  static pollers = new Map();

  static outbound = new Map();

  static listening = false;

  static splitMessage = splitMessage;

  /**
   * Call a Bot API method. Errors never contain the bot token.
   */
  static async api(token, method, params = {}, { timeoutMs = 20000, signal } = {}) {
    try {
      const res = await axios.post(`${API_BASE()}/bot${token}/${method}`, params, {
        timeout: timeoutMs,
        signal,
      });
      if (!res.data || res.data.ok !== true) {
        const error = new Error(`Telegram ${method} failed: ${(res.data && res.data.description) || 'unexpected response'}`);
        error.status = null;
        error.cancelled = false;
        throw error;
      }
      return res.data.result;
    } catch (err) {
      if (err && Object.prototype.hasOwnProperty.call(err, 'cancelled')) throw err;
      throw botApiError(method, err, token);
    }
  }

  /**
   * Upload a file to one chat. Images Telegram can display inline are sent as
   * photos; other types keep their filename as a document, video, or audio.
   */
  static async sendFile(token, chatId, file) {
    const attempt = async () => {
      const { method, field } = telegramUploadMethod(file.mimeType, file.buffer.length);
      // The form-data package, not the global FormData. On Node 18, append(blob, filename)
      // builds an experimental buffer.File and prints a warning. This package writes the
      // multipart body from the Buffer directly.
      const form = new FormData();
      form.append('chat_id', String(chatId));
      const caption = file.caption ? String(file.caption).slice(0, 1024) : '';
      if (caption) form.append('caption', caption);
      const filename = file.filename || 'file';
      const mimeType = normalizeMime(file.mimeType) || 'application/octet-stream';
      form.append(field, file.buffer, { filename, contentType: mimeType });
      try {
        const res = await axios.post(`${API_BASE()}/bot${token}/${method}`, form, {
          headers: form.getHeaders(),
          timeout: 120000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        });
        if (!res.data || res.data.ok !== true) {
          const error = new Error(`Telegram ${method} failed: ${(res.data && res.data.description) || 'unexpected response'}`);
          error.status = null;
          throw error;
        }
        return { method };
      } catch (err) {
        if (err && err.status !== undefined && String(err.message || '').startsWith('Telegram ')) throw err;
        throw botApiError(method, err, token);
      }
    };

    try {
      return await attempt();
    } catch (err) {
      if (err.status === 429 && err.retryAfter != null && err.retryAfter <= MAX_RETRY_AFTER_SECONDS) {
        await new Promise((resolve) => setTimeout(resolve, err.retryAfter * 1000));
        return attempt();
      }
      throw err;
    }
  }

  /**
   * Upload one file to every chat linked to the session.
   * A chat that blocked the bot is unlinked.
   */
  static async sendFileToLinkedChats(sessionId, file) {
    const poller = TelegramService.pollers.get(sessionId) || TelegramService.pollers.get(Number(sessionId));
    if (!poller) {
      return {
        success: false,
        error: 'Telegram is not connected for this session. Connect a bot in Configure Session → Telegram.',
      };
    }

    const chats = await SessionTelegram.listChats(sessionId);
    if (!chats || chats.length === 0) {
      return {
        success: false,
        error: 'No Telegram chat is linked to this session. Link one from Configure Session → Telegram.',
      };
    }

    const failed = [];
    let chatsSent = 0;
    let method = null;
    for (const chat of chats) {
      try {
        const sent = await TelegramService.sendFile(poller.token, chat.chat_id, file);
        chatsSent += 1;
        method = method || sent.method;
      } catch (err) {
        if (err.status === 403) {
          logger.info(`Telegram chat ${chat.chat_id} blocked the bot; unlinking it from session ${sessionId}`);
          await SessionTelegram.removeChatByChatId(sessionId, chat.chat_id).catch(() => {});
        } else {
          logger.warn(`Telegram file delivery to chat ${chat.chat_id} failed (session ${sessionId}): ${err.message}`);
        }
        failed.push({ chat_id: String(chat.chat_id), error: err.message });
      }
    }

    if (chatsSent === 0) {
      return {
        success: false,
        error: (failed[0] && failed[0].error) || 'No linked chat received the file.',
        filename: file.filename,
        failed,
      };
    }

    return {
      success: true,
      filename: file.filename,
      bytes: file.buffer.length,
      chats_sent: chatsSent,
      method,
      failed,
    };
  }

  static async sendText(token, chatId, text) {
    for (const chunk of splitMessage(text)) {
      const payload = { chat_id: chatId, text: chunk, disable_web_page_preview: true };
      try {
        await TelegramService.api(token, 'sendMessage', payload);
      } catch (err) {
        // Telegram rate limit: wait as told (bounded) and retry this chunk once
        if (err.status === 429 && err.retryAfter != null && err.retryAfter <= MAX_RETRY_AFTER_SECONDS) {
          await new Promise((resolve) => setTimeout(resolve, err.retryAfter * 1000));
          await TelegramService.api(token, 'sendMessage', payload);
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Download a file the user sent to the bot. Errors never contain the bot token.
   */
  static async downloadFile(token, fileId) {
    const info = await TelegramService.api(token, 'getFile', { file_id: fileId });
    if (!info || !info.file_path) {
      throw new Error('Telegram did not provide a download path for this file.');
    }
    const limit = maxDownloadBytes();
    try {
      const res = await axios.get(`${API_BASE()}/file/bot${token}/${info.file_path}`, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: limit,
        maxBodyLength: limit,
      });
      return Buffer.from(res.data);
    } catch (err) {
      throw botApiError('file download', err, token);
    }
  }

  /**
   * Store a downloaded attachment as a document of the session owner and add it to
   * the session. No per-agent assignment is created, so the file belongs to the
   * orchestrator until it (or the user) assigns it to an agent.
   */
  static async ingestAttachment(session, attachment, buffer) {
    const Document = require('../../models/Document');
    const DocumentService = require('../documents/DocumentService');
    const DuplicateDetector = require('../documents/DuplicateDetector');
    const path = require('path');

    const userId = session.user_id;
    const existing = await Document.findByContentHash(DuplicateDetector.calculateBufferHash(buffer));

    let document;
    let reused = false;
    if (existing) {
      // Content hashes are unique across the whole system, so another account's copy cannot be shared
      if (existing.user_id !== userId) {
        throw new Error('This file cannot be added because an identical file already exists.');
      }
      document = existing;
      reused = true;
    } else {
      const owned = await Document.findByUserId(userId);
      const taken = new Set(owned.map((d) => String(d.filename).toLowerCase()));
      const extension = path.extname(attachment.filename);
      const stem = extension ? attachment.filename.slice(0, -extension.length) : attachment.filename;
      let filename = attachment.filename;
      for (let n = 2; taken.has(filename.toLowerCase()); n += 1) {
        filename = `${stem}_${n}${extension}`;
      }

      const result = await DocumentService.uploadDocument(userId, {
        buffer,
        originalname: filename,
        mimetype: attachment.mimeType,
        size: buffer.length,
      });
      document = result.document;
    }

    const sessionDocuments = await Document.getBySession(session.id);
    const alreadyInSession = sessionDocuments.some((d) => d.id === document.id);
    if (!alreadyInSession) await WorkSession.assignDocument(session.id, document.id);

    return { document, reused, alreadyInSession };
  }

  /**
   * Start following chat messages. Every message stored in a session that has a
   * running Telegram poller is forwarded to that session's linked chats.
   */
  static listen() {
    if (TelegramService.listening) return;
    TelegramService.listening = true;
    messageEvents.on('created', TelegramService.onMessageCreated);
  }

  static onMessageCreated(message) {
    if (!message || !MIRROR_ROLES.has(message.role)) return;
    if (!TelegramService.pollers.has(message.session_id)) return;
    if (!message.content || !String(message.content).trim()) return;

    const sessionId = message.session_id;
    const entry = TelegramService.outbound.get(sessionId) || { chain: Promise.resolve(), pending: 0 };
    if (entry.pending >= MIRROR_MAX_PENDING) {
      logger.warn(`Telegram forwarding backlog full for session ${sessionId}; dropping a message`);
      return;
    }

    entry.pending += 1;
    // One queue per session keeps the prompt ahead of its reply
    entry.chain = entry.chain
      .then(() => TelegramService.deliverMessage(message))
      .catch((err) => logger.error(`Telegram forwarding failed (session ${sessionId}): ${describeError(err)}`))
      .then(() => {
        entry.pending -= 1;
        if (entry.pending === 0) TelegramService.outbound.delete(sessionId);
      });
    TelegramService.outbound.set(sessionId, entry);
  }

  static parseMetadata(message) {
    if (message.metadata && typeof message.metadata === 'object') return message.metadata;
    if (typeof message.metadata === 'string') {
      try {
        return JSON.parse(message.metadata) || {};
      } catch {
        return {};
      }
    }
    return {};
  }

  static formatForwardedText(message, meta) {
    const content = String(message.content).trim();
    if (message.role === 'assistant') {
      return message.agent_name ? `${message.agent_name}:\n${content}` : content;
    }
    if (message.role === 'system') return `System: ${content}`;

    let label;
    if (meta.channel === 'telegram') label = meta.telegram_username || 'Telegram';
    else if (meta.channel === 'scheduled') label = 'Scheduled job';
    else label = meta.username || 'User';
    return `${label}: ${content}`;
  }

  static async deliverMessage(message) {
    const sessionId = message.session_id;
    const poller = TelegramService.pollers.get(sessionId);
    if (!poller) return;

    const meta = TelegramService.parseMetadata(message);
    const originChatId = message.role === 'user' && meta.channel === 'telegram' && meta.telegram_chat_id != null
      ? String(meta.telegram_chat_id)
      : null;
    const raw = String(message.content).trim();
    const extracted = message.role === 'assistant'
      ? extractOutboundMedia(raw)
      : { text: raw, files: [] };
    const text = extracted.text
      ? TelegramService.formatForwardedText({ ...message, content: extracted.text }, meta)
      : '';

    const chats = await SessionTelegram.listChats(sessionId);
    for (const chat of chats) {
      // The chat that typed the message already has it on screen
      if (originChatId && String(chat.chat_id) === originChatId) continue;
      try {
        if (text) await TelegramService.sendText(poller.token, chat.chat_id, text);
        for (const file of extracted.files) {
          const caption = message.agent_name ? `${message.agent_name}: ${file.filename}` : file.filename;
          await TelegramService.sendFile(poller.token, chat.chat_id, { ...file, caption });
        }
      } catch (err) {
        if (err.status === 403) {
          logger.info(`Telegram chat ${chat.chat_id} blocked the bot; unlinking it from session ${sessionId}`);
          await SessionTelegram.removeChatByChatId(sessionId, chat.chat_id).catch(() => {});
        } else {
          logger.warn(`Telegram delivery to chat ${chat.chat_id} failed (session ${sessionId}): ${err.message}`);
        }
      }
    }
  }

  static async assertOwner(sessionId, userId) {
    const session = await WorkSession.findById(sessionId);
    if (!session || session.user_id !== userId) {
      throw new AppError('Session not found', 404, 'SESSION_NOT_FOUND');
    }
    return session;
  }

  static maskToken(config) {
    return `${config.bot_id}:••••••••`;
  }

  static async getStatus(sessionId, userId) {
    await TelegramService.assertOwner(sessionId, userId);
    const config = await SessionTelegram.getConfig(sessionId);
    if (!config) return { configured: false, chats: [] };

    const chats = await SessionTelegram.listChats(sessionId);
    return {
      configured: true,
      enabled: !!config.enabled,
      running: TelegramService.pollers.has(sessionId),
      bot_username: config.bot_username,
      token_masked: TelegramService.maskToken(config),
      last_error: config.last_error || null,
      chats,
    };
  }

  static async saveConfig(sessionId, userId, rawToken) {
    await TelegramService.assertOwner(sessionId, userId);

    const token = String(rawToken || '').trim();
    if (!TOKEN_PATTERN.test(token)) {
      throw new AppError('That does not look like a BotFather token (expected 123456789:AA...).', 400, 'INVALID_BOT_TOKEN');
    }

    let me;
    try {
      me = await TelegramService.api(token, 'getMe');
    } catch (err) {
      const message = err.status === 401 || err.status === 404
        ? 'Telegram rejected this token. Check it in BotFather.'
        : `Could not reach Telegram: ${err.message}`;
      throw new AppError(message, 400, 'TELEGRAM_VALIDATION_FAILED');
    }
    if (!me || !me.is_bot || !me.id) {
      throw new AppError('This token does not belong to a bot.', 400, 'INVALID_BOT_TOKEN');
    }

    const existing = await SessionTelegram.findConfigByBotId(me.id);
    if (existing && existing.session_id !== sessionId) {
      throw new AppError(
        'This bot is already connected to another session. A bot can serve only one session.',
        409,
        'BOT_ALREADY_IN_USE'
      );
    }

    TelegramService.stop(sessionId);

    try {
      await TelegramService.api(token, 'deleteWebhook', { drop_pending_updates: false });
    } catch (err) {
      throw new AppError(`Could not prepare the bot: ${err.message}`, 502, 'TELEGRAM_SETUP_FAILED');
    }

    const previous = await SessionTelegram.getConfig(sessionId);
    if (previous && String(previous.bot_id) !== String(me.id)) {
      await SessionTelegram.deleteConfig(sessionId);
    }

    await SessionTelegram.upsertConfig({
      session_id: sessionId,
      bot_token_encrypted: encrypt(token),
      bot_id: me.id,
      bot_username: me.username || null,
    });

    await TelegramService.start(sessionId);
    return TelegramService.getStatus(sessionId, userId);
  }

  static async disconnect(sessionId, userId) {
    await TelegramService.assertOwner(sessionId, userId);
    TelegramService.stop(sessionId);
    await SessionTelegram.deleteConfig(sessionId);
  }

  static async createPairing(sessionId, userId) {
    await TelegramService.assertOwner(sessionId, userId);
    const config = await SessionTelegram.getConfig(sessionId);
    if (!config || !config.bot_username) {
      throw new AppError('Connect a Telegram bot first.', 400, 'TELEGRAM_NOT_CONFIGURED');
    }
    if (!config.enabled) {
      throw new AppError('The Telegram bot is disabled. Reconnect it first.', 400, 'TELEGRAM_DISABLED');
    }

    const code = crypto.randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + pairingTtlMs()).toISOString();
    await SessionTelegram.createPairing(sessionId, hashCode(code), expiresAt);

    const link = `https://t.me/${config.bot_username}?start=${code}`;
    const deepLink = `tg://resolve?domain=${config.bot_username}&start=${code}`;
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 320, errorCorrectionLevel: 'M' });

    return { link, deepLink, qr, expiresAt, botUsername: config.bot_username };
  }

  static async revokeChat(sessionId, userId, id) {
    await TelegramService.assertOwner(sessionId, userId);
    const chats = await SessionTelegram.listChats(sessionId);
    const chat = chats.find((c) => c.id === id);
    if (!chat) throw new AppError('Linked chat not found', 404, 'TELEGRAM_CHAT_NOT_FOUND');

    await SessionTelegram.removeChatById(sessionId, id);

    const config = await SessionTelegram.getConfig(sessionId);
    if (config) {
      try {
        await TelegramService.sendText(
          decrypt(config.bot_token_encrypted),
          chat.chat_id,
          'This chat was unlinked from the session by its owner.'
        );
      } catch (err) {
        logger.debug(`Could not notify revoked Telegram chat: ${err.message}`);
      }
    }
  }

  static async start(sessionId) {
    TelegramService.stop(sessionId);
    const config = await SessionTelegram.getConfig(sessionId);
    if (!config || !config.enabled) return false;

    let token;
    try {
      token = decrypt(config.bot_token_encrypted);
    } catch (err) {
      logger.error(`Telegram token for session ${sessionId} cannot be decrypted: ${err.message}`);
      await SessionTelegram.setEnabled(sessionId, false, 'The stored bot token cannot be decrypted. Reconnect the bot.').catch(() => {});
      return false;
    }

    const poller = new TelegramPoller(sessionId, token, config.bot_username, config.last_update_id);
    TelegramService.pollers.set(sessionId, poller);
    poller.start();
    return true;
  }

  static stop(sessionId) {
    const poller = TelegramService.pollers.get(sessionId);
    if (poller) {
      poller.stop();
      TelegramService.pollers.delete(sessionId);
    }
  }

  static async startAll() {
    TelegramService.listen();
    try {
      const configs = await SessionTelegram.listEnabledConfigs();
      for (const config of configs) {
        await TelegramService.start(config.session_id);
      }
      if (configs.length > 0) logger.info(`Telegram pollers started: ${configs.length}`);
    } catch (err) {
      logger.error(`Telegram startAll failed: ${err.message}`);
    }
  }

  static stopAll() {
    for (const sessionId of Array.from(TelegramService.pollers.keys())) {
      TelegramService.stop(sessionId);
    }
  }

  /**
   * Handle one incoming Telegram message for a session.
   * `ctx` needs { sessionId, token }.
   */
  static async handleMessage(ctx, message) {
    const { sessionId, token } = ctx;
    const chat = message && message.chat;
    if (!chat) return;

    const reply = (text) => TelegramService.sendText(token, chat.id, text);

    if (chat.type !== 'private') {
      await reply('This bot only works in private chats.');
      return;
    }

    const session = await WorkSession.findById(sessionId);
    if (!session || !session.is_active) {
      TelegramService.stop(sessionId);
      return;
    }

    const from = message.from || {};
    const displayName = [from.first_name, from.last_name].filter(Boolean).join(' ') || chat.first_name || null;
    const text = typeof message.text === 'string' ? message.text.trim() : '';
    const linked = await SessionTelegram.findChat(sessionId, chat.id);

    const command = text.match(/^\/([A-Za-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);
    if (command) {
      const name = command[1].toLowerCase();
      const arg = (command[2] || '').trim();

      if (name === 'start') {
        if (arg) {
          const ok = await SessionTelegram.consumePairing(sessionId, hashCode(arg));
          if (!ok) {
            await reply('This link is invalid, expired, or already used. Generate a new one in Configure Session.');
            return;
          }
          await SessionTelegram.addChat({
            session_id: sessionId,
            chat_id: chat.id,
            telegram_user_id: from.id,
            username: from.username,
            display_name: displayName,
          });
          await reply(`Connected to session "${session.name}". Send a message to talk to it. /unlink disconnects this chat.`);
          return;
        }
        await reply(linked
          ? `Connected to session "${session.name}". Send a message to talk to it.`
          : 'This chat is not linked to a session. Scan the QR code in Configure Session > Telegram.');
        return;
      }

      if (!linked) {
        await reply('This chat is not linked to a session. Scan the QR code in Configure Session > Telegram.');
        return;
      }

      if (name === 'unlink') {
        await SessionTelegram.removeChatByChatId(sessionId, chat.id);
        await reply('This chat is no longer linked.');
        return;
      }
      if (name === 'status') {
        const agents = await WorkSession.getAgents(sessionId);
        await reply(`Session: ${session.name}\nAgents: ${(agents || []).length}`);
        return;
      }
      if (name === 'help') {
        await reply('Send any message to chat with the session.\nPhotos, videos and supported files are saved to the session documents (assigned to the orchestrator). Other files, including voice messages, are saved as files in the orchestrator working folder under TelegramDownloads. A caption is sent as your message.\nAsk the session to send a file and it is uploaded into this chat.\n/status shows the session\n/unlink disconnects this chat');
        return;
      }
      await reply('Unknown command. Send /help for the list.');
      return;
    }

    if (!linked) {
      await reply('This chat is not linked to a session. Scan the QR code in Configure Session > Telegram.');
      return;
    }

    const origin = {
      channel: 'telegram',
      telegram_username: linked.username || displayName || String(chat.id),
      telegram_chat_id: String(chat.id),
    };

    const attachment = extractAttachment(message);
    if (attachment) {
      const caption = typeof message.caption === 'string' ? message.caption.trim() : '';
      await SessionTelegram.touchChat(sessionId, chat.id);
      await TelegramService.handleAttachment(ctx, { session, chat, origin, reply }, attachment, caption);
      return;
    }

    if (!text) {
      await reply('Only text, photos, videos and files are supported.');
      return;
    }

    await SessionTelegram.touchChat(sessionId, chat.id);
    await TelegramService.runChat(ctx, { session, chat, origin, reply }, text);
  }

  /**
   * Write a file the document pipeline cannot index into the orchestrator's
   * working folder, under TelegramDownloads. Returns null when that folder
   * is not configured.
   */
  static async writeOrchestratorDownload(sessionId, attachment, buffer) {
    const fs = require('fs').promises;
    const path = require('path');
    const { getWorkspacePathForOrchestrator, resolveWorkspacePath } = require('../tools/localWorkingFolderTool');

    const workspace = await getWorkspacePathForOrchestrator(sessionId);
    if (!workspace) return null;

    await fs.mkdir(resolveWorkspacePath(TELEGRAM_DOWNLOADS_DIR, workspace), { recursive: true });

    const safeName = path.basename(attachment.filename || '') || 'file';
    const extension = path.extname(safeName);
    const stem = extension ? safeName.slice(0, -extension.length) : safeName;
    let filename = safeName;
    let absolutePath;
    for (let n = 2; ; n += 1) {
      absolutePath = resolveWorkspacePath(path.join(TELEGRAM_DOWNLOADS_DIR, filename), workspace);
      try {
        await fs.access(absolutePath);
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
        break;
      }
      if (n > 1000) throw new Error('Too many files with the same name in TelegramDownloads.');
      filename = `${stem}_${n}${extension}`;
    }

    await fs.writeFile(absolutePath, buffer);
    return {
      filename,
      relativePath: `${TELEGRAM_DOWNLOADS_DIR}/${filename}`,
      bytes: buffer.length,
    };
  }

  /**
   * Record an upload in the conversation. A caption is sent through the chat
   * pipeline; without one, only a context message is stored.
   */
  static async recordAttachment(ctx, { session, chat, origin, reply }, { caption, note, metadata, confirmation }) {
    const { sessionId } = ctx;
    await reply(confirmation).catch((err) => logger.warn(`Telegram confirmation failed (session ${sessionId}): ${err.message}`));

    if (caption) {
      await TelegramService.runChat(ctx, { session, chat, origin, reply }, `${caption}\n\n[Attached via Telegram: ${note}]`);
      return;
    }

    try {
      const Message = require('../../models/Message');
      await Message.create({
        session_id: sessionId,
        role: 'user',
        content: note,
        metadata: { ...origin, ...metadata },
      });
      await require('../sessions/AutoSaveService').autoSave(sessionId, 'message').catch(() => {});
    } catch (err) {
      logger.warn(`Could not record Telegram upload in session ${sessionId}: ${err.message}`);
    }
  }

  /**
   * Save a file the session document pipeline does not accept (zip, voice note, ...)
   * into TelegramDownloads in the orchestrator working folder.
   */
  static async saveUnsupportedAttachment(ctx, { session, chat, origin, reply }, attachment, caption) {
    const { sessionId, token } = ctx;
    const { getWorkspacePathForOrchestrator } = require('../tools/localWorkingFolderTool');

    const workspace = await getWorkspacePathForOrchestrator(sessionId);
    if (!workspace) {
      const what = attachment.kind === 'voice'
        ? 'Voice messages are saved as audio'
        : `"${attachment.filename}" is not a session-document type, so it would be saved as a file`;
      await reply(
        `${what} in the orchestrator working folder (${TELEGRAM_DOWNLOADS_DIR}), but local_working_folder is not configured for the orchestrator. Set a folder name in Configure Session > Tools, then send the file again.`
      );
      return;
    }

    TelegramService.api(token, 'sendChatAction', { chat_id: chat.id, action: 'upload_document' }).catch(() => {});

    let saved;
    try {
      const buffer = await TelegramService.downloadFile(token, attachment.fileId);
      const limit = maxDownloadBytes();
      if (buffer.length > limit) {
        await reply(`"${attachment.filename}" is ${formatBytes(buffer.length)}; the limit for Telegram uploads is ${formatBytes(limit)}.`);
        return;
      }
      saved = await TelegramService.writeOrchestratorDownload(sessionId, attachment, buffer);
    } catch (err) {
      logger.error(`Telegram file save failed (session ${sessionId}): ${describeError(err, token)}`);
      await reply(`Could not save "${attachment.filename}": ${String(describeError(err, token)).slice(0, 300)}`).catch(() => {});
      return;
    }

    if (!saved) {
      await reply(`Could not save "${attachment.filename}": the orchestrator working folder is not available.`);
      return;
    }

    const sizeLabel = formatBytes(saved.bytes);
    const confirmation = attachment.kind === 'voice'
      ? `Saved the voice message as audio in the orchestrator working folder: ${saved.relativePath} (${sizeLabel}).`
      : `Saved "${saved.filename}" (${sizeLabel}) in the orchestrator working folder: ${saved.relativePath}. This type is not added to the session documents.`;
    const note = attachment.kind === 'voice'
      ? `Voice message saved as audio at ${saved.relativePath} in the orchestrator working folder (${sizeLabel}).`
      : `Uploaded "${saved.filename}" (${sizeLabel}) via Telegram to ${saved.relativePath} in the orchestrator working folder.`;

    await TelegramService.recordAttachment(ctx, { session, chat, origin, reply }, {
      caption,
      note,
      confirmation,
      metadata: { filename: saved.filename, download_path: saved.relativePath },
    });
  }

  /**
   * Save a photo/video/file sent from Telegram into the session documents
   * (assigned to the orchestrator) and record it in the conversation.
   * Types the document pipeline cannot index are written to the orchestrator
   * working folder instead.
   */
  static async handleAttachment(ctx, { session, chat, origin, reply }, attachment, caption) {
    const { sessionId, token } = ctx;
    const DocumentProcessor = require('../documents/DocumentProcessor');

    const limit = Math.min(maxDownloadBytes(), DocumentProcessor.getMaxFileSize());
    if (attachment.fileSize != null && attachment.fileSize > limit) {
      await reply(`"${attachment.filename}" is ${formatBytes(attachment.fileSize)}; the limit for Telegram uploads is ${formatBytes(limit)}.`);
      return;
    }

    if (!DocumentProcessor.isSupported(attachment.mimeType)) {
      await TelegramService.saveUnsupportedAttachment(ctx, { session, chat, origin, reply }, attachment, caption);
      return;
    }

    TelegramService.api(token, 'sendChatAction', { chat_id: chat.id, action: 'upload_document' }).catch(() => {});

    let stored;
    let size;
    try {
      const buffer = await TelegramService.downloadFile(token, attachment.fileId);
      size = buffer.length;
      stored = await TelegramService.ingestAttachment(session, attachment, buffer);
    } catch (err) {
      logger.error(`Telegram attachment intake failed (session ${sessionId}): ${describeError(err, token)}`);
      await reply(`Could not save "${attachment.filename}": ${String(describeError(err, token)).slice(0, 300)}`).catch(() => {});
      return;
    }

    const { document, reused, alreadyInSession } = stored;
    const label = `"${document.filename}" (${formatBytes(size)})`;

    let confirmation;
    if (alreadyInSession) {
      confirmation = `${label} is already in this session's documents.`;
    } else if (reused) {
      confirmation = `${label} was already in your document library; added to this session and assigned to the orchestrator.`;
    } else {
      confirmation = `Saved ${label} to the session documents, assigned to the orchestrator.`;
    }
    confirmation += `\nTo give it to an agent, say: assign ${document.filename} to @AgentName`;

    const note = alreadyInSession
      ? `Sent ${label} via Telegram (already in the session documents).`
      : `Uploaded ${label} via Telegram. It is in the session documents, assigned to the orchestrator.`;

    await reply(confirmation).catch((err) => logger.warn(`Telegram confirmation failed (session ${sessionId}): ${err.message}`));

    if (caption) {
      await TelegramService.runChat(ctx, { session, chat, origin, reply }, `${caption}\n\n[Attached via Telegram: "${document.filename}" - ${note}]`);
      return;
    }

    try {
      const Message = require('../../models/Message');
      await Message.create({
        session_id: sessionId,
        role: 'user',
        content: note,
        metadata: { ...origin, document_id: document.id, filename: document.filename },
      });
      await require('../sessions/AutoSaveService').autoSave(sessionId, 'message').catch(() => {});
    } catch (err) {
      logger.warn(`Could not record Telegram upload in session ${sessionId}: ${err.message}`);
    }
  }

  /**
   * Run text from a linked Telegram chat through the normal chat pipeline.
   */
  static async runChat(ctx, { session, chat, origin, reply }, text) {
    const { sessionId, token } = ctx;

    const typing = () => TelegramService.api(token, 'sendChatAction', { chat_id: chat.id, action: 'typing' }).catch(() => {});
    typing();
    const typingTimer = setInterval(typing, 4000);

    try {
      const { ChatService } = require('../chat/ChatService');
      const AutoSaveService = require('../sessions/AutoSaveService');

      const result = await ChatService.processMessage(sessionId, session.user_id, text, {
        stream: false,
        metadataExtra: origin,
      });
      await AutoSaveService.autoSave(sessionId, 'message').catch(() => {});

      // The stored assistant message is forwarded to every linked chat (including
      // this one) by the message listener, so only an empty answer needs a reply here.
      const hasAnswer = result && typeof result.message === 'string' && result.message.trim();
      if (!hasAnswer) await reply('(no answer)');
    } catch (err) {
      logger.error(`Telegram chat processing failed (session ${sessionId}): ${describeError(err, token)}`);
      await reply(`Sorry, that failed: ${String(err.message || 'unknown error').slice(0, 500)}`).catch(() => {});
    } finally {
      clearInterval(typingTimer);
    }
  }
}

module.exports = TelegramService;
