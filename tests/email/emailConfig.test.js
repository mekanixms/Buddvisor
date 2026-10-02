const { resolveEmailAccount, incomingReady, smtpReady, publicAccount } = require('../../src/services/email/emailConfig');

const ENV_KEYS = [
  'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_FROM', 'SMTP_SECURE',
  'IMAP_HOST', 'IMAP_PORT', 'IMAP_USER', 'IMAP_PASS', 'IMAP_MAILBOX',
  'POP3_HOST', 'POP3_PORT', 'POP3_USER', 'POP3_PASS',
  'EMAIL_PROTOCOL', 'EMAIL_SECURE', 'EMAIL_NOTIFY', 'EMAIL_TLS_REJECT_UNAUTHORIZED', 'EMAIL_NOTIFY_OWN',
];

describe('email account config', () => {
  const saved = {};

  beforeEach(() => {
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

  it('reads the session tool config and ignores environment mail settings', () => {
    process.env.IMAP_HOST = 'imap.gmail.com';
    process.env.IMAP_USER = 'env@example.com';
    process.env.IMAP_PASS = 'env-pass';
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'env@example.com';
    process.env.SMTP_PASS = 'env-pass';
    process.env.EMAIL_PROTOCOL = 'pop3';

    const account = resolveEmailAccount({
      protocol: 'imap',
      incoming_host: 'mail.example.com',
      incoming_port: 993,
      username: 'box@example.com',
      password: 'box-pass',
      smtp_host: 'mail.example.com',
      smtp_port: 465,
    });

    expect(account.protocol).toBe('imap');
    expect(account.incoming).toMatchObject({
      host: 'mail.example.com',
      port: 993,
      secure: true,
      user: 'box@example.com',
      pass: 'box-pass',
    });
    expect(account.smtp).toMatchObject({
      host: 'mail.example.com',
      port: 465,
      secure: true,
      user: 'box@example.com',
      pass: 'box-pass',
    });
    expect(incomingReady(account)).toBe(true);
    expect(smtpReady(account)).toBe(true);
    expect(publicAccount(account).username).toBe('box@example.com');
    expect(JSON.stringify(publicAccount(account))).not.toContain('box-pass');
    expect(JSON.stringify(account.smtp)).not.toContain('gmail');
  });

  it('uses POP3 and STARTTLS SMTP from the session config', () => {
    const account = resolveEmailAccount({
      protocol: 'pop3',
      incoming_host: 'pop.example.com',
      incoming_port: 995,
      username: 'box@example.com',
      password: 'box-pass',
      smtp_host: 'smtp.box.example.com',
      smtp_port: 587,
      notify: false,
    });

    expect(account.protocol).toBe('pop3');
    expect(account.incoming).toMatchObject({ host: 'pop.example.com', port: 995, secure: true, user: 'box@example.com', pass: 'box-pass' });
    expect(account.smtp).toMatchObject({ host: 'smtp.box.example.com', port: 587, secure: false, user: 'box@example.com' });
    expect(account.notify).toBe(false);
  });

  it('treats port 143 as STARTTLS and an explicit secure flag as authoritative', () => {
    expect(resolveEmailAccount({ incoming_host: 'imap.example.com', incoming_port: 143, username: 'a', password: 'b' }).incoming)
      .toMatchObject({ port: 143, secure: false });
    expect(resolveEmailAccount({ incoming_host: 'imap.example.com', incoming_port: 143, secure: true, username: 'a', password: 'b' }).incoming)
      .toMatchObject({ port: 143, secure: true });
  });

  it('rejects protocols other than imap and pop3', () => {
    expect(() => resolveEmailAccount({ protocol: 'exchange' })).toThrow(/imap or pop3/);
  });

  it('reports which side is missing when the session config is empty', () => {
    process.env.SMTP_HOST = 'smtp.gmail.com';
    process.env.SMTP_USER = 'env@example.com';
    process.env.SMTP_PASS = 'env-pass';
    const account = resolveEmailAccount({});
    expect(account.incoming.host).toBe('');
    expect(account.smtp.host).toBe('');
    expect(incomingReady(account)).toBe(false);
    expect(smtpReady(account)).toBe(false);
  });
});
