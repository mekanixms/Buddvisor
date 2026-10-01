const crypto = require('crypto');

process.env.ENCRYPTION_KEY = 'k'.repeat(40);
process.env.TELEGRAM_POLL_TIMEOUT_SECONDS = '0';

jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));

jest.mock('../../src/models/Document', () => ({
  findByContentHash: jest.fn(),
  findByUserId: jest.fn(),
  getBySession: jest.fn(),
}));

jest.mock('../../src/models/Message', () => ({ create: jest.fn() }));

jest.mock('../../src/services/documents/DocumentService', () => ({ uploadDocument: jest.fn() }));

jest.mock('../../src/services/documents/DocumentProcessor', () => {
  const supported = new Set(['application/pdf', 'image/jpeg', 'image/png', 'video/mp4', 'text/plain']);
  return {
    isSupported: (mime) => supported.has(mime),
    getMaxFileSize: () => 50 * 1024 * 1024,
  };
});

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/models/WorkSession', () => ({
  findById: jest.fn(),
  getAgents: jest.fn(),
  assignDocument: jest.fn(),
}));

jest.mock('../../src/models/SessionTelegram', () => ({
  getConfig: jest.fn(),
  findConfigByBotId: jest.fn(),
  upsertConfig: jest.fn(),
  deleteConfig: jest.fn(),
  setLastUpdateId: jest.fn(),
  setEnabled: jest.fn(),
  setLastError: jest.fn(),
  createPairing: jest.fn(),
  consumePairing: jest.fn(),
  listChats: jest.fn(),
  findChat: jest.fn(),
  addChat: jest.fn(),
  touchChat: jest.fn(),
  removeChatById: jest.fn(),
  removeChatByChatId: jest.fn(),
}));

jest.mock('../../src/services/chat/ChatService', () => ({
  ChatService: { processMessage: jest.fn() },
}));

jest.mock('../../src/services/sessions/AutoSaveService', () => ({
  autoSave: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/tools/localWorkingFolderTool', () => {
  const path = require('path');
  return {
    getWorkspacePathForOrchestrator: jest.fn(),
    resolveWorkspacePath: (relativePath, workspacePath) => {
      const resolved = path.resolve(workspacePath, relativePath);
      const root = path.resolve(workspacePath);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error(`Path traversal detected: ${relativePath}`);
      }
      return resolved;
    },
  };
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const WorkSession = require('../../src/models/WorkSession');
const { getWorkspacePathForOrchestrator } = require('../../src/services/tools/localWorkingFolderTool');
const SessionTelegram = require('../../src/models/SessionTelegram');
const { ChatService } = require('../../src/services/chat/ChatService');
const TelegramService = require('../../src/services/telegram/TelegramService');
const { encrypt } = require('../../src/utils/crypto');

const TOKEN = '123456789:AAEexampleTokenExampleTokenExample_12';
const ok = (result = {}) => ({ data: { ok: true, result } });

const sentTexts = () => axios.post.mock.calls
  .filter(([url]) => url.endsWith('/sendMessage'))
  .map(([, body]) => body.text);

const formField = (body, name) => {
  const match = body.getBuffer().toString('utf8').match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r\\n]*)`));
  return match ? match[1] : null;
};

const ctx = { sessionId: 7, token: TOKEN };
const privateMessage = (text, extra = {}) => ({
  chat: { id: 555, type: 'private', first_name: 'Ana' },
  from: { id: 555, username: 'ana', first_name: 'Ana' },
  text,
  ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  axios.post.mockResolvedValue(ok());
  WorkSession.findById.mockResolvedValue({ id: 7, user_id: 1, name: 'Planning', is_active: 1 });
});

afterEach(() => {
  TelegramService.stopAll();
});

describe('splitMessage', () => {
  test('returns short text untouched', () => {
    expect(TelegramService.splitMessage('hello')).toEqual(['hello']);
  });

  test('splits at 4096 characters and keeps every character', () => {
    const text = 'word '.repeat(2000);
    const parts = TelegramService.splitMessage(text);
    expect(parts.length).toBeGreaterThan(1);
    parts.forEach((p) => expect(p.length).toBeLessThanOrEqual(4096));
    expect(parts.join(' ').replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
  });

  test('prefers a paragraph boundary', () => {
    const first = 'a'.repeat(3000);
    const second = 'b'.repeat(3000);
    expect(TelegramService.splitMessage(`${first}\n\n${second}`)).toEqual([first, second]);
  });

  test('hard-cuts text with no whitespace', () => {
    const parts = TelegramService.splitMessage('x'.repeat(9000));
    expect(parts.map((p) => p.length)).toEqual([4096, 4096, 808]);
  });
});

describe('Bot API errors', () => {
  test('never leak the token and expose the HTTP status', async () => {
    axios.post.mockRejectedValue({
      message: `Request failed with status code 401 for /bot${TOKEN}/getMe`,
      response: { status: 401, data: { description: 'Unauthorized' } },
    });
    await expect(TelegramService.api(TOKEN, 'getMe')).rejects.toMatchObject({ status: 401 });
    await TelegramService.api(TOKEN, 'getMe').catch((err) => {
      expect(err.message).not.toContain(TOKEN);
    });
  });

  test('strips the token from network errors', async () => {
    axios.post.mockRejectedValue(new Error(`connect ECONNREFUSED /bot${TOKEN}/getMe`));
    await TelegramService.api(TOKEN, 'getMe').catch((err) => {
      expect(err.message).not.toContain(TOKEN);
    });
  });
});

describe('handleMessage', () => {
  test('ignores an unlinked chat and never reaches the chat pipeline', async () => {
    SessionTelegram.findChat.mockResolvedValue(null);
    await TelegramService.handleMessage(ctx, privateMessage('hello'));
    expect(ChatService.processMessage).not.toHaveBeenCalled();
    expect(sentTexts()[0]).toMatch(/not linked/i);
  });

  test('refuses group chats', async () => {
    await TelegramService.handleMessage(ctx, {
      chat: { id: -100, type: 'group' },
      from: { id: 1 },
      text: 'hi',
    });
    expect(ChatService.processMessage).not.toHaveBeenCalled();
    expect(SessionTelegram.addChat).not.toHaveBeenCalled();
    expect(sentTexts()[0]).toMatch(/private chats/i);
  });

  test('links a chat with a valid one-time code', async () => {
    SessionTelegram.findChat.mockResolvedValue(null);
    SessionTelegram.consumePairing.mockResolvedValue(true);

    await TelegramService.handleMessage(ctx, privateMessage('/start abc123'));

    const expectedHash = crypto.createHash('sha256').update('abc123').digest('hex');
    expect(SessionTelegram.consumePairing).toHaveBeenCalledWith(7, expectedHash);
    expect(SessionTelegram.addChat).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 7,
      chat_id: 555,
      username: 'ana',
    }));
    expect(sentTexts()[0]).toMatch(/Connected to session "Planning"/);
  });

  test('rejects an invalid, expired or used code', async () => {
    SessionTelegram.findChat.mockResolvedValue(null);
    SessionTelegram.consumePairing.mockResolvedValue(false);

    await TelegramService.handleMessage(ctx, privateMessage('/start nope'));

    expect(SessionTelegram.addChat).not.toHaveBeenCalled();
    expect(sentTexts()[0]).toMatch(/invalid, expired, or already used/i);
  });

  test('runs a linked chat message through the pipeline; the reply comes from forwarding', async () => {
    SessionTelegram.findChat.mockResolvedValue({ chat_id: '555', username: 'ana' });
    ChatService.processMessage.mockResolvedValue({ message: 'the plan' });

    await TelegramService.handleMessage(ctx, privateMessage('what is the plan?'));

    expect(ChatService.processMessage).toHaveBeenCalledWith(
      7,
      1,
      'what is the plan?',
      expect.objectContaining({
        stream: false,
        metadataExtra: { channel: 'telegram', telegram_username: 'ana', telegram_chat_id: '555' },
      })
    );
    expect(SessionTelegram.touchChat).toHaveBeenCalledWith(7, 555);
    expect(sentTexts()).toHaveLength(0);
  });

  test('replies directly only when the pipeline produced an empty answer', async () => {
    SessionTelegram.findChat.mockResolvedValue({ chat_id: '555', username: 'ana' });
    ChatService.processMessage.mockResolvedValue({ message: '   ' });

    await TelegramService.handleMessage(ctx, privateMessage('hello'));

    expect(sentTexts()).toEqual(['(no answer)']);
  });

  test('reports a pipeline failure without crashing', async () => {
    SessionTelegram.findChat.mockResolvedValue({ chat_id: '555', username: 'ana' });
    ChatService.processMessage.mockRejectedValue(new Error('provider down'));

    await TelegramService.handleMessage(ctx, privateMessage('hello'));

    expect(sentTexts().pop()).toMatch(/provider down/);
  });

  test('/unlink removes the link', async () => {
    SessionTelegram.findChat.mockResolvedValue({ chat_id: '555' });
    await TelegramService.handleMessage(ctx, privateMessage('/unlink'));
    expect(SessionTelegram.removeChatByChatId).toHaveBeenCalledWith(7, 555);
  });

  test('unsupported message kinds from a linked chat get a hint, not a pipeline call', async () => {
    SessionTelegram.findChat.mockResolvedValue({ chat_id: '555' });
    await TelegramService.handleMessage(ctx, privateMessage(undefined, { text: undefined, sticker: { file_id: 's' } }));
    expect(ChatService.processMessage).not.toHaveBeenCalled();
    expect(sentTexts()[0]).toMatch(/only text, photos, videos and files/i);
  });

  test('a deleted or inactive session stops answering', async () => {
    WorkSession.findById.mockResolvedValue({ id: 7, user_id: 1, is_active: 0 });
    await TelegramService.handleMessage(ctx, privateMessage('hello'));
    expect(ChatService.processMessage).not.toHaveBeenCalled();
    expect(sentTexts()).toHaveLength(0);
  });
});

describe('media intake', () => {
  const Document = require('../../src/models/Document');
  const Message = require('../../src/models/Message');
  const DocumentService = require('../../src/services/documents/DocumentService');

  const photoMessage = (extra = {}) => privateMessage(undefined, {
    text: undefined,
    date: 1700000000,
    photo: [
      { file_id: 'small', file_unique_id: 'AAAA1111', width: 90, height: 90, file_size: 900 },
      { file_id: 'big', file_unique_id: 'BBBB2222', width: 1280, height: 960, file_size: 90000 },
    ],
    ...extra,
  });

  const bytes = Buffer.from('some-file-bytes');

  beforeEach(() => {
    SessionTelegram.findChat.mockResolvedValue({ chat_id: '555', username: 'ana' });
    axios.post.mockImplementation(async (url) => {
      if (url.endsWith('/getFile')) return ok({ file_path: 'photos/file_1.jpg' });
      return ok();
    });
    axios.get.mockResolvedValue({ data: bytes });
    Document.findByContentHash.mockResolvedValue(null);
    Document.findByUserId.mockResolvedValue([]);
    Document.getBySession.mockResolvedValue([]);
    DocumentService.uploadDocument.mockImplementation(async (userId, file) => ({
      document: { id: 42, user_id: userId, filename: file.originalname },
    }));
    Message.create.mockResolvedValue({});
    getWorkspacePathForOrchestrator.mockReset();
  });

  test('a photo is downloaded, stored for the owner and added to the session without agent rows', async () => {
    await TelegramService.handleMessage(ctx, photoMessage());

    const getFile = axios.post.mock.calls.find(([url]) => url.endsWith('/getFile'));
    expect(getFile[1]).toEqual({ file_id: 'big' });
    expect(axios.get.mock.calls[0][0]).toBe(`https://api.telegram.org/file/bot${TOKEN}/photos/file_1.jpg`);

    expect(DocumentService.uploadDocument).toHaveBeenCalledWith(1, expect.objectContaining({
      originalname: 'photo_20231114_221320_BBBB22.jpg',
      mimetype: 'image/jpeg',
      size: bytes.length,
    }));
    expect(WorkSession.assignDocument).toHaveBeenCalledWith(7, 42);
    expect(ChatService.processMessage).not.toHaveBeenCalled();
    expect(sentTexts()[0]).toMatch(/Saved "photo_20231114_221320_BBBB22\.jpg".*assigned to the orchestrator/s);
    expect(sentTexts()[0]).toMatch(/assign photo_20231114_221320_BBBB22\.jpg to @AgentName/);
  });

  test('the upload is recorded in the conversation as a context message from that chat', async () => {
    await TelegramService.handleMessage(ctx, photoMessage());

    expect(Message.create).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 7,
      role: 'user',
      content: expect.stringMatching(/Uploaded .*via Telegram.*assigned to the orchestrator/),
      metadata: expect.objectContaining({
        channel: 'telegram',
        telegram_chat_id: '555',
        document_id: 42,
      }),
    }));
  });

  test('a caption is sent through the chat pipeline together with the file name', async () => {
    ChatService.processMessage.mockResolvedValue({ message: 'looks fine' });

    await TelegramService.handleMessage(ctx, photoMessage({ caption: 'what is on this photo?' }));

    expect(ChatService.processMessage).toHaveBeenCalledWith(
      7,
      1,
      expect.stringMatching(/^what is on this photo\?\n\n\[Attached via Telegram: "photo_.*\.jpg"/),
      expect.objectContaining({ metadataExtra: expect.objectContaining({ channel: 'telegram' }) })
    );
    expect(Message.create).not.toHaveBeenCalled();
  });

  test('a document keeps its file name and MIME type is inferred from the extension', async () => {
    await TelegramService.handleMessage(ctx, privateMessage(undefined, {
      text: undefined,
      document: { file_id: 'd1', file_name: 'invoice.pdf', mime_type: 'application/octet-stream', file_size: 2000 },
    }));

    expect(DocumentService.uploadDocument).toHaveBeenCalledWith(1, expect.objectContaining({
      originalname: 'invoice.pdf',
      mimetype: 'application/pdf',
    }));
  });

  test('a file name already used in the library gets a numeric suffix', async () => {
    Document.findByUserId.mockResolvedValue([{ filename: 'Invoice.pdf' }, { filename: 'invoice_2.pdf' }]);

    await TelegramService.handleMessage(ctx, privateMessage(undefined, {
      text: undefined,
      document: { file_id: 'd1', file_name: 'invoice.pdf', mime_type: 'application/pdf' },
    }));

    expect(DocumentService.uploadDocument.mock.calls[0][1].originalname).toBe('invoice_3.pdf');
  });

  test('an identical file already owned by the user is reused, not uploaded twice', async () => {
    Document.findByContentHash.mockResolvedValue({ id: 9, user_id: 1, filename: 'old.jpg' });

    await TelegramService.handleMessage(ctx, photoMessage());

    expect(DocumentService.uploadDocument).not.toHaveBeenCalled();
    expect(WorkSession.assignDocument).toHaveBeenCalledWith(7, 9);
    expect(sentTexts()[0]).toMatch(/already in your document library/);
  });

  test('a file that is already in the session is not assigned again', async () => {
    Document.findByContentHash.mockResolvedValue({ id: 9, user_id: 1, filename: 'old.jpg' });
    Document.getBySession.mockResolvedValue([{ id: 9 }]);

    await TelegramService.handleMessage(ctx, photoMessage());

    expect(WorkSession.assignDocument).not.toHaveBeenCalled();
    expect(sentTexts()[0]).toMatch(/already in this session/);
  });

  test('an identical file owned by another account is refused', async () => {
    Document.findByContentHash.mockResolvedValue({ id: 9, user_id: 2, filename: 'theirs.jpg' });

    await TelegramService.handleMessage(ctx, photoMessage());

    expect(WorkSession.assignDocument).not.toHaveBeenCalled();
    expect(sentTexts()[0]).toMatch(/Could not save/);
  });

  test('unsupported files are not downloaded when the orchestrator has no working folder', async () => {
    getWorkspacePathForOrchestrator.mockResolvedValue(null);

    await TelegramService.handleMessage(ctx, privateMessage(undefined, {
      text: undefined,
      document: { file_id: 'z', file_name: 'archive.zip', mime_type: 'application/zip', file_size: 1000 },
    }));

    expect(axios.get).not.toHaveBeenCalled();
    expect(sentTexts()[0]).toMatch(/local_working_folder is not configured/);
    expect(ChatService.processMessage).not.toHaveBeenCalled();
  });

  test('an unsupported file is saved in the orchestrator TelegramDownloads folder', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-downloads-'));
    getWorkspacePathForOrchestrator.mockResolvedValue(workspace);

    await TelegramService.handleMessage(ctx, privateMessage(undefined, {
      text: undefined,
      document: { file_id: 'z', file_name: 'archive.zip', mime_type: 'application/zip', file_size: bytes.length },
    }));

    const saved = path.join(workspace, 'TelegramDownloads', 'archive.zip');
    expect(fs.readFileSync(saved)).toEqual(bytes);
    expect(WorkSession.assignDocument).not.toHaveBeenCalled();
    expect(ChatService.processMessage).not.toHaveBeenCalled();
    expect(sentTexts()[0]).toMatch(/TelegramDownloads\/archive\.zip/);
    expect(Message.create).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 7,
      role: 'user',
      content: expect.stringMatching(/TelegramDownloads\/archive\.zip/),
      metadata: expect.objectContaining({ channel: 'telegram', download_path: 'TelegramDownloads/archive.zip' }),
    }));
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('a voice message is saved as an audio file in TelegramDownloads', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-voice-'));
    getWorkspacePathForOrchestrator.mockResolvedValue(workspace);

    await TelegramService.handleMessage(ctx, privateMessage(undefined, {
      text: undefined,
      date: 1700000000,
      voice: { file_id: 'v1', file_unique_id: 'VOICE1', file_size: bytes.length, mime_type: 'audio/ogg' },
    }));

    const files = fs.readdirSync(path.join(workspace, 'TelegramDownloads'));
    expect(files).toEqual(['audio_20231114_221320_VOICE1.ogg']);
    expect(fs.readFileSync(path.join(workspace, 'TelegramDownloads', files[0]))).toEqual(bytes);
    expect(sentTexts()[0]).toMatch(/Saved the voice message as audio/);
    expect(sentTexts()[0]).toMatch(/TelegramDownloads\/audio_20231114_221320_VOICE1\.ogg/);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('a caption on an unsupported file is sent through the chat pipeline', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-caption-'));
    getWorkspacePathForOrchestrator.mockResolvedValue(workspace);
    ChatService.processMessage.mockResolvedValue({ message: 'unzipped' });

    await TelegramService.handleMessage(ctx, privateMessage(undefined, {
      text: undefined,
      document: { file_id: 'z', file_name: 'archive.zip', mime_type: 'application/zip' },
      caption: 'please unpack this',
    }));

    expect(ChatService.processMessage).toHaveBeenCalledWith(
      7,
      1,
      expect.stringMatching(/^please unpack this\n\n\[Attached via Telegram: .*TelegramDownloads\/archive\.zip/),
      expect.objectContaining({ metadataExtra: expect.objectContaining({ channel: 'telegram' }) })
    );
    expect(Message.create).not.toHaveBeenCalled();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('a second copy of the same file name gets a numeric suffix', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-dup-'));
    fs.mkdirSync(path.join(workspace, 'TelegramDownloads'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'TelegramDownloads', 'archive.zip'), 'old');
    getWorkspacePathForOrchestrator.mockResolvedValue(workspace);

    await TelegramService.handleMessage(ctx, privateMessage(undefined, {
      text: undefined,
      document: { file_id: 'z', file_name: 'archive.zip', mime_type: 'application/zip' },
    }));

    expect(fs.readFileSync(path.join(workspace, 'TelegramDownloads', 'archive_2.zip'))).toEqual(bytes);
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('files over the download limit are refused before downloading', async () => {
    await TelegramService.handleMessage(ctx, privateMessage(undefined, {
      text: undefined,
      video: { file_id: 'v', file_name: 'big.mp4', mime_type: 'video/mp4', file_size: 30 * 1024 * 1024 },
    }));

    expect(axios.get).not.toHaveBeenCalled();
    expect(sentTexts()[0]).toMatch(/limit for Telegram uploads is 20\.0 MB/);
  });

  test('a failed download is reported without leaking the bot token', async () => {
    axios.get.mockRejectedValue(new Error(`socket hang up on /file/bot${TOKEN}/photos/file_1.jpg`));

    await TelegramService.handleMessage(ctx, photoMessage());

    expect(WorkSession.assignDocument).not.toHaveBeenCalled();
    const reply = sentTexts()[0];
    expect(reply).toMatch(/Could not save/);
    expect(reply).not.toContain(TOKEN);
  });

  test('an unlinked chat cannot upload files', async () => {
    SessionTelegram.findChat.mockResolvedValue(null);

    await TelegramService.handleMessage(ctx, photoMessage());

    expect(axios.get).not.toHaveBeenCalled();
    expect(sentTexts()[0]).toMatch(/not linked/i);
  });
});

describe('forwarding chat messages to Telegram', () => {
  const chatA = { chat_id: '111', username: 'ana' };
  const chatB = { chat_id: '222', username: 'bob' };

  const flush = async () => {
    const end = Date.now() + 1500;
    while (TelegramService.outbound.size > 0 && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  const sends = () => axios.post.mock.calls
    .filter(([url]) => url.endsWith('/sendMessage'))
    .map(([, body]) => ({ chat: body.chat_id, text: body.text }));

  const message = (overrides) => ({
    id: 1,
    session_id: 7,
    role: 'user',
    content: 'hello',
    agent_name: null,
    metadata: { username: 'owner' },
    ...overrides,
  });

  beforeEach(() => {
    TelegramService.pollers.set(7, { token: TOKEN, stop: jest.fn() });
    SessionTelegram.listChats.mockResolvedValue([chatA, chatB]);
    SessionTelegram.removeChatByChatId.mockResolvedValue(true);
  });

  test('a message typed in the web chat reaches every linked chat', async () => {
    TelegramService.onMessageCreated(message());
    await flush();
    expect(sends()).toEqual([
      { chat: '111', text: 'owner: hello' },
      { chat: '222', text: 'owner: hello' },
    ]);
  });

  test('an agent reply is labelled with the agent name', async () => {
    TelegramService.onMessageCreated(message({ role: 'assistant', agent_name: 'Accounting', content: 'Done.' }));
    await flush();
    expect(sends()[0]).toEqual({ chat: '111', text: 'Accounting:\nDone.' });
  });

  test('a scheduled prompt is labelled as such', async () => {
    TelegramService.onMessageCreated(message({ metadata: JSON.stringify({ username: 'owner', channel: 'scheduled' }) }));
    await flush();
    expect(sends()[0].text).toBe('Scheduled job: hello');
  });

  test('a Telegram-typed message is not echoed to its own chat but reaches the others', async () => {
    TelegramService.onMessageCreated(message({
      metadata: { username: 'owner', channel: 'telegram', telegram_username: 'ana', telegram_chat_id: '111' },
    }));
    await flush();
    expect(sends()).toEqual([{ chat: '222', text: 'ana: hello' }]);
  });

  test('the reply to a Telegram-typed message reaches the chat that asked', async () => {
    TelegramService.onMessageCreated(message({ role: 'assistant', agent_name: 'Legal', content: 'Answer' }));
    await flush();
    expect(sends().map((s) => s.chat)).toEqual(['111', '222']);
  });

  test('the prompt is delivered before its reply', async () => {
    TelegramService.onMessageCreated(message({ id: 1 }));
    TelegramService.onMessageCreated(message({ id: 2, role: 'assistant', agent_name: 'Legal', content: 'Answer' }));
    await flush();
    expect(sends().map((s) => s.text)).toEqual([
      'owner: hello',
      'owner: hello',
      'Legal:\nAnswer',
      'Legal:\nAnswer',
    ]);
  });

  test('sessions without a Telegram bot, empty content and other roles are ignored', async () => {
    TelegramService.onMessageCreated(message({ session_id: 99 }));
    TelegramService.onMessageCreated(message({ content: '   ' }));
    TelegramService.onMessageCreated(message({ role: 'tool' }));
    await flush();
    expect(sends()).toHaveLength(0);
  });

  test('a chat that blocked the bot is unlinked and the others still receive the message', async () => {
    axios.post.mockImplementation(async (url, body) => {
      if (url.endsWith('/sendMessage') && body.chat_id === '111') {
        throw { message: 'forbidden', response: { status: 403, data: { description: 'Forbidden: bot was blocked by the user' } } };
      }
      return ok();
    });

    TelegramService.onMessageCreated(message());
    await flush();

    expect(SessionTelegram.removeChatByChatId).toHaveBeenCalledWith(7, '111');
    expect(sends().some((s) => s.chat === '222')).toBe(true);
  });

  test('an assistant HTML card is uploaded as a photo instead of base64 text', async () => {
    const payload = Buffer.alloc(40, 7).toString('base64');
    const content = `<div class="card"><h2>trigRatios.jpeg</h2><p class="desc">Rendered directly from assigned session storage</p><img src="data:image/jpeg;base64,${payload}"></div>`;
    TelegramService.onMessageCreated(message({ role: 'assistant', agent_name: 'Accounting', content }));
    await flush();

    expect(sends()).toEqual([]);
    const photos = axios.post.mock.calls.filter(([url]) => url.endsWith('/sendPhoto'));
    expect(photos.map(([, body]) => formField(body, 'chat_id'))).toEqual(['111', '222']);
    expect(formField(photos[0][1], 'caption')).toBe('Accounting: trigRatios.jpeg');
    expect(photos[0][1].getBuffer().includes(Buffer.alloc(40, 7))).toBe(true);
  });

  test('retries once when Telegram asks to slow down (429)', async () => {
    let first = true;
    axios.post.mockImplementation(async (url) => {
      if (url.endsWith('/sendMessage') && first) {
        first = false;
        throw { message: 'too many', response: { status: 429, data: { description: 'Too Many Requests', parameters: { retry_after: 0 } } } };
      }
      return ok();
    });
    SessionTelegram.listChats.mockResolvedValue([chatA]);

    TelegramService.onMessageCreated(message());
    await flush();

    expect(sends()).toHaveLength(2);
  });
});

describe('sendFileToLinkedChats', () => {
  const chatA = { chat_id: '111' };
  const chatB = { chat_id: '222' };
  const file = { buffer: Buffer.from('hello'), filename: 'note.txt', mimeType: 'text/plain', caption: 'note.txt' };

  beforeEach(() => {
    TelegramService.pollers.set(7, { token: TOKEN, stop: jest.fn() });
    SessionTelegram.listChats.mockResolvedValue([chatA, chatB]);
    SessionTelegram.removeChatByChatId.mockResolvedValue(true);
  });

  test('uploads the file to every linked chat', async () => {
    const result = await TelegramService.sendFileToLinkedChats(7, file);
    expect(result).toMatchObject({ success: true, chats_sent: 2, method: 'sendDocument', filename: 'note.txt' });
    const docs = axios.post.mock.calls.filter(([url]) => url.endsWith('/sendDocument'));
    expect(docs.map(([, body]) => formField(body, 'chat_id'))).toEqual(['111', '222']);
    expect(formField(docs[0][1], 'caption')).toBe('note.txt');
  });

  test('refuses when the session has no bot or no linked chat', async () => {
    await expect(TelegramService.sendFileToLinkedChats(99, file)).resolves.toMatchObject({ success: false });
    SessionTelegram.listChats.mockResolvedValue([]);
    await expect(TelegramService.sendFileToLinkedChats(7, file)).resolves.toMatchObject({ success: false });
    expect(axios.post).not.toHaveBeenCalled();
  });

  test('unlinks a chat that blocked the bot and still sends to the others', async () => {
    axios.post.mockImplementation(async (url, body) => {
      if (url.endsWith('/sendDocument') && formField(body, 'chat_id') === '111') {
        throw { message: 'forbidden', response: { status: 403, data: { description: 'Forbidden: bot was blocked by the user' } } };
      }
      return ok();
    });

    const result = await TelegramService.sendFileToLinkedChats(7, file);
    expect(result.chats_sent).toBe(1);
    expect(SessionTelegram.removeChatByChatId).toHaveBeenCalledWith(7, '111');
  });
});

describe('pairing', () => {
  test('creates a hashed, expiring code with QR and both link styles', async () => {
    SessionTelegram.getConfig.mockResolvedValue({ bot_username: 'my_bot', enabled: 1 });

    const before = Date.now();
    const result = await TelegramService.createPairing(7, 1);

    const code = new URL(result.link).searchParams.get('start');
    expect(result.link.startsWith('https://t.me/my_bot?start=')).toBe(true);
    expect(result.deepLink).toBe(`tg://resolve?domain=my_bot&start=${code}`);
    expect(code).toMatch(/^[A-Za-z0-9_-]{20,64}$/);
    expect(result.qr.startsWith('data:image/png;base64,')).toBe(true);

    const [sessionId, hash, expiresAt] = SessionTelegram.createPairing.mock.calls[0];
    expect(sessionId).toBe(7);
    expect(hash).toBe(crypto.createHash('sha256').update(code).digest('hex'));
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(before);
  });

  test('requires a connected bot', async () => {
    SessionTelegram.getConfig.mockResolvedValue(null);
    await expect(TelegramService.createPairing(7, 1)).rejects.toMatchObject({ code: 'TELEGRAM_NOT_CONFIGURED' });
  });

  test('only the session owner may create a code', async () => {
    await expect(TelegramService.createPairing(7, 2)).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('saveConfig', () => {
  test('rejects a token that is not in BotFather format', async () => {
    await expect(TelegramService.saveConfig(7, 1, 'not-a-token')).rejects.toMatchObject({ code: 'INVALID_BOT_TOKEN' });
  });

  test('refuses a bot that already serves another session', async () => {
    axios.post.mockResolvedValue(ok({ id: 99, is_bot: true, username: 'my_bot' }));
    SessionTelegram.findConfigByBotId.mockResolvedValue({ session_id: 8 });

    await expect(TelegramService.saveConfig(7, 1, TOKEN)).rejects.toMatchObject({ code: 'BOT_ALREADY_IN_USE' });
    expect(SessionTelegram.upsertConfig).not.toHaveBeenCalled();
  });

  test('stores the token encrypted and clears any webhook', async () => {
    axios.post.mockImplementation(async (url) => {
      if (url.endsWith('/getMe')) return ok({ id: 99, is_bot: true, username: 'my_bot' });
      return ok(true);
    });
    SessionTelegram.findConfigByBotId.mockResolvedValue(null);
    SessionTelegram.getConfig.mockResolvedValue(null);
    SessionTelegram.listChats.mockResolvedValue([]);

    await TelegramService.saveConfig(7, 1, TOKEN);

    expect(axios.post.mock.calls.some(([url]) => url.endsWith('/deleteWebhook'))).toBe(true);
    const saved = SessionTelegram.upsertConfig.mock.calls[0][0];
    expect(saved.bot_id).toBe(99);
    expect(saved.bot_token_encrypted).not.toContain(TOKEN);
  });
});

describe('poller', () => {
  const waitFor = async (predicate, ms = 1500) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  };

  const startWithConfig = async () => {
    const config = {
      session_id: 7,
      enabled: 1,
      bot_username: 'my_bot',
      last_update_id: 0,
      bot_token_encrypted: encrypt(TOKEN),
    };
    SessionTelegram.getConfig.mockResolvedValue(config);
    await TelegramService.start(7);
  };

  test('disables the bot when Telegram rejects the token (401)', async () => {
    axios.post.mockRejectedValue({ message: 'unauthorized', response: { status: 401, data: { description: 'Unauthorized' } } });

    await startWithConfig();

    expect(await waitFor(() => SessionTelegram.setEnabled.mock.calls.length > 0)).toBe(true);
    expect(SessionTelegram.setEnabled).toHaveBeenCalledWith(7, false, expect.stringMatching(/rejected the bot token/i));
  });

  test('records a conflict when another consumer polls the bot (409)', async () => {
    axios.post.mockRejectedValue({ message: 'conflict', response: { status: 409, data: { description: 'Conflict' } } });

    await startWithConfig();

    expect(await waitFor(() => SessionTelegram.setLastError.mock.calls.length > 0)).toBe(true);
    expect(SessionTelegram.setLastError).toHaveBeenCalledWith(7, expect.stringMatching(/one consumer per bot/i));
  });

  test('persists the update offset before handling a message', async () => {
    SessionTelegram.findChat.mockResolvedValue({ chat_id: '555', username: 'ana' });
    ChatService.processMessage.mockResolvedValue({ message: 'done' });

    let polls = 0;
    axios.post.mockImplementation(async (url) => {
      if (url.endsWith('/getUpdates')) {
        polls += 1;
        if (polls === 1) return ok([{ update_id: 41, message: privateMessage('hi') }]);
        return new Promise(() => {});
      }
      return ok();
    });

    await startWithConfig();

    expect(await waitFor(() => ChatService.processMessage.mock.calls.length > 0)).toBe(true);
    expect(SessionTelegram.setLastUpdateId).toHaveBeenCalledWith(7, 41);
    expect(SessionTelegram.setLastUpdateId.mock.invocationCallOrder[0])
      .toBeLessThan(ChatService.processMessage.mock.invocationCallOrder[0]);
  });
});
