jest.mock('../../src/services/email/mailOps', () => ({
  listMessages: jest.fn(),
  readMessage: jest.fn(),
  sendMessage: jest.fn(),
  setSeen: jest.fn(),
  moveMessages: jest.fn(),
  moveToSpecial: jest.fn(),
  createFolder: jest.fn(),
  deleteFolder: jest.fn(),
  renameFolder: jest.fn(),
  listFolders: jest.fn(),
  checkAccount: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../config/database', () => ({
  dbAll: jest.fn(),
}));

const mailOps = require('../../src/services/email/mailOps');
const { dbAll } = require('../../config/database');
const { toolRegistry } = require('../../src/services/tools/ToolRegistry');
const { registerEmailTool } = require('../../src/services/tools/emailTool');

const ENV_KEYS = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS',
  'IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS',
  'POP3_HOST', 'POP3_USER', 'POP3_PASS', 'EMAIL_PROTOCOL', 'EMAIL_NOTIFY',
];

describe('email tool', () => {
  let handler;
  const saved = {};
  const ctx = {
    sessionId: 4,
    agentId: 9,
    toolConfig: {
      protocol: 'imap',
      incoming_host: 'imap.example.com',
      username: 'ada@example.com',
      password: 'secret',
      smtp_host: 'smtp.example.com',
      smtp_port: 587,
    },
  };

  beforeAll(() => {
    registerEmailTool();
    handler = toolRegistry.get('email').handler;
  });

  afterAll(() => {
    toolRegistry.unregister('email');
  });

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] == null) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('lists mail with the resolved account and does not echo the password', async () => {
    mailOps.listMessages.mockResolvedValue({ messages: [] });
    const result = await handler({ action: 'list', unseen: true, limit: 5 }, ctx);
    expect(result.messages).toEqual([]);
    const account = mailOps.listMessages.mock.calls[0][0];
    expect(account.incoming).toMatchObject({ host: 'imap.example.com', port: 993, secure: true, user: 'ada@example.com' });
    expect(account.smtp.port).toBe(587);
    expect(account.smtp.secure).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('refuses folder actions on POP3', async () => {
    const pop = { ...ctx, toolConfig: { ...ctx.toolConfig, protocol: 'pop3', incoming_port: 995 } };
    await expect(handler({ action: 'archive', id: 'abc' }, pop)).rejects.toThrow(/POP3/);
    await expect(handler({ action: 'spam', id: 'abc' }, pop)).rejects.toThrow(/IMAP/);
    expect(mailOps.moveToSpecial).not.toHaveBeenCalled();
  });

  it('creates, deletes, and renames IMAP folders', async () => {
    mailOps.createFolder.mockResolvedValue({ action: 'create_folder', folder: 'Projects' });
    mailOps.deleteFolder.mockResolvedValue({ action: 'delete_folder', folder: 'Projects' });
    mailOps.renameFolder.mockResolvedValue({ action: 'rename_folder', folder: 'Projects', destination: 'Clients' });
    await handler({ action: 'create_folder', folder: 'Projects' }, ctx);
    await handler({ action: 'delete_folder', folder: 'Projects' }, ctx);
    await handler({ action: 'rename_folder', folder: 'Projects', destination: 'Clients' }, ctx);
    expect(mailOps.createFolder).toHaveBeenCalledWith(expect.any(Object), 'Projects');
    expect(mailOps.deleteFolder).toHaveBeenCalledWith(expect.any(Object), 'Projects');
    expect(mailOps.renameFolder).toHaveBeenCalledWith(expect.any(Object), 'Projects', 'Clients');
  });

  it('refuses folder management on POP3 and a rename without a new name', async () => {
    const pop = { ...ctx, toolConfig: { ...ctx.toolConfig, protocol: 'pop3', incoming_port: 995 } };
    await expect(handler({ action: 'create_folder', folder: 'Projects' }, pop)).rejects.toThrow(/POP3/);
    await expect(handler({ action: 'rename_folder', folder: 'Projects' }, ctx)).rejects.toThrow(/destination/);
    expect(mailOps.createFolder).not.toHaveBeenCalled();
    expect(mailOps.renameFolder).not.toHaveBeenCalled();
  });

  it('requires a destination when moving', async () => {
    await expect(handler({ action: 'move', id: '12' }, ctx)).rejects.toThrow(/destination/);
    expect(mailOps.moveMessages).not.toHaveBeenCalled();
  });

  it('sends through SMTP and threads a reply', async () => {
    mailOps.sendMessage.mockResolvedValue({ message_id: '<sent@example.com>', accepted: ['bob@example.com'], rejected: [] });
    const result = await handler({
      action: 'send',
      to: 'bob@example.com',
      subject: 'Hello',
      text: 'Hi',
      reply_to_id: '12',
    }, ctx);
    expect(result.message_id).toBe('<sent@example.com>');
    expect(mailOps.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ smtp: expect.objectContaining({ host: 'smtp.example.com' }) }),
      expect.objectContaining({ to: 'bob@example.com', reply_to_id: '12' }),
      ctx
    );
  });

  it('tells the caller to configure a mailbox before listing', async () => {
    await expect(handler({ action: 'list' }, { sessionId: 4, agentId: 9, toolConfig: {} })).rejects.toThrow(/Configure Session/);
    expect(mailOps.listMessages).not.toHaveBeenCalled();
  });

  it('loads the saved email config when another tool left its config on the context', async () => {
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_USER = 'gmail@example.com';
    process.env.SMTP_PASS = 'gmail-pass';
    dbAll.mockResolvedValue([{
      tool_config: JSON.stringify({
        protocol: 'imap',
        incoming_host: 'mail.example.com',
        incoming_port: 993,
        username: 'box@example.com',
        password: 'box-pass',
        smtp_host: 'mail.example.com',
        smtp_port: 465,
      }),
    }]);
    mailOps.listMessages.mockResolvedValue({ messages: [] });
    await handler({ action: 'list' }, {
      sessionId: 82,
      agentId: 51,
      toolConfig: { folder_name: 'workspace' },
    });
    const account = mailOps.listMessages.mock.calls[0][0];
    expect(account.incoming).toMatchObject({ host: 'mail.example.com', user: 'box@example.com' });
    expect(account.smtp).toMatchObject({ host: 'mail.example.com', port: 465, user: 'box@example.com' });
    expect(JSON.stringify(account)).not.toContain('gmail');
  });

  it('reports watcher state without connecting unless check is set', async () => {
    const status = await handler({ action: 'status' }, ctx);
    expect(status.incoming_configured).toBe(true);
    expect(status.smtp_configured).toBe(true);
    expect(status.watcher.running).toBe(false);
    expect(mailOps.checkAccount).not.toHaveBeenCalled();

    mailOps.checkAccount.mockResolvedValue({ incoming: { ok: true }, smtp: { ok: true } });
    const checked = await handler({ action: 'status', check: true }, ctx);
    expect(checked.check.incoming.ok).toBe(true);
  });
});
