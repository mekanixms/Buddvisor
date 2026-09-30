/**
 * Registry of live terminal sessions, scoped per (work session, agent) so one
 * agent can never reach another agent's shells.
 */

const logger = require('../../../utils/logger');
const { resolveSandbox } = require('./sandbox');
const { TerminalSession } = require('./TerminalSession');
const { TerminalLog } = require('./TerminalLog');

const SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_IDLE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const DEFAULT_MAX_PER_AGENT = 4;
const DEFAULT_MAX_TOTAL = 24;
const SESSION_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

class TerminalManager {
  constructor() {
    this.sessions = new Map();
    this.opening = new Map();
    this.sweeper = null;
  }

  static validateName(name) {
    if (!SESSION_NAME_PATTERN.test(name)) {
      throw new Error('Session name must be 1-32 characters: letters, digits, "_" or "-"');
    }
    return name;
  }

  static scopeOf(context) {
    return `${context.sessionId}:${context.agentId !== undefined && context.agentId !== null ? context.agentId : 'orchestrator'}`;
  }

  key(scope, name) {
    return `${scope}|${name}`;
  }

  /** Live session or null. Dead sessions are dropped. */
  get(scope, name) {
    const key = this.key(scope, name);
    const session = this.sessions.get(key);
    if (session && session.dead) {
      this.sessions.delete(key);
      return null;
    }
    return session || null;
  }

  list(scope) {
    const prefix = `${scope}|`;
    const summaries = [];
    for (const [key, session] of this.sessions) {
      if (!key.startsWith(prefix)) continue;
      if (session.dead) {
        this.sessions.delete(key);
        continue;
      }
      summaries.push(session.summary());
    }
    return summaries;
  }

  countForScope(scope) {
    return this.list(scope).length;
  }

  /**
   * Return the live session with this name, starting one if needed.
   * @returns {Promise<{session: TerminalSession, started: boolean, note?: string}>}
   */
  async open({ scope, name, workspace, startDir, env, idleTimeoutMs }) {
    TerminalManager.validateName(name);
    const key = this.key(scope, name);

    if (this.opening.has(key)) return this.opening.get(key);
    const promise = this.openUnlocked({ scope, name, workspace, startDir, env, idleTimeoutMs })
      .finally(() => this.opening.delete(key));
    this.opening.set(key, promise);
    return promise;
  }

  async openUnlocked({ scope, name, workspace, startDir, env, idleTimeoutMs }) {
    const key = this.key(scope, name);
    let note;

    const existing = this.sessions.get(key);
    if (existing && !existing.dead) {
      if (existing.workspace === workspace) return { session: existing, started: false };
      existing.close('workspace changed');
      note = 'Workspace configuration changed; previous session was closed.';
    } else if (existing) {
      note = `Previous "${name}" session had exited (code ${existing.exitCode}); started a new one.`;
    }
    this.sessions.delete(key);

    const maxPerAgent = envNumber('TERMINAL_MAX_SESSIONS_PER_AGENT', DEFAULT_MAX_PER_AGENT);
    if (this.countForScope(scope) >= maxPerAgent) {
      throw new Error(`Session limit reached (${maxPerAgent} per agent). Close one with operation "close".`);
    }
    if (this.sessions.size >= envNumber('TERMINAL_MAX_SESSIONS', DEFAULT_MAX_TOTAL)) {
      throw new Error('Too many terminal sessions are open on the server. Try again later.');
    }

    const sandbox = resolveSandbox();
    const maxIdle = envNumber('TERMINAL_MAX_IDLE_TIMEOUT_MS', DEFAULT_MAX_IDLE_TIMEOUT_MS);
    const requestedIdle = Number(idleTimeoutMs);
    const effectiveIdle = Math.min(
      Number.isFinite(requestedIdle) && requestedIdle > 0 ? requestedIdle : envNumber('TERMINAL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS),
      maxIdle
    );
    const log = TerminalLog.forWorkspace(workspace);

    const build = (jail) => new TerminalSession({ name, workspace, startDir, env, jail, log, idleTimeoutMs: effectiveIdle });
    let session = build(sandbox.kind);
    try {
      await session.start();
    } catch (error) {
      if (!sandbox.kind) throw error;
      logger.warn(`[terminal] Jailed start failed (${error.message}); falling back to soft jail`);
      session = build(null);
      await session.start();
      note = `${note ? `${note} ` : ''}OS-level jail failed to start; this session has the soft jail only.`;
    }

    if (!sandbox.kind && sandbox.reason) {
      note = `${note ? `${note} ` : ''}Soft jail only (${sandbox.reason}).`;
    }

    this.sessions.set(key, session);
    this.startSweeper();
    return { session, started: true, note };
  }

  async close(scope, name) {
    const session = this.get(scope, name);
    if (!session) return null;
    const finalOutput = session.buildResult();
    session.close('closed by agent');
    this.sessions.delete(this.key(scope, name));
    return finalOutput;
  }

  startSweeper() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  sweep() {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.dead) {
        this.sessions.delete(key);
      } else if (now - session.lastUsedAt > session.idleTimeoutMs) {
        session.close('idle timeout');
        this.sessions.delete(key);
      }
    }
  }

  /** Stop every shell and flush logs; used on server shutdown. */
  closeAll() {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = null;
    }
    for (const session of this.sessions.values()) session.close('server shutdown');
    this.sessions.clear();
    TerminalLog.flushAll();
  }
}

const terminalManager = new TerminalManager();

module.exports = { TerminalManager, terminalManager };
