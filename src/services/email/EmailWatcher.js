/**
 * Incoming mail for sessions that have the email tool assigned.
 * IMAP stays in IDLE (the server pushes new mail). POP3 has no push, so it is polled.
 * New messages are posted into the session chat. Mail already in the box when a
 * watcher first starts is recorded and not posted.
 */

const crypto = require('crypto');
const logger = require('../../utils/logger');
const { resolveEmailAccount, incomingReady } = require('./emailConfig');
const { buildInboundMessage, isOwnMessage, scrubSecrets, clampInt } = require('./plan');
const { getCursor, setCursor } = require('./cursors');
const { createImapClient, collectImapArrivals, collectPop3Arrivals } = require('./mailOps');

const watchers = new Map();
let started = false;
let refreshing = null;
let refreshAgain = false;
let scheduleTimer = null;
let reconcileTimer = null;

function parseConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function fingerprint(account) {
  return crypto.createHash('sha256').update(JSON.stringify({
    protocol: account.protocol,
    host: account.incoming.host,
    port: account.incoming.port,
    secure: account.incoming.secure,
    user: account.incoming.user,
    pass: account.incoming.pass,
    mailbox: account.mailbox,
    tls: account.rejectUnauthorized,
    notifyOwn: account.notifyOwn,
  })).digest('hex').slice(0, 24);
}

function buildTarget(sessionId, agentId, userId, rawConfig) {
  const config = parseConfig(rawConfig);
  if (config == null) {
    logger.warn(`email watcher skipped session=${sessionId}: invalid tool config`);
    return null;
  }
  let account;
  try {
    account = resolveEmailAccount(config);
  } catch (err) {
    logger.warn(`email watcher skipped session=${sessionId}: ${err.message}`);
    return null;
  }
  if (!account.notify || !incomingReady(account)) return null;
  const who = agentId == null ? 'orchestrator' : String(agentId);
  const key = `${sessionId}:${who}:${account.protocol}:${account.incoming.host}:${account.incoming.user}:${account.mailbox}`;
  return {
    key,
    sessionId: Number(sessionId),
    agentId: agentId == null ? null : Number(agentId),
    userId: Number(userId),
    account,
    fingerprint: fingerprint(account),
  };
}

async function loadTargets() {
  const { dbAll } = require('../../../config/database');
  const agentRows = await dbAll(
    `SELECT t.session_id, t.agent_id, t.tool_config, s.user_id
     FROM session_agent_tools t
     JOIN work_sessions s ON s.id = t.session_id
     WHERE t.tool_name = 'email' AND s.is_active = 1`
  );
  const orchRows = await dbAll(
    `SELECT t.session_id, t.tool_config, s.user_id
     FROM session_orchestrator_tools t
     JOIN work_sessions s ON s.id = t.session_id
     WHERE t.tool_name = 'email' AND s.is_active = 1`
  );
  const targets = [];
  for (const row of agentRows || []) {
    const target = buildTarget(row.session_id, row.agent_id, row.user_id, row.tool_config);
    if (target) targets.push(target);
  }
  for (const row of orchRows || []) {
    const target = buildTarget(row.session_id, null, row.user_id, row.tool_config);
    if (target) targets.push(target);
  }
  return targets;
}

function wait(ms, state) {
  return new Promise((resolve) => {
    if (state.stopped) {
      resolve();
      return;
    }
    const finish = () => {
      if (state.timer) clearTimeout(state.timer);
      state.timer = null;
      state.cancelWait = null;
      resolve();
    };
    state.cancelWait = finish;
    state.timer = setTimeout(finish, ms);
  });
}

function stopOne(state) {
  state.stopped = true;
  if (state.cancelWait) state.cancelWait();
  try {
    if (state.client) state.client.close();
  } catch { /* closing */ }
}

function inboundLimit() {
  return clampInt(process.env.EMAIL_INBOUND_MAX_PER_HOUR, 1, 500, 30);
}

function allowInbound(state) {
  const max = inboundLimit();
  const now = Date.now();
  state.hits = (state.hits || []).filter((stamp) => now - stamp < 60 * 60 * 1000);
  if (state.hits.length < max) state.pausedNotice = false;
  if (state.hits.length >= max) return false;
  state.hits.push(now);
  return true;
}

async function alreadyPosted(target, message) {
  if (!message || message.id == null || message.id === '') return false;
  const { dbGet } = require('../../../config/database');
  const row = await dbGet(
    `SELECT id FROM messages
     WHERE session_id = ?
       AND role = 'user'
       AND json_extract(metadata, '$.channel') = 'email'
       AND json_extract(metadata, '$.email_id') = ?
     LIMIT 1`,
    [target.sessionId, String(message.id)]
  );
  return !!row;
}

async function postChat(target, text, message) {
  if (target.agentId != null) {
    const WorkSession = require('../../models/WorkSession');
    const agents = await WorkSession.getAgents(target.sessionId);
    if (!(agents || []).some((agent) => Number(agent.id) === Number(target.agentId))) {
      logger.warn(`email notify skipped session=${target.sessionId}: agent ${target.agentId} is no longer in the session`);
      return;
    }
  }
  const { ChatService } = require('../chat/ChatService');
  const metadataExtra = {
    channel: 'email',
    email_from: message && message.from ? message.from : null,
    email_subject: message && message.subject ? message.subject : null,
    email_id: message && message.id ? message.id : null,
  };
  const options = { stream: false, metadataExtra };
  if (target.agentId != null) options.directAgentIds = [target.agentId];
  else options.orchestratorDirect = true;
  await ChatService.processMessage(target.sessionId, target.userId, text, options);
}

async function deliverBatch(target, state, messages, overflow) {
  const visible = target.account.notifyOwn
    ? messages
    : messages.filter((message) => !isOwnMessage(target.account, message.from));
  for (let i = 0; i < visible.length; i += 1) {
    if (state.stopped) return;
    if (await alreadyPosted(target, visible[i])) {
      logger.info(`Incoming email already in session=${target.sessionId} id=${visible[i].id}; not posting again`);
      continue;
    }
    if (!allowInbound(state)) {
      if (!state.pausedNotice) {
        state.pausedNotice = true;
        const max = inboundLimit();
        try {
          await postChat(
            target,
            `[Email notify paused for an hour after ${max} messages. Use the email tool action "list" to read what arrived.]`,
            null
          );
        } catch (err) {
          logger.warn(`email notify pause notice failed session=${target.sessionId}: ${err.message}`);
        }
      }
      return;
    }
    const note = i === visible.length - 1 ? overflow : 0;
    await postChat(target, buildInboundMessage(visible[i], note), visible[i]);
    logger.info(`Incoming email session=${target.sessionId} id=${visible[i].id} subject=${oneLineSubject(visible[i].subject)}`);
  }
}

function oneLineSubject(subject) {
  return String(subject || '').replace(/[\r\n]+/g, ' ').slice(0, 120);
}

async function pull(target, collect) {
  const cursor = await getCursor(target.key);
  return collect(cursor);
}

async function deliverAndCommit(target, state, result) {
  if (!result) return;
  if (!result.baseline && result.messages && result.messages.length > 0) {
    await deliverBatch(target, state, result.messages, result.overflow);
  }
  await setCursor(target.key, result.cursor);
}

const IMAP_RECHECK_MS = 20000;

function breakIdle(client) {
  if (client && client.idling && typeof client.preCheck === 'function') {
    const pending = client.preCheck();
    if (pending && typeof pending.catch === 'function') pending.catch(() => {});
  }
}


async function runImap(target, state) {
  let delay = 5000;
  while (!state.stopped) {
    const client = createImapClient(target.account);
    state.client = client;
    try {
      await client.connect();
      if (!client.secureConnection) throw new Error('IMAP connection is not encrypted');
      await client.mailboxOpen(target.account.mailbox || 'INBOX');
      state.connected = true;
      state.lastError = null;
      delay = 5000;
      logger.info(`email IDLE session=${target.sessionId} mailbox=${target.account.incoming.user} ${target.account.mailbox}`);
      // imapflow idle() stays open until DONE. A new message emits "exists" but does not
      // resolve idle(), so the loop must break IDLE itself. The timer covers a server that
      // never pushes EXISTS, and mail that arrives between the search and IDLE.
      let arrived = false;
      const onExists = (info) => {
        if (!info || Number(info.count) > Number(info.prevCount)) {
          arrived = true;
          breakIdle(client);
        }
      };
      client.on('exists', onExists);
      while (!state.stopped) {
        arrived = false;
        const result = await pull(target, (cursor) => collectImapArrivals(client, cursor));
        try {
          await deliverAndCommit(target, state, result);
        } catch (err) {
          logger.error(`email notify failed session=${target.sessionId}: ${err.message}`);
        }
        if (state.stopped || arrived) continue;
        const timer = setTimeout(() => breakIdle(client), IMAP_RECHECK_MS);
        if (timer.unref) timer.unref();
        try {
          await client.idle();
        } finally {
          clearTimeout(timer);
        }
      }
    } catch (err) {
      state.connected = false;
      if (state.stopped) break;
      state.lastError = scrubSecrets(err.message, target.account);
      logger.warn(`email IDLE session=${target.sessionId} agent=${target.agentId == null ? 'orchestrator' : target.agentId}: ${state.lastError}`);
    } finally {
      state.client = null;
      state.connected = false;
      try { await client.logout(); } catch { try { client.close(); } catch { /* ignore */ } }
    }
    if (state.stopped) break;
    await wait(delay, state);
    delay = Math.min(delay * 2, 60000);
  }
}

function pop3PollMs() {
  return clampInt(process.env.EMAIL_POP3_POLL_MS, 15000, 60 * 60 * 1000, 120000);
}

async function runPop3(target, state) {
  let delay = pop3PollMs();
  while (!state.stopped) {
    try {
      const result = await pull(target, (cursor) => collectPop3Arrivals(target.account, cursor));
      await deliverAndCommit(target, state, result);
      state.connected = true;
      state.lastError = null;
      delay = pop3PollMs();
    } catch (err) {
      state.connected = false;
      if (state.stopped) break;
      state.lastError = scrubSecrets(err.message, target.account);
      logger.warn(`email POP3 poll session=${target.sessionId}: ${state.lastError}`);
      delay = Math.min(Math.max(delay * 2, pop3PollMs()), 15 * 60 * 1000);
    }
    if (state.stopped) break;
    await wait(delay, state);
  }
}

function startOne(target) {
  const state = {
    fingerprint: target.fingerprint,
    stopped: false,
    connected: false,
    lastError: null,
    mode: target.account.protocol === 'pop3' ? 'poll' : 'idle',
    client: null,
    hits: [],
    pausedNotice: false,
    startedAt: new Date().toISOString(),
  };
  watchers.set(target.key, state);
  const run = target.account.protocol === 'pop3' ? runPop3(target, state) : runImap(target, state);
  run.catch((err) => {
    logger.error(`email watcher crashed session=${target.sessionId}: ${err.message}`);
  });
}

async function refreshEmailWatchers() {
  if (!started) return;
  if (refreshing) {
    refreshAgain = true;
    return refreshing;
  }
  refreshing = (async () => {
    do {
      refreshAgain = false;
      const targets = await loadTargets();
      const wanted = new Map(targets.map((target) => [target.key, target]));
      for (const [key, state] of watchers) {
        const next = wanted.get(key);
        if (!next || next.fingerprint !== state.fingerprint) {
          stopOne(state);
          watchers.delete(key);
        }
      }
      for (const [key, target] of wanted) {
        if (!watchers.has(key)) startOne(target);
      }
    } while (refreshAgain);
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

function scheduleEmailWatcherRefresh() {
  if (!started) return;
  if (scheduleTimer) clearTimeout(scheduleTimer);
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null;
    refreshEmailWatchers().catch((err) => {
      logger.warn(`email watcher refresh failed: ${err.message}`);
    });
  }, 400);
}

function startEmailWatchers() {
  started = true;
  refreshEmailWatchers().catch((err) => {
    logger.error(`email watcher start failed: ${err.message}`);
  });
  if (reconcileTimer) clearInterval(reconcileTimer);
  const interval = clampInt(process.env.EMAIL_WATCH_RECONCILE_MS, 15000, 10 * 60 * 1000, 60000);
  reconcileTimer = setInterval(() => {
    refreshEmailWatchers().catch((err) => {
      logger.warn(`email watcher reconcile failed: ${err.message}`);
    });
  }, interval);
  if (reconcileTimer.unref) reconcileTimer.unref();
  logger.info('Email watchers started');
}

function stopEmailWatchers() {
  started = false;
  if (scheduleTimer) clearTimeout(scheduleTimer);
  scheduleTimer = null;
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconcileTimer = null;
  for (const state of watchers.values()) stopOne(state);
  watchers.clear();
}

function getWatcherStatus(context) {
  const sessionId = Number(context && context.sessionId);
  const who = context && context.agentId != null ? String(context.agentId) : 'orchestrator';
  const prefix = `${sessionId}:${who}:`;
  for (const [key, state] of watchers) {
    if (!key.startsWith(prefix)) continue;
    return {
      running: !state.stopped,
      mode: state.mode,
      connected: !!state.connected,
      last_error: state.lastError,
      since: state.startedAt,
    };
  }
  return { running: false, mode: null, connected: false, last_error: null };
}

module.exports = {
  startEmailWatchers,
  stopEmailWatchers,
  scheduleEmailWatcherRefresh,
  refreshEmailWatchers,
  getWatcherStatus,
  buildTarget,
  breakIdle,
};
