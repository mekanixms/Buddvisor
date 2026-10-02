const { JSDOM } = require('jsdom');
const { renderEmailToolConfig, readEmailToolConfig } = require('../../public/js/components/emailToolConfig');

function block(html) {
  return new JSDOM(`<table><tr><td>${html}</td></tr></table>`).window.document.querySelector('.email-config-block');
}

describe('email tool config form', () => {
  it('round-trips host, protocol, and password, and keeps a blank password', () => {
    const html = renderEmailToolConfig({
      cfg: {
        protocol: 'pop3',
        incoming_host: 'pop.example.com',
        password: 's3cret',
        notify: false,
        secure: false,
      },
      enabled: true,
      agentId: 7,
    });
    const el = block(html);
    expect(el.getAttribute('data-agent-id')).toBe('7');
    expect(el.querySelector('[data-config-key="protocol"]').value).toBe('pop3');
    expect(el.querySelector('[data-config-key="notify"]').checked).toBe(false);

    const saved = readEmailToolConfig(el, null);
    expect(saved).toMatchObject({
      protocol: 'pop3',
      incoming_host: 'pop.example.com',
      password: 's3cret',
      notify: false,
      secure: false,
      reject_unauthorized: true,
    });

    el.querySelector('[data-config-key="password"]').value = '';
    expect(readEmailToolConfig(el, { password: 'kept' }).password).toBe('kept');
  });

  it('does not assign the tool when Enable is unchecked', () => {
    const el = block(renderEmailToolConfig({
      cfg: { incoming_host: 'imap.example.com' },
      enabled: true,
      isOrchestrator: true,
    }));
    el.querySelector('[data-config-key="enabled"]').checked = false;
    expect(readEmailToolConfig(el, null)).toBeNull();
  });

  it('escapes host values so they stay inside the input', () => {
    const el = block(renderEmailToolConfig({
      cfg: { incoming_host: 'a"><b' },
      enabled: true,
      isOrchestrator: true,
    }));
    expect(el.querySelector('[data-config-key="incoming_host"]').value).toBe('a"><b');
    expect(el.querySelectorAll('b')).toHaveLength(0);
  });
});
