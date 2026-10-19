const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddvisor-terminal-list-'));
process.env.DATABASE_PATH = path.join(dbDir, 'test.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'terminal-list-test-secret';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { dbRun, runMigrations, closeDatabase } = require('../../config/database');
const { terminalManager } = require('../../src/services/tools/terminal/TerminalManager');
const sessionsRouter = require('../../src/routes/sessions.routes');
const errorHandler = require('../../src/middleware/errorHandler');

let sessionId;
let otherSessionId;
let agentId;
let app;

function request(method, urlPath, token) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          server.close();
          let parsed = null;
          try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = raw; }
          resolve({ status: res.statusCode, body: parsed });
        });
      });
      req.on('error', (err) => {
        server.close();
        reject(err);
      });
      req.end();
    });
  });
}

beforeAll(async () => {
  await runMigrations();
  await dbRun("INSERT INTO users (username, password_hash) VALUES ('owner', 'x')");
  sessionId = (await dbRun("INSERT INTO work_sessions (user_id, name) VALUES (1, 'With terminal')")).lastID;
  otherSessionId = (await dbRun("INSERT INTO work_sessions (user_id, name) VALUES (1, 'Without terminal')")).lastID;
  agentId = (await dbRun(
    "INSERT INTO agents (user_id, name, role, provider_type, provider_config) VALUES (1, 'Analyst', 'analyst', 'ollama', '{}')"
  )).lastID;
  await dbRun('INSERT INTO session_agents (session_id, agent_id) VALUES (?, ?)', [sessionId, agentId]);
  await dbRun(
    'INSERT INTO session_agent_tools (session_id, agent_id, tool_name) VALUES (?, ?, ?)',
    [sessionId, agentId, 'terminal']
  );

  terminalManager.sessions.set(`${sessionId}:${agentId}|main`, {
    dead: false,
    state: 'idle',
    pending: 'unread by agent',
    log: {
      tail: ({ session }) => (session === 'main'
        ? '2026-10-19T08:00:00.000Z main$ ls\nmain| file.txt'
        : ''),
    },
    summary: () => ({ session: 'main', state: 'idle', cwd: 'reports', jail: 'soft', age_s: 12, idle_s: 3 }),
  });
  terminalManager.sessions.set(`${otherSessionId}:orchestrator|main`, {
    dead: false,
    summary: () => ({ session: 'main', state: 'running', cwd: '.', jail: 'soft', age_s: 1, idle_s: 0 }),
  });

  app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
});

afterAll(async () => {
  terminalManager.sessions.clear();
  await closeDatabase();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('GET /api/sessions/:id/terminals', () => {
  const token = () => jwt.sign({ id: 1, username: 'owner' }, process.env.JWT_SECRET);

  test('lists live sessions for agents that have the terminal tool', async () => {
    const res = await request('GET', `/api/sessions/${sessionId}/terminals`, token());
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(true);
    expect(res.body.data.sessions).toEqual([
      expect.objectContaining({
        owner: agentId,
        owner_name: 'Analyst',
        session: 'main',
        state: 'idle',
        cwd: 'reports',
      }),
    ]);
  });

  test('reports the tool as disabled when it is not assigned', async () => {
    const res = await request('GET', `/api/sessions/${otherSessionId}/terminals`, token());
    expect(res.status).toBe(200);
    expect(res.body.data.enabled).toBe(false);
    expect(res.body.data.sessions).toEqual([]);
  });

  test('returns live output without consuming unread agent output', async () => {
    const shell = terminalManager.sessions.get(`${sessionId}:${agentId}|main`);
    const res = await request('GET', `/api/sessions/${sessionId}/terminals/output?owner=${agentId}&name=main`, token());
    expect(res.status).toBe(200);
    expect(res.body.data.output).toBe('$ ls\nfile.txt');
    expect(res.body.data.owner_name).toBe('Analyst');
    expect(res.body.data.state).toBe('idle');
    expect(shell.pending).toBe('unread by agent');
  });

  test('refuses output for a terminal that is not open', async () => {
    const res = await request('GET', `/api/sessions/${sessionId}/terminals/output?owner=${agentId}&name=missing`, token());
    expect(res.status).toBe(404);
  });

  test('refuses another user', async () => {
    const other = jwt.sign({ id: 99, username: 'stranger' }, process.env.JWT_SECRET);
    const res = await request('GET', `/api/sessions/${sessionId}/terminals`, other);
    expect(res.status).toBe(404);
  });
});
