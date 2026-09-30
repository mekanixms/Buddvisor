/**
 * One long-lived interactive shell on a pseudo-terminal, confined to an agent workspace.
 *
 * Protocol: bash runs interactively with PS1 set to a per-session marker that
 * carries the last exit status and the working directory. Seeing the marker means
 * "the shell is back at its prompt", so command completion, exit codes and cwd
 * tracking need no input injection and work even while a REPL or ssh session is
 * in the foreground (no marker appears until it exits).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const logger = require('../../../utils/logger');
const { buildWrapper, isInside } = require('./sandbox');
const { cleanTerminalText, trimBlock, truncateMiddle, shellQuote, findLongLine } = require('./textUtils');

const PTY_HELPER = path.join(__dirname, 'pty_helper.py');
const START_TIMEOUT_MS = 10000;
const CWD_RECOVERY_TIMEOUT_MS = 3000;
const INTERRUPT_WAIT_MS = 2000;
const POLL_MS = 15;
const MAX_PENDING_CHARS = 256 * 1024;
const MAX_LINE_CHARS = 3800;
const MAX_INPUT_CHARS = 20000;
const BACKGROUND_OUTPUT_CHARS = 1000;
const DEFAULT_OUTPUT_CHARS = 4000;
const MAX_OUTPUT_CHARS = 20000;

const BLOCKED_ENV_KEYS = new Set([
  'PATH', 'HOME', 'SHELL', 'PS1', 'PS2', 'PROMPT_COMMAND', 'BASH_ENV', 'ENV',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
]);
const PRIVILEGE_PATTERN = /(^|[;&|(\n])\s*(sudo|su|doas)(\s|$)/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}

function validateEnv(env) {
  const result = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment variable name: ${key}`);
    if (typeof value !== 'string') throw new Error(`Environment variable ${key} must be a string`);
    if (BLOCKED_ENV_KEYS.has(key.toUpperCase())) throw new Error(`Environment variable ${key} cannot be set`);
    result[key] = value;
  }
  return result;
}

function defaultLocale() {
  return process.env.LANG || process.env.LC_ALL || (process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8');
}

class TerminalSession {
  /**
   * @param {object} options
   * @param {string} options.name session name
   * @param {string} options.workspace real path of the agent workspace
   * @param {string} options.startDir absolute directory inside the workspace
   * @param {object} options.env extra (validated) environment variables
   * @param {string|null} options.jail 'bwrap' | 'sandbox-exec' | null (soft jail)
   * @param {import('./TerminalLog').TerminalLog} options.log
   * @param {number} options.idleTimeoutMs close the session after this long without use
   */
  constructor({ name, workspace, startDir, env = {}, jail = null, log, idleTimeoutMs }) {
    this.name = name;
    this.workspace = workspace;
    this.startDir = startDir;
    this.extraEnv = validateEnv(env);
    this.jail = jail;
    this.log = log;
    this.idleTimeoutMs = idleTimeoutMs;

    this.token = crypto.randomBytes(6).toString('hex');
    this.marker = new RegExp(`@@BVD${this.token}:(\\d+):([^\\n\\r]*?)@@\\r?\\n?`, 'g');
    this.markerHead = `@@BVD${this.token}:`;

    this.child = null;
    this.decoder = new StringDecoder('utf8');
    this.raw = '';
    this.pending = '';
    this.droppedChars = 0;
    this.dataCount = 0;
    this.lastDataAt = 0;
    this.atPrompt = false;
    this.lastExit = null;
    this.cwd = startDir;
    this.dead = false;
    this.exitCode = null;
    this.openedAt = Date.now();
    this.lastUsedAt = Date.now();
    this.queue = Promise.resolve();
  }

  get state() {
    if (this.dead) return 'exited';
    return this.atPrompt ? 'idle' : 'running';
  }

  relativeCwd() {
    return path.relative(this.workspace, this.cwd) || '.';
  }

  touch() {
    this.lastUsedAt = Date.now();
  }

  exclusive(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async start() {
    const wrapper = buildWrapper(this.jail, this.workspace);
    const shell = ['/bin/bash', '--noprofile', '--norc', '--noediting', '+o', 'histexpand', '-i'];
    const command = [...wrapper, ...shell];

    const env = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: this.workspace,
      USER: process.env.USER || 'agent',
      LOGNAME: process.env.USER || 'agent',
      SHELL: '/bin/bash',
      LANG: defaultLocale(),
      TERM: 'dumb',
      HISTFILE: '/dev/null',
      BASH_SILENCE_DEPRECATION_WARNING: '1',
      ...this.extraEnv,
      PS1: `@@BVD${this.token}:$?:$PWD@@\n`,
      PS2: '',
    };

    this.child = spawn('python3', [PTY_HELPER, '200', '50', '--', ...command], {
      cwd: this.startDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrText = '';
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => {
      stderrText = (stderrText + chunk.toString()).slice(-2000);
    });
    this.child.stdin.on('error', () => {});
    this.child.on('error', (error) => {
      stderrText += error.code === 'ENOENT' ? 'python3 is required for the terminal tool but was not found' : error.message;
      this.onExit(1);
    });
    this.child.on('close', (code) => this.onExit(code));

    const outcome = await this.waitFor({ untilPrompt: true, maxMs: START_TIMEOUT_MS });
    if (outcome !== 'prompt') {
      const detail = stderrText.trim() || trimBlock(cleanTerminalText(this.pending)) || outcome;
      this.close('failed to start');
      throw new Error(`Terminal failed to start: ${detail}`);
    }
    this.pending = '';
    this.dataCount = 0;
    this.log.event(this.name, `opened jail=${this.jail || 'soft'} cwd=${this.relativeCwd()}`);
  }

  onData(chunk) {
    this.raw += this.decoder.write(chunk);
    let text = '';
    let consumed = 0;
    this.marker.lastIndex = 0;

    let match;
    while ((match = this.marker.exec(this.raw)) !== null) {
      text += this.raw.slice(consumed, match.index);
      consumed = match.index + match[0].length;
      this.lastExit = Number(match[1]);
      this.cwd = match[2] || this.cwd;
      this.atPrompt = true;
    }

    const tail = this.raw.slice(consumed);
    const holdFrom = this.partialMarkerStart(tail);
    if (holdFrom >= 0) {
      text += tail.slice(0, holdFrom);
      this.raw = tail.slice(holdFrom);
    } else {
      text += tail;
      this.raw = '';
    }

    if (text) this.appendOutput(text);
  }

  /** Index where an incomplete marker begins at the end of `tail`, or -1. */
  partialMarkerStart(tail) {
    let position = tail.indexOf('@');
    while (position !== -1) {
      const rest = tail.slice(position);
      const couldBeHead = this.markerHead.startsWith(rest);
      const unfinished = rest.startsWith(this.markerHead) && rest.length < this.markerHead.length + 600 && !rest.includes('@@', this.markerHead.length);
      if (couldBeHead || unfinished) return position;
      position = tail.indexOf('@', position + 1);
    }
    return -1;
  }

  appendOutput(text) {
    this.dataCount += 1;
    this.lastDataAt = Date.now();
    this.log.output(this.name, cleanTerminalText(text));

    this.pending += text;
    if (this.pending.length > MAX_PENDING_CHARS) {
      const overflow = this.pending.length - MAX_PENDING_CHARS;
      this.pending = this.pending.slice(overflow);
      this.droppedChars += overflow;
    }
  }

  onExit(code) {
    if (this.dead) return;
    const rest = this.decoder.end();
    if (rest || this.raw) {
      this.raw = '';
      if (rest) this.appendOutput(rest);
    }
    this.dead = true;
    this.atPrompt = false;
    this.exitCode = code;
    this.log.event(this.name, `exited code=${code}`);
  }

  async waitFor({ untilPrompt = false, idleMs = null, sinceCount = 0, maxMs }) {
    const deadline = Date.now() + maxMs;
    for (;;) {
      if (this.dead) return 'exited';
      if (untilPrompt && this.atPrompt) return 'prompt';
      if (idleMs !== null && this.dataCount > sinceCount && Date.now() - this.lastDataAt >= idleMs) return 'idle';
      if (Date.now() >= deadline) return 'timeout';
      await sleep(POLL_MS);
    }
  }

  write(data) {
    if (this.dead || !this.child?.stdin?.writable) {
      throw new Error(`Terminal session "${this.name}" has exited`);
    }
    this.child.stdin.write(data);
  }

  takeOutput(maxChars = DEFAULT_OUTPUT_CHARS) {
    const cleaned = trimBlock(cleanTerminalText(this.pending));
    const dropped = this.droppedChars;
    this.pending = '';
    this.droppedChars = 0;
    const { text, omitted } = truncateMiddle(cleaned, Math.min(Math.max(200, maxChars), MAX_OUTPUT_CHARS));
    return { output: text, omitted, dropped };
  }

  buildResult(extra = {}) {
    const { output, omitted, dropped } = this.takeOutput(extra.maxChars);
    const result = {
      session: this.name,
      status: this.state === 'idle' ? 'done' : this.state,
      exit_code: this.dead ? this.exitCode : (this.atPrompt ? this.lastExit : undefined),
      cwd: this.dead ? undefined : this.relativeCwd(),
      output,
      omitted_chars: omitted || undefined,
      dropped_chars: dropped || undefined,
      background_output: extra.background || undefined,
      note: extra.note,
    };
    return compact(result);
  }

  validateInput(text) {
    if (typeof text !== 'string' || text.length === 0) throw new Error('Input must be a non-empty string');
    if (text.length > MAX_INPUT_CHARS) {
      throw new Error(`Input too long (max ${MAX_INPUT_CHARS} chars). Write it to a file with local_working_folder and run the file.`);
    }
    if (findLongLine(text, MAX_LINE_CHARS) !== -1) {
      throw new Error(`A line exceeds ${MAX_LINE_CHARS} chars (terminal line limit). Write the content to a file with local_working_folder instead.`);
    }
  }

  /** Bring the shell back inside the workspace if `cd` (or a program) left it. */
  async enforceWorkspace() {
    if (this.dead || !this.atPrompt) return undefined;
    let real = null;
    try {
      real = fs.realpathSync(this.cwd);
    } catch (error) {
      real = null;
    }
    if (real && isInside(real, this.workspace)) return undefined;

    this.log.event(this.name, `cwd left workspace (${this.cwd}); returning`);
    this.atPrompt = false;
    this.write(`cd -- ${shellQuote(this.workspace)}\n`);
    await this.waitFor({ untilPrompt: true, maxMs: CWD_RECOVERY_TIMEOUT_MS });
    return 'The shell left the workspace and was returned to its root.';
  }

  /**
   * Run a shell command to completion. Only valid while the shell is at its prompt.
   */
  run(command, { timeoutMs = 30000, maxChars } = {}) {
    return this.exclusive(async () => {
      this.touch();
      this.validateInput(command);
      if (PRIVILEGE_PATTERN.test(command)) throw new Error('Privilege escalation commands (sudo/su/doas) are not allowed');
      if (this.dead) throw new Error(`Terminal session "${this.name}" has exited`);
      if (!this.atPrompt) {
        throw new Error(`Session "${this.name}" is busy: a program is still in the foreground. Use send to give it input, read to see its output, interrupt to stop it, or use another session name.`);
      }

      const stale = this.takeOutput(BACKGROUND_OUTPUT_CHARS).output;
      this.log.input(this.name, command);
      this.atPrompt = false;
      this.write(`eval ${shellQuote(command)}\n`);

      await this.waitFor({ untilPrompt: true, maxMs: timeoutMs });
      const note = await this.enforceWorkspace();
      return this.buildResult({ maxChars, background: stale, note });
    });
  }

  /**
   * Type text into whatever is in the foreground (shell prompt, psql, ssh, a REPL...).
   * Returns once the shell prompt returns, or output arrives and goes quiet.
   */
  send(text, { newline = true, waitMs = 3000, idleMs = 400, secret = false, maxChars } = {}) {
    return this.exclusive(async () => {
      this.touch();
      this.validateInput(text);
      if (this.dead) throw new Error(`Terminal session "${this.name}" has exited`);

      const sinceCount = this.dataCount;
      this.log.input(this.name, text, { secret });
      this.atPrompt = false;
      this.write(newline ? `${text}\n` : text);

      await this.waitFor({ untilPrompt: true, idleMs, sinceCount, maxMs: waitMs });
      const note = await this.enforceWorkspace();
      return this.buildResult({ maxChars, note });
    });
  }

  /** Collect output produced since the last call, optionally waiting for some. */
  read({ waitMs = 0, idleMs = 400, maxChars } = {}) {
    return this.exclusive(async () => {
      this.touch();
      if (waitMs > 0) {
        const sinceCount = this.pending ? -1 : this.dataCount;
        await this.waitFor({ idleMs, sinceCount, maxMs: waitMs });
      }
      const note = await this.enforceWorkspace();
      return this.buildResult({ maxChars, note });
    });
  }

  /** Send Ctrl-C to the foreground program. */
  interrupt({ maxChars } = {}) {
    return this.exclusive(async () => {
      this.touch();
      if (this.dead) throw new Error(`Terminal session "${this.name}" has exited`);
      this.log.input(this.name, '^C');
      this.write('\u0003');
      await this.waitFor({ untilPrompt: true, maxMs: INTERRUPT_WAIT_MS });
      const note = await this.enforceWorkspace();
      const result = this.buildResult({ maxChars, note });
      if (result.status === 'running') {
        result.note = 'The program is still running after Ctrl-C. Call close to kill this session.';
      }
      return result;
    });
  }

  /** Terminate the shell and everything attached to its terminal. */
  close(reason = 'closed') {
    if (!this.child || this.dead) {
      this.dead = true;
      return;
    }
    this.log.event(this.name, `closing (${reason})`);
    try {
      this.child.stdin.end();
    } catch (error) {
      // already closed
    }
    const killer = setTimeout(() => {
      try {
        this.child.kill('SIGKILL');
      } catch (error) {
        logger.debug(`[terminal] kill failed for ${this.name}: ${error.message}`);
      }
    }, 4000);
    killer.unref();
    this.child.once('close', () => clearTimeout(killer));
  }

  summary() {
    return compact({
      session: this.name,
      state: this.state,
      cwd: this.dead ? undefined : this.relativeCwd(),
      jail: this.jail || 'soft',
      age_s: Math.round((Date.now() - this.openedAt) / 1000),
      idle_s: Math.round((Date.now() - this.lastUsedAt) / 1000),
      unread_chars: this.pending.length || undefined,
    });
  }
}

module.exports = { TerminalSession, validateEnv, DEFAULT_OUTPUT_CHARS };
