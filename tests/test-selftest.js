import test from 'node:test';
import assert from 'node:assert/strict';
import { runSelftest, waitForPlugin } from '../src/core/selftest.js';

function response({ ok = true, code = 200, body = {} } = {}) {
  return { ok, status: code, json: async () => body };
}

function liveInspection() {
  return {
    inspectionId: 'insp-1',
    document: { name: 'Brief', pages: 2 },
    pages: [
      { index: 0, items: [{ index: 0 }, { index: 1 }] },
      { index: 1, items: [] },
    ],
  };
}

test('waitForPlugin returns as soon as the plugin is connected', async () => {
  const calls = [];
  await waitForPlugin({
    fetchImpl: async (url) => {
      calls.push(url);
      return response({ body: { connected: true } });
    },
    sleepImpl: async () => {
      throw new Error('should not sleep when the plugin is already connected');
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/status$/);
});

test('waitForPlugin fails with SELFTEST_TIMEOUT when no plugin connects', async () => {
  const messages = [];
  let polls = 0;
  await assert.rejects(
    () => waitForPlugin({
      timeoutMs: 3000,
      intervalMs: 1000,
      fetchImpl: async () => {
        polls += 1;
        return response({ body: { connected: false } });
      },
      sleepImpl: async () => {},
      log: (message) => messages.push(message),
    }),
    (error) => error.code === 'SELFTEST_TIMEOUT' && /no InDesign plugin connected after 3s/.test(error.message),
  );
  assert.equal(polls, 4);
  assert.equal(messages.length, 2);
});

test('waitForPlugin surfaces a bridge token mismatch immediately', async () => {
  await assert.rejects(
    () => waitForPlugin({
      fetchImpl: async () => response({ ok: false, code: 401 }),
      sleepImpl: async () => {},
    }),
    /BRIDGE_UNAUTHORIZED/,
  );
});

test('runSelftest waits, then inspects and previews the live document', async () => {
  const calls = [];
  const toolCall = async (name, args) => {
    calls.push({ name, args });
    if (name === 'inspect_layout') return { success: true, result: liveInspection() };
    if (name === 'preview_layout') {
      return { success: true, result: { paths: ['C:/tmp/page_1.png'], opened: true } };
    }
    throw new Error(`unexpected tool ${name}`);
  };

  const summary = await runSelftest({
    toolCall,
    wait: async () => {},
  });

  assert.deepEqual(calls.map((call) => call.name), ['inspect_layout', 'preview_layout']);
  assert.deepEqual(calls[1].args, { pages: [0], open: true });
  assert.equal(summary.status, 'passed');
  assert.equal(summary.inspectionId, 'insp-1');
  assert.equal(summary.document, 'Brief');
  assert.deepEqual(summary.previewPaths, ['C:/tmp/page_1.png']);
});

test('runSelftest does not touch the document before the plugin connects', async () => {
  let called = false;
  await assert.rejects(
    () => runSelftest({
      wait: async () => {
        throw Object.assign(new Error('SELFTEST_TIMEOUT: no InDesign plugin connected after 60s.'), {
          code: 'SELFTEST_TIMEOUT',
        });
      },
      toolCall: async () => { called = true; },
    }),
    /SELFTEST_TIMEOUT/,
  );
  assert.equal(called, false);
});

test('runSelftest fails when inspection or preview does not work', async () => {
  await assert.rejects(
    () => runSelftest({
      toolCall: async () => ({ success: false, result: 'no document open' }),
      wait: async () => {},
    }),
    /SELFTEST_FAILED.*no document open/,
  );

  await assert.rejects(
    () => runSelftest({
      toolCall: async (name) => (name === 'inspect_layout'
        ? { success: true, result: liveInspection() }
        : { success: true, result: { paths: [] } }),
      wait: async () => {},
    }),
    /preview_layout returned no rendered pages/,
  );

  await assert.rejects(
    () => runSelftest({
      toolCall: async () => ({ success: true, result: { pages: [] } }),
      wait: async () => {},
    }),
    /returned no inspectionId/,
  );
});

test('runSelftest wraps bridge errors with the selftest code', async () => {
  await assert.rejects(
    () => runSelftest({
      toolCall: async () => { throw new Error('Bridge not reachable'); },
      wait: async () => {},
    }),
    (error) => error.code === 'SELFTEST_FAILED' && /inspect_layout failed: Bridge not reachable/.test(error.message),
  );
});
