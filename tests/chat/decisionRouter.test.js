jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  promptsLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const axios = require('axios');
const DecisionRouter = require('../../src/services/chat/DecisionRouter');
const OrchestratorAgent = require('../../src/services/chat/OrchestratorAgent');
const ProviderFactory = require('../../src/providers/ProviderFactory');

const ORCH_TOOLS = ['manage_agent_documents', 'manage_agent_tools', 'send_to_telegram'];

const agents = [
  {
    id: 2,
    name: 'Researcher',
    role: 'custom',
    initial_context: 'Looks things up in assigned files. '.repeat(30),
  },
  {
    id: 3,
    name: 'Bookkeeper',
    role: 'accounting',
    initial_context: '',
  },
];

const toolNamesByAgentId = {
  2: ['web_search', 'terminal'],
  3: [],
};

function session(overrides = {}) {
  return {
    id: 9,
    orchestration_mode: 'route',
    decision_model_enabled: 1,
    decision_model_provider: 'ollama',
    decision_model_config: {
      model: 'nimble',
      baseURL: 'http://10.0.0.5:11434',
      timeout: 15000,
    },
    description: 'A'.repeat(2000),
    orchestrator_provider_type: 'claude',
    orchestrator_provider_config: {},
    orchestrator_tools: ORCH_TOOLS,
    ...overrides,
  };
}

function routeArgs(overrides = {}) {
  return {
    session: session(),
    agents,
    userMessage: 'Look up the tax rate',
    documentContext: 'SECRET_CHUNK_TEXT',
    toolNamesByAgentId,
    orchestratorToolNames: ORCH_TOOLS,
    ...overrides,
  };
}

function answerBody(handler, needsAnother = 0.1) {
  return {
    model: 'nimble',
    answers: {
      handler,
      needs_another: { type: 'noul', noul: needsAnother },
    },
    usage: { input_tokens: 100, output_tokens: 2 },
  };
}

describe('DecisionRouter', () => {
  const savedTypeSafeKey = process.env.TYPESAFE_API_KEY;

  beforeEach(() => {
    axios.post.mockReset();
    if (savedTypeSafeKey === undefined) delete process.env.TYPESAFE_API_KEY;
    else process.env.TYPESAFE_API_KEY = savedTypeSafeKey;
  });

  function builtRequest(overrides = {}) {
    const args = routeArgs(overrides);
    const connection = DecisionRouter.resolveConnection(args.session);
    return DecisionRouter.buildRequest({ ...args, connection });
  }

  it('puts tool names in each choice and leaves schemas out', () => {
    const body = builtRequest();
    const serialized = JSON.stringify(body);
    const researcher = body.questions.handler.criteria.agent_2;
    const bookkeeper = body.questions.handler.criteria.agent_3;
    const direct = body.questions.handler.criteria.direct;

    expect(researcher).toContain('web_search');
    expect(researcher).toContain('terminal');
    expect(researcher).not.toContain('manage_agent_documents');
    expect(researcher).not.toContain('assign documents');
    expect(researcher.length).toBeLessThanOrEqual(400);

    expect(bookkeeper).toContain('Tools: none.');
    expect(bookkeeper).not.toContain('web_search');

    expect(direct).toContain('manage_agent_documents');
    expect(direct).toContain('manage_agent_tools');
    expect(direct).toContain('send_to_telegram');
    expect(direct).toContain('assign documents');
    expect(direct).toContain('give tools');
    expect(direct).toContain('Telegram');

    expect(serialized).not.toContain('input_schema');
    expect(serialized).not.toContain('SECRET_CHUNK_TEXT');
    expect(body.state.documents).toBe('Relevant documents are available for this request.');
    expect(body.state.session.length).toBeLessThanOrEqual(1500);
    expect(body.state.request).toBe('Look up the tax rate');
    expect(body.questions.needs_another.type).toBe('noul');
  });

  it('omits orchestrator policy sentences when those tools are not assigned', () => {
    const body = builtRequest({ orchestratorToolNames: ['web_search'] });
    expect(body.questions.handler.criteria.direct).toContain('web_search');
    expect(body.questions.handler.criteria.direct).not.toContain('assign documents');
    expect(body.questions.handler.criteria.direct).not.toContain('Telegram');
  });

  it('maps a specialist choice to a single route', () => {
    const decision = DecisionRouter.interpret(answerBody({
      type: 'choice',
      choice: 'agent_2',
      probabilities: { agent_2: 0.91, agent_3: 0.05, direct: 0.04 },
      confidence: 0.84,
    }), agents, 'nimble');

    expect(decision.type).toBe('single');
    expect(decision.agent.id).toBe(2);
    expect(decision.reasoning).toBe('decision model nimble: agent_2 (0.91), confidence 0.84');
    expect(decision.usage).toEqual({ inputTokens: 100, outputTokens: 2, tokensUsed: 102 });
  });

  it('maps direct, and keeps direct when a second specialist is also likely', () => {
    const decision = DecisionRouter.interpret(answerBody({
      type: 'choice',
      choice: 'direct',
      probabilities: { agent_2: 0.4, agent_3: 0.2, direct: 0.4 },
      confidence: 0.1,
    }, 0.99), agents, 'nimble');

    expect(decision.type).toBe('direct');
    expect(decision.agent).toBeUndefined();
  });

  it('routes to two agents when a second specialist is likely', () => {
    const decision = DecisionRouter.interpret(answerBody({
      type: 'choice',
      choice: 'agent_2',
      probabilities: { agent_2: 0.55, agent_3: 0.30, direct: 0.15 },
      confidence: 0.2,
    }, 0.8), agents, 'nimble');

    expect(decision.type).toBe('multi');
    expect(decision.agents.map((agent) => agent.id)).toEqual([2, 3]);
    expect(decision.reasoning).toContain('agent_3 (0.30)');
    expect(decision.reasoning).toContain('needs_another 0.80');
  });

  it('stays with one agent when the runner-up is unlikely', () => {
    const decision = DecisionRouter.interpret(answerBody({
      type: 'choice',
      choice: 'agent_2',
      probabilities: { agent_2: 0.8, agent_3: 0.1, direct: 0.1 },
      confidence: 0.6,
    }, 0.9), agents, 'nimble');

    expect(decision.type).toBe('single');
    expect(decision.agent.id).toBe(2);
  });

  it('posts to the local systemone endpoint and returns the scored route', async () => {
    axios.post.mockResolvedValue({
      data: answerBody({
        type: 'choice',
        choice: 'agent_3',
        probabilities: { agent_2: 0.2, agent_3: 0.7, direct: 0.1 },
        confidence: 0.5,
      }),
    });

    const decision = await DecisionRouter.route(routeArgs());

    expect(decision.type).toBe('single');
    expect(decision.agent.id).toBe(3);
    expect(axios.post).toHaveBeenCalledWith(
      'http://10.0.0.5:11434/v1/systemone',
      expect.objectContaining({ model: 'nimble' }),
      expect.objectContaining({
        timeout: 15000,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  it('calls Jev with the environment API key', async () => {
    process.env.TYPESAFE_API_KEY = 'env-key';
    axios.post.mockResolvedValue({
      data: answerBody({
        type: 'choice',
        choice: 'direct',
        probabilities: { direct: 0.7, agent_2: 0.2, agent_3: 0.1 },
        confidence: 0.4,
      }),
    });

    const decision = await DecisionRouter.route(routeArgs({
      session: session({
        decision_model_provider: 'jev',
        decision_model_config: { model: 'jev' },
      }),
    }));

    expect(decision.type).toBe('direct');
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.typesafe.ai/v1/systemone',
      expect.objectContaining({ model: 'jev-latest' }),
      expect.objectContaining({
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer env-key',
        },
      })
    );
  });

  it('falls back when Jev has no API key', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const decision = await DecisionRouter.route(routeArgs({
      session: session({
        decision_model_provider: 'jev',
        decision_model_config: { model: 'jev-latest' },
      }),
    }));
    expect(decision).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('falls back when there are more agents than Nimble can score', async () => {
    const many = Array.from({ length: 26 }, (_, index) => ({
      id: index + 1,
      name: `Agent ${index + 1}`,
      role: 'custom',
    }));
    const decision = await DecisionRouter.route(routeArgs({ agents: many }));
    expect(decision).toBeNull();
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('falls back when the decision service fails or the choice is unknown', async () => {
    axios.post.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(DecisionRouter.route(routeArgs())).resolves.toBeNull();

    axios.post.mockResolvedValueOnce({
      data: answerBody({
        type: 'choice',
        choice: 'agent_999',
        probabilities: { agent_999: 1 },
        confidence: 1,
      }),
    });
    await expect(DecisionRouter.route(routeArgs())).resolves.toBeNull();
  });

  it('answers directly when no specialists are assigned', async () => {
    const decision = await DecisionRouter.route(routeArgs({ agents: [] }));
    expect(decision).toEqual({
      type: 'direct',
      reasoning: 'No specialists assigned',
      usage: { inputTokens: 0, outputTokens: 0, tokensUsed: 0 },
    });
    expect(axios.post).not.toHaveBeenCalled();
  });
});

describe('analyzeAndRoute with a decision model', () => {
  const savedKeys = {};
  const envNames = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY', 'DEEPSEEK_API_KEY'];

  beforeEach(() => {
    for (const name of envNames) {
      savedKeys[name] = process.env[name];
      delete process.env[name];
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const name of envNames) {
      if (savedKeys[name] === undefined) delete process.env[name];
      else process.env[name] = savedKeys[name];
    }
  });

  it('uses the decision and does not call the generative provider', async () => {
    jest.spyOn(DecisionRouter, 'route').mockResolvedValue({
      type: 'direct',
      reasoning: 'decision model nimble: direct (0.80), confidence 0.70',
      usage: { inputTokens: 10, outputTokens: 1, tokensUsed: 11 },
    });
    const create = jest.spyOn(ProviderFactory, 'create');

    const result = await OrchestratorAgent.analyzeAndRoute(
      session(),
      agents,
      'Look up the tax rate',
      ''
    );

    expect(result.reasoning).toContain('decision model nimble');
    expect(create).not.toHaveBeenCalled();
  });

  it('falls back to the generative router when the decision model declines', async () => {
    jest.spyOn(DecisionRouter, 'route').mockResolvedValue(null);

    const result = await OrchestratorAgent.analyzeAndRoute(
      session(),
      agents,
      'Look up the tax rate',
      ''
    );

    expect(result.reasoning).toMatch(/no orchestrator API key/i);
  });

  it('ignores the flag outside Router mode', async () => {
    const route = jest.spyOn(DecisionRouter, 'route');

    const result = await OrchestratorAgent.analyzeAndRoute(
      session({ orchestration_mode: 'orchestrator_led' }),
      agents,
      'Look up the tax rate',
      ''
    );

    expect(route).not.toHaveBeenCalled();
    expect(result.reasoning).toMatch(/no orchestrator API key/i);
  });
});
