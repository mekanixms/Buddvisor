const fs = require('fs');
const os = require('os');
const path = require('path');

const { cleanTerminalText, trimBlock, truncateMiddle, shellQuote, findLongLine } = require('../../src/services/tools/terminal/textUtils');
const { TerminalLog } = require('../../src/services/tools/terminal/TerminalLog');
const { bwrapArgs, sandboxExecProfile, buildWrapper } = require('../../src/services/tools/terminal/sandbox');
const { validateEnv } = require('../../src/services/tools/terminal/TerminalSession');
const { TerminalManager } = require('../../src/services/tools/terminal/TerminalManager');

describe('textUtils', () => {
  test('strips ANSI sequences and normalizes line endings', () => {
    expect(cleanTerminalText('\u001b[31mred\u001b[0m\r\nnext\r\n')).toBe('red\nnext\n');
  });

  test('keeps only the final state of carriage-return rewrites', () => {
    expect(cleanTerminalText('10%\r50%\r100%\r\ndone')).toBe('100%\ndone');
    expect(cleanTerminalText('partial\r')).toBe('partial');
  });

  test('trimBlock removes leading blank lines and trailing whitespace', () => {
    expect(trimBlock('\n\n  \nhello\n\n')).toBe('hello');
  });

  test('truncateMiddle keeps head and most of the tail', () => {
    const text = 'a'.repeat(1000) + 'b'.repeat(1000);
    const { text: shortened, omitted } = truncateMiddle(text, 400);
    expect(omitted).toBe(1600);
    expect(shortened.startsWith('a'.repeat(100))).toBe(true);
    expect(shortened.endsWith('b'.repeat(300))).toBe(true);
    expect(shortened).toContain('[1600 chars omitted]');
  });

  test('truncateMiddle leaves short text alone', () => {
    expect(truncateMiddle('short', 400)).toEqual({ text: 'short', omitted: 0 });
  });

  test('shellQuote survives single quotes', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });

  test('findLongLine locates the offending line', () => {
    expect(findLongLine('ok\n' + 'x'.repeat(50), 10)).toBe(1);
    expect(findLongLine('ok\nfine', 10)).toBe(-1);
  });
});

describe('TerminalLog', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-log-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('writes compact tagged lines and filters by session', () => {
    const log = new TerminalLog(path.join(dir, 'logs', 'terminal.log'));
    log.input('db', 'select 1;');
    log.output('db', 'result\n\n\nrow');
    log.input('srv', 'npm start');
    log.output('srv', 'listening');
    log.event('db', 'exited code=0');

    const dbLines = log.tail({ session: 'db' }).split('\n');
    expect(dbLines).toHaveLength(4);
    expect(dbLines[0]).toMatch(/^\S+ db\$ select 1;$/);
    expect(dbLines[1]).toBe('db| result');
    expect(dbLines[2]).toBe('db| row');
    expect(dbLines[3]).toMatch(/^\S+ db# exited code=0$/);
    expect(log.tail({ session: 'srv' })).not.toContain('db|');
  });

  test('hides secret input and truncates long lines', () => {
    const log = new TerminalLog(path.join(dir, 'terminal.log'), { maxLineChars: 20 });
    log.input('main', 'hunter2', { secret: true });
    log.output('main', 'x'.repeat(100));
    const content = log.tail();
    expect(content).not.toContain('hunter2');
    expect(content).toContain('[input hidden]');
    expect(content).toContain(`main| ${'x'.repeat(20)}…`);
  });

  test('rotates to a single backup file when the size cap is hit', () => {
    const file = path.join(dir, 'terminal.log');
    const log = new TerminalLog(file, { maxBytes: 200 });
    for (let i = 0; i < 20; i += 1) {
      log.output('main', `line number ${i} with some padding text`);
      log.flush();
    }
    expect(fs.existsSync(`${file}.1`)).toBe(true);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(200);
    expect(fs.existsSync(`${file}.2`)).toBe(false);
  });

  test('tail of a missing log is empty', () => {
    const log = new TerminalLog(path.join(dir, 'nothing', 'terminal.log'));
    expect(log.tail()).toBe('');
  });
});

describe('sandbox wrappers', () => {
  const options = { hide: ['/home/u'], allowRead: ['/home/u/.nvm'], documentTargets: ['/app/storage/documents/a.pdf'] };

  test('bwrap: read-only system, hidden home, writable workspace only', () => {
    const args = bwrapArgs('/app/storage/agents-workspaces/w_1', options).join(' ');
    expect(args).toContain('--ro-bind / /');
    expect(args).toContain('--unshare-pid');
    expect(args.indexOf('--tmpfs /home/u')).toBeLessThan(args.indexOf('--ro-bind /home/u/.nvm'));
    expect(args.indexOf('--tmpfs /home/u')).toBeLessThan(args.indexOf('--bind /app/storage/agents-workspaces/w_1'));
    expect(args).toContain('--ro-bind /app/storage/documents/a.pdf /app/storage/documents/a.pdf');
    expect(args).toContain('--chdir /app/storage/agents-workspaces/w_1');
    expect(args.endsWith('--')).toBe(true);
  });

  test('sandbox-exec: deny writes by default, allow workspace, hide reads', () => {
    const profile = sandboxExecProfile('/Users/u/app/ws"1', { ...options, hide: ['/Users/u'] });
    expect(profile).toContain('(deny file-write*)');
    expect(profile).toContain('(subpath "/Users/u/app/ws\\"1")');
    expect(profile).toContain('(deny file-read-data (subpath "/Users/u"))');
    expect(profile.indexOf('(deny file-read-data')).toBeLessThan(profile.indexOf('(allow file-read-data (subpath "/Users/u/app/ws'));
  });

  test('soft jail adds no wrapper', () => {
    expect(buildWrapper(null, '/tmp/ws')).toEqual([]);
  });
});

describe('validation', () => {
  test('session names', () => {
    expect(TerminalManager.validateName('db-1_a')).toBe('db-1_a');
    expect(() => TerminalManager.validateName('bad name')).toThrow();
    expect(() => TerminalManager.validateName('a'.repeat(33))).toThrow();
    expect(() => TerminalManager.validateName('../x')).toThrow();
  });

  test('env variables', () => {
    expect(validateEnv({ PYTHONPATH: './lib' })).toEqual({ PYTHONPATH: './lib' });
    expect(() => validateEnv({ PATH: '/x' })).toThrow(/cannot be set/);
    expect(() => validateEnv({ PS1: 'x' })).toThrow(/cannot be set/);
    expect(() => validateEnv({ 'BAD-NAME': 'x' })).toThrow(/Invalid/);
    expect(() => validateEnv({ N: 1 })).toThrow(/string/);
  });

  test('scope separates agents and the orchestrator', () => {
    expect(TerminalManager.scopeOf({ sessionId: 1, agentId: 2 })).toBe('1:2');
    expect(TerminalManager.scopeOf({ sessionId: 1 })).toBe('1:orchestrator');
  });
});
