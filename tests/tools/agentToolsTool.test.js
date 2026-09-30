jest.mock('../../src/models/WorkSession');
jest.mock('../../src/models/Document');
jest.mock('../../src/services/sessions/SessionStorageLinks', () => ({
  syncSessionStorageLinks: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const WorkSession = require('../../src/models/WorkSession');
const { syncSessionStorageLinks } = require('../../src/services/sessions/SessionStorageLinks');
const { toolRegistry } = require('../../src/services/tools/ToolRegistry');
const {
  registerAgentToolsTool,
  matchTools,
  maskConfig,
  missingConfigKeys,
} = require('../../src/services/tools/agentToolsTool');

const agents = [
  { id: 10, name: 'Tax Advisor' },
  { id: 11, name: 'Accountant' },
];

const fakeTools = ['web_search', 'session_pool', 'session_schedule', 'sqlite_local_db',
  'local_working_folder', 'workspace_exec', 'terminal', 'manage_agent_documents'];

describe('matchTools', () => {
  const tools = fakeTools.map((name) => ({ name }));

  it('matches exact names case-insensitively, tolerating spaces and hyphens', () => {
    expect(matchTools('Web Search', tools).matches.map((t) => t.name)).toEqual(['web_search']);
    expect(matchTools('session-pool', tools).matches.map((t) => t.name)).toEqual(['session_pool']);
  });

  it('matches wildcards', () => {
    expect(matchTools('session_*', tools).matches.map((t) => t.name)).toEqual(['session_pool', 'session_schedule']);
  });

  it('accepts a unique substring but flags several as ambiguous', () => {
    expect(matchTools('terminal', tools).ambiguous).toBe(false);
    expect(matchTools('session', tools).ambiguous).toBe(true);
  });
});

describe('config helpers', () => {
  it('masks secrets', () => {
    expect(maskConfig({ base_url: 'https://x', password: 'p', api_key: 'k' }))
      .toEqual({ base_url: 'https://x', password: '***', api_key: '***' });
  });

  it('reports missing required keys', () => {
    expect(missingConfigKeys('sqlite_local_db', null)).toEqual(['database_name']);
    expect(missingConfigKeys('sqlite_local_db', { database_name: 'main' })).toEqual([]);
    expect(missingConfigKeys('web_search', null)).toEqual([]);
  });
});

describe('manage_agent_tools handler', () => {
  let handler;
  const ctx = { sessionId: 1, userId: 7, agentId: null };
  const originalEnabled = process.env.ENABLED_TOOLS;

  beforeAll(() => {
    fakeTools.forEach((name) => toolRegistry.register({
      name, description: `${name} tool`, category: 'test', handler: async () => ({}),
    }));
    registerAgentToolsTool();
    handler = toolRegistry.get('manage_agent_tools').handler;
  });

  afterAll(() => {
    [...fakeTools, 'manage_agent_tools'].forEach((name) => toolRegistry.unregister(name));
    if (originalEnabled === undefined) delete process.env.ENABLED_TOOLS;
    else process.env.ENABLED_TOOLS = originalEnabled;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ENABLED_TOOLS;
    WorkSession.getAgents.mockResolvedValue(agents);
    WorkSession.getToolAgentAssignments.mockResolvedValue([]);
    WorkSession.addToolAgentAssignment.mockResolvedValue('created');
    WorkSession.removeToolAgentAssignment.mockResolvedValue(true);
  });

  it('refuses to run for session agents', async () => {
    const res = await handler({ action: 'list' }, { ...ctx, agentId: 10 });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/orchestrator/);
  });

  it('assigns a tool to an agent and refreshes storage links', async () => {
    const res = await handler({ action: 'assign', tools: ['web_search'], agents: ['@Tax Advisor'] }, ctx);

    expect(res.success).toBe(true);
    expect(res.total_changed).toBe(1);
    expect(WorkSession.addToolAgentAssignment).toHaveBeenCalledWith(1, 10, 'web_search', null);
    expect(res.results[0].assigned).toEqual(['web_search']);
    expect(syncSessionStorageLinks).toHaveBeenCalledWith(1);
  });

  it('reports tools that are already assigned', async () => {
    WorkSession.addToolAgentAssignment.mockResolvedValue('unchanged');
    const res = await handler({ action: 'assign', tools: ['web_search'], agents: ['Accountant'] }, ctx);

    expect(res.success).toBe(true);
    expect(res.total_changed).toBe(0);
    expect(res.results[0].already_assigned).toEqual(['web_search']);
    expect(syncSessionStorageLinks).not.toHaveBeenCalled();
  });

  it('does not assign a tool that needs configuration without one', async () => {
    const res = await handler({ action: 'assign', tools: ['sqlite_local_db'], agents: ['Accountant'] }, ctx);

    expect(res.success).toBe(false);
    expect(res.results[0].needs_config).toEqual([{ tool: 'sqlite_local_db', missing_config: ['database_name'] }]);
    expect(WorkSession.addToolAgentAssignment).not.toHaveBeenCalled();
  });

  it('assigns a configured tool with the supplied config', async () => {
    const res = await handler({
      action: 'assign', tools: ['sqlite_local_db'], agents: ['Accountant'], tool_config: { database_name: 'main' },
    }, ctx);

    expect(res.success).toBe(true);
    expect(WorkSession.addToolAgentAssignment).toHaveBeenCalledWith(1, 11, 'sqlite_local_db', { database_name: 'main' });
  });

  it('reuses the stored config of an already assigned tool', async () => {
    WorkSession.getToolAgentAssignments.mockResolvedValue([
      { agent_id: 11, tool_name: 'sqlite_local_db', tool_config: { database_name: 'main' } },
    ]);
    WorkSession.addToolAgentAssignment.mockResolvedValue('unchanged');
    const res = await handler({ action: 'assign', tools: ['sqlite_local_db'], agents: ['Accountant'] }, ctx);

    expect(res.success).toBe(true);
    expect(res.results[0].already_assigned).toEqual(['sqlite_local_db']);
  });

  it('refuses to hand orchestrator-only tools to agents', async () => {
    const res = await handler({ action: 'assign', tools: ['manage_agent_documents'], agents: ['Accountant'] }, ctx);

    expect(res.success).toBe(false);
    expect(res.skipped_tools[0].tool).toBe('manage_agent_documents');
    expect(WorkSession.addToolAgentAssignment).not.toHaveBeenCalled();
  });

  it('warns when terminal is assigned without a working folder', async () => {
    WorkSession.getToolAgentAssignments
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ agent_id: 10, tool_name: 'terminal', tool_config: null }]);
    const res = await handler({ action: 'assign', tools: ['terminal'], agents: ['Tax Advisor'] }, ctx);

    expect(res.success).toBe(true);
    expect(res.notes.join(' ')).toMatch(/local_working_folder/);
  });

  it('fails on unknown tools and lists the available ones', async () => {
    const res = await handler({ action: 'assign', tools: ['ghost'], agents: ['Accountant'] }, ctx);

    expect(res.success).toBe(false);
    expect(res.unmatched_tools).toEqual(['ghost']);
    expect(res.available_tools).toContain('web_search');
    expect(res.available_tools).not.toContain('manage_agent_documents');
  });

  it('does not offer tools hidden by ENABLED_TOOLS', async () => {
    process.env.ENABLED_TOOLS = 'terminal';
    const res = await handler({ action: 'assign', tools: ['web_search'], agents: ['Accountant'] }, ctx);

    expect(res.success).toBe(false);
    expect(res.unmatched_tools).toEqual(['web_search']);
    expect(WorkSession.addToolAgentAssignment).not.toHaveBeenCalled();
  });

  it('rejects unknown agents and lists the available ones', async () => {
    const res = await handler({ action: 'assign', tools: ['web_search'], agents: ['@Nobody'] }, ctx);

    expect(res.success).toBe(false);
    expect(res.unmatched_agents).toEqual(['@Nobody']);
    expect(res.available_agents).toEqual(['Tax Advisor (id 10)', 'Accountant (id 11)']);
  });

  it('rejects an invalid tool_config', async () => {
    const res = await handler({ action: 'assign', tools: ['web_search'], agents: ['Accountant'], tool_config: '[1]' }, ctx);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/tool_config/);
  });

  it('removes tools from an agent', async () => {
    const res = await handler({ action: 'remove', tools: ['session_*'], agents: ['Accountant'] }, ctx);

    expect(res.success).toBe(true);
    expect(res.total_changed).toBe(2);
    expect(WorkSession.removeToolAgentAssignment).toHaveBeenCalledWith(1, 11, 'session_pool');
    expect(WorkSession.removeToolAgentAssignment).toHaveBeenCalledWith(1, 11, 'session_schedule');
  });

  it('reports tools an agent did not have on remove', async () => {
    WorkSession.removeToolAgentAssignment.mockResolvedValue(false);
    const res = await handler({ action: 'remove', tools: ['terminal'], agents: ['Accountant'] }, ctx);

    expect(res.success).toBe(true);
    expect(res.total_changed).toBe(0);
    expect(res.results[0].not_assigned).toEqual(['terminal']);
  });

  it('lists agent tools with secrets masked, plus the available tools', async () => {
    WorkSession.getToolAgentAssignments.mockResolvedValue([
      { agent_id: 10, tool_name: 'web_search', tool_config: null },
      { agent_id: 10, tool_name: 'sqlite_local_db', tool_config: { database_name: 'main' } },
    ]);
    const res = await handler({ action: 'list' }, ctx);

    expect(res.success).toBe(true);
    expect(res.agents[0].tools).toEqual([
      { name: 'web_search' },
      { name: 'sqlite_local_db', config: { database_name: 'main' } },
    ]);
    expect(res.agents[1].tools).toEqual([]);
    const names = res.available_tools.map((t) => t.name);
    expect(names).toContain('sqlite_local_db');
    expect(names).not.toContain('manage_agent_documents');
    expect(res.available_tools.find((t) => t.name === 'sqlite_local_db').requires_config).toEqual(['database_name']);
  });
});
