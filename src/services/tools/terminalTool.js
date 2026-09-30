/**
 * Terminal Tool
 * Persistent, named interactive shell sessions confined to the agent's working folder.
 * Linux and macOS only. See src/services/tools/terminal/ for the implementation.
 */

const fs = require('fs');
const { toolRegistry } = require('./ToolRegistry');
const logger = require('../../utils/logger');
const { dbAll } = require('../../../config/database');
const { getWorkspacePath, resolveWorkspacePath } = require('./localWorkingFolderTool');
const { terminalManager, TerminalManager } = require('./terminal/TerminalManager');
const { TerminalLog } = require('./terminal/TerminalLog');
const { isInside } = require('./terminal/sandbox');

const SUPPORTED_PLATFORMS = new Set(['linux', 'darwin']);
const DEFAULT_SESSION_NAME = 'main';
const EXECUTION_TIMEOUT_MS = 130 * 1000;
const OPERATIONS = ['run', 'send', 'read', 'interrupt', 'open', 'list', 'close', 'tail_log'];

function assertSupportedPlatform() {
  if (!SUPPORTED_PLATFORMS.has(process.platform)) {
    throw new Error('The terminal tool is supported on Linux and macOS only. Use workspace_exec for one-off commands.');
  }
}

/**
 * Real path of the workspace configured through local_working_folder
 * (same lookup and naming rules as workspace_exec).
 */
async function resolveWorkspace(context) {
  const isOrchestrator = !context.agentId;
  const rows = isOrchestrator
    ? await dbAll(
      'SELECT tool_config FROM session_orchestrator_tools WHERE session_id = ? AND tool_name = ?',
      [context.sessionId, 'local_working_folder']
    )
    : await dbAll(
      'SELECT tool_config FROM session_agent_tools WHERE session_id = ? AND agent_id = ? AND tool_name = ?',
      [context.sessionId, context.agentId, 'local_working_folder']
    );

  const entity = isOrchestrator ? 'orchestrator' : 'agent';
  if (!rows || rows.length === 0) {
    throw new Error(`local_working_folder must be configured for this ${entity} before using terminal. Configure the folder name in Session Settings → Tools.`);
  }

  let config = rows[0].tool_config;
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config);
    } catch (error) {
      throw new Error('Invalid workspace configuration. Please reconfigure the folder name in Session Settings → Tools.');
    }
  }
  if (!config || !config.folder_name || String(config.folder_name).trim() === '') {
    throw new Error(`Workspace folder name not configured for this ${entity}. Configure local_working_folder in Session Settings → Tools.`);
  }

  const workspacePath = getWorkspacePath(
    String(config.folder_name).trim(),
    context.sessionId,
    context.agentId !== undefined ? context.agentId : null,
    config.randomize_name !== false
  );
  fs.mkdirSync(workspacePath, { recursive: true });
  return fs.realpathSync(workspacePath);
}

/** Start directory inside the workspace, checked after symlinks are resolved. */
function resolveStartDir(cwd, workspace) {
  if (!cwd) return workspace;
  const resolved = resolveWorkspacePath(cwd, workspace);
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch (error) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }
  if (!fs.statSync(real).isDirectory()) throw new Error(`cwd is not a directory: ${cwd}`);
  if (!isInside(real, workspace)) throw new Error(`cwd resolves outside the workspace: ${cwd}`);
  return real;
}

function withStartInfo(result, { session, started, note }) {
  if (!started && !note) return result;
  const merged = { ...result };
  if (started) {
    merged.started = true;
    merged.jail = session.jail || 'soft';
  }
  if (note) merged.note = merged.note ? `${merged.note} ${note}` : note;
  return merged;
}

function requireLiveSession(scope, name) {
  const session = terminalManager.get(scope, name);
  if (!session) {
    throw new Error(`No live terminal session "${name}". Use run or open to start one (operation "list" shows open sessions).`);
  }
  return session;
}

async function handleTerminal(params, context) {
  assertSupportedPlatform();
  if (!context.sessionId) throw new Error('sessionId is required in context');

  const { operation } = params;
  const name = TerminalManager.validateName(params.session || DEFAULT_SESSION_NAME);
  const scope = TerminalManager.scopeOf(context);
  const maxChars = params.max_output_chars;

  if (operation === 'list') {
    return { sessions: terminalManager.list(scope) };
  }

  const workspace = await resolveWorkspace(context);

  switch (operation) {
    case 'tail_log':
      return {
        session: params.session || undefined,
        log: TerminalLog.forWorkspace(workspace).tail({ lines: params.lines || 50, session: params.session || null }),
      };

    case 'open': {
      const startDir = resolveStartDir(params.cwd, workspace);
      const opened = await terminalManager.open({
        scope, name, workspace, startDir, env: params.env, idleTimeoutMs: params.idle_timeout_ms,
      });
      const result = { ...opened.session.summary(), started: opened.started };
      return withStartInfo(result, { session: opened.session, started: false, note: opened.note });
    }

    case 'run': {
      if (!params.command) throw new Error('command is required for run');
      const startDir = resolveStartDir(params.cwd, workspace);
      const opened = await terminalManager.open({ scope, name, workspace, startDir, env: params.env });
      const result = await opened.session.run(params.command, { timeoutMs: params.timeout_ms || 30000, maxChars });
      return withStartInfo(result, opened);
    }

    case 'send': {
      if (typeof params.input !== 'string') throw new Error('input is required for send');
      const opened = await terminalManager.open({ scope, name, workspace, startDir: resolveStartDir(params.cwd, workspace), env: params.env });
      const result = await opened.session.send(params.input, {
        newline: params.newline !== false,
        waitMs: params.wait_ms !== undefined ? params.wait_ms : 3000,
        idleMs: params.idle_ms || 400,
        secret: params.secret === true,
        maxChars,
      });
      return withStartInfo(result, opened);
    }

    case 'read': {
      const session = requireLiveSession(scope, name);
      return session.read({ waitMs: params.wait_ms || 0, idleMs: params.idle_ms || 400, maxChars });
    }

    case 'interrupt':
      return requireLiveSession(scope, name).interrupt({ maxChars });

    case 'close': {
      const final = await terminalManager.close(scope, name);
      return final ? { ...final, status: 'closed' } : { session: name, status: 'not_found' };
    }

    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

function registerTerminalTool() {
  toolRegistry.register({
    name: 'terminal',
    description:
      'Persistent interactive terminal (bash) inside your working folder; requires local_working_folder. ' +
      'Sessions stay open between calls, so cwd, environment, logins (ssh, psql, ...) and background services persist. ' +
      'Operations: run (shell command to completion; returns exit_code + output; session must be at its prompt), ' +
      'send (type input into whatever is in the foreground: REPL, client, password prompt; secret:true hides it from the log), ' +
      'read (collect new output, optional wait_ms), interrupt (Ctrl-C), open (optionally set cwd/env), list, close, ' +
      'tail_log (recent lines of logs/terminal.log). Use named sessions (e.g. "db", "server") to run a client and a service side by side. ' +
      'status "done" = back at the prompt, "running" = a program is still in the foreground, "exited" = shell ended. ' +
      'Output is trimmed to max_output_chars and already shown to the user, so do not repeat it in your reply. ' +
      'Use workspace_exec for one-off commands that do not need a persistent session. Linux/macOS only.',
    category: 'execution',
    executionTimeout: EXECUTION_TIMEOUT_MS,
    parameters: {
      operation: {
        type: 'string',
        description: 'What to do',
        required: true,
        enum: OPERATIONS,
      },
      session: {
        type: 'string',
        description: 'Session name (default "main"): letters, digits, _ or -, max 32 chars',
        required: false,
        maxLength: 32,
      },
      command: {
        type: 'string',
        description: 'Shell command for run. May span several lines. Max 20000 chars, each line max 3800.',
        required: false,
        maxLength: 20000,
      },
      input: {
        type: 'string',
        description: 'Text for send, typed into the foreground program',
        required: false,
        maxLength: 20000,
      },
      newline: {
        type: 'boolean',
        description: 'send: append Enter after input (default true). Use false for control characters such as "\\u0004" (Ctrl-D).',
        required: false,
      },
      secret: {
        type: 'boolean',
        description: 'send: input is a secret (password); it is not written to logs/terminal.log',
        required: false,
      },
      cwd: {
        type: 'string',
        description: 'Start directory inside the workspace, used only when the session is created (default: workspace root)',
        required: false,
      },
      env: {
        type: 'object',
        description: 'Extra environment variables (string values) for a newly created session',
        required: false,
      },
      timeout_ms: {
        type: 'number',
        description: 'run: max wait for the command to finish (default 30000, max 120000). On timeout the command keeps running; use read, send or interrupt.',
        required: false,
        minimum: 1000,
        maximum: 120000,
      },
      wait_ms: {
        type: 'number',
        description: 'send: max wait for a response (default 3000). read: how long to wait for new output (default 0).',
        required: false,
        minimum: 0,
        maximum: 120000,
      },
      idle_ms: {
        type: 'number',
        description: 'send/read: treat output as complete after this much silence (default 400)',
        required: false,
        minimum: 50,
        maximum: 10000,
      },
      max_output_chars: {
        type: 'number',
        description: 'Cap on returned output (default 4000, max 20000). Long output keeps its start and end.',
        required: false,
        minimum: 200,
        maximum: 20000,
      },
      lines: {
        type: 'number',
        description: 'tail_log: number of lines (default 50, max 300)',
        required: false,
        minimum: 1,
        maximum: 300,
      },
      idle_timeout_ms: {
        type: 'number',
        description: 'open: close the session after this long without use (default 30 min, server-capped)',
        required: false,
        minimum: 60000,
      },
    },
    handler: handleTerminal,
    examples: [
      { description: 'Run a command', parameters: { operation: 'run', command: 'python3 analyze.py data.csv' } },
      { description: 'Start a database client and keep it logged in', parameters: { operation: 'send', session: 'db', input: 'sqlite3 shop.db' } },
      { description: 'Query it later without reconnecting', parameters: { operation: 'send', session: 'db', input: 'SELECT count(*) FROM orders;' } },
      { description: 'Check a background service', parameters: { operation: 'read', session: 'server', wait_ms: 2000 } },
    ],
  });
  logger.debug('[terminal] Tool registered');
}

function closeAllTerminals() {
  terminalManager.closeAll();
}

module.exports = { registerTerminalTool, closeAllTerminals, handleTerminal };
