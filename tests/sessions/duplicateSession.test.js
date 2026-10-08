jest.mock('../../src/models/WorkSession');
jest.mock('../../src/models/Document');
jest.mock('../../src/models/Message');
jest.mock('../../src/services/sessions/SessionStorageLinks', () => ({
  syncSessionStorageLinks: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const WorkSession = require('../../src/models/WorkSession');
const Message = require('../../src/models/Message');
const SessionService = require('../../src/services/sessions/SessionService');

describe('duplicateSession', () => {
  const original = {
    id: 7,
    name: 'Plan',
    description: 'orchestrator prompt',
    context_length: 40,
    orchestrator_provider_type: 'claude',
    orchestrator_provider_config: { model: 'claude-sonnet' },
    conversation_mode_enabled: 0,
    conversation_max_rounds: 10,
    conversation_token_budget: 50000,
    orchestration_mode: 'orchestrator_led',
    decision_model_enabled: 0,
    decision_model_provider: null,
    decision_model_config: null,
    agents: [
      { id: 3, name: 'Analyst', session_context: 'agent three prompt' },
      { id: 4, name: 'Writer', session_context: null },
    ],
    documents: [
      { id: 9, filename: 'brief.pdf' },
      { id: 10, filename: 'notes.txt' },
    ],
    document_agent_assignments: [
      { document_id: 9, agent_id: 3 },
    ],
    tool_agent_assignments: [
      { agent_id: 3, tool_name: 'local_working_folder', tool_config: { folder_name: 'books' } },
      { agent_id: 3, tool_name: 'datetime', tool_config: null },
      { agent_id: 4, tool_name: 'datetime', tool_config: null },
    ],
    orchestrator_tool_assignments: [
      { tool_name: 'manage_agent_documents' },
      { tool_name: 'email', tool_config: { host: 'imap.example.com' } },
    ],
  };

  beforeEach(() => {
    jest.restoreAllMocks();
    WorkSession.update.mockResolvedValue({});
    WorkSession.setAgentSessionContext.mockResolvedValue();
  });

  function stubCopiers(copy) {
    jest.spyOn(SessionService, 'getCompleteSession')
      .mockResolvedValueOnce(original)
      .mockResolvedValueOnce(copy);
    jest.spyOn(SessionService, 'createSession').mockResolvedValue({ id: 20, name: 'Plan (Copy)' });
    jest.spyOn(SessionService, 'updateSession').mockResolvedValue({});
    jest.spyOn(SessionService, 'assignAgents').mockResolvedValue();
    jest.spyOn(SessionService, 'assignDocuments').mockResolvedValue();
    jest.spyOn(SessionService, 'setDocumentAgentAssignments').mockResolvedValue();
    jest.spyOn(SessionService, 'setToolAgentAssignments').mockResolvedValue();
    jest.spyOn(SessionService, 'setOrchestratorToolAssignments').mockResolvedValue();
  }

  it('copies session prompts, tool assignments, and document assignments without messages', async () => {
    const copy = { id: 20, agents: original.agents, documents: original.documents };
    stubCopiers(copy);

    const result = await SessionService.duplicateSession(7, 1);

    expect(SessionService.createSession).toHaveBeenCalledWith(1, expect.objectContaining({
      name: 'Plan (Copy)',
      description: 'orchestrator prompt',
    }));
    expect(WorkSession.update).toHaveBeenCalledWith(20, expect.objectContaining({
      orchestration_mode: 'orchestrator_led',
    }));
    expect(SessionService.assignAgents).toHaveBeenCalledWith(20, 1, [3, 4]);
    expect(WorkSession.setAgentSessionContext).toHaveBeenCalledTimes(1);
    expect(WorkSession.setAgentSessionContext).toHaveBeenCalledWith(20, 3, 'agent three prompt');
    expect(SessionService.setDocumentAgentAssignments).toHaveBeenCalledWith(
      20,
      1,
      [{ documentId: 9, agentIds: [3] }],
      [9, 10]
    );
    expect(SessionService.assignDocuments).not.toHaveBeenCalled();
    expect(SessionService.setToolAgentAssignments).toHaveBeenCalledWith(20, 1, [
      {
        toolName: 'local_working_folder',
        agentIds: [3],
        toolConfigs: { 3: { folder_name: 'books' } },
      },
      {
        toolName: 'datetime',
        agentIds: [3, 4],
        toolConfigs: {},
      },
    ]);
    expect(SessionService.setOrchestratorToolAssignments).toHaveBeenCalledWith(20, 1, [
      { tool_name: 'manage_agent_documents' },
      { tool_name: 'email', tool_config: { host: 'imap.example.com' } },
    ]);
    expect(Message.create).not.toHaveBeenCalled();
    expect(result).toBe(copy);
  });

  it('assigns session documents when no per-agent document rows exist', async () => {
    original.document_agent_assignments = [];
    try {
      const copy = { id: 20, agents: [], documents: [] };
      stubCopiers(copy);

      await SessionService.duplicateSession(7, 1);

      expect(SessionService.assignDocuments).toHaveBeenCalledWith(20, 1, [9, 10]);
      expect(SessionService.setDocumentAgentAssignments).not.toHaveBeenCalled();
    } finally {
      original.document_agent_assignments = [{ document_id: 9, agent_id: 3 }];
    }
  });
});
