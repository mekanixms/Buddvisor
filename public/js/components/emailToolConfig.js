/**
 * Configure Session → Tools fields for the email tool.
 * The mailbox is whatever is saved here. Blank host, username, or password means that side is not configured.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) {
    root.renderEmailToolConfig = api.renderEmailToolConfig;
    root.readEmailToolConfig = api.readEmailToolConfig;
  }
})(typeof window !== 'undefined' ? window : global, function () {
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function field(key, placeholder, value, extra) {
    const type = extra && extra.type ? extra.type : 'text';
    const title = extra && extra.title ? ` title="${esc(extra.title)}"` : '';
    return `<input type="${type}" class="form-control form-control-sm" placeholder="${esc(placeholder)}" data-config-key="${key}" value="${esc(value || '')}" style="font-size: 0.75rem;" autocomplete="off"${title}>`;
  }

  function renderEmailToolConfig(options) {
    const opts = options || {};
    const cfg = opts.cfg || {};
    const protocol = String(cfg.protocol || 'imap').toLowerCase() === 'pop3' ? 'pop3' : 'imap';
    const owner = opts.isOrchestrator
      ? ' data-is-orchestrator="true"'
      : ` data-agent-id="${esc(opts.agentId)}"`;
    const checked = (flag, defaultOn) => ((flag == null ? defaultOn : flag !== false && flag !== 'false') ? 'checked' : '');
    return `
      <div class="email-config-block d-flex flex-column gap-1" data-tool-name="email"${owner} style="min-width: 210px;">
        <label class="small mb-0 text-start"><input type="checkbox" data-config-key="enabled" ${opts.enabled ? 'checked' : ''}> Enable</label>
        <select class="form-select form-select-sm" data-config-key="protocol" style="font-size: 0.75rem;" title="Incoming protocol. Outgoing mail is always SMTP.">
          <option value="imap" ${protocol === 'imap' ? 'selected' : ''}>IMAP</option>
          <option value="pop3" ${protocol === 'pop3' ? 'selected' : ''}>POP3</option>
        </select>
        ${field('incoming_host', 'Incoming host', cfg.incoming_host || cfg.host, { title: 'IMAP or POP3 server' })}
        ${field('incoming_port', 'Port 993 / 995', cfg.incoming_port || cfg.port, { title: '993/995 implicit TLS, 143/110 STARTTLS' })}
        ${field('smtp_host', 'SMTP host', cfg.smtp_host)}
        ${field('smtp_port', 'SMTP port 587 or 465', cfg.smtp_port, { title: '465 is implicit TLS. Any other port uses STARTTLS.' })}
        ${field('username', 'Username', cfg.username || cfg.user)}
        ${field('password', 'Password (blank keeps saved)', cfg.password, { type: 'password', title: 'Blank keeps the saved password' })}
        ${field('from_address', 'From address (optional)', cfg.from_address || cfg.from)}
        ${field('mailbox', 'IMAP mailbox (INBOX)', cfg.mailbox, { title: 'Ignored for POP3' })}
        <label class="small mb-0 text-start"><input type="checkbox" data-config-key="secure" ${checked(cfg.secure, true)}> Incoming implicit TLS</label>
        <label class="small mb-0 text-start" title="IMAP uses IDLE. POP3 is polled in the background."><input type="checkbox" data-config-key="notify" ${checked(cfg.notify, true)}> Notify on new mail</label>
        <label class="small mb-0 text-start"><input type="checkbox" data-config-key="reject_unauthorized" ${checked(cfg.reject_unauthorized, true)}> Verify SSL</label>
      </div>
      <small class="text-muted d-block mt-1" style="font-size: 0.65rem;">Host, username, and password are required. SMTP uses the same login. New mail is posted into this session.</small>
    `;
  }

  function valueOf(block, key) {
    const el = block.querySelector(`[data-config-key="${key}"]`);
    return el ? String(el.value || '').trim() : '';
  }

  function checkedOf(block, key) {
    const el = block.querySelector(`[data-config-key="${key}"]`);
    return !!(el && el.checked);
  }

  function readEmailToolConfig(block, previous) {
    if (!block || !checkedOf(block, 'enabled')) return null;
    const prev = previous && typeof previous === 'object' ? previous : {};
    const cfg = {
      protocol: valueOf(block, 'protocol') === 'pop3' ? 'pop3' : 'imap',
      secure: checkedOf(block, 'secure'),
      notify: checkedOf(block, 'notify'),
      reject_unauthorized: checkedOf(block, 'reject_unauthorized'),
    };
    const incomingHost = valueOf(block, 'incoming_host');
    const incomingPort = valueOf(block, 'incoming_port');
    const smtpHost = valueOf(block, 'smtp_host');
    const smtpPort = valueOf(block, 'smtp_port');
    const username = valueOf(block, 'username');
    const typedPassword = valueOf(block, 'password');
    const fromAddress = valueOf(block, 'from_address');
    const mailbox = valueOf(block, 'mailbox');
    if (incomingHost) cfg.incoming_host = incomingHost;
    if (/^\d+$/.test(incomingPort)) cfg.incoming_port = parseInt(incomingPort, 10);
    if (smtpHost) cfg.smtp_host = smtpHost;
    if (/^\d+$/.test(smtpPort)) cfg.smtp_port = parseInt(smtpPort, 10);
    if (username) cfg.username = username;
    if (typedPassword) cfg.password = typedPassword;
    else if (prev.password) cfg.password = prev.password;
    if (fromAddress) cfg.from_address = fromAddress;
    if (mailbox) cfg.mailbox = mailbox;
    return cfg;
  }

  return { renderEmailToolConfig, readEmailToolConfig };
});
