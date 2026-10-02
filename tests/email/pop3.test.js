const net = require('net');
const { pop3Session, parseUidl, parseList } = require('../../src/services/email/pop3');

function startServer(onLine) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.write('+OK test\r\n');
      let buf = '';
      socket.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        while (buf.includes('\r\n')) {
          const index = buf.indexOf('\r\n');
          const line = buf.slice(0, index);
          buf = buf.slice(index + 2);
          onLine(socket, line);
        }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function connectPaused(port) {
  const socket = new net.Socket();
  socket.pause();
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.connect(port, '127.0.0.1', () => resolve(socket));
  });
}

describe('POP3 session', () => {
  it('parses UIDL and undoes dot-stuffing on RETR', async () => {
    const server = await startServer((socket, line) => {
      if (line === 'UIDL') socket.write('+OK\r\n1 aaa\r\n2 bbb\r\n.\r\n');
      else if (line === 'LIST') socket.write('+OK\r\n1 20\r\n2 40\r\n.\r\n');
      else if (line === 'RETR 1') socket.write('+OK\r\nSubject: Hi\r\n\r\nHello\r\n..starts with a dot\r\n.\r\n');
      else if (line === 'QUIT') socket.write('+OK bye\r\n');
      else socket.write('-ERR no\r\n');
    });
    let socket;
    try {
      socket = await connectPaused(server.address().port);
      const result = await pop3Session(socket, async (api) => {
        const uidl = await api.command('UIDL', { multiline: true });
        const list = await api.command('LIST', { multiline: true });
        const retr = await api.command('RETR 1', { multiline: true, binary: true });
        return { uidl: uidl.body, list: list.body, retr: retr.body };
      });
      expect(parseUidl(result.uidl)).toEqual([
        { number: 1, uidl: 'aaa' },
        { number: 2, uidl: 'bbb' },
      ]);
      expect(parseList(result.list).get(2)).toBe(40);
      expect(result.retr.toString('utf8')).toContain('Hello');
      expect(result.retr.toString('utf8')).toContain('.starts with a dot');
      expect(result.retr.toString('utf8')).not.toContain('..starts');
    } finally {
      if (socket) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('surfaces a negative status', async () => {
    const server = await startServer((socket, line) => {
      if (line === 'QUIT') socket.write('+OK bye\r\n');
      else socket.write('-ERR denied\r\n');
    });
    let socket;
    try {
      socket = await connectPaused(server.address().port);
      await expect(pop3Session(socket, (api) => api.command('STAT'))).rejects.toThrow(/denied/);
    } finally {
      if (socket) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
