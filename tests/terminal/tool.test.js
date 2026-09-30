/**
 * End-to-end through ToolExecutor + tool handler (workspace lookup mocked).
 * PTY-dependent cases are skipped where a PTY is unavailable.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

process.env.TERMINAL_SANDBOX = 'off';

jest.mock('../../config/database', () => ({ dbAll: jest.fn(), dbGet: jest.fn(), dbRun: jest.fn() }));

const { dbAll } = require('../../config/database');
const { toolExecutor } = require('../../src/services/tools/ToolExecutor');
const { toolRegistry } = require('../../src/services/tools/ToolRegistry');
const { registerTerminalTool, closeAllTerminals } = require('../../src/services/tools/terminalTool');
const { TerminalLog } = require('../../src/services/tools/terminal/TerminalLog');

function canUsePty() {
  if (!['linux', 'darwin'].includes(process.platform)) return false;
  const probe = spawnSync('python3', ['-c', 'import pty; pty.openpty()'], { timeout: 5000 });
  return probe.status === 0 && fs.existsSync('/bin/bash');
}
const testIfPty = canUsePty() ? test : test.skip;

const FOLDER = `terminal-tool-test-${process.pid}`;
const WORKSPACE_ROOT = path.join(process.cwd(), 'storage', 'agents-workspaces', FOLDER);
const context = { sessionId: 901, agentId: 7, userId: 1 };

const call = (params, ctx = context) => toolExecutor.execute('terminal', params, ctx);

beforeAll(() => {
  registerTerminalTool();
});

beforeEach(() => {
  dbAll.mockResolvedValue([{ tool_config: JSON.stringify({ folder_name: FOLDER, randomize_name: false }) }]);
});

afterEach(async () => {
  closeAllTerminals();
  await new Promise((resolve) => setTimeout(resolve, 150));
});

afterAll(async () => {
  closeAllTerminals();
  await new Promise((resolve) => setTimeout(resolve, 600));
  TerminalLog.flushAll();
  fs.rmSync(WORKSPACE_ROOT, { recursive: true, force: true });
});

describe('terminal tool registration', () => {
  test('is registered with the expected operations', () => {
    const tool = toolRegistry.get('terminal');
    expect(tool.parameters.operation.enum).toEqual(['run', 'send', 'read', 'interrupt', 'open', 'list', 'close', 'tail_log']);
    expect(tool.executionTimeout).toBeGreaterThan(120000);
  });

  test('rejects unknown operations and out-of-range values through the executor', async () => {
    expect(await call({ operation: 'rm' })).toMatchObject({ success: false });
    expect(await call({ operation: 'run', command: 'ls', timeout_ms: 5 })).toMatchObject({ success: false });
  });
});

describe('terminal tool guards', () => {
  test('requires local_working_folder to be configured', async () => {
    dbAll.mockResolvedValue([]);
    const result = await call({ operation: 'run', command: 'echo hi' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/local_working_folder must be configured/);
  });

  test('refuses Windows with a clear message', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      const result = await call({ operation: 'list' });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/Linux and macOS only/);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  test('rejects invalid session names', async () => {
    const result = await call({ operation: 'list', session: '../etc' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Session name/);
  });

  test('list needs no workspace and starts empty', async () => {
    dbAll.mockResolvedValue([]);
    const result = await call({ operation: 'list' });
    expect(result).toMatchObject({ success: true, result: { sessions: [] } });
  });

  test('read and interrupt need an existing session', async () => {
    for (const operation of ['read', 'interrupt']) {
      const result = await call({ operation });
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No live terminal session/);
    }
  });

  test('close of an unknown session is not an error', async () => {
    expect(await call({ operation: 'close', session: 'ghost' })).toMatchObject({ success: true, result: { status: 'not_found' } });
  });
});

describe('terminal tool with a live shell', () => {
  testIfPty('auto-starts on run, reports the jail and keeps state', async () => {
    const first = await call({ operation: 'run', command: 'mkdir -p data && cd data && pwd' });
    expect(first.success).toBe(true);
    expect(first.result).toMatchObject({ status: 'done', exit_code: 0, cwd: 'data', started: true, jail: 'soft' });
    expect(first.result.output.endsWith(path.join('agents-workspaces', FOLDER, 'data'))).toBe(true);

    const second = await call({ operation: 'run', command: 'pwd' });
    expect(second.result.started).toBeUndefined();
    expect(second.result.cwd).toBe('data');
  });

  testIfPty('named sessions, list, close and tail_log', async () => {
    await call({ operation: 'run', session: 'db', command: 'echo from-db' });
    await call({ operation: 'run', session: 'svc', command: 'echo from-svc' });

    const listed = await call({ operation: 'list' });
    expect(listed.result.sessions.map((s) => s.session).sort()).toEqual(['db', 'svc']);
    expect(listed.result.sessions[0]).toMatchObject({ state: 'idle', jail: 'soft' });

    const tail = await call({ operation: 'tail_log', session: 'db' });
    expect(tail.result.log).toContain('db$ echo from-db');
    expect(tail.result.log).toContain('db| from-db');
    expect(tail.result.log).not.toContain('svc|');

    const closed = await call({ operation: 'close', session: 'db' });
    expect(closed.result.status).toBe('closed');
    expect((await call({ operation: 'list' })).result.sessions.map((s) => s.session)).toEqual(['svc']);
  });

  testIfPty('keeps its log separate from workspace_exec\'s exec_history.log', async () => {
    await call({ operation: 'run', command: 'echo separate' });
    const logsDir = path.join(WORKSPACE_ROOT, 'logs');
    await call({ operation: 'tail_log' });
    expect(fs.existsSync(path.join(logsDir, 'terminal.log'))).toBe(true);
    expect(fs.existsSync(path.join(logsDir, 'exec_history.log'))).toBe(false);
  });

  testIfPty('each agent gets its own sessions', async () => {
    await call({ operation: 'run', command: 'export OWNER=seven' });
    const other = await call({ operation: 'run', command: 'echo "[$OWNER]"' }, { ...context, agentId: 8 });
    expect(other.result.output).toBe('[]');
    expect(other.result.started).toBe(true);
  });

  testIfPty('rejects a cwd that escapes the workspace, including via symlink', async () => {
    fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
    const link = path.join(WORKSPACE_ROOT, 'escape-link');
    fs.rmSync(link, { force: true });
    fs.symlinkSync(os.tmpdir(), link);

    const traversal = await call({ operation: 'open', session: 'x', cwd: '../../..' });
    expect(traversal.success).toBe(false);
    expect(traversal.error).toMatch(/traversal|outside/i);

    const viaSymlink = await call({ operation: 'open', session: 'y', cwd: 'escape-link' });
    expect(viaSymlink.success).toBe(false);
    expect(viaSymlink.error).toMatch(/outside the workspace/);
  });

  testIfPty('interactive flow: send, secret input, interrupt', async () => {
    const prompt = await call({ operation: 'run', command: "read -s -p 'pw: ' p; echo length:${#p}", timeout_ms: 1000 });
    expect(prompt.result).toMatchObject({ status: 'running', output: 'pw:' });

    const answered = await call({ operation: 'send', input: 'hunter2', secret: true });
    expect(answered.result).toMatchObject({ status: 'done', exit_code: 0 });
    expect(answered.result.output).toBe('length:7');

    const logged = await call({ operation: 'tail_log' });
    expect(logged.result.log).not.toContain('hunter2');
    expect(logged.result.log).toContain('[input hidden]');
  });
});
