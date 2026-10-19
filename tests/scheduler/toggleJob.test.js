const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddvisor-cron-toggle-'));
process.env.DATABASE_PATH = path.join(dbDir, 'test.sqlite');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'cron-toggle-test-secret';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { dbRun, runMigrations, closeDatabase } = require('../../config/database');
const SessionScheduledJob = require('../../src/models/SessionScheduledJob');
const sessionsRouter = require('../../src/routes/sessions.routes');
const errorHandler = require('../../src/middleware/errorHandler');

let ownerSession;
let otherSession;
let app;

function tokenFor(userId, extra = {}) {
  return jwt.sign({ id: userId, username: extra.username || 'owner', ...extra }, process.env.JWT_SECRET);
}

function request(method, urlPath, token, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const payload = body == null ? null : JSON.stringify(body);
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: urlPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
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
      if (payload) req.write(payload);
      req.end();
    });
  });
}

beforeAll(async () => {
  await runMigrations();
  await dbRun("INSERT INTO users (username, password_hash) VALUES ('owner', 'x')");
  await dbRun("INSERT INTO users (username, password_hash) VALUES ('other', 'x')");
  ownerSession = (await dbRun("INSERT INTO work_sessions (user_id, name) VALUES (1, 'Owner')")).lastID;
  otherSession = (await dbRun("INSERT INTO work_sessions (user_id, name) VALUES (2, 'Other')")).lastID;

  app = express();
  app.use(express.json());
  app.use('/api/sessions', sessionsRouter);
  app.use(errorHandler);
});

afterAll(async () => {
  await closeDatabase();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe('PATCH /api/sessions/scheduled-jobs/:id', () => {
  test('disables an enabled job and enables it again without running an overdue slot immediately', async () => {
    const overdue = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const job = await SessionScheduledJob.create({
      session_id: ownerSession,
      task_key: 'daily-report',
      schedule_type: 'cron',
      schedule_value: '30 21 * * *',
      task_type: 'prompt',
      prompt_text: 'status',
      enabled: 1,
      next_run_at: overdue,
    });

    const ownerToken = tokenFor(1);
    const off = await request('PATCH', `/api/sessions/scheduled-jobs/${job.id}`, ownerToken, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.data.job.enabled).toBe(0);
    expect(off.body.data.job.next_run_at).toBe(overdue);

    const on = await request('PATCH', `/api/sessions/scheduled-jobs/${job.id}`, ownerToken, { enabled: true });
    expect(on.status).toBe(200);
    expect(on.body.data.job.enabled).toBe(1);
    expect(new Date(on.body.data.job.next_run_at).getTime()).toBeGreaterThan(Date.now());
  });

  test('refuses a job owned by someone else', async () => {
    const job = await SessionScheduledJob.create({
      session_id: otherSession,
      task_key: 'other-job',
      schedule_type: 'interval',
      schedule_value: '3600',
      task_type: 'prompt',
      prompt_text: 'nope',
      enabled: 1,
      next_run_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    const res = await request('PATCH', `/api/sessions/scheduled-jobs/${job.id}`, tokenFor(1), { enabled: false });
    expect(res.status).toBe(404);
    const still = await SessionScheduledJob.findById(job.id);
    expect(still.enabled).toBe(1);
  });

  test('a share link can toggle only its own session', async () => {
    const job = await SessionScheduledJob.create({
      session_id: ownerSession,
      task_key: 'share-job',
      schedule_type: 'interval',
      schedule_value: '3600',
      task_type: 'prompt',
      prompt_text: 'shared',
      enabled: 1,
      next_run_at: new Date(Date.now() + 3600 * 1000).toISOString(),
    });
    const shareOther = tokenFor(1, { username: 'share', shareSessionId: otherSession });
    const denied = await request('PATCH', `/api/sessions/scheduled-jobs/${job.id}`, shareOther, { enabled: false });
    expect(denied.status).toBe(404);

    const shareOwn = tokenFor(1, { username: 'share', shareSessionId: ownerSession });
    const allowed = await request('PATCH', `/api/sessions/scheduled-jobs/${job.id}`, shareOwn, { enabled: false });
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.job.enabled).toBe(0);
  });
});
