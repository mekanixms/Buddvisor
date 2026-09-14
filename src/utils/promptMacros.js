/**
 * Expand {%macro%} / {%macro(args)%} tokens in system prompts at request time.
 */

const { decrypt } = require('./crypto');
const { snapshotDateTime } = require('./datetimeFormat');
const logger = require('./logger');

const MACRO_RE = /\{%\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(([^%]*?)\))?\s*%\}/g;

function looksLikeTimeZone(value) {
  const s = String(value || '').trim();
  return /^(UTC|GMT|local)$/i.test(s) || s.includes('/');
}

function parseDatetimeArgs(raw) {
  const args = String(raw || '').trim();
  if (!args) return { format: null, timeZone: null };
  const lastComma = args.lastIndexOf(',');
  if (lastComma > 0) {
    const left = args.slice(0, lastComma).trim();
    const right = args.slice(lastComma + 1).trim();
    if (looksLikeTimeZone(right)) return { format: left || null, timeZone: right };
  }
  if (looksLikeTimeZone(args)) return { format: null, timeZone: args };
  return { format: args, timeZone: null };
}

function parseProviderConfig(raw) {
  if (!raw) return {};
  try {
    const cfg = typeof raw === 'string' ? JSON.parse(decrypt(raw)) : raw;
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    try {
      return typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
    } catch {
      return {};
    }
  }
}

function modelFromConfig(config) {
  return config?.model ? String(config.model) : '';
}

/**
 * @param {object} [opts]
 * @param {object} [opts.session]
 * @param {object} [opts.agent] - session agent; omit for orchestrator
 * @param {string} [opts.provider]
 * @param {string} [opts.model]
 * @param {string[]} [opts.tools]
 * @param {number} [opts.userId]
 * @param {string} [opts.timezone]
 * @param {Date} [opts.now]
 */
function buildMacroContext(opts = {}) {
  const session = opts.session || {};
  const agent = opts.agent || null;
  const orchCfg = parseProviderConfig(session.orchestrator_provider_config);
  const agentCfg = agent ? parseProviderConfig(agent.provider_config) : {};

  const provider = opts.provider
    || (agent ? agent.provider_type : session.orchestrator_provider_type)
    || '';
  const model = opts.model
    || (agent ? modelFromConfig(agentCfg) : modelFromConfig(orchCfg))
    || '';

  const tools = Array.isArray(opts.tools)
    ? opts.tools
    : (agent
      ? (opts.agentTools || [])
      : (session.orchestrator_tools || []));

  return {
    now: opts.now instanceof Date ? opts.now : new Date(),
    timezone: opts.timezone || null,
    provider: String(provider || ''),
    model: String(model || ''),
    agentName: agent ? (agent.name || '') : 'Orchestrator',
    agentRole: agent ? (agent.role || '') : 'orchestrator',
    agentId: agent ? (agent.id ?? '') : 'orchestrator',
    sessionName: session.name || '',
    sessionId: session.id ?? '',
    orchestrationMode: session.orchestration_mode || 'route',
    tools: Array.isArray(tools) ? tools : [],
    userId: opts.userId ?? session.user_id ?? '',
  };
}

function resolveMacro(name, argsRaw, ctx) {
  const n = String(name || '').toLowerCase();
  const snapNow = (format, timeZone) => snapshotDateTime({
    now: ctx.now,
    format,
    timeZone: timeZone || ctx.timezone,
  });

  switch (n) {
    case 'datetime':
    case 'now': {
      const { format, timeZone } = parseDatetimeArgs(argsRaw);
      return snapNow(format, timeZone).formatted;
    }
    case 'iso_datetime':
    case 'iso':
      return snapNow(null, parseDatetimeArgs(argsRaw).timeZone).iso;
    case 'date':
      return snapNow(null, parseDatetimeArgs(argsRaw).timeZone).date;
    case 'time':
      return snapNow(null, parseDatetimeArgs(argsRaw).timeZone).time;
    case 'unix':
      return String(snapNow().unix);
    case 'timezone':
    case 'tz':
      return snapNow(null, argsRaw || ctx.timezone).timezone;
    case 'weekday':
      return snapNow(null, parseDatetimeArgs(argsRaw).timeZone).weekday;
    case 'year':
      return snapNow().year;
    case 'month':
      return snapNow().month;
    case 'day':
      return snapNow().day;
    case 'model':
      return ctx.model || '';
    case 'provider':
      return ctx.provider || '';
    case 'agent_name':
    case 'name':
      return String(ctx.agentName ?? '');
    case 'agent_role':
    case 'role':
      return String(ctx.agentRole ?? '');
    case 'agent_id':
      return String(ctx.agentId ?? '');
    case 'session_name':
      return String(ctx.sessionName ?? '');
    case 'session_id':
      return String(ctx.sessionId ?? '');
    case 'orchestration_mode':
      return String(ctx.orchestrationMode ?? '');
    case 'user_id':
      return String(ctx.userId ?? '');
    case 'tools':
      return Array.isArray(ctx.tools) ? ctx.tools.join(', ') : '';
    default:
      return null;
  }
}

/**
 * Replace {%macro%} tokens. Unknown macros are left unchanged.
 */
function expandPromptMacros(text, context = {}) {
  if (text == null || text === '') return text;
  const src = String(text);
  if (!src.includes('{%')) return src;

  const ctx = context.session || context.agent
    ? buildMacroContext(context)
    : { now: new Date(), timezone: null, provider: '', model: '', agentName: '', agentRole: '', agentId: '', sessionName: '', sessionId: '', orchestrationMode: '', tools: [], userId: '', ...context };

  return src.replace(MACRO_RE, (match, name, args) => {
    try {
      const value = resolveMacro(name, args, ctx);
      if (value == null) {
        logger.warn(`Unknown prompt macro: ${match}`);
        return match;
      }
      return value;
    } catch (err) {
      logger.warn(`Prompt macro failed (${match}): ${err.message}`);
      return match;
    }
  });
}

const MACRO_HELP = [
  '{%datetime%} — current date/time (ISO with offset)',
  '{%datetime(YYYY-MM-DD HH:mm)%} — custom format (YYYY YY MM DD HH mm ss dddd ddd tz)',
  '{%datetime(YYDDMM-HH:mm)%} — example compact stamp',
  '{%datetime(YYYY-MM-DD HH:mm, Europe/Bucharest)%} — format + IANA timezone',
  '{%date%} {%time%} {%iso_datetime%} {%unix%} {%timezone%} {%weekday%}',
  '{%year%} {%month%} {%day%}',
  '{%model%} {%provider%} — this agent/orchestrator LLM',
  '{%agent_name%} {%agent_role%} {%agent_id%}',
  '{%session_name%} {%session_id%} {%orchestration_mode%}',
  '{%user_id%} {%tools%} — assigned tools for this caller',
].join('\n');

module.exports = {
  expandPromptMacros,
  buildMacroContext,
  MACRO_HELP,
  parseDatetimeArgs,
};
