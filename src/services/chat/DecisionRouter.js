/**
 * Router-mode decision model.
 * Nimble (local Ollama) and Jev (remote) score a fixed set of handlers.
 * They do not write the user-facing answer.
 */

const axios = require('axios');
const WorkSession = require('../../models/WorkSession');
const logger = require('../../utils/logger');
const { usageFromResponse } = require('./tokenUsage');

const promptsLogger = logger.promptsLogger || logger;

const MAX_AGENTS = 25;
const RUNNER_UP_MIN = 0.15;
const NOUL_YES = 0.5;
const STATE_DESCRIPTION_MAX = 1500;
const CONTEXT_SLICE = 180;
const AGENT_CRITERIA_MAX = 400;
const DIRECT_CRITERIA_MAX = 700;

const DOCUMENT_ADMIN_TOOL = 'manage_agent_documents';
const TOOL_ADMIN_TOOL = 'manage_agent_tools';
const TELEGRAM_SEND_TOOL = 'send_to_telegram';

const DEFAULT_MODELS = {
  ollama: 'nimble',
  jev: 'jev-latest',
};

const DEFAULT_BASE_URLS = {
  ollama: 'http://localhost:11434',
  jev: 'https://api.typesafe.ai',
};

function truncate(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  if (max <= 1) return value.slice(0, max);
  return `${value.slice(0, max - 1)}…`;
}

function formatProb(value) {
  return typeof value === 'number' && !Number.isNaN(value) ? value.toFixed(2) : 'n/a';
}

function roleDescription(role) {
  const OrchestratorAgent = require('./OrchestratorAgent');
  return OrchestratorAgent.getRoleDescription(role);
}

function readConfig(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {
    // Encrypted blob, or not JSON.
  }
  try {
    const { decrypt } = require('../../utils/crypto');
    const parsed = JSON.parse(decrypt(raw));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (_) {
    // Leave empty and let the caller fall back.
  }
  return {};
}

function normalizeBaseURL(raw, fallback) {
  const candidate = String(raw || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(candidate)) return candidate;
  return String(fallback || '').trim().replace(/\/+$/, '');
}

function systemOneURL(baseURL) {
  const trimmed = String(baseURL || '').replace(/\/+$/, '');
  if (trimmed.endsWith('/v1/systemone')) return trimmed;
  if (trimmed.endsWith('/v1')) return `${trimmed}/systemone`;
  return `${trimmed}/v1/systemone`;
}

function normalizeModel(provider, model) {
  const value = String(model || '').trim();
  if (provider === 'jev' && (value === 'jev' || value === 'jev-latest')) return 'jev-latest';
  if (provider === 'ollama' && value === 'nimble') return 'nimble';
  return DEFAULT_MODELS[provider];
}

function agentKey(agentId) {
  return `agent_${agentId}`;
}

function agentFromKey(key, agents) {
  const match = /^agent_(\d+)$/.exec(String(key || ''));
  if (!match) return null;
  return (agents || []).find((agent) => String(agent.id) === match[1]) || null;
}

function buildAgentCriteria(agent, toolNames) {
  const name = truncate(agent.name || 'Agent', 80);
  const tools = (toolNames || []).map((name) => String(name || '').trim()).filter(Boolean);
  const toolPart = `Tools: ${tools.length ? tools.join(', ') : 'none'}.`;
  const head = `${name} (${agent.role || 'custom'}): ${roleDescription(agent.role)}. ${toolPart}`;
  const context = truncate(agent.initial_context, CONTEXT_SLICE);
  return truncate(context ? `${head} ${context}` : head, AGENT_CRITERIA_MAX);
}

function buildDirectCriteria(toolNames) {
  const tools = (toolNames || []).map((name) => String(name || '').trim()).filter(Boolean);
  const parts = ['The orchestrator answers general questions that do not need a specialist.'];
  if (tools.includes(DOCUMENT_ADMIN_TOOL)) {
    parts.push('Requests to assign documents to an agent, remove documents from an agent, or list agent documents are handled here.');
  }
  if (tools.includes(TOOL_ADMIN_TOOL)) {
    parts.push('Requests to give tools to an agent, remove tools from an agent, or list agent tools are handled here.');
  }
  if (tools.includes(TELEGRAM_SEND_TOOL)) {
    parts.push('Requests to send, upload, or attach a file to the linked Telegram chat are handled here.');
  }
  parts.push(`Tools: ${tools.length ? tools.join(', ') : 'none'}.`);
  return truncate(parts.join(' '), DIRECT_CRITERIA_MAX);
}

function runnerUp(probabilities, winnerKey, agents) {
  let best = null;
  for (const [key, probability] of Object.entries(probabilities || {})) {
    if (key === winnerKey || key === 'direct') continue;
    const agent = agentFromKey(key, agents);
    const score = Number(probability);
    if (!agent || Number.isNaN(score)) continue;
    if (!best || score > best.probability) {
      best = { key, agent, probability: score };
    }
  }
  return best;
}

class DecisionRouter {
  static isEnabled(session) {
    if (!session) return false;
    const mode = session.orchestration_mode || 'route';
    if (mode !== 'route') return false;
    const flag = session.decision_model_enabled;
    return flag === 1 || flag === true || flag === '1';
  }

  /**
   * Connection for the saved provider. Null when Jev has no API key or the provider is unknown.
   */
  static resolveConnection(session) {
    const provider = session?.decision_model_provider;
    if (provider !== 'ollama' && provider !== 'jev') return null;

    const config = readConfig(session.decision_model_config);
    const model = normalizeModel(provider, config.model);
    const fallback = provider === 'ollama'
      ? (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URLS.ollama)
      : (process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URLS.jev);
    const baseURL = normalizeBaseURL(config.baseURL, fallback);
    let apiKey = config.apiKey && String(config.apiKey).trim() ? String(config.apiKey).trim() : null;
    if (provider === 'jev') {
      apiKey = apiKey || (process.env.TYPESAFE_API_KEY && String(process.env.TYPESAFE_API_KEY).trim()) || null;
      if (!apiKey) return null;
    }

    let timeout = parseInt(config.timeout, 10);
    if (!timeout || timeout < 1000 || timeout > 600000) timeout = 60000;

    return {
      provider,
      model,
      apiKey,
      timeout,
      url: systemOneURL(baseURL),
    };
  }

  static async loadToolContext(session, agents, explicit = {}) {
    if (explicit.toolNamesByAgentId || explicit.orchestratorToolNames) {
      return {
        toolNamesByAgentId: explicit.toolNamesByAgentId || {},
        orchestratorToolNames: explicit.orchestratorToolNames || [],
      };
    }

    const orchestratorToolNames = Array.isArray(session.orchestrator_tools)
      ? session.orchestrator_tools
      : await WorkSession.getOrchestratorToolNames(session.id);

    const toolNamesByAgentId = {};
    await Promise.all((agents || []).map(async (agent) => {
      if (agent && agent.id != null) {
        toolNamesByAgentId[agent.id] = await WorkSession.getToolNamesBySessionAndAgent(session.id, agent.id);
      }
    }));
    return { toolNamesByAgentId, orchestratorToolNames };
  }

  /**
   * Build the /v1/systemone body. Returns null when the choice list cannot be scored.
   */
  static buildRequest({
    session,
    agents,
    userMessage,
    documentContext,
    toolNamesByAgentId = {},
    orchestratorToolNames = [],
    connection,
  }) {
    const usableAgents = (agents || []).filter((agent) => agent && agent.id != null);
    if (usableAgents.length > MAX_AGENTS) return null;

    const criteria = {};
    for (const agent of usableAgents) {
      criteria[agentKey(agent.id)] = buildAgentCriteria(agent, toolNamesByAgentId[agent.id]);
    }
    criteria.direct = buildDirectCriteria(orchestratorToolNames);

    if (Object.keys(criteria).length < 2) return null;

    const state = {
      request: String(userMessage ?? ''),
    };
    const sessionText = truncate(session?.description, STATE_DESCRIPTION_MAX);
    if (sessionText) state.session = sessionText;
    if (documentContext && String(documentContext).trim()) {
      state.documents = 'Relevant documents are available for this request.';
    }

    return {
      model: connection.model,
      state,
      questions: {
        handler: {
          type: 'choice',
          instructions: 'Which handler should answer this user request? Pick the one specialist whose role and tools fit. Pick direct when the request is general or matches an orchestrator tool.',
          criteria,
        },
        needs_another: {
          type: 'noul',
          instructions: 'Does this request need a second specialist as well?',
          criteria: {
            true: 'The request needs expertise from two specialists.',
            false: 'One handler is enough, or the orchestrator should answer directly.',
          },
        },
      },
    };
  }

  static interpret(responseBody, agents, model) {
    const handler = responseBody?.answers?.handler;
    const choice = handler?.choice;
    if (!choice) return null;

    const probabilities = handler.probabilities || {};
    const confidence = handler.confidence;
    const usage = usageFromResponse(responseBody);
    const modelName = responseBody?.model || model || 'decision-model';

    const reasoningFor = (key, extra) => {
      const bits = [
        `decision model ${modelName}: ${key} (${formatProb(probabilities[key])})`,
        `confidence ${formatProb(confidence)}`,
      ];
      if (extra) bits.push(extra);
      return bits.join(', ');
    };

    if (choice === 'direct') {
      return { type: 'direct', reasoning: reasoningFor('direct'), usage };
    }

    const agent = agentFromKey(choice, agents);
    if (!agent) return null;

    const noul = responseBody?.answers?.needs_another?.noul;
    if (typeof noul === 'number' && noul >= NOUL_YES) {
      const second = runnerUp(probabilities, choice, agents);
      if (second && second.probability >= RUNNER_UP_MIN) {
        return {
          type: 'multi',
          agents: [agent, second.agent],
          reasoning: reasoningFor(
            choice,
            `${second.key} (${formatProb(second.probability)}), needs_another ${formatProb(noul)}`
          ),
          usage,
        };
      }
    }

    return {
      type: 'single',
      agent,
      reasoning: reasoningFor(choice),
      usage,
    };
  }

  static async postSystemOne({ url, body, apiKey, timeout }) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await axios.post(url, body, { headers, timeout });
    return response.data;
  }

  /**
   * Score the user request. Returns null when the caller should use the generative router.
   */
  static async route({
    session,
    agents,
    userMessage,
    documentContext,
    toolNamesByAgentId,
    orchestratorToolNames,
  }) {
    if (!this.isEnabled(session)) return null;

    const usableAgents = (agents || []).filter((agent) => agent && agent.id != null);
    if (usableAgents.length === 0) {
      return {
        type: 'direct',
        reasoning: 'No specialists assigned',
        usage: usageFromResponse(null),
      };
    }
    if (usableAgents.length > MAX_AGENTS) {
      logger.warn(`Decision model supports at most ${MAX_AGENTS} agents; falling back`);
      return null;
    }

    const connection = this.resolveConnection(session);
    if (!connection) {
      logger.warn('Decision model is not configured; falling back');
      return null;
    }

    const tools = await this.loadToolContext(session, usableAgents, {
      toolNamesByAgentId,
      orchestratorToolNames,
    });
    const body = this.buildRequest({
      session,
      agents: usableAgents,
      userMessage,
      documentContext,
      toolNamesByAgentId: tools.toolNamesByAgentId,
      orchestratorToolNames: tools.orchestratorToolNames,
      connection,
    });
    if (!body) return null;

    logger.info('=== DECISION MODEL ROUTING ===');
    promptsLogger.info(`\n\n=== DECISION MODEL ROUTING ===\n${JSON.stringify(body, null, 2)}`);

    try {
      const data = await this.postSystemOne({
        url: connection.url,
        body,
        apiKey: connection.apiKey,
        timeout: connection.timeout,
      });
      const decision = this.interpret(data, usableAgents, connection.model);
      if (!decision) {
        logger.warn('Decision model returned an unusable answer; falling back');
      }
      return decision;
    } catch (error) {
      logger.error(`Decision model request failed: ${error.message}`);
      return null;
    }
  }
}

module.exports = DecisionRouter;
