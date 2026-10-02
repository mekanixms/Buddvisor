/**
 * Agent Tools Tool (orchestrator only)
 * Lets the orchestrator assign tools to, or remove them from, the session's agents,
 * exactly like Configure Session → Tools does. Tools are given by name (wildcards allowed),
 * agents by name (with or without "@") or id.
 */

const { toolRegistry } = require('./ToolRegistry');
const WorkSession = require('../../models/WorkSession');
const { resolveAgent, globToRegExp } = require('./agentDocumentsTool');
const logger = require('../../utils/logger');

const TOOL_NAME = 'manage_agent_tools';

// Tools only the orchestrator can use; assigning them to a session agent would be useless.
const ORCHESTRATOR_ONLY_TOOLS = new Set(['manage_agent_documents', TOOL_NAME]);

// Config keys a tool needs before it can work at all (same inputs as Configure Session → Tools).
const REQUIRED_CONFIG = {
  sqlite_local_db: ['database_name'],
  local_working_folder: ['folder_name'],
  ef_api: ['base_url', 'username', 'password'],
  open_memory: ['base_url'],
};

const REQUIRES_WORKSPACE = ['workspace_exec', 'terminal'];

const SECRET_KEY_RE = /pass(word)?|secret|token|api_?key/i;

function stripDecorations(value) {
  return String(value == null ? '' : value)
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .trim();
}

function toStringList(value) {
  if (Array.isArray(value)) return value.map(stripDecorations).filter(Boolean);
  if (typeof value === 'string' && value.trim()) return [stripDecorations(value)];
  return [];
}

function normalizeToolName(value) {
  return stripDecorations(value).toLowerCase().replace(/[\s-]+/g, '_');
}

function getEnabledToolsSet() {
  const val = process.env.ENABLED_TOOLS;
  if (!val || typeof val !== 'string' || val.trim() === '') return null;
  return new Set(val.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Registered tools the user can see in Configure Session → Tools (honours ENABLED_TOOLS). */
function getAvailableTools() {
  const enabled = getEnabledToolsSet();
  return toolRegistry.getAll().filter((t) => !enabled || enabled.has(t.name));
}

/**
 * Resolve one tool reference against the available tools.
 * Wildcards match all hits; plain names match exactly, then by unique substring.
 * @returns {{matches: object[], ambiguous: boolean}}
 */
function matchTools(rawPattern, tools) {
  const pattern = stripDecorations(rawPattern);
  if (!pattern) return { matches: [], ambiguous: false };

  if (/[*?]/.test(pattern)) {
    const re = globToRegExp(normalizeToolName(pattern));
    return { matches: tools.filter((t) => re.test(t.name)), ambiguous: false };
  }

  const wanted = normalizeToolName(pattern);
  const exact = tools.filter((t) => t.name.toLowerCase() === wanted);
  if (exact.length > 0) return { matches: exact, ambiguous: false };

  const contains = tools.filter((t) => t.name.toLowerCase().includes(wanted));
  return { matches: contains, ambiguous: contains.length > 1 };
}

function maskConfig(config) {
  if (!config || typeof config !== 'object') return null;
  const out = {};
  for (const [key, value] of Object.entries(config)) {
    out[key] = SECRET_KEY_RE.test(key) && value ? '***' : value;
  }
  return out;
}

function missingConfigKeys(toolName, config) {
  return (REQUIRED_CONFIG[toolName] || []).filter((key) => {
    const v = config ? config[key] : undefined;
    return v == null || String(v).trim() === '';
  });
}

function parseToolConfig(value) {
  if (value == null || value === '') return { config: null };
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (e) {
      return { error: 'tool_config must be a JSON object.' };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'tool_config must be a JSON object.' };
  }
  return { config: Object.keys(parsed).length > 0 ? parsed : null };
}

async function refreshStorageLinks(sessionId) {
  try {
    const { syncSessionStorageLinks } = require('../sessions/SessionStorageLinks');
    await syncSessionStorageLinks(sessionId);
  } catch (err) {
    logger.warn(`manage_agent_tools: could not refresh session storage links: ${err.message}`);
  }
}

function groupByAgent(assignments) {
  const byAgent = new Map();
  for (const a of assignments) {
    if (!byAgent.has(a.agent_id)) byAgent.set(a.agent_id, []);
    byAgent.get(a.agent_id).push(a);
  }
  return byAgent;
}

async function runList({ sessionId, agents, tools }) {
  const available = getAvailableTools();
  let shown = available;
  if (tools.length > 0) {
    const seen = new Set();
    shown = [];
    for (const pattern of tools) {
      for (const t of matchTools(pattern, available).matches) {
        if (!seen.has(t.name)) {
          seen.add(t.name);
          shown.push(t);
        }
      }
    }
  }
  const shownNames = new Set(shown.map((t) => t.name));

  const byAgent = groupByAgent(await WorkSession.getToolAgentAssignments(sessionId));

  return {
    success: true,
    action: 'list',
    agents: agents.map((a) => ({
      id: a.id,
      name: a.name,
      tools: (byAgent.get(a.id) || [])
        .filter((t) => tools.length === 0 || shownNames.has(t.tool_name))
        .map((t) => {
          const entry = { name: t.tool_name };
          if (t.tool_config) entry.config = maskConfig(t.tool_config);
          return entry;
        }),
    })),
    available_tools: shown
      .filter((t) => !ORCHESTRATOR_ONLY_TOOLS.has(t.name))
      .map((t) => {
        const entry = { name: t.name, category: t.category, description: String(t.description || '').slice(0, 160) };
        if (REQUIRED_CONFIG[t.name]) entry.requires_config = REQUIRED_CONFIG[t.name];
        return entry;
      }),
  };
}

async function runChange({ action, sessionId, agents, tools, agentRefs, toolConfig }) {
  const isAssign = action === 'assign';

  if (agentRefs.length === 0) {
    return { success: false, error: 'At least one agent is required (name or id).' };
  }
  if (tools.length === 0) {
    return { success: false, error: 'At least one tool name (tools) is required.' };
  }

  const targetAgents = [];
  const unmatchedAgents = [];
  const ambiguousAgents = [];
  for (const ref of agentRefs) {
    const { agent, ambiguous } = resolveAgent(ref, agents);
    if (agent) {
      if (!targetAgents.some((a) => a.id === agent.id)) targetAgents.push(agent);
    } else if (ambiguous.length > 0) {
      ambiguousAgents.push({ agent: ref, candidates: ambiguous.map((a) => `${a.name} (id ${a.id})`) });
    } else {
      unmatchedAgents.push(ref);
    }
  }

  const availableAgents = agents.map((a) => `${a.name} (id ${a.id})`);
  if (targetAgents.length === 0) {
    return {
      success: false,
      error: 'No matching agent in this session.',
      unmatched_agents: unmatchedAgents,
      ambiguous_agents: ambiguousAgents,
      available_agents: availableAgents,
    };
  }

  const available = getAvailableTools();
  const resolvedTools = new Map();
  const unmatchedTools = [];
  const ambiguousTools = [];
  for (const pattern of tools) {
    const { matches, ambiguous } = matchTools(pattern, available);
    if (matches.length === 0) unmatchedTools.push(pattern);
    else if (ambiguous) ambiguousTools.push({ tool: pattern, candidates: matches.map((t) => t.name) });
    else matches.forEach((t) => resolvedTools.set(t.name, t));
  }

  const skipped = [];
  const toolNames = [];
  for (const name of resolvedTools.keys()) {
    if (isAssign && ORCHESTRATOR_ONLY_TOOLS.has(name)) {
      skipped.push({ tool: name, reason: 'Orchestrator-only tool; it cannot be assigned to session agents.' });
    } else {
      toolNames.push(name);
    }
  }

  const before = groupByAgent(await WorkSession.getToolAgentAssignments(sessionId));
  const existingFor = (agentId, toolName) =>
    (before.get(agentId) || []).find((a) => a.tool_name === toolName) || null;

  const perAgentResults = [];
  let totalChanged = 0;
  let totalUnchanged = 0;

  for (const agent of targetAgents) {
    const changed = [];
    const unchanged = [];
    const configUpdated = [];
    const needsConfig = [];

    for (const toolName of toolNames) {
      if (isAssign) {
        const existing = existingFor(agent.id, toolName);
        const effective = toolConfig || existing?.tool_config || null;
        const missing = missingConfigKeys(toolName, effective);
        if (missing.length > 0) {
          needsConfig.push({ tool: toolName, missing_config: missing });
          continue;
        }
        const outcome = await WorkSession.addToolAgentAssignment(sessionId, agent.id, toolName, toolConfig);
        if (outcome === 'created') changed.push(toolName);
        else if (outcome === 'updated') configUpdated.push(toolName);
        else unchanged.push(toolName);
      } else {
        const removed = await WorkSession.removeToolAgentAssignment(sessionId, agent.id, toolName);
        (removed ? changed : unchanged).push(toolName);
      }
    }

    totalChanged += changed.length + configUpdated.length;
    totalUnchanged += unchanged.length;

    const entry = { agent_id: agent.id, agent_name: agent.name };
    if (isAssign) {
      entry.assigned = changed;
      entry.config_updated = configUpdated;
      entry.already_assigned = unchanged;
      if (needsConfig.length > 0) entry.needs_config = needsConfig;
    } else {
      entry.removed = changed;
      entry.not_assigned = unchanged;
    }
    perAgentResults.push(entry);
  }

  const notes = [];
  if (totalChanged > 0) {
    await refreshStorageLinks(sessionId);
    try {
      require('../email/EmailWatcher').scheduleEmailWatcherRefresh();
    } catch (err) {
      logger.warn(`email watcher refresh skipped: ${err.message}`);
    }

    if (isAssign) {
      const after = groupByAgent(await WorkSession.getToolAgentAssignments(sessionId));
      for (const agent of targetAgents) {
        const names = (after.get(agent.id) || []);
        const hasWorkspace = names.some((a) => a.tool_name === 'local_working_folder'
          && missingConfigKeys('local_working_folder', a.tool_config).length === 0);
        const dependents = names.map((a) => a.tool_name).filter((n) => REQUIRES_WORKSPACE.includes(n));
        if (!hasWorkspace && dependents.length > 0) {
          notes.push(`${agent.name} has ${dependents.join(' and ')} but no local_working_folder; assign local_working_folder (with a folder_name) too, otherwise ${dependents.length > 1 ? 'they' : 'it'} will not work.`);
        }
      }
    }
  }

  const needsConfigTotal = perAgentResults.reduce((n, r) => n + (r.needs_config ? r.needs_config.length : 0), 0);
  const problems = unmatchedTools.length > 0 || ambiguousTools.length > 0 || skipped.length > 0
    || unmatchedAgents.length > 0 || ambiguousAgents.length > 0 || needsConfigTotal > 0;

  const result = {
    success: totalChanged > 0 || (totalUnchanged > 0 && !problems),
    action,
    results: perAgentResults,
    total_changed: totalChanged,
  };
  if (unmatchedTools.length > 0) {
    result.unmatched_tools = unmatchedTools;
    result.available_tools = available.map((t) => t.name).filter((n) => !ORCHESTRATOR_ONLY_TOOLS.has(n));
  }
  if (ambiguousTools.length > 0) result.ambiguous_tools = ambiguousTools;
  if (skipped.length > 0) result.skipped_tools = skipped;
  if (unmatchedAgents.length > 0) result.unmatched_agents = unmatchedAgents;
  if (ambiguousAgents.length > 0) result.ambiguous_agents = ambiguousAgents;
  if (unmatchedAgents.length > 0) result.available_agents = availableAgents;
  if (needsConfigTotal > 0) {
    notes.push('Some tools need a tool_config before they can be assigned; ask the user for the missing values and call again. Required keys: '
      + Object.entries(REQUIRED_CONFIG).map(([t, keys]) => `${t}: ${keys.join(', ')}`).join('; ') + '.');
  }
  if (notes.length > 0) result.notes = notes;
  if (!result.success) {
    result.error = needsConfigTotal > 0 && totalChanged === 0
      ? 'Missing tool configuration; nothing was assigned for those tools.'
      : (totalUnchanged === 0 && totalChanged === 0 && unmatchedTools.length > 0
        ? 'No matching tool found.'
        : 'Nothing was changed; see unmatched/ambiguous/skipped entries.');
  }

  logger.info(
    `${TOOL_NAME} ${action}: session=${sessionId} agents=[${targetAgents.map((a) => a.name).join(', ')}] tools=[${toolNames.join(', ')}] changed=${totalChanged}`
  );
  return result;
}

function registerAgentToolsTool() {
  toolRegistry.register({
    name: TOOL_NAME,
    description:
      'Orchestrator only. Assign tools to, or remove tools from, the session\'s agents (same effect as Configure Session → Tools). ' +
      'Use it when the user says things like "give @Tax Advisor the web_search tool" or "remove terminal from @Accountant". ' +
      'Tools are matched by name (wildcards * and ? supported, e.g. "session_*"); agents by name (leading @ is fine) or numeric id. ' +
      'Some tools need a tool_config: sqlite_local_db {database_name}, local_working_folder {folder_name}, ' +
      'ef_api {base_url, username, password}, open_memory {base_url}. ' +
      'email needs tool_config {protocol, incoming_host, username, password, smtp_host} from Configure Session. ' +
      'terminal and workspace_exec also need local_working_folder. ' +
      'Actions: "assign", "remove", "list" (shows each agent\'s tools and the tools available; optional "tools" filter). ' +
      'Call it once per request and report the outcome to the user.',
    category: 'session',
    parameters: {
      action: {
        type: 'string',
        enum: ['assign', 'remove', 'list'],
        description: 'assign: give agent(s) tools; remove: take tools away from agent(s); list: show assignments and available tools.',
        required: true,
      },
      tools: {
        type: 'array',
        description: 'Tool names or wildcard patterns, e.g. ["web_search"] or ["local_working_folder", "workspace_exec"]. For list, an optional filter.',
        required: false,
        items: { type: 'string' },
      },
      agents: {
        type: 'array',
        description: 'Target agents by name (with or without a leading @) or numeric id, e.g. ["Tax Advisor"]. Required for assign and remove.',
        required: false,
        items: { type: 'string' },
      },
      tool_config: {
        type: 'object',
        description: 'Optional configuration applied to every assigned tool (replaces an existing one), e.g. {"folder_name":"work"} or {"database_name":"main"}. Assign one configured tool per call.',
        required: false,
      },
    },
    handler: async (params, context = {}) => {
      const { action } = params || {};

      if (!context.sessionId || !context.userId) {
        throw new Error('sessionId and userId are required in context');
      }
      if (context.agentId != null) {
        return { success: false, error: `${TOOL_NAME} can only be used by the orchestrator, not by session agents.` };
      }

      const sessionId = context.sessionId;
      const agents = (await WorkSession.getAgents(sessionId)) || [];
      const tools = toStringList(params.tools);
      const agentRefs = toStringList(params.agents);

      if (action === 'list') {
        return runList({ sessionId, agents, tools });
      }
      if (action === 'assign' || action === 'remove') {
        if (agents.length === 0) {
          return { success: false, error: 'This session has no agents.' };
        }
        const parsed = parseToolConfig(params.tool_config);
        if (parsed.error) return { success: false, error: parsed.error };
        return runChange({ action, sessionId, agents, tools, agentRefs, toolConfig: parsed.config });
      }
      return { success: false, error: `Unknown action: ${action}` };
    },
    examples: [
      { description: 'Give an agent a tool', parameters: { action: 'assign', tools: ['web_search'], agents: ['Tax Advisor'] } },
      { description: 'Give an agent a configured tool', parameters: { action: 'assign', tools: ['local_working_folder'], agents: ['Accountant'], tool_config: { folder_name: 'work' } } },
      { description: 'Remove a tool from an agent', parameters: { action: 'remove', tools: ['terminal'], agents: ['Accountant'] } },
      { description: 'Show current tool assignments', parameters: { action: 'list' } },
    ],
  });

  logger.info(`${TOOL_NAME} tool registered`);
}

module.exports = {
  registerAgentToolsTool,
  matchTools,
  maskConfig,
  missingConfigKeys,
};
