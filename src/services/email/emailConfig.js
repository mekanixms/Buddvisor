/**
 * Resolve an email account from the Configure Session tool config only.
 * Incoming IMAP/POP3 and outgoing SMTP are resolved separately so send can work
 * when only the SMTP fields are set, and read can work when only the incoming side is set.
 */

const PROTOCOLS = new Set(['imap', 'pop3']);

function clean(value) {
  if (value == null) return '';
  return String(value).trim();
}

function boolFrom(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
}

function parsePort(value) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return n;
}

function firstSecret(values) {
  for (const value of values) {
    if (value != null && String(value) !== '') return String(value);
  }
  return '';
}

function resolveEmailAccount(toolConfig) {
  const cfg = toolConfig && typeof toolConfig === 'object' && !Array.isArray(toolConfig) ? toolConfig : {};
  const protocol = clean(cfg.protocol || cfg.incoming_protocol || 'imap').toLowerCase();
  if (!PROTOCOLS.has(protocol)) {
    throw new Error('Email protocol must be imap or pop3.');
  }

  const explicitPortRaw = cfg.incoming_port != null && cfg.incoming_port !== ''
    ? cfg.incoming_port
    : cfg.port;
  const hasExplicitPort = explicitPortRaw != null && String(explicitPortRaw).trim() !== '';
  const parsedPort = hasExplicitPort ? parsePort(explicitPortRaw) : null;

  let secure;
  if (cfg.secure != null && cfg.secure !== '') secure = boolFrom(cfg.secure, true);
  else if (cfg.incoming_secure != null && cfg.incoming_secure !== '') secure = boolFrom(cfg.incoming_secure, true);
  else if (parsedPort === 143 || parsedPort === 110) secure = false;
  else secure = true;

  const port = parsedPort || (protocol === 'pop3' ? (secure ? 995 : 110) : (secure ? 993 : 143));
  const incomingHost = clean(cfg.incoming_host || cfg.host);
  const username = clean(cfg.username || cfg.user);
  const password = firstSecret([cfg.password, cfg.pass]);

  const smtpPortRaw = cfg.smtp_port;
  const smtpPort = smtpPortRaw != null && String(smtpPortRaw).trim() !== '' ? parsePort(smtpPortRaw) : 587;
  const smtpSecure = cfg.smtp_secure != null && cfg.smtp_secure !== ''
    ? boolFrom(cfg.smtp_secure, smtpPort === 465)
    : smtpPort === 465;

  const smtpUser = clean(cfg.smtp_user) || username;
  const smtpPass = firstSecret([cfg.smtp_pass, password]);
  const fromAddress = clean(cfg.from_address || cfg.from) || smtpUser || username;
  const mailbox = clean(cfg.mailbox) || 'INBOX';
  const rejectUnauthorized = cfg.reject_unauthorized != null && cfg.reject_unauthorized !== ''
    ? boolFrom(cfg.reject_unauthorized, true)
    : true;
  const notify = cfg.notify != null && cfg.notify !== ''
    ? boolFrom(cfg.notify, true)
    : true;
  const notifyOwn = cfg.notify_own != null && cfg.notify_own !== ''
    ? boolFrom(cfg.notify_own, false)
    : false;

  return {
    protocol,
    incoming: {
      host: incomingHost,
      port,
      secure: !!secure,
      user: username,
      pass: password,
    },
    smtp: {
      host: clean(cfg.smtp_host),
      port: smtpPort,
      secure: !!smtpSecure,
      user: smtpUser,
      pass: smtpPass,
    },
    fromAddress,
    mailbox,
    rejectUnauthorized: !!rejectUnauthorized,
    notify: !!notify,
    notifyOwn: !!notifyOwn,
  };
}

function incomingReady(account) {
  return !!(account && account.incoming.host && account.incoming.user && account.incoming.pass);
}

function smtpReady(account) {
  return !!(account && account.smtp.host && account.smtp.user && account.smtp.pass);
}

function publicAccount(account) {
  return {
    protocol: account.protocol,
    incoming_host: account.incoming.host || null,
    incoming_port: account.incoming.port,
    incoming_tls: account.incoming.secure ? 'implicit' : 'starttls',
    incoming_configured: incomingReady(account),
    smtp_host: account.smtp.host || null,
    smtp_port: account.smtp.port,
    smtp_tls: account.smtp.secure ? 'implicit' : 'starttls',
    smtp_configured: smtpReady(account),
    username: account.incoming.user || null,
    from_address: account.fromAddress || null,
    mailbox: account.mailbox,
    notify: account.notify,
    verify_ssl: account.rejectUnauthorized,
  };
}

module.exports = {
  resolveEmailAccount,
  incomingReady,
  smtpReady,
  publicAccount,
};
