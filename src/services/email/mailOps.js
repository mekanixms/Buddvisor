/**
 * IMAP, POP3, and SMTP operations for the email tool and the incoming watcher.
 */

const fs = require('fs').promises;
const path = require('path');
const { simpleParser } = require('mailparser');
const { withPop3, parseUidl, parseList } = require('./pop3');
const {
  oneLine,
  clampInt,
  parseSince,
  cleanFolder,
  requireFolder,
  assertNotInbox,
  collectIds,
  parseAddressList,
  normalizeAddress,
  textFromParsed,
  formatAddressList,
  scrubSecrets,
  sanitizeFilename,
  planImapDeliveries,
  planPop3Deliveries,
} = require('./plan');

const MAX_READ_BYTES = 12 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL = 25 * 1024 * 1024;
const MAX_BASE64_ATTACHMENT = 8 * 1024 * 1024;

function createImapClient(account) {
  const { ImapFlow } = require('imapflow');
  const secure = account.incoming.secure !== false;
  const client = new ImapFlow({
    host: account.incoming.host,
    port: account.incoming.port,
    secure,
    doSTARTTLS: secure ? undefined : true,
    auth: {
      user: account.incoming.user,
      pass: account.incoming.pass,
    },
    tls: { rejectUnauthorized: account.rejectUnauthorized !== false },
    logger: false,
    disableAutoIdle: true,
    maxLiteralSize: MAX_READ_BYTES,
    connectionTimeout: 20000,
    greetingTimeout: 16000,
    socketTimeout: 10 * 60 * 1000,
    maxIdleTime: 4 * 60 * 1000,
  });
  client.on('error', () => {});
  return client;
}

async function withImap(account, fn) {
  const client = createImapClient(account);
  try {
    await client.connect();
    if (!client.secureConnection) throw new Error('IMAP connection is not encrypted');
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      try { client.close(); } catch { /* already closed */ }
    }
  }
}

function imapUids(ids) {
  return ids.map((id) => {
    if (!/^\d+$/.test(String(id))) {
      throw new Error(`IMAP message ids are numeric UIDs; got "${id}". Use the id returned by list or read.`);
    }
    return Number(id);
  });
}

function summaryFromEnvelope(msg, folder) {
  const env = msg.envelope || {};
  const flags = msg.flags ? [...msg.flags].map((flag) => String(flag)) : [];
  const date = env.date ? new Date(env.date) : null;
  return {
    id: String(msg.uid),
    folder,
    from: formatAddressList(env.from),
    to: formatAddressList(env.to),
    cc: formatAddressList(env.cc),
    subject: env.subject || '',
    date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    message_id: env.messageId || null,
    seen: flags.some((flag) => flag.toLowerCase() === '\\seen'),
    flags,
    size: msg.size || null,
  };
}

function parsedAddressText(address) {
  if (!address) return '';
  if (typeof address.text === 'string' && address.text.trim()) return address.text.trim();
  return formatAddressList(address.value || address);
}

async function parsedMessage(source, maxChars) {
  const parsed = await simpleParser(source);
  const body = textFromParsed(parsed, maxChars);
  const date = parsed.date ? new Date(parsed.date) : null;
  return {
    parsed,
    from: parsedAddressText(parsed.from),
    to: parsedAddressText(parsed.to),
    cc: parsedAddressText(parsed.cc),
    subject: parsed.subject || '',
    date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    messageId: parsed.messageId || null,
    text: body.text,
    truncated: body.truncated,
    html: parsed.html ? String(parsed.html) : '',
    attachments: parsed.attachments || [],
  };
}

async function listMessages(account, params) {
  const limit = clampInt(params.limit, 1, 50, 20);
  if (account.protocol === 'pop3') return listPop3(account, params, limit);
  const folder = cleanFolder(params.folder, account.mailbox);
  const since = parseSince(params.since);
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const query = {};
      if (params.unseen === true) query.seen = false;
      if (params.from) query.from = oneLine(params.from);
      if (params.subject) query.subject = oneLine(params.subject);
      if (since) query.since = since;
      if (Object.keys(query).length === 0) query.all = true;
      const found = await client.search(query, { uid: true });
      const uids = (Array.isArray(found) ? found : []).filter((uid) => Number.isFinite(Number(uid)));
      const selected = uids.slice(-limit);
      const messages = [];
      if (selected.length > 0) {
        for await (const msg of client.fetch(selected, {
          uid: true,
          envelope: true,
          flags: true,
          size: true,
        }, { uid: true })) {
          messages.push(summaryFromEnvelope(msg, folder));
        }
      }
      messages.sort((a, b) => Number(b.id) - Number(a.id));
      return {
        protocol: 'imap',
        folder,
        matched: uids.length,
        returned: messages.length,
        messages,
      };
    } finally {
      lock.release();
    }
  });
}

async function listPop3(account, params, limit) {
  const since = parseSince(params.since);
  const fromFilter = params.from ? oneLine(params.from).toLowerCase() : '';
  const subjectFilter = params.subject ? oneLine(params.subject).toLowerCase() : '';
  const filtering = !!(fromFilter || subjectFilter || since);
  return withPop3(account, async (api) => {
    const uidlBody = await api.command('UIDL', { multiline: true });
    const entries = parseUidl(uidlBody.body).sort((a, b) => b.number - a.number);
    const listBody = await api.command('LIST', { multiline: true });
    const sizes = parseList(listBody.body);
    const scan = filtering ? entries.slice(0, 80) : entries.slice(0, limit);
    let headersAvailable = true;
    const messages = [];
    for (const entry of scan) {
      if (!filtering && messages.length >= limit) break;
      let headers = null;
      if (headersAvailable) {
        try {
          const top = await api.command(`TOP ${entry.number} 0`, { multiline: true, timeoutMs: 15000 });
          headers = String(top.body || '');
        } catch (err) {
          if (err.code === 'POP3') headersAvailable = false;
          else throw err;
        }
      }
      let summary = {
        id: entry.uidl,
        message_number: entry.number,
        folder: 'INBOX',
        from: '',
        to: '',
        subject: '',
        date: null,
        message_id: null,
        seen: null,
        size: sizes.get(entry.number) || null,
      };
      if (headers) {
        const parsed = await parsedMessage(`${headers}\r\n\r\n`, 0);
        summary = {
          ...summary,
          from: parsed.from,
          to: parsed.to,
          subject: parsed.subject,
          date: parsed.date,
          message_id: parsed.messageId,
        };
        if (fromFilter && !summary.from.toLowerCase().includes(fromFilter)) continue;
        if (subjectFilter && !summary.subject.toLowerCase().includes(subjectFilter)) continue;
        if (since && summary.date && new Date(summary.date) < since) continue;
      }
      messages.push(summary);
      if (messages.length >= limit) break;
    }
    const result = {
      protocol: 'pop3',
      folder: 'INBOX',
      matched: entries.length,
      returned: messages.length,
      messages,
    };
    const notes = [];
    if (params.unseen === true) notes.push('POP3 has no unread flag; this is the mailbox listing, not an unseen filter.');
    if (filtering && !headersAvailable) notes.push('This POP3 server has no TOP command, so from/subject/since filters were not applied.');
    if (notes.length) result.notes = notes;
    return result;
  });
}

async function workspaceFor(context) {
  const {
    getWorkspacePathForSessionAgent,
    getWorkspacePathForOrchestrator,
  } = require('../tools/localWorkingFolderTool');
  const sessionId = Number(context && context.sessionId);
  if (!Number.isFinite(sessionId)) return null;
  if (context.agentId == null) return getWorkspacePathForOrchestrator(sessionId);
  return getWorkspacePathForSessionAgent(sessionId, Number(context.agentId));
}

async function uniqueName(directory, filename) {
  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  let candidate = filename;
  for (let n = 2; n < 100; n += 1) {
    try {
      await fs.access(path.join(directory, candidate));
      candidate = `${stem}_${n}${ext}`;
    } catch {
      return candidate;
    }
  }
  return `${stem}_${Date.now()}${ext}`;
}

async function saveAttachments(context, directory, attachments) {
  const { resolveWorkspacePath } = require('../tools/localWorkingFolderTool');
  const workspace = await workspaceFor(context);
  if (!workspace) {
    throw new Error('Saving attachments needs local_working_folder configured for this agent.');
  }
  const relDir = directory && String(directory).trim() ? String(directory).trim() : 'email_attachments';
  const saved = [];
  for (const attachment of attachments || []) {
    if (!attachment || !attachment.content || !attachment.content.length) continue;
    if (attachment.content.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment "${attachment.filename || 'attachment'}" exceeds 15 MB`);
    }
    const filename = sanitizeFilename(attachment.filename || 'attachment');
    const dirAbs = resolveWorkspacePath(relDir, workspace);
    await fs.mkdir(dirAbs, { recursive: true });
    const stored = await uniqueName(dirAbs, filename);
    const rel = path.posix.join(relDir.split(path.sep).join('/'), stored);
    const abs = resolveWorkspacePath(rel, workspace);
    await fs.writeFile(abs, attachment.content);
    saved.push({
      filename: stored,
      path: rel,
      size: attachment.content.length,
      content_type: attachment.contentType || null,
    });
  }
  return saved;
}

async function readMessage(account, params, context) {
  const ids = collectIds(params);
  if (ids.length === 0) throw new Error('id is required. Use the id from list.');
  const id = ids[0];
  const maxChars = clampInt(params.max_chars, 200, 50000, 8000);
  if (account.protocol === 'pop3') return readPop3(account, id, params, context, maxChars);
  const folder = cleanFolder(params.folder, account.mailbox);
  const uid = imapUids([id])[0];
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(folder);
    try {
      const msg = await client.fetchOne(uid, {
        uid: true,
        envelope: true,
        flags: true,
        size: true,
      }, { uid: true });
      if (!msg) throw new Error(`No message ${id} in ${folder}`);
      const summary = summaryFromEnvelope(msg, folder);
      if ((msg.size || 0) > MAX_READ_BYTES) {
        return {
          ...summary,
          text: '',
          truncated: true,
          attachments: [],
          note: 'Message is larger than 12 MB and its body was not loaded.',
        };
      }
      const full = await client.fetchOne(uid, { source: true, uid: true }, { uid: true });
      const parsed = await parsedMessage(full && full.source ? full.source : '', maxChars);
      const result = {
        ...summary,
        from: parsed.from || summary.from,
        to: parsed.to || summary.to,
        cc: parsed.cc || summary.cc,
        subject: parsed.subject || summary.subject,
        date: parsed.date || summary.date,
        message_id: parsed.messageId || summary.message_id,
        text: parsed.text,
        truncated: parsed.truncated,
        attachments: (parsed.attachments || []).map((item) => ({
          filename: item.filename || 'attachment',
          content_type: item.contentType || null,
          size: item.size || (item.content ? item.content.length : 0),
        })),
      };
      if (params.include_html === true && parsed.html) {
        const html = textFromParsed({ text: parsed.html }, maxChars);
        result.html = html.text;
        result.html_truncated = html.truncated;
      }
      if (params.save_attachments === true) {
        result.saved_attachments = await saveAttachments(context, params.save_dir, parsed.attachments);
      }
      return result;
    } finally {
      lock.release();
    }
  });
}

async function readPop3(account, id, params, context, maxChars) {
  return withPop3(account, async (api) => {
    const uidlBody = await api.command('UIDL', { multiline: true });
    const entries = parseUidl(uidlBody.body);
    const entry = entries.find((item) => item.uidl === id)
      || (/^\d+$/.test(id) ? entries.find((item) => item.number === Number(id)) : null);
    if (!entry) throw new Error(`No message with id ${id}`);
    const listBody = await api.command('LIST', { multiline: true });
    const size = parseList(listBody.body).get(entry.number) || 0;
    if (size > MAX_READ_BYTES) {
      return {
        id: entry.uidl,
        message_number: entry.number,
        folder: 'INBOX',
        size,
        text: '',
        truncated: true,
        attachments: [],
        note: 'Message is larger than 12 MB and its body was not loaded.',
      };
    }
    const retr = await api.command(`RETR ${entry.number}`, { multiline: true, binary: true, timeoutMs: 120000 });
    const parsed = await parsedMessage(retr.body, maxChars);
    const result = {
      id: entry.uidl,
      message_number: entry.number,
      folder: 'INBOX',
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      subject: parsed.subject,
      date: parsed.date,
      message_id: parsed.messageId,
      seen: null,
      size: size || (retr.body ? retr.body.length : null),
      text: parsed.text,
      truncated: parsed.truncated,
      attachments: (parsed.attachments || []).map((item) => ({
        filename: item.filename || 'attachment',
        content_type: item.contentType || null,
        size: item.size || (item.content ? item.content.length : 0),
      })),
    };
    if (params.include_html === true && parsed.html) {
      const html = textFromParsed({ text: parsed.html }, maxChars);
      result.html = html.text;
      result.html_truncated = html.truncated;
    }
    if (params.save_attachments === true) {
      result.saved_attachments = await saveAttachments(context, params.save_dir, parsed.attachments);
    }
    return result;
  });
}

async function resolveAttachments(list, context) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('attachments must be an array');
  if (list.length > 10) throw new Error('At most 10 attachments');
  const { resolveWorkspacePath } = require('../tools/localWorkingFolderTool');
  const out = [];
  let total = 0;
  let workspace = null;
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new Error('Each attachment must be an object with path or content_base64');
    if (item.path) {
      if (!workspace) {
        workspace = await workspaceFor(context);
        if (!workspace) throw new Error('Attaching a workspace file needs local_working_folder configured for this agent.');
      }
      const abs = resolveWorkspacePath(String(item.path), workspace);
      const stat = await fs.stat(abs);
      if (!stat.isFile()) throw new Error(`Not a file: ${item.path}`);
      if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment too large: ${item.path}`);
      total += stat.size;
      out.push({
        filename: sanitizeFilename(item.filename || path.basename(abs)),
        path: abs,
        contentType: item.content_type || undefined,
      });
    } else if (item.content_base64) {
      const buf = Buffer.from(String(item.content_base64).replace(/\s+/g, ''), 'base64');
      if (!buf.length) throw new Error('Attachment content_base64 is empty');
      if (buf.length > MAX_BASE64_ATTACHMENT) throw new Error('Base64 attachment exceeds 8 MB');
      total += buf.length;
      out.push({
        filename: sanitizeFilename(item.filename || 'attachment'),
        content: buf,
        contentType: item.content_type || undefined,
      });
    } else {
      throw new Error('Each attachment needs path or content_base64');
    }
  }
  if (total > MAX_ATTACHMENTS_TOTAL) throw new Error('Attachments exceed 25 MB');
  return out;
}

async function replyHeaders(account, id, folder) {
  const uid = imapUids([id])[0];
  const mailbox = cleanFolder(folder, account.mailbox);
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      const msg = await client.fetchOne(uid, { envelope: true, uid: true }, { uid: true });
      if (!msg || !msg.envelope) throw new Error(`No message ${id} in ${mailbox}`);
      return {
        messageId: msg.envelope.messageId || null,
        subject: msg.envelope.subject || '',
      };
    } finally {
      lock.release();
    }
  });
}

async function sendMessage(account, params, context) {
  const to = parseAddressList(params.to).map(normalizeAddress);
  const cc = parseAddressList(params.cc).map(normalizeAddress);
  const bcc = parseAddressList(params.bcc).map(normalizeAddress);
  if (to.length === 0) throw new Error('to is required');
  if (to.length + cc.length + bcc.length > 20) throw new Error('Too many recipients (max 20)');

  let subject = oneLine(params.subject || '');
  const text = params.text != null ? String(params.text) : '';
  const html = params.html != null ? String(params.html) : '';
  if (text.length > 200000 || html.length > 200000) throw new Error('Message body is too large');
  let inReplyTo = params.in_reply_to ? oneLine(params.in_reply_to) : undefined;
  let references = params.references ? oneLine(params.references) : undefined;
  const replyId = params.reply_to_id || params.reply_to_uid;
  if (replyId) {
    const original = await replyHeaders(account, String(replyId).trim(), params.folder);
    if (!inReplyTo && original.messageId) inReplyTo = original.messageId;
    if (!references && original.messageId) references = original.messageId;
    if (!subject && original.subject) {
      subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
    }
  }
  if (!text.trim() && !html.trim()) throw new Error('text or html is required');

  const attachments = await resolveAttachments(params.attachments, context);
  const nodemailer = require('nodemailer');
  const transport = {
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure === true,
    auth: { user: account.smtp.user, pass: account.smtp.pass },
    tls: { rejectUnauthorized: account.rejectUnauthorized !== false },
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  };
  if (!transport.secure) transport.requireTLS = true;
  const info = await nodemailer.createTransport(transport).sendMail({
    from: normalizeAddress(params.from_address || account.fromAddress),
    to,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    subject,
    text: text.trim() ? text : undefined,
    html: html.trim() ? html : undefined,
    replyTo: params.reply_to ? normalizeAddress(params.reply_to) : undefined,
    inReplyTo,
    references,
    attachments: attachments.length ? attachments : undefined,
  });
  if (Array.isArray(info.rejected) && info.rejected.length > 0 && (!info.accepted || info.accepted.length === 0)) {
    throw new Error(`SMTP rejected recipients: ${info.rejected.join(', ')}`);
  }
  return {
    message_id: info.messageId || null,
    accepted: info.accepted || [],
    rejected: info.rejected || [],
    response: info.response || null,
  };
}

async function setSeen(account, ids, seen, folder) {
  const uids = imapUids(ids);
  const mailbox = cleanFolder(folder, account.mailbox);
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      if (seen) await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
      else await client.messageFlagsRemove(uids, ['\\Seen'], { uid: true });
      return { action: seen ? 'mark_read' : 'mark_unread', folder: mailbox, ids: ids.map(String) };
    } finally {
      lock.release();
    }
  });
}

async function findSpecialFolder(client, kind) {
  const boxes = await client.list();
  const special = kind === 'archive' ? '\\Archive' : '\\Junk';
  const names = kind === 'archive'
    ? ['archive', 'archives']
    : ['junk', 'spam', 'junk email', 'bulk mail', 'bulk'];
  const list = boxes || [];
  const match = list.find((box) => box.specialUse === special)
    || list.find((box) => names.includes(String(box.name || '').toLowerCase()))
    || list.find((box) => {
      const leaf = String(box.path || '').split(box.delimiter || '/').pop().toLowerCase();
      return names.includes(leaf);
    });
  if (!match || !match.path) {
    const available = list.map((box) => box.path).filter(Boolean).slice(0, 40);
    throw new Error(`This server has no ${kind} folder. Use action "move" with destination set to one of: ${available.join(', ') || '(none)'}`);
  }
  return match.path;
}

async function moveMessages(account, ids, source, destination) {
  const uids = imapUids(ids);
  const mailbox = cleanFolder(source, account.mailbox);
  const target = oneLine(destination);
  if (!target || target.length > 200) throw new Error('destination folder is required');
  return withImap(account, async (client) => {
    const lock = await client.getMailboxLock(mailbox);
    try {
      await client.messageMove(uids, target, { uid: true });
      return { action: 'move', folder: mailbox, destination: target, ids: ids.map(String) };
    } finally {
      lock.release();
    }
  });
}

async function moveToSpecial(account, ids, source, kind) {
  const uids = imapUids(ids);
  const mailbox = cleanFolder(source, account.mailbox);
  return withImap(account, async (client) => {
    const destination = await findSpecialFolder(client, kind);
    const lock = await client.getMailboxLock(mailbox);
    try {
      await client.messageMove(uids, destination, { uid: true });
      return { action: kind, folder: mailbox, destination, ids: ids.map(String) };
    } finally {
      lock.release();
    }
  });
}

async function createFolder(account, folder) {
  const folderPath = requireFolder(folder);
  return withImap(account, async (client) => {
    await client.mailboxCreate(folderPath);
    return { action: 'create_folder', folder: folderPath };
  });
}

async function deleteFolder(account, folder) {
  const folderPath = requireFolder(folder);
  assertNotInbox(folderPath, 'delete');
  return withImap(account, async (client) => {
    await client.mailboxDelete(folderPath);
    return { action: 'delete_folder', folder: folderPath };
  });
}

async function renameFolder(account, folder, destination) {
  const folderPath = requireFolder(folder);
  const next = requireFolder(destination);
  assertNotInbox(folderPath, 'rename');
  assertNotInbox(next, 'rename to');
  if (folderPath.toLowerCase() === next.toLowerCase()) {
    throw new Error('New folder name is the same as the current name');
  }
  return withImap(account, async (client) => {
    await client.mailboxRename(folderPath, next);
    return { action: 'rename_folder', folder: folderPath, destination: next };
  });
}

async function listFolders(account) {
  return withImap(account, async (client) => {
    const boxes = await client.list();
    const folders = (boxes || []).slice(0, 200).map((box) => ({
      path: box.path,
      name: box.name || box.path,
      special_use: box.specialUse || null,
    }));
    return {
      protocol: 'imap',
      returned: folders.length,
      truncated: (boxes || []).length > folders.length,
      folders,
    };
  });
}

async function checkAccount(account) {
  const { incomingReady, smtpReady } = require('./emailConfig');
  const result = {};
  if (!incomingReady(account)) {
    result.incoming = { ok: false, error: 'not configured' };
  } else {
    try {
      if (account.protocol === 'pop3') {
        await withPop3(account, (api) => api.command('STAT'));
      } else {
        await withImap(account, (client) => client.mailboxOpen(account.mailbox || 'INBOX'));
      }
      result.incoming = { ok: true, protocol: account.protocol, host: account.incoming.host };
    } catch (err) {
      result.incoming = { ok: false, error: scrubSecrets(err.message, account) };
    }
  }
  if (!smtpReady(account)) {
    result.smtp = { ok: false, error: 'not configured' };
  } else {
    try {
      const nodemailer = require('nodemailer');
      const transport = {
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure === true,
        auth: { user: account.smtp.user, pass: account.smtp.pass },
        tls: { rejectUnauthorized: account.rejectUnauthorized !== false },
        connectionTimeout: 20000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
      };
      if (!transport.secure) transport.requireTLS = true;
      await nodemailer.createTransport(transport).verify();
      result.smtp = { ok: true, host: account.smtp.host, port: account.smtp.port };
    } catch (err) {
      result.smtp = { ok: false, error: scrubSecrets(err.message, account) };
    }
  }
  return result;
}

async function summarizeImapMessage(client, uid, folder, maxChars) {
  const meta = await client.fetchOne(uid, {
    uid: true,
    envelope: true,
    flags: true,
    size: true,
  }, { uid: true });
  if (!meta) {
    return {
      id: String(uid),
      folder,
      from: '',
      to: '',
      subject: '(missing message)',
      date: null,
      messageId: null,
      text: '',
    };
  }
  const summary = summaryFromEnvelope(meta, folder);
  let text = '';
  if (meta.size && meta.size <= MAX_PREVIEW_BYTES) {
    const full = await client.fetchOne(uid, { source: true, uid: true }, { uid: true });
    if (full && full.source) {
      const parsed = await parsedMessage(full.source, maxChars);
      text = parsed.text;
      summary.from = parsed.from || summary.from;
      summary.to = parsed.to || summary.to;
      summary.subject = parsed.subject || summary.subject;
      summary.date = parsed.date || summary.date;
      summary.message_id = parsed.messageId || summary.message_id;
    }
  } else if (!meta.size) {
    text = '(message size was not reported; use the email tool to read it)';
  } else {
    text = '(message is large; use the email tool to read it)';
  }
  return {
    id: summary.id,
    folder: summary.folder,
    from: summary.from,
    to: summary.to,
    subject: summary.subject,
    date: summary.date,
    messageId: summary.message_id,
    text,
  };
}

async function collectImapArrivals(client, cursor, max = 20) {
  const box = client.mailbox;
  if (!box) throw new Error('IMAP mailbox is not open');
  const uidValidity = String(box.uidValidity);
  const uidNext = Number(box.uidNext) || 1;
  let uids = [];
  if (cursor && String(cursor.uidValidity) === uidValidity && Number.isFinite(Number(cursor.lastUid))) {
    const start = Number(cursor.lastUid) + 1;
    const found = await client.search({ uid: `${start}:*` }, { uid: true });
    uids = Array.isArray(found) ? found : [];
  }
  const plan = planImapDeliveries({ uidValidity, uidNext, cursor, uids, max });
  const messages = [];
  for (const uid of plan.deliver) {
    try {
      messages.push(await summarizeImapMessage(client, uid, box.path, 2000));
    } catch (err) {
      messages.push({
        id: String(uid),
        folder: box.path,
        from: '',
        to: '',
        subject: '(unreadable message)',
        date: null,
        messageId: null,
        text: scrubSecrets(err.message, null),
      });
    }
  }
  return {
    baseline: plan.baseline,
    cursor: plan.cursor,
    messages,
    overflow: plan.overflow,
  };
}

async function collectPop3Arrivals(account, cursor, max = 20) {
  return withPop3(account, async (api) => {
    const uidlBody = await api.command('UIDL', { multiline: true });
    const entries = parseUidl(uidlBody.body);
    const plan = planPop3Deliveries(entries, cursor, max);
    const messages = [];
    if (!plan.baseline) {
      const listBody = await api.command('LIST', { multiline: true });
      const sizes = parseList(listBody.body);
      for (const entry of plan.deliver) {
        const size = sizes.get(entry.number) || 0;
        if (size > MAX_PREVIEW_BYTES) {
          messages.push({
            id: entry.uidl,
            folder: 'INBOX',
            from: '',
            to: '',
            subject: '(large message)',
            date: null,
            messageId: null,
            text: '(message is large; use the email tool to read it)',
          });
          continue;
        }
        try {
          const retr = await api.command(`RETR ${entry.number}`, { multiline: true, binary: true, timeoutMs: 120000 });
          const parsed = await parsedMessage(retr.body, 2000);
          messages.push({
            id: entry.uidl,
            folder: 'INBOX',
            from: parsed.from,
            to: parsed.to,
            subject: parsed.subject,
            date: parsed.date,
            messageId: parsed.messageId,
            text: parsed.text,
          });
        } catch (err) {
          messages.push({
            id: entry.uidl,
            folder: 'INBOX',
            from: '',
            to: '',
            subject: '(unreadable message)',
            date: null,
            messageId: null,
            text: scrubSecrets(err.message, account),
          });
        }
      }
    }
    return {
      baseline: plan.baseline,
      cursor: plan.cursor,
      messages,
      overflow: plan.overflow,
    };
  });
}

module.exports = {
  createImapClient,
  listMessages,
  readMessage,
  sendMessage,
  setSeen,
  moveMessages,
  moveToSpecial,
  createFolder,
  deleteFolder,
  renameFolder,
  listFolders,
  checkAccount,
  collectImapArrivals,
  collectPop3Arrivals,
};
