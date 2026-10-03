/**
 * Router-mode decision model.
 * Nimble (local Ollama) and Jev (remote, or a Jev id on OpenRouter) score a fixed set of handlers.
 * Other OpenRouter models are asked for the same choice as JSON.
 * They do not write the user-facing answer.
 */

const axios = require('axios');
const WorkSession = require('../../models/WorkSession');
const OpenRouterProvider = require('../../providers/OpenRouterProvider');
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
  openrouter: 'google/gemini-2.5-flash',
};

const DEFAULT_BASE_URLS = {
  ollama: 'http://localhost:11434',
  jev: 'https://api.typesafe.ai',
};

const DECISION_PROVIDERS = ['ollama', 'jev', 'openrouter'];

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

/**
 * Jev on OpenRouter is a decisions model. Chat completions reject it.
 * @param {string} model
 */
function isJevDecisionModel(model) {
  const value = String(model || '').trim().toLowerCase();
  if (value === 'jev' || value.startsWith('jev-')) return true;
  return value.startsWith('typesafe/jev') || value.startsWith('~typesafe/jev');
}

/**
 * Decisions API ids are typesafe/jev-… or the ~typesafe/jev-latest alias.
 * @param {string} model
 */
function decisionsModelId(model) {
  const value = String(model || '').trim();
  const lower = value.toLowerCase();
  if (lower === 'jev' || lower === 'jev-latest') return '~typesafe/jev-latest';
  if (lower.startsWith('typesafe/') || lower.startsWith('~typesafe/')) return value;
  if (lower.startsWith('jev-')) return `typesafe/${value}`;
  return value;
}

/**
 * Chat base https://openrouter.ai/api/v1 → https://openrouter.ai/api/alpha/decisions.
 * @param {string} baseURL
 */
function openRouterDecisionsURL(baseURL) {
  const trimmed = String(baseURL || '').replace(/\/+$/, '');
  if (trimmed.endsWith('/alpha/decisions')) return trimmed;
  return `${trimmed.replace(/\/v1$/, '')}/alpha/decisions`;
}

function normalizeModel(provider, model) {
  const value = String(model || '').trim();
  if (provider === 'openrouter') return value || DEFAULT_MODELS.openrouter;
  if (provider === 'jev' && (value === 'jev' || value === 'jev-latest')) return 'jev-latest';
  if (provider === 'ollama' && value === 'nimble') return 'nimble';
  return DEFAULT_MODELS[provider];
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : raw;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1));
    throw _;
  }
}

function noulFrom(value) {
  if (typeof value === 'boolean') return value ? 0.8 : 0.1;
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true' || lower === 'yes') return 0.8;
    if (lower === 'false' || lower === 'no') return 0.1;
  }
  const score = Number(value);
  if (!Number.isFinite(score)) return 0.1;
  return Math.min(1, Math.max(0, score));
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
   * Connection for the saved provider. Null when a remote provider has no API key.
   */
  static resolveConnection(session) {
    const provider = session?.decision_model_provider;
    if (!DECISION_PROVIDERS.includes(provider)) return null;

    const config = readConfig(session.decision_model_config);
    const model = normalizeModel(provider, config.model);
    let timeout = parseInt(config.timeout, 10);
    if (!timeout || timeout < 1000 || timeout > 600000) timeout = 60000;

    if (provider === 'openrouter') {
      const configuredKey = config.apiKey && String(config.apiKey).trim();
      const apiKey = configuredKey
        || (process.env.OPENROUTER_API_KEY && String(process.env.OPENROUTER_API_KEY).trim())
        || null;
      if (!apiKey) return null;
      const baseURL = OpenRouterProvider.resolveBaseURL(config.baseURL);
      if (isJevDecisionModel(model)) {
        return {
          provider,
          kind: 'decisions',
          model: decisionsModelId(model),
          apiKey,
          timeout,
          url: openRouterDecisionsURL(baseURL),
        };
      }
      return {
        provider,
        kind: 'chat',
        model,
        apiKey,
        timeout,
        baseURL,
        openrouterSort: OpenRouterProvider.normalizeSort(config.openrouterSort),
      };
    }

    const fallback = provider === 'ollama'
      ? (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URLS.ollama)
      : (process.env.TYPESAFE_BASE_URL || DEFAULT_BASE_URLS.jev);
    const baseURL = normalizeBaseURL(config.baseURL, fallback);
    let apiKey = config.apiKey && String(config.apiKey).trim() ? String(config.apiKey).trim() : null;
    if (provider === 'jev') {
      apiKey = apiKey || (process.env.TYPESAFE_API_KEY && String(process.env.TYPESAFE_API_KEY).trim()) || null;
      if (!apiKey) return null;
    }

    return {
      provider,
      kind: 'systemone',
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
   * Chat prompt that asks for the same handler choice as /v1/systemone.
   */
  static buildOpenRouterMessages(systemOneBody) {
    const criteria = systemOneBody?.questions?.handler?.criteria || {};
    const lines = Object.entries(criteria).map(([key, text]) => `- ${key}: ${text}`);
    const state = systemOneBody?.state || {};
    const parts = [`User request:\n${state.request || ''}`];
    if (state.session) parts.push(`Session context:\n${state.session}`);
    if (state.documents) parts.push(state.documents);
    parts.push(`Handlers:\n${lines.join('\n')}`);
    parts.push([
      'Reply with JSON only, no markdown.',
      'Schema: {"choice":"<handler key>","confidence":0.0,"probabilities":{"<key>":0.0},"needs_another":0.0}.',
      'choice must be one handler key.',
      'probabilities must include every handler key.',
      'needs_another is from 0 to 1: how likely a second specialist is also required.',
    ].join(' '));
    return [
      {
        role: 'system',
        content: 'You route a user request to exactly one handler. You do not answer the user.',
      },
      { role: 'user', content: parts.join('\n\n') },
    ];
  }

  /**
   * Map a chat JSON reply onto the /v1/systemone answer shape. Null when the choice is unusable.
   */
  static parseOpenRouterDecision(content, model, systemOneBody) {
    const keys = Object.keys(systemOneBody?.questions?.handler?.criteria || {});
    if (!keys.length) return null;

    let parsed;
    try {
      parsed = extractJsonObject(content);
    } catch (_) {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const choice = String(parsed.choice || '').trim();
    if (!keys.includes(choice)) return null;

    const raw = parsed.probabilities && typeof parsed.probabilities === 'object' ? parsed.probabilities : {};
    const probabilities = {};
    let sum = 0;
    for (const key of keys) {
      const score = Number(raw[key]);
      probabilities[key] = Number.isFinite(score) && score >= 0 ? score : 0;
      sum += probabilities[key];
    }
    if (sum <= 0) {
      const confidence = Number(parsed.confidence);
      const winner = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5;
      const rest = keys.length > 1 ? (1 - winner) / (keys.length - 1) : 0;
      for (const key of keys) probabilities[key] = key === choice ? winner : rest;
    }

    let confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence)) confidence = probabilities[choice] || 0;

    return {
      model: model || parsed.model || DEFAULT_MODELS.openrouter,
      answers: {
        handler: {
          type: 'choice',
          choice,
          probabilities,
          confidence,
        },
        needs_another: { type: 'noul', noul: noulFrom(parsed.needs_another) },
      },
    };
  }

  static async postOpenRouter(connection, systemOneBody) {
    const provider = new OpenRouterProvider({
      apiKey: connection.apiKey,
      model: connection.model,
      baseURL: connection.baseURL,
      openrouterSort: connection.openrouterSort,
      timeout: connection.timeout,
      temperature: 0,
      maxTokens: 500,
    });
    const response = await provider.chat(this.buildOpenRouterMessages(systemOneBody), {
      temperature: 0,
      maxTokens: 500,
    });
    const shaped = this.parseOpenRouterDecision(response?.content, connection.model, systemOneBody);
    if (!shaped) return null;
    if (response?.usage) shaped.usage = response.usage;
    return shaped;
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
      const data = connection.kind === 'chat'
        ? await this.postOpenRouter(connection, body)
        : await this.postSystemOne({
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
