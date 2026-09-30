const fs = require('fs');
const os = require('os');
const path = require('path');

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buddvisor-telegram-'));
process.env.DATABASE_PATH = path.join(dbDir, 'test.sqlite');

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { dbRun, runMigrations, closeDatabase } = require('../../config/database');
const SessionTelegram = require('../../src/models/SessionTelegram');
const Message = require('../../src/models/Message');
const messageEvents = require('../../src/utils/messageEvents');

let sessionA;
let sessionB;

beforeAll(async () => {
  await runMigrations();
  await dbRun("INSERT INTO users (username, password_hash) VALUES ('owner', 'x')");
  sessionA = (await dbRun("INSERT INTO work_sessions (user_id, name) VALUES (1, 'A')")).lastID;
  sessionB = (await dbRun("INSERT INTO work_sessions (user_id, name) VALUES (1, 'B')")).lastID;
});

afterAll(async () => {
  await closeDatabase();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();

describe('pairing codes', () => {
  test('a valid code works exactly once', async () => {
    await SessionTelegram.createPairing(sessionA, 'hash-once', inMinutes(10));
    expect(await SessionTelegram.consumePairing(sessionA, 'hash-once')).toBe(true);
    expect(await SessionTelegram.consumePairing(sessionA, 'hash-once')).toBe(false);
  });

  test('an expired code is refused', async () => {
    await SessionTelegram.createPairing(sessionA, 'hash-expired', inMinutes(-1));
    expect(await SessionTelegram.consumePairing(sessionA, 'hash-expired')).toBe(false);
  });

  test('a code cannot be used against another session', async () => {
    await SessionTelegram.createPairing(sessionA, 'hash-other', inMinutes(10));
    expect(await SessionTelegram.consumePairing(sessionB, 'hash-other')).toBe(false);
    expect(await SessionTelegram.consumePairing(sessionA, 'hash-other')).toBe(true);
  });

  test('an unknown code is refused', async () => {
    expect(await SessionTelegram.consumePairing(sessionA, 'never-created')).toBe(false);
  });
});

describe('config and chats', () => {
  test('one bot cannot serve two sessions', async () => {
    await SessionTelegram.upsertConfig({ session_id: sessionA, bot_token_encrypted: 'enc', bot_id: 500, bot_username: 'bot_a' });
    await expect(
      SessionTelegram.upsertConfig({ session_id: sessionB, bot_token_encrypted: 'enc', bot_id: 500, bot_username: 'bot_a' })
    ).rejects.toThrow(/UNIQUE/i);
  });

  test('linking the same chat twice keeps one row', async () => {
    const chat = { session_id: sessionA, chat_id: 42, telegram_user_id: 42, username: 'ana', display_name: 'Ana' };
    await SessionTelegram.addChat(chat);
    await SessionTelegram.addChat({ ...chat, username: 'ana2' });
    const chats = await SessionTelegram.listChats(sessionA);
    expect(chats).toHaveLength(1);
    expect(chats[0].username).toBe('ana2');
  });

  test('disconnecting removes the config, pairings and chats', async () => {
    await SessionTelegram.createPairing(sessionA, 'hash-cleanup', inMinutes(10));
    await SessionTelegram.deleteConfig(sessionA);

    expect(await SessionTelegram.getConfig(sessionA)).toBeNull();
    expect(await SessionTelegram.listChats(sessionA)).toHaveLength(0);
    expect(await SessionTelegram.consumePairing(sessionA, 'hash-cleanup')).toBe(false);
  });

  test('disabled bots and inactive sessions are not started at boot', async () => {
    await SessionTelegram.upsertConfig({ session_id: sessionA, bot_token_encrypted: 'enc', bot_id: 600, bot_username: 'bot_a' });
    expect((await SessionTelegram.listEnabledConfigs()).map((c) => c.session_id)).toContain(sessionA);

    await SessionTelegram.setEnabled(sessionA, false, 'off');
    expect((await SessionTelegram.listEnabledConfigs()).map((c) => c.session_id)).not.toContain(sessionA);

    await SessionTelegram.upsertConfig({ session_id: sessionA, bot_token_encrypted: 'enc', bot_id: 600, bot_username: 'bot_a' });
    await dbRun('UPDATE work_sessions SET is_active = 0 WHERE id = ?', [sessionA]);
    expect((await SessionTelegram.listEnabledConfigs()).map((c) => c.session_id)).not.toContain(sessionA);
  });
});

describe('message events', () => {
  test('Message.create announces every stored message, with parsed metadata', async () => {
    const seen = [];
    const listener = (m) => seen.push(m);
    messageEvents.on('created', listener);
    try {
      await Message.create({ session_id: sessionB, role: 'user', content: 'hi', metadata: { username: 'owner' } });
    } finally {
      messageEvents.off('created', listener);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ session_id: sessionB, role: 'user', content: 'hi' });
    expect(seen[0].metadata).toEqual({ username: 'owner' });
  });

  test('emit: false stores the message without announcing it (bulk import)', async () => {
    const listener = jest.fn();
    messageEvents.on('created', listener);
    try {
      await Message.create({ session_id: sessionB, role: 'user', content: 'imported', emit: false });
    } finally {
      messageEvents.off('created', listener);
    }
    expect(listener).not.toHaveBeenCalled();
  });

  test('a failing listener never breaks message creation', async () => {
    const listener = () => { throw new Error('boom'); };
    messageEvents.on('created', listener);
    try {
      const created = await Message.create({ session_id: sessionB, role: 'user', content: 'still saved' });
      expect(created.content).toBe('still saved');
    } finally {
      messageEvents.off('created', listener);
    }
  });
});
