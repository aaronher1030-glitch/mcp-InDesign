import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  anthropicMessagesUrl,
  chatCompletionsUrl,
  resolveBaseUrl,
  toAnthropic,
} from '../src/chat/providers.js';
import { normalizeSettings, resolveApproval, runChat } from '../src/chat/agent.js';
import { SkillRuntime } from '../src/skills/runtime.js';
import { InDesignMCPServer } from '../src/core/InDesignMCPServer.js';

const SETTINGS = { provider: 'openai', model: 'test-model', apiKey: 'secret-key' };
const APPLY_TOOL = {
  name: 'apply_edit_plan',
  description: 'Apply a plan',
  inputSchema: { type: 'object', properties: {} },
};

function toolCall(name, args = {}) {
  return {
    id: `call_${name}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) },
  };
}

function finishingAfterToolCall(call) {
  return async ({ messages }) => (
    messages.some((message) => message.role === 'tool')
      ? { content: 'Finished.', toolCalls: [] }
      : { content: '', toolCalls: [call] }
  );
}

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

test('rejects model-issued tools that were not advertised to that model', async (t) => {
  for (const name of ['execute_indesign_code', 'save_document']) {
    await t.test(name, async () => {
      const calls = [];
      const events = [];
      await runChat({
        messages: [{ role: 'user', content: 'Do something unsafe.' }],
        settings: SETTINGS,
        toolDefinitions: [APPLY_TOOL],
        complete: finishingAfterToolCall(toolCall(name, { code: 'app.documents.add()', filePath: 'x.indd' })),
        emit: (event) => events.push(event),
        callTool: async (toolName, args) => {
          calls.push({ toolName, args });
          return { success: true };
        },
      });
      assert.deepEqual(calls, []);
      const result = events.find((event) => event.type === 'tool_result');
      assert.match(result.preview, /TOOL_NOT_ADVERTISED/);
      assert.match(result.preview, new RegExp(name));
    });
  }
});

test('strips all model-authored approval fields before apply_edit_plan', async () => {
  const calls = [];
  let authorizations = 0;
  await runChat({
    messages: [{ role: 'user', content: 'Apply the risky plan.' }],
    settings: SETTINGS,
    toolDefinitions: [APPLY_TOOL],
    complete: finishingAfterToolCall(toolCall('apply_edit_plan', {
      planId: 'plan-1', approved: true, approvalToken: 'model-token', expectedVersion: 4,
    })),
    emit: () => {},
    approvalAuthorizer: async () => { authorizations += 1; return 'trusted-token'; },
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { success: true, result: { status: 'approval_required', planId: 'plan-1', version: 4 } };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'apply_edit_plan');
  assert.equal(Object.hasOwn(calls[0].args, 'approved'), false);
  assert.equal(Object.hasOwn(calls[0].args, 'approvalToken'), false);
  assert.equal(authorizations, 0);
});

test('trusted tool adapter forwards cancellation to runtime without forwarding model approval', async () => {
  const original = InDesignMCPServer.prototype.handleToolCall;
  let received;
  InDesignMCPServer.prototype.handleToolCall = async function (name, args, context) {
    if (name === 'apply_edit_plan') {
      received = { args, context };
      return { success: true, result: { status: 'applied' } };
    }
    return { success: true, result: { status: 'verified' } };
  };
  try {
    await runChat({
      messages: [{ role: 'user', content: 'Apply the low-risk plan.' }],
      settings: SETTINGS,
      toolDefinitions: [APPLY_TOOL],
      complete: finishingAfterToolCall(toolCall('apply_edit_plan', {
        planId: 'plan-1', approved: true, expectedVersion: 1,
      })),
      emit: () => {},
    });
    assert.equal(Object.hasOwn(received.args, 'approved'), false);
    assert.equal(Object.hasOwn(received.args, 'approvalToken'), false);
    assert.ok(received.args.signal instanceof AbortSignal);
    assert.equal(received.context.signal, received.args.signal);
    assert.equal(received.context.deferApproval, true);
  } finally {
    InDesignMCPServer.prototype.handleToolCall = original;
  }
});

test('emits exact approval targets, steps, and supplied before artifacts before waiting', async () => {
  const events = [];
  const targets = [{ pageIndex: 0, itemIndex: 2, before: { geometricBounds: [10, 20, 30, 40] } }];
  const steps = [{ id: 'step-1', toolName: 'move_page_item', arguments: { pageIndex: 0, itemIndex: 2, x: 50, y: 60 } }];
  const beforeArtifacts = ['C:/renders/before.png'];
  const calls = [];
  await runChat({
    messages: [{ role: 'user', content: 'Change the master.' }],
    settings: SETTINGS,
    toolDefinitions: [APPLY_TOOL],
    complete: finishingAfterToolCall(toolCall('apply_edit_plan', { planId: 'plan-1', approved: true })),
    emit: (event) => events.push(event),
    callTool: async (name, args) => {
      calls.push({ name, args });
      return {
        success: true,
        result: {
          status: 'approval_required', planId: 'plan-1', version: 3,
          summary: 'Change the master', affectedPages: [0], risk: 'high',
          targets, steps, beforeArtifacts,
        },
      };
    },
  });
  const approval = events.find((event) => event.type === 'approval');
  assert.deepEqual(approval.targets, targets);
  assert.deepEqual(approval.steps, steps);
  assert.deepEqual(approval.beforeArtifacts, beforeArtifacts);
  assert.equal(approval.version, 3);
  assert.deepEqual(calls.map((call) => call.name), ['apply_edit_plan']);
  assert.equal(Object.hasOwn(calls[0].args, 'approved'), false);
  assert.equal(Object.hasOwn(calls[0].args, 'approvalToken'), false);
});

test('renders before artifacts without opening a viewer when approval omits them', async () => {
  const events = [];
  const calls = [];
  await runChat({
    messages: [{ role: 'user', content: 'Change the master.' }],
    settings: SETTINGS,
    toolDefinitions: [APPLY_TOOL, { name: 'preview_layout', inputSchema: { type: 'object', properties: {} } }],
    complete: finishingAfterToolCall(toolCall('apply_edit_plan', { planId: 'plan-1' })),
    emit: (event) => events.push(event),
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'preview_layout') {
        return { success: true, result: { paths: ['C:/renders/before.png'], pageIndexes: [0] } };
      }
      return {
        success: true,
        result: {
          status: 'approval_required', planId: 'plan-1', version: 2,
          summary: 'Change the master', affectedPages: [0], risk: 'high',
          targets: [], steps: [],
        },
      };
    },
  });
  assert.deepEqual(calls[1], { name: 'preview_layout', args: { pages: [0], open: false } });
  const approval = events.find((event) => event.type === 'approval');
  assert.deepEqual(approval.beforeArtifacts, ['C:/renders/before.png']);
  assert.deepEqual(approval.beforeArtifactsPageIndexes, [0]);
});

test('approval reports a before-render failure instead of hiding it behind empty artifacts', async () => {
  const events = [];
  await runChat({
    messages: [{ role: 'user', content: 'Change the master.' }],
    settings: SETTINGS,
    toolDefinitions: [APPLY_TOOL, { name: 'preview_layout', inputSchema: { type: 'object', properties: {} } }],
    complete: finishingAfterToolCall(toolCall('apply_edit_plan', { planId: 'plan-1' })),
    emit: (event) => events.push(event),
    callTool: async (name) => {
      if (name === 'preview_layout') return { success: false, error: 'PNG export failed' };
      return {
        success: true,
        result: {
          status: 'approval_required', planId: 'plan-1', version: 2,
          summary: 'Change the master', affectedPages: [0], risk: 'high',
          targets: [], steps: [], beforeArtifacts: [],
        },
      };
    },
  });
  const approval = events.find((event) => event.type === 'approval');
  assert.deepEqual(approval.beforeArtifacts, []);
  assert.match(approval.beforeArtifactsError, /PNG export failed/);
  assert.deepEqual(approval.beforeArtifactsPageIndexes, []);
});

test('passes an AbortSignal to model requests and stops before invoking tools', async () => {
  const controller = new AbortController();
  const calls = [];
  const complete = async ({ signal }) => {
    assert.ok(signal instanceof AbortSignal);
    controller.abort();
    return { content: '', toolCalls: [toolCall('apply_edit_plan', { planId: 'plan-1' })] };
  };
  const result = await runChat({
    messages: [{ role: 'user', content: 'Apply the plan.' }],
    settings: SETTINGS,
    signal: controller.signal,
    toolDefinitions: [APPLY_TOOL],
    complete,
    emit: () => {},
    callTool: async (name) => {
      calls.push(name);
      return { success: true };
    },
  });
  assert.equal(result.status, 'stopped');
  assert.deepEqual(calls, []);
});

test('approval cancellation reaches apply and rolls back without running a later step', async () => {
  const controller = new AbortController();
  const mutations = [];
  let applyStarted;
  const started = new Promise((resolve) => { applyStarted = resolve; });
  const approvalPromise = resolveApproval({
    approval: { planId: 'plan-1', approved: true, version: 3 },
    settings: SETTINGS,
    signal: controller.signal,
    emit: () => {},
    approvalAuthorizer: async ({ planId, expectedVersion }) => {
      assert.equal(planId, 'plan-1');
      assert.equal(expectedVersion, 3);
      return 'trusted-token';
    },
    callTool: async (name, args, options) => {
      if (name === 'apply_edit_plan') {
        assert.equal(args.expectedVersion, 3);
        mutations.push('step-1');
        applyStarted();
        if (!(options.signal instanceof AbortSignal)) {
          return { success: false, error: 'apply did not receive options.signal' };
        }
        await new Promise((resolve) => options.signal.addEventListener('abort', resolve, { once: true }));
        // A later step must not mutate once cancellation has been observed.
        if (!options.signal.aborted) mutations.push('step-2');
        return { success: true, result: { status: 'applied' } };
      }
      if (name === 'rollback_edit') {
        mutations.push('rollback');
        return { success: true, result: { status: 'rolled_back' } };
      }
      mutations.push(name);
      return { success: true };
    },
  });
  await started;
  controller.abort();
  const result = await approvalPromise;
  assert.equal(result.status, 'stopped');
  assert.deepEqual(mutations, ['step-1', 'rollback']);
});

test('real runtime does not mutate a later plan step after Stop and rolls back the first', async () => {
  const controller = new AbortController();
  const mutations = [];
  const runtime = new SkillRuntime({
    callTool: async (name, args) => {
      if (name === 'get_document_info') {
        return { success: true, result: { name: 'Brief', filePath: 'C:/docs/brief.indd', pages: 1, width: 210, height: 297 } };
      }
      if (name === 'list_page_items') {
        return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
      }
      if (name === 'validate_document') return { success: true, result: { issues: [] } };
      if (name === 'move_page_item') {
        mutations.push({ x: args.x, y: args.y });
        if (args.y === 20) controller.abort();
        return { success: true, result: { ok: true } };
      }
      return { success: true, result: {} };
    },
    render: async ({ pages }) => ({ paths: pages.map((page) => `C:/renders/page_${page + 1}.png`), pageIndexes: pages }),
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const plan = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'align-distribute',
    plan: {
      targets: [{ pageIndex: 0, itemIndex: 0, name: 'Title', before: { geometricBounds: [10, 10, 30, 100] } }],
      steps: [
        { toolName: 'move_page_item', arguments: { pageIndex: 0, itemIndex: 0, x: 10, y: 20 } },
        { toolName: 'move_page_item', arguments: { pageIndex: 0, itemIndex: 0, x: 10, y: 40 } },
      ],
      affectedPages: [0],
      expectedChanges: ['Move title down twice'],
      qualityCriteria: ['Only the title changes'],
    },
  });
  const result = await resolveApproval({
    approval: { planId: plan.planId, approved: true, version: 1 },
    settings: SETTINGS,
    signal: controller.signal,
    emit: () => {},
    approvalAuthorizer: async () => 'trusted-token',
    callTool: async (name, args, options) => {
      if (name === 'apply_edit_plan') {
        return { success: true, result: await runtime.applyPlan({ ...args, signal: options.signal }) };
      }
      if (name === 'rollback_edit') return { success: true, result: await runtime.rollbackPlan(args) };
      return runtime.callTool(name, args);
    },
  });
  assert.equal(result.status, 'stopped');
  assert.equal(result.rollback.status, 'rolled_back');
  assert.deepEqual(mutations, [{ x: 10, y: 20 }, { x: 10, y: 10 }]);
  assert.equal(runtime.getPlan(plan.planId).plan.status, 'rolled_back');
});

test('an already-stopped approval does not apply or attempt rollback', async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = [];
  const result = await resolveApproval({
    approval: { planId: 'plan-1', approved: true, version: 1 },
    settings: SETTINGS,
    signal: controller.signal,
    emit: () => {},
    callTool: async (name) => {
      calls.push(name);
      return { success: true };
    },
  });
  assert.equal(result.status, 'stopped');
  assert.deepEqual(calls, []);
});

test('resolveApproval refuses to apply when approval.version is omitted', async () => {
  const calls = [];
  await assert.rejects(() => resolveApproval({
    approval: { planId: 'plan-1', approved: true },
    settings: SETTINGS,
    emit: () => {},
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { success: true };
    },
  }), /version/i);
  assert.deepEqual(calls, []);
});

test('resolveApproval revalidates the exact UI version before issuing a capability', async () => {
  const calls = [];
  const result = await resolveApproval({
    approval: { planId: 'plan-1', approved: true, version: 2 },
    settings: SETTINGS,
    emit: () => {},
    approvalAuthorizer: async ({ planId, expectedVersion }) => {
      assert.equal(planId, 'plan-1');
      assert.equal(expectedVersion, 2);
      const error = new Error('APPROVAL_MISMATCH: approval is stale');
      error.code = 'APPROVAL_MISMATCH';
      throw error;
    },
    callTool: async (name, args) => {
      calls.push({ name, args });
      return { success: true };
    },
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(calls, []);
});

test('resolveApproval issues a trusted capability and applies with its token without exposing it', async () => {
  const calls = [];
  const events = [];
  const authorizations = [];
  const result = await resolveApproval({
    approval: { planId: 'plan-1', approved: true, version: 7 },
    settings: SETTINGS,
    emit: (event) => events.push(event),
    approvalAuthorizer: async (input) => {
      authorizations.push(input);
      return 'trusted-capability-token';
    },
    callTool: async (name, args, context) => {
      calls.push({ name, args, context });
      return { success: true, result: { status: name === 'apply_edit_plan' ? 'applied' : 'verified' } };
    },
  });
  assert.equal(result.status, 'applied');
  assert.deepEqual(authorizations, [{ planId: 'plan-1', expectedVersion: 7 }]);
  assert.equal(calls[0].name, 'apply_edit_plan');
  assert.deepEqual(calls[0].args, { planId: 'plan-1', expectedVersion: 7, approvalToken: 'trusted-capability-token' });
  assert.equal(calls[0].context.settings.model, 'test-model');
  assert.equal(calls[0].context.trustedApproval, true);
  assert.ok(calls[0].context.signal instanceof AbortSignal);
  assert.equal(calls[1].name, 'verify_layout');
  assert.deepEqual(calls[1].args, { planId: 'plan-1' });
  assert.equal(calls[1].context.trustedApproval, undefined);
  assert.equal(JSON.stringify(events).includes('trusted-capability-token'), false);
});

test('the default chat adapter preserves trusted approval context for immediate apply', async () => {
  const original = InDesignMCPServer.prototype.handleToolCall;
  const calls = [];
  InDesignMCPServer.prototype.handleToolCall = async function (name, args, context) {
    calls.push({ name, args, context });
    return { success: true, result: { status: name === 'apply_edit_plan' ? 'applied' : 'verified' } };
  };
  try {
    const result = await resolveApproval({
      approval: { planId: 'plan-1', approved: true, version: 7 },
      settings: SETTINGS,
      emit: () => {},
      approvalAuthorizer: async () => 'trusted-capability-token',
    });
    assert.equal(result.status, 'applied');
    assert.equal(calls[0].args.approvalToken, 'trusted-capability-token');
    assert.equal(calls[0].context.trustedApproval, true);
    assert.equal(calls[0].context.deferApproval, undefined);
  } finally {
    InDesignMCPServer.prototype.handleToolCall = original;
  }
});

test('resolveApproval does not issue a capability when the UI declines', async () => {
  let authorizations = 0;
  const result = await resolveApproval({
    approval: { planId: 'plan-1', approved: false, version: 7 },
    settings: SETTINGS,
    emit: () => {},
    approvalAuthorizer: async () => { authorizations += 1; return 'must-not-be-issued'; },
    callTool: async () => { throw new Error('declined approval must not call tools'); },
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(authorizations, 0);
});

function loadPluginHarness() {
  const elements = new Map();
  const storage = new Map();
  const sockets = [];
  const makeElement = () => {
    const classes = new Set();
    const listeners = new Map();
    return {
      value: '', textContent: '', disabled: false, scrollTop: 0, scrollHeight: 0,
      classList: {
        add: (...names) => names.forEach((name) => classes.add(name)),
        remove: (...names) => names.forEach((name) => classes.delete(name)),
        toggle: (name) => (classes.has(name) ? classes.delete(name) : classes.add(name)),
        contains: (name) => classes.has(name),
      },
      addEventListener: (name, handler) => listeners.set(name, handler),
      click: () => listeners.get('click')?.(),
      appendChild: () => {},
    };
  };
  const ids = [
    'status', 'log', 'empty', 'activity', 'settings', 'input', 'send', 'approval',
    'approvalSummary', 'approvalPages', 'approvalPlan', 'approveBtn', 'cancelBtn',
    'provider', 'baseUrl', 'model', 'apiKey', 'bridgeToken', 'settingsBtn',
    'saveSettings', 'clearBtn', 'composer',
  ];
  for (const id of ids) elements.set(id, makeElement());
  let setup;
  class FakeWebSocket {
    constructor(...args) {
      this.args = args;
      this.sent = [];
      sockets.push(this);
    }
    send(data) { this.sent.push(JSON.parse(data)); }
  }
  const context = {
    require: (name) => (name === 'indesign' ? { app: {} } : { entrypoints: { setup: (value) => { setup = value; } } }),
    document: {
      getElementById: (id) => elements.get(id),
      createElement: makeElement,
    },
    localStorage: {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    },
    WebSocket: FakeWebSocket,
    setTimeout: () => 1,
    clearTimeout: () => {},
    console: { log: () => {}, error: () => {} },
    TextDecoder,
    AbortController,
  };
  vm.runInNewContext(
    readFileSync(new URL('../plugin/index.js', import.meta.url), 'utf8'),
    context,
    { filename: 'plugin/index.js' },
  );
  return {
    context, elements, storage, sockets,
    show: () => setup.panels.mainPanel.show(),
    click: (id) => elements.get(id).click(),
  };
}

test('plugin settings persist non-secrets but never persist an API key', () => {
  const plugin = loadPluginHarness();
  plugin.elements.get('provider').value = 'anthropic';
  plugin.elements.get('baseUrl').value = 'https://models.example/v1';
  plugin.elements.get('model').value = 'model-a';
  plugin.elements.get('bridgeToken').value = 'bridge-secret';
  plugin.elements.get('apiKey').value = 'api-secret';
  plugin.click('saveSettings');

  const saved = JSON.parse(plugin.storage.get('indesign-copilot-settings'));
  assert.deepEqual(saved, {
    provider: 'anthropic', baseUrl: 'https://models.example/v1',
    model: 'model-a', bridgeToken: 'bridge-secret',
  });
  assert.equal(JSON.stringify([...plugin.storage]).includes('api-secret'), false);
});

test('plugin removes legacy persisted API keys and keeps the key field empty on load', () => {
  const plugin = loadPluginHarness();
  plugin.storage.set('indesign-copilot-settings', JSON.stringify({
    provider: 'openai', model: 'old-model', apiKey: 'legacy-secret',
  }));
  plugin.show();
  assert.equal(plugin.elements.get('apiKey').value, '');
  assert.equal(plugin.storage.get('indesign-copilot-settings').includes('legacy-secret'), false);
  assert.equal(JSON.parse(plugin.storage.get('indesign-copilot-settings')).apiKey, undefined);
});

test('plugin sends a WebSocket auth protocol only when a bridge token is configured', () => {
  const withoutToken = loadPluginHarness();
  withoutToken.show();
  assert.equal(withoutToken.sockets[0].args.length, 1);

  const withToken = loadPluginHarness();
  withToken.elements.get('bridgeToken').value = 'bridge-secret';
  withToken.show();
  assert.deepEqual(withToken.sockets[0].args, [
    'ws://127.0.0.1:3001', 'indesign-auth.bridge-secret',
  ]);
});

test('plugin rejects malformed bridge messages without executing them and remains usable', async () => {
  const plugin = loadPluginHarness();
  plugin.show();
  const ws = plugin.sockets[0];
  for (const data of [
    'null', '[]', '{"type":"execute","code":"return 99;"}',
    '{"type":"execute","id":"bad-code","code":42}',
    '{"id":"missing-type","code":"return 99;"}',
  ]) {
    ws.onmessage({ data });
  }
  assert.equal(ws.sent.length, 5);
  assert.ok(ws.sent.every((message) => message.type === 'error'));
  assert.equal(ws.sent.some((message) => message.result === 99), false);

  ws.onmessage({ data: JSON.stringify({ type: 'execute', id: 'valid', code: 'return 42;' }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ws.sent.at(-1), { type: 'result', id: 'valid', result: 42 });
});

test('plugin shows exact approval details and refuses approval without a version', () => {
  const plugin = loadPluginHarness();
  const approval = {
    planId: 'plan-1', version: 5, summary: 'Apply master', affectedPages: [0],
    targets: [{ pageIndex: 0, itemIndex: 1 }],
    steps: [{ toolName: 'apply_master_spread', arguments: { masterName: 'A' } }],
    beforeArtifacts: ['C:/before.png'],
    beforeArtifactsPageIndexes: [0],
  };
  plugin.context.applyEvent({ type: 'approval', ...approval }, { text: '' });
  const details = plugin.elements.get('approvalPlan').textContent;
  assert.match(details, /"itemIndex": 1/);
  assert.match(details, /apply_master_spread/);
  assert.match(details, /C:\/before\.png/);
  assert.equal(plugin.elements.get('approveBtn').disabled, false);

  plugin.context.applyEvent({
    type: 'approval', ...approval, version: undefined,
    targets: undefined, steps: undefined, beforeArtifacts: undefined,
  }, { text: '' });
  assert.equal(plugin.elements.get('approveBtn').disabled, true);
});

test('plugin fails closed when before renders are empty, invalid, errored, or incomplete', async (t) => {
  const valid = {
    planId: 'plan-1', version: 5, summary: 'Apply master', affectedPages: [0, 2],
    targets: [{ pageIndex: 0, itemIndex: 1 }],
    steps: [{ toolName: 'apply_master_spread', arguments: { masterName: 'A' } }],
    beforeArtifacts: ['C:/renders/page_1.png', 'C:/renders/page_3.png'],
    beforeArtifactsPageIndexes: [0, 2],
  };
  const cases = [
    ['empty artifacts', { beforeArtifacts: [] }, /before-render artifacts/i],
    ['invalid paths', { beforeArtifacts: ['', null] }, /before-render artifacts/i],
    ['relative artifact path', { beforeArtifacts: ['relative.png', 'C:/renders/page_3.png'] }, /before-render artifacts/i],
    ['non-PNG artifact path', { beforeArtifacts: ['C:/renders/page_1.txt', 'C:/renders/page_3.png'] }, /before-render artifacts/i],
    ['duplicate artifact path', { beforeArtifacts: ['C:/renders/page_1.png', 'C:/renders/page_1.png'] }, /before-render artifacts/i],
    ['render error despite paths', { beforeArtifactsError: 'export failed' }, /before-render failed.*export failed/i],
    ['missing page coverage', { beforeArtifactsPageIndexes: [0] }, /coverage is incomplete/i],
    ['unverifiable coverage', { beforeArtifactsPageIndexes: undefined, beforeArtifacts: ['C:/renders/before.png'] }, /coverage is incomplete/i],
  ];
  for (const [name, override, message] of cases) {
    await t.test(name, () => {
      const plugin = loadPluginHarness();
      plugin.context.applyEvent({ type: 'approval', ...valid, ...override }, { text: '' });
      assert.equal(plugin.elements.get('approveBtn').disabled, true);
      assert.match(plugin.elements.get('approvalPlan').textContent, message);
      assert.match(plugin.elements.get('approvalPlan').textContent, /Exact plan version 5/);
      assert.match(plugin.elements.get('approvalPlan').textContent, /apply_master_spread/);
    });
  }
});

test('plugin accepts complete valid before-render coverage and preserves render details', () => {
  const plugin = loadPluginHarness();
  plugin.context.applyEvent({
    type: 'approval',
    planId: 'plan-1', version: 5, summary: 'Apply master', affectedPages: [0, 2],
    targets: [{ pageIndex: 0, itemIndex: 1 }],
    steps: [{ toolName: 'apply_master_spread', arguments: { masterName: 'A' } }],
    beforeArtifacts: ['C:/renders/page_1.png', 'C:/renders/page_3.png'],
    beforeArtifactsPageIndexes: [0, 2],
  }, { text: '' });
  assert.equal(plugin.elements.get('approveBtn').disabled, false);
  assert.match(plugin.elements.get('approvalPlan').textContent, /page_1\.png/);
  assert.match(plugin.elements.get('approvalPlan').textContent, /page_3\.png/);
});
