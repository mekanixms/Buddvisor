const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));
jest.mock('../../src/services/documents/DocumentService', () => ({
  uploadDocument: jest.fn(),
}));
jest.mock('../../src/services/sessions/SessionService', () => ({
  getSession: jest.fn(),
}));
jest.mock('../../src/models/Message', () => ({
  create: jest.fn(),
}));
jest.mock('../../src/services/sessions/AutoSaveService', () => ({
  autoSave: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/tools/localWorkingFolderTool', () => {
  const nodePath = require('path');
  return {
    getWorkspacePathForOrchestrator: jest.fn(),
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

const DocumentService = require('../../src/services/documents/DocumentService');
const SessionService = require('../../src/services/sessions/SessionService');
const Message = require('../../src/models/Message');
const { getWorkspacePathForOrchestrator } = require('../../src/services/tools/localWorkingFolderTool');
const ChatUploadService = require('../../src/services/chat/ChatUploadService');

describe('ChatUploadService', () => {
  let workspace;

  beforeEach(() => {
    jest.clearAllMocks();
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-upload-'));
    SessionService.getSession.mockResolvedValue({ id: 7, user_id: 1 });
    getWorkspacePathForOrchestrator.mockResolvedValue(workspace);
    Message.create.mockImplementation(async (row) => ({ id: 42, ...row }));
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('a supported file is stored as a session document', async () => {
    DocumentService.uploadDocument.mockResolvedValue({
      document: { id: 3, filename: 'notes.pdf' },
      message: 'Document uploaded.',
    });

    const result = await ChatUploadService.save(7, 1, {
      originalname: 'notes.pdf',
      mimetype: 'application/pdf',
      size: 4,
      buffer: Buffer.from('pdf'),
    });

    expect(result.kind).toBe('document');
    expect(result.document.id).toBe(3);
    expect(DocumentService.uploadDocument).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ mimetype: 'application/pdf', originalname: 'notes.pdf' }),
      { generateEmbeddings: true }
    );
    expect(Message.create).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workspace, 'Uploads'))).toBe(false);
  });

  test('an octet-stream upload with a known extension is treated as that document type', async () => {
    DocumentService.uploadDocument.mockResolvedValue({
      document: { id: 4, filename: 'notes.pdf' },
      message: 'Document uploaded.',
    });

    await ChatUploadService.save(7, 1, {
      originalname: 'notes.pdf',
      mimetype: 'application/octet-stream',
      size: 3,
      buffer: Buffer.from('pdf'),
    });

    expect(DocumentService.uploadDocument).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ mimetype: 'application/pdf' }),
      expect.any(Object)
    );
  });

  test('an unsupported file is saved in the orchestrator Uploads folder and recorded as context', async () => {
    const result = await ChatUploadService.save(7, 1, {
      originalname: 'archive.zip',
      mimetype: 'application/zip',
      size: 5,
      buffer: Buffer.from('bytes'),
    });

    expect(fs.readFileSync(path.join(workspace, 'Uploads', 'archive.zip'))).toEqual(Buffer.from('bytes'));
    expect(result.kind).toBe('workspace');
    expect(result.relativePath).toBe('Uploads/archive.zip');
    expect(DocumentService.uploadDocument).not.toHaveBeenCalled();
    expect(Message.create).toHaveBeenCalledWith(expect.objectContaining({
      session_id: 7,
      role: 'user',
      content: expect.stringMatching(/Uploads\/archive\.zip/),
      metadata: expect.objectContaining({
        channel: 'chat_upload',
        download_path: 'Uploads/archive.zip',
      }),
    }));
  });

  test('a second copy of the same file name gets a numeric suffix', async () => {
    fs.mkdirSync(path.join(workspace, 'Uploads'));
    fs.writeFileSync(path.join(workspace, 'Uploads', 'archive.zip'), 'old');

    const result = await ChatUploadService.save(7, 1, {
      originalname: 'archive.zip',
      mimetype: 'application/zip',
      size: 5,
      buffer: Buffer.from('bytes'),
    });

    expect(result.relativePath).toBe('Uploads/archive_2.zip');
    expect(fs.readFileSync(path.join(workspace, 'Uploads', 'archive_2.zip'))).toEqual(Buffer.from('bytes'));
  });

  test('an unsupported file is refused when the orchestrator has no working folder', async () => {
    getWorkspacePathForOrchestrator.mockResolvedValue(null);

    await expect(ChatUploadService.save(7, 1, {
      originalname: 'archive.zip',
      mimetype: 'application/zip',
      size: 5,
      buffer: Buffer.from('bytes'),
    })).rejects.toThrow(/local_working_folder is not configured/);
    expect(Message.create).not.toHaveBeenCalled();
  });
});
