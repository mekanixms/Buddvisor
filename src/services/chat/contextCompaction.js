/**
 * Fit a prompt into a percentage of the model's context window.
 * The same model summarizes whatever does not fit, then the real prompt is
 * system instructions + that summary + the new request. Prior context-window
 * messages are not sent again and the summary is not stored as chat history.
 */

const logger = require('../../utils/logger');
const { parseStoredCapabilitiesJson } = require('../../utils/modelCapabilities');
const { usageFromResponse, zeroUsage } = require('./tokenUsage');

const DEFAULT_COMPACT_PERCENT = 70;
const MAX_SUMMARY_PASSES = 4;
const UNKNOWN_WINDOW_WARN_TOKENS = 8000;
const CONTEXT_TOKENS_MAX = 10000000;

const HISTORY_PREFIX = 'Compacted prior context. This replaces the earlier messages from the context window:\n\n';

function clampPercent(value) {
  if (value == null || value === '') return DEFAULT_COMPACT_PERCENT;
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_COMPACT_PERCENT;
  return Math.min(100, Math.max(1, Math.round(n)));
}

function messageText(message) {
  if (!message || message.content == null) return '';
  if (typeof message.content === 'string') return message.content;
  try {
    return JSON.stringify(message.content);
  } catch {
    return String(message.content);
  }
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

function estimateMessagesTokens(messages) {
  let total = 0;
  for (const msg of messages || []) {
    total += 4;
    total += estimateTokens(messageText(msg));
  }
  return total;
}

/**
 * Context length stored on an agent or the orchestrator.
 * Hugging Face puts it on hf_runtime_hints; OpenRouter on openrouter_runtime_hints.
 * @param {object|string|null} raw
 * @returns {number|null}
 */
function contextWindowFromCapabilities(raw) {
  const caps = parseStoredCapabilitiesJson(raw);
  if (!caps) return null;
  const candidates = [
    caps.hf_runtime_hints && caps.hf_runtime_hints.context_length,
    caps.openrouter_runtime_hints && caps.openrouter_runtime_hints.context_length,
    caps.context_length,
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}

function positiveTokenCount(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Blank, null, or '' means unset. A set value is a whole number of tokens.
 * @param {unknown} value
 * @returns {number|null}
 */
function parseOptionalContextTokens(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > CONTEXT_TOKENS_MAX) {
    throw new Error(`Context size must be between 1 and ${CONTEXT_TOKENS_MAX} tokens`);
  }
  return n;
}

/**
 * A caller's own size wins, then the session size, then the model's reported length.
 * @param {object} session
 * @param {object|string|null} capabilities
 * @param {number|string|null|undefined} explicitTokens
 * @returns {number|null}
 */
function resolveContextWindowTokens(session, capabilities, explicitTokens) {
  return positiveTokenCount(explicitTokens)
    || positiveTokenCount(session?.context_tokens)
    || contextWindowFromCapabilities(capabilities);
}

function compactionOptions(session, capabilities, label, explicitTokens) {
  return {
    contextWindowTokens: resolveContextWindowTokens(session, capabilities, explicitTokens),
    compactPercent: clampPercent(session?.context_compact_percent ?? DEFAULT_COMPACT_PERCENT),
    compactLabel: label || 'agent',
  };
}

/**
 * System messages stay put. The last user message is the new prompt.
 * Everything else is prior context and is eligible to be summarized away.
 */
function splitForCompaction(messages) {
  const systemMessages = [];
  const rest = [];
  for (const msg of messages || []) {
    if (msg && msg.role === 'system') systemMessages.push(msg);
    else rest.push(msg);
  }
  let newPromptIndex = -1;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (rest[i] && rest[i].role === 'user') {
      newPromptIndex = i;
      break;
    }
  }
  if (newPromptIndex === -1) {
    return { systemMessages, history: rest, newPrompt: null };
  }
  return {
    systemMessages,
    history: rest.slice(0, newPromptIndex),
    newPrompt: rest[newPromptIndex],
  };
}

function formatTranscript(messages) {
  return (messages || []).map((msg) => `${msg.role || 'message'}: ${messageText(msg)}`).join('\n\n');
}

function chunkByTokens(text, maxTokens) {
  const maxChars = Math.max(80, maxTokens) * 4;
  if (!text) return [];
  if (text.length <= maxChars) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const breakAt = text.lastIndexOf('\n\n', end);
      if (breakAt > start + Math.floor(maxChars * 0.5)) end = breakAt;
    }
    const piece = text.slice(start, end).trim();
    if (piece) chunks.push(piece);
    if (end <= start) break;
    start = end;
  }
  return chunks;
}

function truncateToTokens(text, maxTokens) {
  const maxChars = Math.max(1, maxTokens) * 4;
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated]`;
}

function instructionFor(kind) {
  if (kind === 'system') {
    return 'Summarize these assistant instructions and the additional context bundled with them. Keep every rule, name, number, constraint, and fact required to keep doing the job. Drop repetition. Write plain prose.';
  }
  if (kind === 'request') {
    return 'Summarize this user request so a later reply can still carry it out. Keep the ask, the data, and the constraints. Drop repetition. Write plain prose.';
  }
  return 'Summarize this prior conversation and context. Keep decisions, facts, names, numbers, constraints, and unfinished tasks. Drop repetition. Write plain prose the assistant can use as its only memory of what happened before the next request.';
}

function absorbUsage(total, response) {
  const usage = usageFromResponse(response);
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.tokensUsed += usage.tokensUsed;
}

/**
 * Summarize `text` until it is at most `targetTokens`, chunking so each
 * summarizer call itself stays within `limit`.
 */
async function summarizeToFit(provider, text, targetTokens, { limit, kind, label }) {
  const usage = zeroUsage();
  let current = String(text || '').trim();
  if (!current) return { summary: '', usage };

  const instruction = instructionFor(kind);
  const outputReserve = Math.min(800, Math.max(80, Math.floor(limit * 0.15)));
  const target = Math.max(40, targetTokens);
  const prefix = `${instruction}\n\nThe summary must stay under ${target} tokens.\n\n`;
  const instructionTokens = estimateTokens(prefix) + 4;
  const inputBudget = Math.max(80, limit - instructionTokens - outputReserve);

  for (let pass = 0; pass < MAX_SUMMARY_PASSES; pass++) {
    if (estimateTokens(current) <= target) {
      return { summary: current, usage };
    }
    const chunks = chunkByTokens(current, inputBudget);
    const pieces = [];
    for (const chunk of chunks) {
      const prompt = `${instruction}\n\nThe summary must stay under ${target} tokens.\n\n${chunk}`;
      logger.promptsLogger?.info(
        `\n\n=== CONTEXT COMPACTION (${label}, ${kind}, pass ${pass + 1}) ===\n${prompt}`
      );
      const response = await provider.chat(
        [{ role: 'user', content: prompt }],
        { maxTokens: Math.min(outputReserve, Math.max(80, target)) }
      );
      absorbUsage(usage, response);
      const content = response && response.content != null ? String(response.content).trim() : '';
      if (!content) throw new Error('Context summary was empty');
      pieces.push(content);
    }
    current = pieces.join('\n\n').trim();
  }

  return { summary: truncateToTokens(current, target), usage };
}

function historyMessage(summary) {
  return { role: 'user', content: HISTORY_PREFIX + summary };
}

function assemble({ systemMessages, systemText, historySummary, newPrompt }) {
  const messages = [];
  if (systemText != null) {
    messages.push({ role: 'system', content: systemText });
  } else {
    messages.push(...systemMessages);
  }
  // One user turn: the summary stands in for the context-window messages,
  // then the current request. A second user message is not added.
  if (historySummary && newPrompt) {
    messages.push({
      role: 'user',
      content: `${HISTORY_PREFIX}${historySummary}\n\nCurrent request:\n${messageText(newPrompt)}`,
    });
  } else if (historySummary) {
    messages.push(historyMessage(historySummary));
  } else if (newPrompt) {
    messages.push(newPrompt);
  }
  return messages;
}

function fallbackTrim({ systemMessages, newPrompt, limit }) {
  const systemText = systemMessages.map((msg) => messageText(msg)).filter(Boolean).join('\n\n');
  let prompt = newPrompt;
  let newTokens = prompt ? estimateMessagesTokens([prompt]) : 0;
  if (prompt && newTokens > limit) {
    prompt = {
      role: 'user',
      content: truncateToTokens(messageText(prompt), Math.max(40, Math.floor(limit * 0.4))),
    };
    newTokens = estimateMessagesTokens([prompt]);
  }
  const systemBudget = Math.max(40, limit - newTokens - 8);
  const messages = [];
  if (systemText) {
    messages.push({ role: 'system', content: truncateToTokens(systemText, systemBudget) });
  }
  if (prompt) messages.push(prompt);
  return messages;
}

/**
 * @param {object} params
 * @param {object} params.provider - Same provider the real prompt will use
 * @param {Array} params.messages
 * @param {number|null} params.contextWindowTokens - Model context length
 * @param {number} [params.compactPercent]
 * @param {string} [params.label]
 * @returns {Promise<{messages: Array, compacted: boolean, estimated: number, limit: number, inputTokens: number, outputTokens: number, tokensUsed: number}>}
 */
async function compactMessagesIfNeeded({
  provider,
  messages,
  contextWindowTokens,
  compactPercent = DEFAULT_COMPACT_PERCENT,
  label = 'agent',
}) {
  const base = { ...zeroUsage(), compacted: false, estimated: 0, limit: 0 };
  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: messages || [], ...base };
  }

  const estimated = estimateMessagesTokens(messages);
  const windowTokens = Number(contextWindowTokens);
  if (!Number.isFinite(windowTokens) || windowTokens < 1) {
    if (estimated > UNKNOWN_WINDOW_WARN_TOKENS) {
      logger.warn(
        `Context compaction skipped for ${label}: model context size is unknown (${estimated} estimated tokens). Fetch the model so its context length is stored.`
      );
    }
    return { messages, ...base, estimated };
  }

  const percent = clampPercent(compactPercent);
  const limit = Math.max(1, Math.floor(windowTokens * percent / 100));
  if (estimated <= limit) {
    return { messages, ...base, estimated, limit };
  }

  const { systemMessages, history, newPrompt } = splitForCompaction(messages);
  const originalSystem = systemMessages.map((msg) => messageText(msg)).filter(Boolean).join('\n\n');
  const usage = zeroUsage();

  try {
    let promptMessage = newPrompt;
    let newTokens = promptMessage ? estimateMessagesTokens([promptMessage]) : 0;
    const systemTokens = originalSystem
      ? estimateMessagesTokens([{ role: 'system', content: originalSystem }])
      : 0;
    const requestCap = Math.max(60, Math.floor(limit * 0.45));

    if (promptMessage && (newTokens > limit || (originalSystem && systemTokens + newTokens + 8 > limit && newTokens > requestCap))) {
      const summarized = await summarizeToFit(
        provider,
        messageText(promptMessage),
        Math.min(newTokens, requestCap),
        { limit, kind: 'request', label }
      );
      absorbUsage(usage, { usage: {
        input_tokens: summarized.usage.inputTokens,
        output_tokens: summarized.usage.outputTokens,
        total_tokens: summarized.usage.tokensUsed,
      } });
      promptMessage = { role: 'user', content: summarized.summary };
      newTokens = estimateMessagesTokens([promptMessage]);
    }

    let systemReplacement = null;
    if (originalSystem && systemTokens + newTokens + 8 > limit) {
      const reservedForHistory = history.length > 0 ? 80 : 0;
      const systemTarget = Math.max(60, limit - newTokens - reservedForHistory - 8);
      const summarized = await summarizeToFit(provider, originalSystem, systemTarget, {
        limit,
        kind: 'system',
        label,
      });
      absorbUsage(usage, { usage: {
        input_tokens: summarized.usage.inputTokens,
        output_tokens: summarized.usage.outputTokens,
        total_tokens: summarized.usage.tokensUsed,
      } });
      systemReplacement = summarized.summary;
    }

    const systemForBudget = systemReplacement != null
      ? estimateMessagesTokens([{ role: 'system', content: systemReplacement }])
      : systemTokens;
    const prefixTokens = estimateTokens(HISTORY_PREFIX) + 4;
    const roomForHistory = limit - newTokens - systemForBudget - 12;
    const summaryBudget = roomForHistory - prefixTokens;

    let historySummary = '';
    if (history.length > 0 && summaryBudget >= 40) {
      const summarized = await summarizeToFit(
        provider,
        formatTranscript(history),
        summaryBudget,
        { limit, kind: 'history', label }
      );
      absorbUsage(usage, { usage: {
        input_tokens: summarized.usage.inputTokens,
        output_tokens: summarized.usage.outputTokens,
        total_tokens: summarized.usage.tokensUsed,
      } });
      historySummary = summarized.summary;
    }

    let compactedMessages = assemble({
      systemMessages,
      systemText: systemReplacement,
      historySummary,
      newPrompt: promptMessage,
    });

    if (historySummary && estimateMessagesTokens(compactedMessages) > limit) {
      const over = estimateMessagesTokens(compactedMessages) - limit;
      historySummary = truncateToTokens(
        historySummary,
        Math.max(40, estimateTokens(historySummary) - over - 4)
      );
      compactedMessages = assemble({
        systemMessages,
        systemText: systemReplacement,
        historySummary,
        newPrompt: promptMessage,
      });
    }

    logger.info(
      `Context compaction for ${label}: ${estimated} tokens is over ${percent}% of ${windowTokens} (limit ${limit}). Next prompt is ${estimateMessagesTokens(compactedMessages)} tokens and does not include the context-window messages.`
    );

    return {
      messages: compactedMessages,
      compacted: true,
      estimated,
      limit,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      tokensUsed: usage.tokensUsed,
    };
  } catch (error) {
    logger.warn(
      `Context compaction failed for ${label}: ${error.message}. Dropping prior messages so the prompt can be sent.`
    );
    return {
      messages: fallbackTrim({ systemMessages, newPrompt, limit }),
      compacted: true,
      estimated,
      limit,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      tokensUsed: usage.tokensUsed,
    };
  }
}

module.exports = {
  DEFAULT_COMPACT_PERCENT,
  HISTORY_PREFIX,
  clampPercent,
  estimateTokens,
  estimateMessagesTokens,
  contextWindowFromCapabilities,
  parseOptionalContextTokens,
  resolveContextWindowTokens,
  compactionOptions,
  splitForCompaction,
  compactMessagesIfNeeded,
};
