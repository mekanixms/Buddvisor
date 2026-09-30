/**
 * Compact, size-capped log for terminal sessions. One file per workspace:
 *   <workspace>/logs/terminal.log
 *
 * Line formats (session names are [A-Za-z0-9_-], so these are easy to filter):
 *   <iso-time> <session>$ <input>
 *   <iso-time> <session># <event>
 *   <session>| <output line>
 *
 * Kept separate from logs/exec_history.log (workspace_exec) on purpose.
 */

const fs = require('fs');
const path = require('path');
const logger = require('../../../utils/logger');

const DEFAULT_MAX_BYTES = 1024 * 1024;
const DEFAULT_MAX_LINE_CHARS = 300;
const FLUSH_DELAY_MS = 250;
const FLUSH_THRESHOLD_CHARS = 32 * 1024;
const TAIL_MAX_LINES = 300;
const TAIL_MAX_CHARS = 12000;

const registry = new Map();

function envNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

class TerminalLog {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxBytes = options.maxBytes || envNumber('TERMINAL_LOG_MAX_BYTES', DEFAULT_MAX_BYTES);
    this.maxLineChars = options.maxLineChars || envNumber('TERMINAL_LOG_MAX_LINE_CHARS', DEFAULT_MAX_LINE_CHARS);
    this.buffer = '';
    this.timer = null;
    this.size = null;
  }

  static forWorkspace(workspacePath, options) {
    const filePath = path.join(workspacePath, 'logs', 'terminal.log');
    if (!registry.has(filePath)) {
      registry.set(filePath, new TerminalLog(filePath, options));
    }
    return registry.get(filePath);
  }

  static flushAll() {
    for (const log of registry.values()) log.flush();
  }

  input(session, text, { secret = false } = {}) {
    const shown = secret ? '[input hidden]' : this.truncate(String(text).replace(/\n/g, '\\n'));
    this.append(`${new Date().toISOString()} ${session}$ ${shown}\n`);
  }

  event(session, text) {
    this.append(`${new Date().toISOString()} ${session}# ${text}\n`);
  }

  /** @param {string} cleanedText output already passed through cleanTerminalText */
  output(session, cleanedText) {
    const lines = String(cleanedText)
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    if (lines.length === 0) return;
    this.append(lines.map((line) => `${session}| ${this.truncate(line)}\n`).join(''));
  }

  truncate(line) {
    return line.length > this.maxLineChars ? `${line.slice(0, this.maxLineChars)}…` : line;
  }

  append(text) {
    this.buffer += text;
    if (this.buffer.length >= FLUSH_THRESHOLD_CHARS) {
      this.flush();
      return;
    }
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_DELAY_MS);
      this.timer.unref();
    }
  }

  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.buffer) return;
    const chunk = this.buffer;
    this.buffer = '';

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      if (this.size === null) {
        this.size = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
      }
      if (this.size > 0 && this.size + Buffer.byteLength(chunk) > this.maxBytes) {
        fs.renameSync(this.filePath, `${this.filePath}.1`);
        this.size = 0;
      }
      fs.appendFileSync(this.filePath, chunk, 'utf8');
      this.size += Buffer.byteLength(chunk);
    } catch (error) {
      logger.warn(`[terminal] Failed to write ${this.filePath}: ${error.message}`);
    }
  }

  /** Last lines of the log, optionally only those of one session. */
  tail({ lines = 50, session = null } = {}) {
    this.flush();
    let content = '';
    try {
      content = fs.readFileSync(this.filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    let all = content.split('\n').filter(Boolean);
    if (session) {
      const inputOrEvent = new RegExp(`^\\S+ ${session}[$#] `);
      all = all.filter((line) => line.startsWith(`${session}| `) || inputOrEvent.test(line));
    }

    const wanted = Math.min(Math.max(1, Math.floor(lines)), TAIL_MAX_LINES);
    let selected = all.slice(-wanted).join('\n');
    if (selected.length > TAIL_MAX_CHARS) {
      selected = selected.slice(selected.length - TAIL_MAX_CHARS);
    }
    return selected;
  }
}

module.exports = { TerminalLog };
