jest.mock('../../src/models/WorkSession');
jest.mock('../../src/models/Document');
jest.mock('../../src/services/tools/localWorkingFolderTool', () => ({
  syncAssignedDocumentsToWorkspace: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const WorkSession = require('../../src/models/WorkSession');
const Document = require('../../src/models/Document');
const { toolRegistry } = require('../../src/services/tools/ToolRegistry');
const {
  registerAgentDocumentsTool,
  matchDocuments,
  resolveAgent,
} = require('../../src/services/tools/agentDocumentsTool');

const docs = [
  { id: 1, filename: 'Report.pdf', file_type: 'pdf' },
  { id: 2, filename: 'Report.xlsx', file_type: 'xlsx' },
  { id: 3, filename: 'invoice 01.pdf', file_type: 'pdf' },
  { id: 4, filename: 'invoice 02.pdf', file_type: 'pdf' },
  { id: 5, filename: 'notes.txt', file_type: 'txt' },
];

const agents = [
  { id: 10, name: 'Tax Advisor' },
  { id: 11, name: 'Accountant' },
];

describe('matchDocuments', () => {
  it('matches wildcards case-insensitively', () => {
    const { matches } = matchDocuments('report.*', docs);
    expect(matches.map((d) => d.id)).toEqual([1, 2]);
    expect(matchDocuments('*.PDF', docs).matches.map((d) => d.id)).toEqual([1, 3, 4]);
  });

  it('escapes regex characters in patterns', () => {
    expect(matchDocuments('Report.p?f', docs).matches.map((d) => d.id)).toEqual([1]);
    expect(matchDocuments('Report(1).*', docs).matches).toEqual([]);
  });

  it('prefers an exact filename', () => {
    const res = matchDocuments('notes.txt', docs);
    expect(res.matches.map((d) => d.id)).toEqual([5]);
    expect(res.ambiguous).toBe(false);
  });

  it('falls back to name without extension and flags ambiguity', () => {
    const res = matchDocuments('report', docs);
    expect(res.matches.map((d) => d.id)).toEqual([1, 2]);
    expect(res.ambiguous).toBe(true);
  });

  it('accepts a unique substring but flags several as ambiguous', () => {
    expect(matchDocuments('notes', docs).ambiguous).toBe(false);
    expect(matchDocuments('invoice', docs).ambiguous).toBe(true);
  });

  it('ignores surrounding quotes and empty patterns', () => {
    expect(matchDocuments('"notes.txt"', docs).matches.map((d) => d.id)).toEqual([5]);
    expect(matchDocuments('  ', docs).matches).toEqual([]);
  });
});

describe('resolveAgent', () => {
  it('resolves @mentions, case-insensitively', () => {
    expect(resolveAgent('@tax advisor', agents).agent.id).toBe(10);
    expect(resolveAgent('@Tax_Advisor', agents).agent.id).toBe(10);
  });

  it('resolves numeric ids and unique partial names', () => {
    expect(resolveAgent('11', agents).agent.id).toBe(11);
    expect(resolveAgent('account', agents).agent.id).toBe(11);
  });

  it('returns nothing for unknown agents', () => {
    const res = resolveAgent('@Nobody', agents);
    expect(res.agent).toBeNull();
    expect(res.ambiguous).toEqual([]);
  });

  it('reports ambiguous partial names', () => {
    const res = resolveAgent('a', agents);
    expect(res.agent).toBeNull();
    expect(res.ambiguous).toHaveLength(2);
  });
});

describe('manage_agent_documents handler', () => {
  let handler;
  const ctx = { sessionId: 1, userId: 7, agentId: null };

  beforeAll(() => {
    registerAgentDocumentsTool();
    handler = toolRegistry.get('manage_agent_documents').handler;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    WorkSession.getAgents.mockResolvedValue(agents);
    WorkSession.assignDocument.mockResolvedValue(undefined);
    WorkSession.addDocumentAgentAssignment.mockResolvedValue(true);
    WorkSession.removeDocumentAgentAssignment.mockResolvedValue(true);
    Document.findByUserId.mockResolvedValue(docs);
    Document.hasAgentAssignments.mockResolvedValue(true);
    Document.getBySession.mockResolvedValue([]);
    Document.getBySessionAndAgent.mockResolvedValue([]);
  });

  it('refuses to run for session agents', async () => {
    const res = await handler({ action: 'list' }, { ...ctx, agentId: 10 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/orchestrator/);
  });

  it('assigns every match of a wildcard to the agent and adds them to the session', async () => {
    const res = await handler({ action: 'assign', documents: ['report.*'], agents: ['@Tax Advisor'] }, ctx);

    expect(res.success).toBe(true);
    expect(res.total_changed).toBe(2);
    expect(WorkSession.addDocumentAgentAssignment).toHaveBeenCalledWith(1, 10, 1);
    expect(WorkSession.addDocumentAgentAssignment).toHaveBeenCalledWith(1, 10, 2);
    expect(WorkSession.assignDocument).toHaveBeenCalledWith(1, 1);
    expect(WorkSession.assignDocument).toHaveBeenCalledWith(1, 2);
    expect(res.results[0].assigned.map((d) => d.filename)).toEqual(['Report.pdf', 'Report.xlsx']);
  });

  it('reports documents that are already assigned', async () => {
    WorkSession.addDocumentAgentAssignment.mockResolvedValue(false);
    const res = await handler({ action: 'assign', documents: ['notes.txt'], agents: ['Accountant'] }, ctx);

    expect(res.success).toBe(true);
    expect(res.total_changed).toBe(0);
    expect(res.results[0].already_assigned).toHaveLength(1);
  });

  it('fails when nothing matches and lists the unmatched names', async () => {
    const res = await handler({ action: 'assign', documents: ['ghost.*'], agents: ['Accountant'] }, ctx);

    expect(res.success).toBe(false);
    expect(res.unmatched_documents).toEqual(['ghost.*']);
    expect(WorkSession.addDocumentAgentAssignment).not.toHaveBeenCalled();
  });

  it('does not guess when a plain name is ambiguous', async () => {
    const res = await handler({ action: 'assign', documents: ['invoice'], agents: ['Accountant'] }, ctx);

    expect(res.success).toBe(false);
    expect(res.ambiguous_documents[0].candidates).toEqual(['invoice 01.pdf', 'invoice 02.pdf']);
    expect(WorkSession.addDocumentAgentAssignment).not.toHaveBeenCalled();
  });

  it('rejects unknown agents and lists the available ones', async () => {
    const res = await handler({ action: 'assign', documents: ['notes.txt'], agents: ['@Nobody'] }, ctx);

    expect(res.success).toBe(false);
    expect(res.unmatched_agents).toEqual(['@Nobody']);
    expect(res.available_agents).toEqual(['Tax Advisor (id 10)', 'Accountant (id 11)']);
  });

  it('warns when the first per-agent assignment restricts the other agents', async () => {
    Document.hasAgentAssignments.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const res = await handler({ action: 'assign', documents: ['notes.txt'], agents: ['Accountant'] }, ctx);

    expect(res.notes.join(' ')).toMatch(/only sees the documents explicitly assigned/);
  });

  it('removes only documents the agent currently has', async () => {
    Document.getBySessionAndAgent.mockResolvedValue([docs[0], docs[1]]);
    const res = await handler({ action: 'remove', documents: ['Report.*'], agents: ['Tax Advisor'] }, ctx);

    expect(res.success).toBe(true);
    expect(res.total_changed).toBe(2);
    expect(WorkSession.removeDocumentAgentAssignment).toHaveBeenCalledWith(1, 10, 1);
    expect(WorkSession.removeDocumentAgentAssignment).toHaveBeenCalledWith(1, 10, 2);
    expect(Document.findByUserId).not.toHaveBeenCalled();
  });

  it('reports a removal request for a document the agent does not have', async () => {
    Document.getBySessionAndAgent.mockResolvedValue([docs[4]]);
    const res = await handler({ action: 'remove', documents: ['Report.pdf'], agents: ['Tax Advisor'] }, ctx);

    expect(res.success).toBe(false);
    expect(res.unmatched_documents).toEqual(['Report.pdf']);
    expect(WorkSession.removeDocumentAgentAssignment).not.toHaveBeenCalled();
  });

  it('does not flag a pattern as unmatched when it matched for at least one agent', async () => {
    Document.getBySessionAndAgent.mockImplementation(async (_s, agentId) => (agentId === 10 ? [docs[4]] : []));
    const res = await handler({ action: 'remove', documents: ['notes.txt'], agents: ['Tax Advisor', 'Accountant'] }, ctx);

    expect(res.success).toBe(true);
    expect(res.unmatched_documents).toBeUndefined();
    expect(WorkSession.removeDocumentAgentAssignment).toHaveBeenCalledTimes(1);
  });

  it('lists agent documents and the library', async () => {
    Document.getBySessionAndAgent.mockImplementation(async (_s, agentId) => (agentId === 10 ? [docs[0]] : []));
    Document.getBySession.mockResolvedValue([docs[0]]);
    const res = await handler({ action: 'list' }, ctx);

    expect(res.success).toBe(true);
    expect(res.agents[0].documents).toEqual([{ id: 1, filename: 'Report.pdf' }]);
    expect(res.library).toHaveLength(5);
    expect(res.library[0]).toMatchObject({ id: 1, in_session: true, assigned_to: ['Tax Advisor'] });
  });
});
