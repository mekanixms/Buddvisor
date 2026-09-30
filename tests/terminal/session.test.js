/**
 * Integration tests: real bash on a real PTY (Linux/macOS). Skipped automatically
 * on hosts that cannot allocate a PTY or lack python3/bash.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function canUsePty() {
  if (!['linux', 'darwin'].includes(process.platform)) return false;
  const probe = spawnSync('python3', ['-c', 'import pty; pty.openpty()'], { timeout: 5000 });
  return probe.status === 0 && fs.existsSync('/bin/bash');
}

const describeIfPty = canUsePty() ? describe : describe.skip;

process.env.TERMINAL_SANDBOX = 'off';

const { TerminalSession } = require('../../src/services/tools/terminal/TerminalSession');
const { TerminalManager } = require('../../src/services/tools/terminal/TerminalManager');
const { TerminalLog } = require('../../src/services/tools/terminal/TerminalLog');

describeIfPty('TerminalSession', () => {
  let workspace;
  let log;
  const opened = [];

  async function open(name = 'main', extra = {}) {
    const session = new TerminalSession({
      name, workspace, startDir: workspace, jail: null, log, idleTimeoutMs: 60000, ...extra,
    });
    await session.start();
    opened.push(session);
    return session;
  }

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-ws-')));
    log = new TerminalLog(path.join(workspace, 'logs', 'terminal.log'));
  });

  afterEach(async () => {
    while (opened.length) opened.pop().close('test cleanup');
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('runs commands and reports exit codes', async () => {
    const session = await open();
    await expect(session.run('echo hello')).resolves.toMatchObject({ status: 'done', exit_code: 0, output: 'hello', cwd: '.' });
    await expect(session.run('false')).resolves.toMatchObject({ status: 'done', exit_code: 1 });
  });

  test('keeps cwd and environment between calls', async () => {
    fs.mkdirSync(path.join(workspace, 'sub'));
    const session = await open();
    await session.run('cd sub && export GREETING=hi');
    const result = await session.run('echo "$GREETING from $(basename "$PWD")"');
    expect(result.output).toBe('hi from sub');
    expect(result.cwd).toBe('sub');
  });

  test('handles multi-line commands with quotes', async () => {
    const session = await open();
    const result = await session.run("echo 'it'\\''s'\nfor i in 1 2; do echo n$i; done\ncat <<EOF\nhere doc\nEOF");
    expect(result.output).toBe("it's\nn1\nn2\nhere doc");
  });

  test('does not echo input and does not expand history', async () => {
    const session = await open();
    const result = await session.run('echo "wow!"; echo !!');
    expect(result.output).toBe('wow!\n!!');
  });

  test('send talks to an interactive program and run is refused meanwhile', async () => {
    const session = await open();
    const waiting = await session.run("read -p 'name? ' n; echo hi $n", { timeoutMs: 1000 });
    expect(waiting).toMatchObject({ status: 'running', output: 'name?' });
    expect(waiting.exit_code).toBeUndefined();

    await expect(session.run('echo nope')).rejects.toThrow(/busy/);

    const answered = await session.send('bob');
    expect(answered).toMatchObject({ status: 'done', exit_code: 0, output: 'hi bob' });
  });

  test('gives programs a real tty and keeps a REPL logged in across calls', async () => {
    const session = await open();
    const started = await session.send('python3 -q', { waitMs: 3000 });
    expect(started.status).toBe('running');
    await session.send('import sys; x = 41');
    const answer = await session.send('print(x + 1, sys.stdin.isatty())');
    expect(answer.output).toContain('42 True');
    const exited = await session.send('exit()');
    expect(exited.status).toBe('done');
  });

  test('interrupt stops a long command and keeps the shell', async () => {
    const session = await open();
    const running = await session.run('sleep 30', { timeoutMs: 1000 });
    expect(running.status).toBe('running');
    const stopped = await session.interrupt();
    expect(stopped).toMatchObject({ status: 'done', exit_code: 130 });
    await expect(session.run('echo alive')).resolves.toMatchObject({ output: 'alive' });
  });

  test('read collects output from a background service', async () => {
    const session = await open();
    const started = await session.run('(sleep 0.4; for i in 1 2 3; do echo tick$i; sleep 0.2; done) &');
    expect(started.status).toBe('done');
    const result = await session.read({ waitMs: 3000, idleMs: 600 });
    expect(result.output).toContain('tick1');
    expect(result.output).toContain('tick3');
  });

  test('stale background output is reported separately from the next command', async () => {
    const session = await open();
    await session.run('(sleep 0.3; echo BG_PAYLOAD_$((1+1))) &');
    await new Promise((resolve) => setTimeout(resolve, 700));
    const result = await session.run('echo foreground');
    expect(result.output.startsWith('foreground')).toBe(true);
    expect(result.output).not.toContain('BG_PAYLOAD_2');
    expect(result.background_output).toContain('BG_PAYLOAD_2');
  });

  test('pulls the shell back into the workspace after cd outside', async () => {
    const session = await open();
    const result = await session.run('cd / && pwd');
    expect(result.note).toMatch(/returned to its root/);
    expect(result.cwd).toBe('.');
    await expect(session.run('pwd')).resolves.toMatchObject({ output: workspace });
  });

  test('refuses privilege escalation', async () => {
    const session = await open();
    await expect(session.run('sudo ls')).rejects.toThrow(/not allowed/);
    await expect(session.run('echo hi && su root')).rejects.toThrow(/not allowed/);
    await expect(session.run('ls su_file')).resolves.toMatchObject({ status: 'done' });
  });

  test('does not leak the server environment to the shell', async () => {
    process.env.JWT_SECRET = 'super-secret-value';
    const session = await open();
    const result = await session.run('env');
    expect(result.output).not.toContain('super-secret-value');
    expect(result.output).toContain(`HOME=${workspace}`);
    delete process.env.JWT_SECRET;
  });

  test('trims long output but keeps start and end', async () => {
    const session = await open();
    const result = await session.run('seq 1 20000', { maxChars: 500 });
    expect(result.omitted_chars).toBeGreaterThan(0);
    expect(result.output.startsWith('1\n2\n')).toBe(true);
    expect(result.output.endsWith('20000')).toBe(true);
    expect(result.output.length).toBeLessThan(700);
  });

  test('reports a shell that exits', async () => {
    const session = await open();
    const result = await session.run('exit 3');
    expect(result).toMatchObject({ status: 'exited', exit_code: 3 });
    await expect(session.run('echo again')).rejects.toThrow(/exited/);
  });

  test('writes inputs and output to terminal.log, never secrets', async () => {
    const session = await open('db');
    await session.run('echo visible-output');
    await session.run("read -s -p 'pw: ' p", { timeoutMs: 500 });
    await session.send('hunter2', { secret: true });
    const logged = log.tail({ session: 'db' });
    expect(logged).toMatch(/db\$ echo visible-output/);
    expect(logged).toContain('db| visible-output');
    expect(logged).toContain('[input hidden]');
    expect(logged).not.toContain('hunter2');
    expect(fs.existsSync(path.join(workspace, 'logs', 'exec_history.log'))).toBe(false);
  });

  test('close terminates the shell and its programs', async () => {
    const session = await open();
    await session.run('sleep 300 &');
    const pidResult = await session.run('echo $!');
    const sleepPid = Number(pidResult.output);
    session.close('test');
    await new Promise((resolve) => setTimeout(resolve, 2500));
    expect(session.dead).toBe(true);
    expect(() => process.kill(sleepPid, 0)).toThrow();
  });
});

describeIfPty('TerminalManager', () => {
  let workspace;
  let manager;

  beforeEach(() => {
    workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-mgr-')));
    manager = new TerminalManager();
  });

  afterEach(async () => {
    manager.closeAll();
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const open = (scope, name, extra = {}) => manager.open({ scope, name, workspace, startDir: workspace, ...extra });

  test('named sessions are independent and reused', async () => {
    const a = await open('1:5', 'db');
    const b = await open('1:5', 'server');
    await a.session.run('export WHO=db');
    await b.session.run('export WHO=server');
    expect((await a.session.run('echo $WHO')).output).toBe('db');
    expect((await b.session.run('echo $WHO')).output).toBe('server');

    const again = await open('1:5', 'db');
    expect(again.started).toBe(false);
    expect(again.session).toBe(a.session);
    expect(manager.list('1:5').map((s) => s.session).sort()).toEqual(['db', 'server']);
  });

  test('agents cannot see each other\'s sessions', async () => {
    await open('1:5', 'main');
    expect(manager.get('1:6', 'main')).toBeNull();
    expect(manager.list('1:6')).toEqual([]);
  });

  test('enforces the per-agent session limit', async () => {
    process.env.TERMINAL_MAX_SESSIONS_PER_AGENT = '2';
    try {
      await open('1:5', 'a');
      await open('1:5', 'b');
      await expect(open('1:5', 'c')).rejects.toThrow(/limit/);
    } finally {
      delete process.env.TERMINAL_MAX_SESSIONS_PER_AGENT;
    }
  });

  test('restarts a session whose shell exited and says so', async () => {
    const first = await open('1:5', 'main');
    await first.session.run('exit 4');
    const second = await open('1:5', 'main');
    expect(second.started).toBe(true);
    expect(second.note).toMatch(/had exited \(code 4\)/);
  });

  test('sweeps sessions idle beyond their timeout', async () => {
    const { session } = await open('1:5', 'main', { idleTimeoutMs: 60000 });
    session.idleTimeoutMs = 10;
    await new Promise((resolve) => setTimeout(resolve, 30));
    manager.sweep();
    expect(manager.get('1:5', 'main')).toBeNull();
  });

  test('concurrent opens of the same name share one shell', async () => {
    const [x, y] = await Promise.all([open('1:5', 'main'), open('1:5', 'main')]);
    expect(x.session).toBe(y.session);
  });
});
