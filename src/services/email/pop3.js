/**
 * Small POP3 client. Implicit TLS (port 995) or STLS (port 110).
 * Cleartext after the handshake is refused.
 */

const net = require('net');
const tls = require('tls');

class ByteQueue {
  constructor(socket) {
    this.chunks = [];
    this.length = 0;
    this.waiters = [];
    this.error = null;
    this.ended = false;
    this._onData = (buf) => {
      const chunk = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
      this.chunks.push(chunk);
      this.length += chunk.length;
      this._pulse();
    };
    this._onError = (err) => {
      this.error = err;
      this._pulse();
    };
    this._onEnd = () => {
      this.ended = true;
      this._pulse();
    };
    this.socket = socket;
    socket.on('data', this._onData);
    socket.on('error', this._onError);
    socket.on('end', this._onEnd);
    socket.on('close', this._onEnd);
  }

  detach() {
    const socket = this.socket;
    if (!socket) return;
    socket.removeListener('data', this._onData);
    socket.removeListener('error', this._onError);
    socket.removeListener('end', this._onEnd);
    socket.removeListener('close', this._onEnd);
    this.socket = null;
  }

  _buffer() {
    if (this.chunks.length > 1) {
      const all = Buffer.concat(this.chunks, this.length);
      this.chunks = [all];
    }
    return this.chunks[0] || Buffer.alloc(0);
  }

  _consume(n) {
    const buf = this._buffer();
    const out = buf.subarray(0, n);
    const rest = buf.subarray(n);
    this.chunks = rest.length ? [Buffer.from(rest)] : [];
    this.length = rest.length;
    return out;
  }

  _pulse() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  async readUntil(findEnd) {
    for (;;) {
      if (this.error) throw this.error;
      const buf = this._buffer();
      const end = buf.length ? findEnd(buf) : -1;
      if (end > 0) return this._consume(end);
      if (this.ended) throw new Error('POP3 connection closed');
      await new Promise((resolve) => this.waiters.push(resolve));
    }
  }
}

async function readLine(queue) {
  const buf = await queue.readUntil((data) => {
    const index = data.indexOf(0x0a);
    return index >= 0 ? index + 1 : -1;
  });
  return buf.toString('utf8').replace(/\r?\n$/, '');
}

function stripCrlf(line) {
  let out = line;
  if (out.length && out[out.length - 1] === 0x0a) out = out.subarray(0, out.length - 1);
  if (out.length && out[out.length - 1] === 0x0d) out = out.subarray(0, out.length - 1);
  return out;
}

async function readMultiline(queue, binary) {
  const parts = [];
  for (;;) {
    const raw = await queue.readUntil((data) => {
      const index = data.indexOf(0x0a);
      return index >= 0 ? index + 1 : -1;
    });
    const line = stripCrlf(raw);
    if (line.length === 1 && line[0] === 0x2e) break;
    const data = line.length >= 2 && line[0] === 0x2e && line[1] === 0x2e ? line.subarray(1) : line;
    if (binary) parts.push(data, Buffer.from('\r\n'));
    else parts.push(data.toString('latin1'));
  }
  if (binary) {
    if (parts.length) parts.pop();
    return parts.length ? Buffer.concat(parts) : Buffer.alloc(0);
  }
  return parts.join('\r\n');
}

function sendCommand(socket, queue, line, { multiline = false, binary = false, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error('POP3 command timed out')), timeoutMs);
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    };
    socket.write(`${line}\r\n`, (err) => {
      if (err) finish(err);
    });
    (async () => {
      const status = await readLine(queue);
      if (!status.startsWith('+OK')) {
        const error = new Error(status.replace(/^-ERR\s*/i, '') || 'POP3 command failed');
        error.code = 'POP3';
        throw error;
      }
      if (!multiline) return { status, body: '' };
      const body = await readMultiline(queue, binary);
      return { status, body };
    })().then((value) => finish(null, value), finish);
  });
}

function connectSocket(factory) {
  return new Promise((resolve, reject) => {
    const socket = factory();
    const fail = (err) => {
      socket.destroy();
      reject(err);
    };
    socket.once('error', fail);
    socket.setTimeout(20000, () => fail(new Error('POP3 connection timed out')));
    const done = () => {
      socket.setTimeout(0);
      socket.removeListener('error', fail);
      resolve(socket);
    };
    if (socket.authorized || socket.encrypted) done();
    else socket.once(socket instanceof tls.TLSSocket ? 'secureConnect' : 'connect', done);
  });
}

function upgradeTls(plain, account) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      socket: plain,
      host: account.incoming.host,
      servername: account.incoming.host,
      rejectUnauthorized: account.rejectUnauthorized !== false,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('POP3 STLS handshake timed out'));
    }, 20000);
    socket.once('secureConnect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Speak POP3 on an already-connected socket. Resumes a paused socket so bytes
 * that arrived before the reader was attached are not lost.
 */
async function pop3Session(socket, fn, { expectGreeting = true } = {}) {
  const queue = new ByteQueue(socket);
  if (typeof socket.isPaused === 'function' && socket.isPaused()) socket.resume();
  const api = {
    command: (line, opts) => sendCommand(socket, queue, line, opts),
  };
  try {
    if (expectGreeting) {
      const greeting = await readLine(queue);
      if (!greeting.startsWith('+OK')) throw new Error(greeting || 'POP3 greeting failed');
    }
    return await fn(api);
  } finally {
    try { await api.command('QUIT', { timeoutMs: 5000 }); } catch { /* already closing */ }
    queue.detach();
  }
}

async function openEncryptedPop3(account) {
  if (account.incoming.secure) {
    const socket = await connectSocket(() => tls.connect({
      host: account.incoming.host,
      port: account.incoming.port,
      servername: account.incoming.host,
      rejectUnauthorized: account.rejectUnauthorized !== false,
    }));
    return { socket, expectGreeting: true };
  }

  const plain = await connectSocket(() => net.connect({
    host: account.incoming.host,
    port: account.incoming.port,
  }));
  const queue = new ByteQueue(plain);
  try {
    const greeting = await readLine(queue);
    if (!greeting.startsWith('+OK')) throw new Error(greeting || 'POP3 greeting failed');
    await sendCommand(plain, queue, 'STLS', { timeoutMs: 20000 });
  } finally {
    queue.detach();
  }
  const socket = await upgradeTls(plain, account);
  if (!socket.encrypted) throw new Error('POP3 server refused TLS');
  return { socket, expectGreeting: false };
}

async function withPop3(account, fn) {
  if (/[\r\n]/.test(account.incoming.user) || /[\r\n]/.test(account.incoming.pass)) {
    throw new Error('Invalid mailbox credentials');
  }
  const opened = await openEncryptedPop3(account);
  const socket = opened.socket;
  if (!socket.encrypted) throw new Error('POP3 connection is not encrypted');
  try {
    return await pop3Session(socket, async (api) => {
      await api.command(`USER ${account.incoming.user}`);
      await api.command(`PASS ${account.incoming.pass}`);
      return fn(api);
    }, { expectGreeting: opened.expectGreeting });
  } finally {
    try { socket.end(); } catch { /* ignore */ }
  }
}

function parseUidl(body) {
  return String(body || '').split(/\r?\n/).map((line) => {
    const match = line.match(/^(\d+)\s+(\S+)/);
    if (!match) return null;
    return { number: Number(match[1]), uidl: match[2] };
  }).filter(Boolean);
}

function parseList(body) {
  const sizes = new Map();
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = line.match(/^(\d+)\s+(\d+)/);
    if (match) sizes.set(Number(match[1]), Number(match[2]));
  }
  return sizes;
}

module.exports = {
  ByteQueue,
  pop3Session,
  withPop3,
  parseUidl,
  parseList,
};
