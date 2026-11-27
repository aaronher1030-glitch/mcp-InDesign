import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectLayout } from '../src/skills/inspector.js';
import { documentFingerprint } from '../src/skills/planSchema.js';

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function fixture() {
  return {
    get_document_info: {
      name: 'Brief', filePath: 'C:/docs/brief.indd', pages: 3, width: 210, height: 297,
    },
    get_document_styles: { paragraph: ['Body'], character: [], object: [] },
    get_document_colors: ['Black', 'Brand Blue'],
    get_document_layers: ['Layer 1'],
    validate_document: { issues: [] },
    list_page_items: {
      items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }],
    },
    get_page_content_summary: { textFrames: 1, rectangles: 0 },
  };
}

function toolFor(results, calls = []) {
  return async (name, args) => {
    calls.push({ name, args });
    return { success: true, result: results[name] };
  };
}

test('inspects metadata and each requested page in deterministic tool order', async () => {
  const calls = [];
  const inspection = await inspectLayout({ pageRange: '3,1-2,2' }, toolFor(fixture(), calls));

  assert.deepEqual(calls.map(({ name }) => name), [
    'get_document_info',
    'get_document_styles',
    'get_document_colors',
    'get_document_layers',
    'validate_document',
    'list_page_items', 'get_page_content_summary',
    'list_page_items', 'get_page_content_summary',
    'list_page_items', 'get_page_content_summary',
  ]);
  assert.deepEqual(calls.slice(5).map(({ args }) => args), [
    { pageIndex: 0 }, { pageIndex: 0 },
    { pageIndex: 1 }, { pageIndex: 1 },
    { pageIndex: 2 }, { pageIndex: 2 },
  ]);
  assert.equal(inspection.document.name, 'Brief');
  assert.deepEqual(inspection.pages.map((page) => page.index), [0, 1, 2]);
  assert.equal(inspection.pages[0].items[0].name, 'Title');
  assert.deepEqual(inspection.pages[0].summary, { textFrames: 1, rectangles: 0 });
  assert.deepEqual(inspection.styles.paragraph, ['Body']);
  assert.deepEqual(inspection.colors, ['Black', 'Brand Blue']);
  assert.deepEqual(inspection.layers, ['Layer 1']);
  assert.deepEqual(inspection.validation, { issues: [] });
  assert.match(inspection.inspectionId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/i);
  assert.match(inspection.fingerprint, /^[0-9a-f]{64}$/);
});

test('defaults to all pages and accepts pageCount metadata', async () => {
  const results = fixture();
  results.get_document_info = { name: 'Two pages', pageCount: 2, width: 100, height: 100 };
  const calls = [];
  const inspection = await inspectLayout({}, toolFor(results, calls));
  assert.deepEqual(inspection.pages.map((page) => page.index), [0, 1]);
  assert.equal(calls.filter(({ name }) => name === 'list_page_items').length, 2);
});

test('returns isolated snapshots without mutating frozen tool results', async () => {
  const results = deepFreeze(fixture());
  const original = structuredClone(results);
  const first = await inspectLayout({ pageRange: '1' }, toolFor(results));
  const second = await inspectLayout({ pageRange: '1' }, toolFor(results));

  assert.deepEqual(results, original);
  assert.notEqual(first.inspectionId, second.inspectionId);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.equal(first.fingerprint, documentFingerprint({
    document: results.get_document_info,
    pages: [{ index: 0, items: results.list_page_items.items, summary: results.get_page_content_summary }],
    styles: results.get_document_styles,
    colors: results.get_document_colors,
    layers: results.get_document_layers,
  }));
  first.pages[0].items[0].name = 'Changed by caller';
  first.document.name = 'Changed by caller';
  assert.equal(results.list_page_items.items[0].name, 'Title');
  assert.equal(results.get_document_info.name, 'Brief');
});

test('wraps unsuccessful tool responses with stable structured error details', async () => {
  let calls = 0;
  await assert.rejects(
    inspectLayout({ pageRange: '1' }, async () => {
      calls += 1;
      return { success: false, error: 'No document open', result: null };
    }),
    (error) => {
      assert.equal(error.code, 'INSPECTION_FAILED');
      assert.equal(error.toolName, 'get_document_info');
      assert.match(error.message, /No document open/);
      assert.equal(error.cause?.message, 'No document open');
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('wraps thrown tool failures and stops before later calls', async () => {
  const calls = [];
  await assert.rejects(
    inspectLayout({ pageRange: '1' }, async (name, args) => {
      calls.push({ name, args });
      if (name === 'list_page_items') throw new Error('bridge disconnected');
      return { success: true, result: fixture()[name] };
    }),
    (error) => {
      assert.equal(error.code, 'INSPECTION_FAILED');
      assert.equal(error.toolName, 'list_page_items');
      assert.deepEqual(error.toolArgs, { pageIndex: 0 });
      assert.match(error.message, /bridge disconnected/);
      return true;
    },
  );
  assert.equal(calls.at(-1).name, 'list_page_items');
  assert.equal(calls.some(({ name }) => name === 'get_page_content_summary'), false);
});

test('rejects malformed envelopes and page item payloads instead of inventing pages', async () => {
  const cases = [
    { name: 'missing success', response: { result: fixture().get_document_info } },
    { name: 'missing result', response: { success: true } },
    { name: 'null document', override: ['get_document_info', null] },
    { name: 'invalid page count', override: ['get_document_info', { pages: 0 }] },
    { name: 'missing items', override: ['list_page_items', {}] },
    { name: 'non-array items', override: ['list_page_items', { items: 'none' }] },
    { name: 'missing summary', override: ['get_page_content_summary', undefined] },
  ];
  for (const entry of cases) {
    const results = fixture();
    let response;
    if (entry.override) [results[entry.override[0]]] = entry.override;
    else response = entry.response;
    await assert.rejects(
      inspectLayout({ pageRange: '1' }, async (name) => response && name === 'get_document_info'
        ? response
        : { success: true, result: results[name] }),
      (error) => error.code === 'INSPECTION_FAILED',
      entry.name,
    );
  }
});

test('rejects invalid invocation and unserializable failure details structurally', async () => {
  let calls = 0;
  await assert.rejects(
    inspectLayout(null, async () => { calls += 1; }),
    (error) => error.code === 'INSPECTION_FAILED',
  );
  assert.equal(calls, 0);

  const circular = {};
  circular.self = circular;
  await assert.rejects(
    inspectLayout({}, async () => ({ success: false, error: circular })),
    (error) => error.code === 'INSPECTION_FAILED' && error.toolName === 'get_document_info',
  );
});

test('rejects invalid ranges and invalid page indexes without page tool calls', async () => {
  for (const pageRange of ['0', '4', '3-1', '1,,2', 'first']) {
    const calls = [];
    await assert.rejects(
      inspectLayout({ pageRange }, toolFor(fixture(), calls)),
      (error) => error.code === 'INSPECTION_FAILED' && error.phase === 'pageRange',
      pageRange,
    );
    assert.equal(calls.some(({ name }) => name.startsWith('list_page') || name === 'get_page_content_summary'), false);
  }
});
