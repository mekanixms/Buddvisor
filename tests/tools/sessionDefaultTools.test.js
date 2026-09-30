jest.mock('../../src/models/WorkSession');
jest.mock('../../src/models/Document');
jest.mock('../../src/models/Message');
jest.mock('../../src/services/sessions/SessionStorageLinks', () => ({
  syncSessionStorageLinks: jest.fn(),
}));
jest.mock('../../src/services/tools/localWorkingFolderTool', () => ({
  syncAssignedDocumentsToWorkspace: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const WorkSession = require('../../src/models/WorkSession');
const { toolRegistry } = require('../../src/services/tools/ToolRegistry');
const { registerAgentDocumentsTool } = require('../../src/services/tools/agentDocumentsTool');
const { registerAgentToolsTool } = require('../../src/services/tools/agentToolsTool');
const { registerTelegramSendTool } = require('../../src/services/tools/telegramSendTool');
const SessionService = require('../../src/services/sessions/SessionService');

describe('default orchestrator tools for new sessions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    WorkSession.create.mockResolvedValue({ id: 5, name: 'S' });
    WorkSession.replaceOrchestratorToolAssignments.mockResolvedValue(undefined);
  });

  afterEach(() => {
    toolRegistry.unregister('manage_agent_documents');
    toolRegistry.unregister('manage_agent_tools');
    toolRegistry.unregister('send_to_telegram');
  });

  it('pre-assigns manage_agent_documents, manage_agent_tools and send_to_telegram to the orchestrator', async () => {
    registerAgentDocumentsTool();
    registerAgentToolsTool();
    registerTelegramSendTool();

    await SessionService.createSession(1, { name: 'S' });

    expect(WorkSession.replaceOrchestratorToolAssignments).toHaveBeenCalledWith(5, [
      { tool_name: 'manage_agent_documents' },
      { tool_name: 'manage_agent_tools' },
      { tool_name: 'send_to_telegram' },
    ]);
  });

  it('only pre-assigns the default tools that are registered', async () => {
    registerAgentToolsTool();

    await SessionService.createSession(1, { name: 'S' });

    expect(WorkSession.replaceOrchestratorToolAssignments).toHaveBeenCalledWith(5, [
      { tool_name: 'manage_agent_tools' },
    ]);
  });

  it('skips a default tool that is not registered', async () => {
    await SessionService.createSession(1, { name: 'S' });

    expect(WorkSession.replaceOrchestratorToolAssignments).not.toHaveBeenCalled();
  });
});
