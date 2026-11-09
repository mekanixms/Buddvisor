jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const {
  compactMessagesIfNeeded,
  contextWindowFromCapabilities,
  compactionOptions,
  estimateMessagesTokens,
  HISTORY_PREFIX,
} = require('../../src/services/chat/contextCompaction');

function providerReturning(text) {
  const calls = [];
  return {
    calls,
    chat: jest.fn(async (messages) => {
      calls.push(messages);
      return {
        content: text,
        usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
      };
    }),
  };
}

describe('context compaction', () => {
  test('reads context length from agent and orchestrator capability hints', () => {
    expect(contextWindowFromCapabilities(JSON.stringify({
      hf_runtime_hints: { context_length: 8192 },
    }))).toBe(8192);
    expect(contextWindowFromCapabilities({
      openrouter_runtime_hints: { context_length: 32768 },
    })).toBe(32768);
    expect(contextWindowFromCapabilities({ text: true, vision: false })).toBeNull();
    expect(compactionOptions({ context_compact_percent: 80 }, {
      hf_runtime_hints: { context_length: 4096 },
    }, 'Books').compactPercent).toBe(80);
    expect(compactionOptions({}, null, 'Books').compactPercent).toBe(70);
    expect(compactionOptions({}, null, 'Books').contextWindowTokens).toBeNull();
    expect(compactionOptions(
      { context_tokens: 16000, context_compact_percent: 50 },
      { hf_runtime_hints: { context_length: 8192 } },
      'Books'
    )).toMatchObject({ contextWindowTokens: 16000, compactPercent: 50 });
    expect(compactionOptions(
      { context_tokens: 16000 },
      { hf_runtime_hints: { context_length: 8192 } },
      'Orchestrator',
      32000
    ).contextWindowTokens).toBe(32000);
    expect(compactionOptions(
      { context_tokens: 16000 },
      { hf_runtime_hints: { context_length: 8192 } },
      'Books',
      null
    ).contextWindowTokens).toBe(16000);
  });

  test('leaves a prompt under the limit unchanged', async () => {
    const provider = providerReturning('unused');
    const messages = [
      { role: 'system', content: 'You are the bookkeeping agent.' },
      { role: 'user', content: 'What is 2 + 2?' },
    ];
    const result = await compactMessagesIfNeeded({
      provider,
      messages,
      contextWindowTokens: 8000,
      compactPercent: 70,
      label: 'Books',
    });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  test('summarizes prior messages and does not send them again', async () => {
    const provider = providerReturning('Kept the Friday decision.');
    const historyFact = 'UNIQUE_HISTORY_FACT_xyz shipped the ledger on Friday.';
    const system = 'You are the bookkeeping agent.';
    const request = 'Please decide the next step.';
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: historyFact },
      { role: 'assistant', content: historyFact + ' noted.' },
      { role: 'user', content: historyFact.repeat(80) },
      { role: 'assistant', content: historyFact.repeat(80) },
      { role: 'user', content: request },
    ];
    const result = await compactMessagesIfNeeded({
      provider,
      messages,
      contextWindowTokens: 4000,
      compactPercent: 50,
      label: 'Books',
    });

    expect(result.compacted).toBe(true);
    expect(provider.chat).toHaveBeenCalled();
    const limit = Math.floor(4000 * 50 / 100);
    for (const call of provider.calls) {
      expect(estimateMessagesTokens(call)).toBeLessThanOrEqual(limit);
      expect(call[0].content).toContain('prior conversation');
    }
    const joined = result.messages.map((msg) => msg.content).join('\n');
    expect(joined).toContain(system);
    expect(joined).toContain(request);
    expect(joined).toContain('Kept the Friday decision.');
    expect(joined).toContain(HISTORY_PREFIX);
    expect(joined).not.toContain(historyFact);
    expect(result.messages.filter((msg) => msg.role !== 'system')).toHaveLength(1);
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(Math.floor(4000 * 50 / 100));
    expect(result.tokensUsed).toBe(provider.chat.mock.calls.length * 18);
  });

  test('summarizes a system prompt that is already over the model window', async () => {
    const provider = providerReturning('Short rules: be precise.');
    const bulky = `RULE keep every invoice line. ${'detail '.repeat(4000)}`;
    const request = 'Please answer.';
    const result = await compactMessagesIfNeeded({
      provider,
      messages: [
        { role: 'system', content: bulky },
        { role: 'user', content: request },
      ],
      contextWindowTokens: 2000,
      compactPercent: 70,
      label: 'Books',
    });

    expect(result.compacted).toBe(true);
    expect(provider.calls[0][0].content).toContain('assistant instructions');
    expect(result.messages[0].role).toBe('system');
    expect(result.messages[0].content).toContain('Short rules: be precise.');
    expect(result.messages[result.messages.length - 1].content).toBe(request);
    expect(result.messages.map((msg) => msg.content).join('\n')).not.toContain('RULE keep every invoice');
    expect(result.messages.some((msg) => msg.role === 'assistant')).toBe(false);
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(Math.floor(2000 * 70 / 100));
  });

  test('fits when both the system prompt and the new request are over the limit', async () => {
    const provider = providerReturning('Compacted.');
    const result = await compactMessagesIfNeeded({
      provider,
      messages: [
        { role: 'system', content: `SYSTEM ${'instruction '.repeat(3000)}` },
        { role: 'user', content: `HISTORY_BLOB ${'prior '.repeat(2500)}` },
        { role: 'assistant', content: `HISTORY_BLOB ${'prior '.repeat(2500)}` },
        { role: 'user', content: `REQUEST ${'attachment '.repeat(3000)}` },
      ],
      contextWindowTokens: 2000,
      compactPercent: 70,
      label: 'Books',
    });
    const limit = Math.floor(2000 * 70 / 100);
    const joined = result.messages.map((msg) => msg.content).join('\n');
    expect(result.compacted).toBe(true);
    expect(joined).not.toContain('HISTORY_BLOB');
    expect(joined).not.toContain('instruction instruction');
    expect(joined).toContain('Compacted.');
    expect(estimateMessagesTokens(result.messages)).toBeLessThanOrEqual(limit);
  });

  test('drops the context window when summarization fails', async () => {
    const provider = {
      chat: jest.fn(async () => {
        throw new Error('model overloaded');
      }),
    };
    const historyFact = 'UNIQUE_HISTORY_FACT_fail';
    const result = await compactMessagesIfNeeded({
      provider,
      messages: [
        { role: 'system', content: 'You are the bookkeeping agent.' },
        { role: 'user', content: historyFact.repeat(200) },
        { role: 'assistant', content: historyFact.repeat(200) },
        { role: 'user', content: 'Please decide the next step.' },
      ],
      contextWindowTokens: 4000,
      compactPercent: 50,
      label: 'Books',
    });

    expect(result.compacted).toBe(true);
    const joined = result.messages.map((msg) => msg.content).join('\n');
    expect(joined).toContain('You are the bookkeeping agent.');
    expect(joined).toContain('Please decide the next step.');
    expect(joined).not.toContain(historyFact);
    expect(result.messages).toHaveLength(2);
  });

  test('skips compaction when the model context size is unknown', async () => {
    const provider = providerReturning('unused');
    const messages = [
      { role: 'system', content: 'x'.repeat(40000) },
      { role: 'user', content: 'hello' },
    ];
    const result = await compactMessagesIfNeeded({
      provider,
      messages,
      contextWindowTokens: null,
      compactPercent: 70,
      label: 'Books',
    });
    expect(provider.chat).not.toHaveBeenCalled();
    expect(result.messages).toBe(messages);
    expect(result.compacted).toBe(false);
  });
});
