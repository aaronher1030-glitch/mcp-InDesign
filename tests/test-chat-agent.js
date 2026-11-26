import test from 'node:test';
import assert from 'node:assert/strict';
import {
  anthropicMessagesUrl,
  chatCompletionsUrl,
  resolveBaseUrl,
  toAnthropic,
} from '../src/chat/providers.js';
import { normalizeSettings, runChat } from '../src/chat/agent.js';

test('joins OpenAI-compatible and Anthropic URLs', () => {
  assert.equal(
    chatCompletionsUrl(resolveBaseUrl('openai', '')),
    'https://api.openai.com/v1/chat/completions'
  );
  assert.equal(
    chatCompletionsUrl('https://openrouter.ai/api/v1'),
    'https://openrouter.ai/api/v1/chat/completions'
  );
  assert.equal(
    anthropicMessagesUrl(resolveBaseUrl('anthropic', '')),
    'https://api.anthropic.com/v1/messages'
  );
  assert.equal(
    anthropicMessagesUrl('https://api.anthropic.com/v1'),
    'https://api.anthropic.com/v1/messages'
  );
});

test('rejects non-http base URLs and missing models', () => {
  assert.throws(() => resolveBaseUrl('openai', 'file:///tmp/model'), /http/);
  assert.throws(() => normalizeSettings({ provider: 'openai', model: '' }), /model name/);
  assert.throws(
    () => normalizeSettings({ provider: 'openai', model: 'gpt-4.1', apiKey: '' }),
    /API key/
  );
  const local = normalizeSettings({
    provider: 'openai',
    model: 'local-model',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKey: '',
  });
  assert.equal(local.model, 'local-model');
  assert.equal(local.apiKey, '');
});

test('Anthropic conversion keeps tool results with their call', () => {
  const converted = toAnthropic([
    { role: 'system', content: 'Be careful.' },
    { role: 'user', content: 'Move the title.' },
    {
      role: 'assistant',
      content: 'Looking.',
      tool_calls: [{
        id: 'call_1',
        function: { name: 'list_page_items', arguments: '{"pageIndex":0}' },
      }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: '{"count":1}' },
  ]);
  assert.equal(converted.system, 'Be careful.');
  assert.equal(converted.messages[1].content[1].name, 'list_page_items');
  assert.equal(converted.messages[2].content[0].tool_use_id, 'call_1');
});

test('a chat turn lists items, moves one, and does not leak the API key', async () => {
  const calls = [];
  const events = [];
  const complete = async ({ apiKey, messages }) => {
    assert.equal(apiKey, 'secret-key');
    const toolNote = messages.some((message) => message.role === 'tool');
    if (!toolNote) {
      return {
        content: 'I will look first.',
        toolCalls: [{
          id: 'call_list',
          type: 'function',
          function: { name: 'list_page_items', arguments: '{"pageIndex":0}' },
        }],
      };
    }
    const sawBounds = messages.some((message) => message.role === 'tool' && message.content.includes('geometricBounds'));
    assert.equal(sawBounds, true);
    return {
      content: '',
      toolCalls: [{
        id: 'call_move',
        type: 'function',
        function: { name: 'move_page_item', arguments: '{"pageIndex":0,"itemIndex":0,"x":10,"y":20}' },
      }],
    };
  };

  let moved = false;
  const completeWithFinish = async (input) => {
    if (moved) return { content: 'Moved the title down.', toolCalls: [] };
    const reply = await complete(input);
    if (reply.toolCalls[0].function.name === 'move_page_item') moved = true;
    return reply;
  };

  await runChat({
    messages: [{ role: 'user', content: 'Move the title down.' }],
    settings: { provider: 'openai', model: 'any-model', apiKey: 'secret-key' },
    emit: (event) => events.push(event),
    toolDefinitions: [
      { name: 'list_page_items', description: 'List items', inputSchema: { type: 'object', properties: {} } },
      { name: 'move_page_item', description: 'Move an item', inputSchema: { type: 'object', properties: {} } },
    ],
    complete: completeWithFinish,
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'list_page_items') {
        return { success: true, items: [{ index: 0, name: 'Title', geometricBounds: [36, 36, 72, 200] }] };
      }
      return { success: true, geometricBounds: [56, 36, 92, 200] };
    },
  });

  assert.deepEqual(calls.map((call) => call.name), ['list_page_items', 'move_page_item']);
  assert.equal(calls[1].args.y, 20);
  const done = events.find((event) => event.type === 'done');
  assert.equal(done.messages.at(-1).content, 'Moved the title down.');
  assert.equal(JSON.stringify(events).includes('secret-key'), false);
});
