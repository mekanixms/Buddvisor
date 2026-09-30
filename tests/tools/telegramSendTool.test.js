const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../src/models/WorkSession');
jest.mock('../../src/models/Document');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../../src/services/tools/localWorkingFolderTool', () => {
  const nodePath = require('path');
  return {
    getWorkspacePathForOrchestrator: jest.fn(),
    getWorkspacePathForSessionAgent: jest.fn(),
    resolveWorkspacePath: (relativePath, workspacePath) => {
      const resolved = nodePath.resolve(workspacePath, relativePath);
      const root = nodePath.resolve(workspacePath);
      if (resolved !== root && !resolved.startsWith(root + nodePath.sep)) {
        throw new Error(`Path traversal detected: ${relativePath}`);
      }
      return resolved;
    },
  };
});
jest.mock('../../src/services/telegram/TelegramService', () => ({
  sendFileToLinkedChats: jest.fn(),
}));

const Document = require('../../src/models/Document');
const { toolRegistry } = require('../../src/services/tools/ToolRegistry');
const { registerTelegramSendTool } = require('../../src/services/tools/telegramSendTool');
const {
  getWorkspacePathForOrchestrator,
  getWorkspacePathForSessionAgent,
} = require('../../src/services/tools/localWorkingFolderTool');
const TelegramService = require('../../src/services/telegram/TelegramService');

describe('send_to_telegram', () => {
  let handler;
  let workspace;
  const ctx = { sessionId: 7, userId: 1, agentId: null };

  beforeEach(() => {
    jest.clearAllMocks();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-send-'));
    getWorkspacePathForOrchestrator.mockResolvedValue(workspace);
    getWorkspacePathForSessionAgent.mockResolvedValue(null);
    Document.hasAgentAssignments.mockResolvedValue(false);
    Document.getBySession.mockResolvedValue([]);
    Document.getBySessionAndAgent.mockResolvedValue([]);
    TelegramService.sendFileToLinkedChats.mockResolvedValue({
      success: true,
      chats_sent: 1,
      method: 'sendPhoto',
    });
    if (!toolRegistry.get('send_to_telegram')) registerTelegramSendTool();
    handler = toolRegistry.get('send_to_telegram').handler;
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  afterAll(() => {
    toolRegistry.unregister('send_to_telegram');
  });

  it('sends a file from the working folder and does not look for a document', async () => {
    const dir = path.join(workspace, 'TelegramDownloads');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'audio_1.ogg'), Buffer.from('ogg'));

    const result = await handler({ file: 'audio_1.ogg', caption: 'the voice note' }, ctx);

    expect(result.success).toBe(true);
    expect(result.filename).toBe('audio_1.ogg');
    expect(Document.getBySession).not.toHaveBeenCalled();
    const sent = TelegramService.sendFileToLinkedChats.mock.calls[0][1];
    expect(sent.filename).toBe('audio_1.ogg');
    expect(sent.mimeType).toBe('audio/ogg');
    expect(sent.caption).toBe('the voice note');
    expect(sent.buffer.equals(Buffer.from('ogg'))).toBe(true);
  });

  it('sends a session document when the working folder does not have the file', async () => {
    const stored = path.join(workspace, 'stored.jpeg');
    fs.writeFileSync(stored, Buffer.from('jpeg'));
    Document.getBySession.mockResolvedValue([
      { id: 3, filename: 'trigRatios.jpeg', file_path: stored, file_type: 'image/jpeg' },
    ]);

    const result = await handler({ file: 'trigRatios.jpeg' }, ctx);

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/trigRatios\.jpeg/);
    const sent = TelegramService.sendFileToLinkedChats.mock.calls[0][1];
    expect(sent.filename).toBe('trigRatios.jpeg');
    expect(sent.mimeType).toBe('image/jpeg');
    expect(sent.caption).toBe('trigRatios.jpeg');
  });

  it('limits an agent to documents assigned to that agent', async () => {
    Document.hasAgentAssignments.mockResolvedValue(true);
    Document.getBySessionAndAgent.mockResolvedValue([]);

    const result = await handler({ file: 'trigRatios.jpeg' }, { ...ctx, agentId: 12 });

    expect(result.success).toBe(false);
    expect(Document.getBySession).not.toHaveBeenCalled();
    expect(Document.getBySessionAndAgent).toHaveBeenCalledWith(7, 12);
    expect(TelegramService.sendFileToLinkedChats).not.toHaveBeenCalled();
  });

  it('returns the Telegram error when no chat is linked', async () => {
    fs.writeFileSync(path.join(workspace, 'note.txt'), 'hi');
    TelegramService.sendFileToLinkedChats.mockResolvedValue({
      success: false,
      error: 'No Telegram chat is linked to this session. Link one from Configure Session → Telegram.',
    });

    const result = await handler({ file: 'note.txt' }, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No Telegram chat is linked/);
  });

  it('refuses a path that leaves the working folder', async () => {
    const result = await handler({ file: '../secret.txt' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/traversal/i);
    expect(TelegramService.sendFileToLinkedChats).not.toHaveBeenCalled();
  });
});
