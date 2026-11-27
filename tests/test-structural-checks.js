import test from 'node:test';
import assert from 'node:assert/strict';
import { runStructuralChecks } from '../src/quality/structuralChecks.js';

const ISSUE_CODES = new Set([
  'PAGE_COUNT_CHANGED',
  'UNINTENDED_ITEM_ADDITION',
  'UNINTENDED_ITEM_REMOVAL',
  'TEXT_OVERFLOW',
  'OUT_OF_BOUNDS',
  'MISSING_LINK',
  'MISSING_FONT',
  'DUPLICATE_STYLE',
  'TARGET_STATE_MISMATCH',
]);

function item(index, name, overrides = {}) {
  return {
    index,
    name,
    geometricBounds: [10, 10, 20 + index, 20 + index],
    overset: false,
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    document: { name: 'Brief', pages: 1, width: 100, height: 100 },
    pages: [{ index: 0, items: [item(0, 'Title')] }],
    styles: { paragraph: ['Body'], character: [], object: [] },
    colors: ['Black'],
    layers: ['Layer 1'],
    validation: { issues: [] },
    links: [],
    fonts: [],
    ...overrides,
  };
}

function target(entry, overrides = {}) {
  return {
    pageIndex: 0,
    itemIndex: entry.index,
    name: entry.name,
    ...(entry.id === undefined ? {} : { id: entry.id }),
    fingerprint: `target-${entry.index}`,
    ...overrides,
  };
}

function plan(targets = [], steps = [], overrides = {}) {
  return { targets, steps, affectedPages: [0], ...overrides };
}

function step(targetEntry, expectedResult = {}, overrides = {}) {
  return {
    id: `step-${targetEntry.index}`,
    toolName: 'move_page_item',
    arguments: { pageIndex: targetEntry.pageIndex, itemIndex: targetEntry.itemIndex },
    targetFingerprint: targetEntry.fingerprint,
    expectedResult,
    ...overrides,
  };
}

function codes(result) {
  return result.issues.map((issue) => issue.code);
}

function hasCode(result, code) {
  return result.issues.some((issue) => issue.code === code);
}

function assertOnlyKnownCodes(result) {
  for (const issue of result.issues) {
    assert.ok(ISSUE_CODES.has(issue.code), `unexpected issue code ${issue.code}`);
    assert.equal(typeof issue.message, 'string');
    assert.ok(issue.message.length > 0);
  }
}

test('unchanged complete inspections pass without issues', () => {
  const before = snapshot();
  const after = structuredClone(before);
  const result = runStructuralChecks({ before, after, plan: plan([], []) });
  assert.deepEqual(result, { pass: true, issues: [] });
});

test('detects new overflow and unintended item deletion', () => {
  const before = snapshot({
    pages: [{ index: 0, items: [item(0, 'Title'), item(1, 'Logo')] }],
  });
  const after = snapshot({
    pages: [{ index: 0, items: [item(0, 'Title', { overset: true })] }],
  });
  const result = runStructuralChecks({
    before,
    after,
    plan: plan([target(before.pages[0].items[0])]),
  });
  assert.equal(result.pass, false);
  assert.ok(hasCode(result, 'TEXT_OVERFLOW'));
  assert.ok(hasCode(result, 'UNINTENDED_ITEM_REMOVAL'));
  assertOnlyKnownCodes(result);
});

test('detects unintended additions and non-target state changes', () => {
  const before = snapshot();
  const after = snapshot({
    pages: [{ index: 0, items: [
      item(0, 'Title', { geometricBounds: [11, 10, 20, 20] }),
      item(1, 'Unexpected'),
    ] }],
  });
  const result = runStructuralChecks({ before, after, plan: plan([], []) });
  assert.equal(result.pass, false);
  assert.ok(hasCode(result, 'UNINTENDED_ITEM_ADDITION'));
  assert.ok(hasCode(result, 'TARGET_STATE_MISMATCH'));
  assert.equal(hasCode(result, 'UNINTENDED_ITEM_REMOVAL'), false);
});

test('allows a planned target to match its expected post-state', () => {
  const before = snapshot();
  const changed = item(0, 'Title', { geometricBounds: [30, 10, 40, 20] });
  const after = snapshot({ pages: [{ index: 0, items: [changed] }] });
  const plannedTarget = target(before.pages[0].items[0]);
  const result = runStructuralChecks({
    before,
    after,
    plan: plan([plannedTarget], [step(plannedTarget, { geometricBounds: changed.geometricBounds })]),
  });
  assert.deepEqual(result, { pass: true, issues: [] });
});

test('matches reordered items by stable id rather than array position', () => {
  const first = item(0, 'Title', { id: 'title-id' });
  const second = item(1, 'Logo', { id: 'logo-id' });
  const before = snapshot({ pages: [{ index: 0, items: [first, second] }] });
  const after = snapshot({ pages: [{ index: 0, items: [second, first] }] });
  const result = runStructuralChecks({ before, after, plan: plan([], []) });
  assert.deepEqual(result, { pass: true, issues: [] });
});

test('matches duplicate identities as multisets independent of ordering', () => {
  const left = item(0, 'Repeated', { geometricBounds: [10, 10, 20, 20] });
  const right = item(0, 'Repeated', { geometricBounds: [30, 10, 40, 20] });
  const before = snapshot({ pages: [{ index: 0, items: [left, right] }] });
  const after = snapshot({ pages: [{ index: 0, items: [structuredClone(right), structuredClone(left)] }] });
  assert.deepEqual(runStructuralChecks({ before, after, plan: plan([], []) }), { pass: true, issues: [] });

  const removed = snapshot({ pages: [{ index: 0, items: [structuredClone(right)] }] });
  const result = runStructuralChecks({ before, after: removed, plan: plan([], []) });
  assert.equal(codes(result).filter((code) => code === 'UNINTENDED_ITEM_REMOVAL').length, 1);
});

test('reports a rename as removal and addition when no stable id survives', () => {
  const before = snapshot();
  const after = snapshot({ pages: [{ index: 0, items: [item(0, 'Renamed')] }] });
  const result = runStructuralChecks({ before, after, plan: plan([], []) });
  assert.ok(hasCode(result, 'UNINTENDED_ITEM_REMOVAL'));
  assert.ok(hasCode(result, 'UNINTENDED_ITEM_ADDITION'));
});

test('allows a planned rename when stable identity and expected name survive', () => {
  const before = snapshot({ pages: [{ index: 0, items: [item(0, 'Title', { id: 'title-id' })] }] });
  const after = snapshot({ pages: [{ index: 0, items: [item(0, 'Heading', { id: 'title-id' })] }] });
  const plannedTarget = target(before.pages[0].items[0]);
  const result = runStructuralChecks({
    before,
    after,
    plan: plan([plannedTarget], [step(plannedTarget, { name: 'Heading' }, { toolName: 'set_page_item_properties' })]),
  });
  assert.deepEqual(result, { pass: true, issues: [] });
});

test('flags unplanned page count changes and mismatched planned page deltas', () => {
  const before = snapshot();
  const after = snapshot({
    document: { name: 'Brief', pages: 2, width: 100, height: 100 },
    pages: [{ index: 0, items: [item(0, 'Title')] }, { index: 1, items: [] }],
  });
  const unplanned = runStructuralChecks({ before, after, plan: plan([], []) });
  assert.ok(hasCode(unplanned, 'PAGE_COUNT_CHANGED'));

  const wrongDelta = runStructuralChecks({
    before,
    after,
    plan: plan([], [
      { toolName: 'delete_page', arguments: { pageIndex: 0 } },
      { toolName: 'delete_page', arguments: { pageIndex: 1 } },
    ]),
  });
  assert.ok(hasCode(wrongDelta, 'PAGE_COUNT_CHANGED'));
});

test('allows explicitly planned page addition including content on the new page', () => {
  const before = snapshot();
  const after = snapshot({
    document: { name: 'Brief', pages: 2, width: 100, height: 100 },
    pages: [{ index: 0, items: [item(0, 'Title')] }, { index: 1, items: [item(0, 'New heading')] }],
  });
  const result = runStructuralChecks({
    before,
    after,
    plan: plan([], [{ toolName: 'add_page', arguments: { position: 'AT_END' } }]),
  });
  assert.deepEqual(result, { pass: true, issues: [] });
});

test('maps index drift after an explicitly planned insertion at the beginning', () => {
  const title = item(0, 'Title', { id: 'title-id' });
  const before = snapshot({ pages: [{ index: 0, id: 'old-page', items: [title] }] });
  const after = snapshot({
    document: { name: 'Brief', pages: 2, width: 100, height: 100 },
    pages: [
      { index: 0, id: 'new-page', items: [item(0, 'Inserted')] },
      { index: 1, id: 'old-page', items: [{ ...title, index: 0 }] },
    ],
  });
  const result = runStructuralChecks({
    before,
    after,
    plan: plan([], [{
      toolName: 'add_page',
      arguments: { position: 'AT_BEGINNING' },
    }]),
  });
  assert.deepEqual(result, { pass: true, issues: [] });
});

test('allows deletion of a planned page and its items without reporting removals', () => {
  const before = snapshot({
    document: { name: 'Brief', pages: 2, width: 100, height: 100 },
    pages: [
      { index: 0, id: 'keep', items: [item(0, 'Title')] },
      { index: 1, id: 'drop', items: [item(0, 'Delete me')] },
    ],
  });
  const after = snapshot({ pages: [{ index: 0, id: 'keep', items: [item(0, 'Title')] }] });
  const result = runStructuralChecks({
    before,
    after,
    plan: plan([], [{ toolName: 'delete_page', arguments: { pageIndex: 1 } }]),
  });
  assert.deepEqual(result, { pass: true, issues: [] });
});

test('checks document bounds while allowing planned target bleed', () => {
  const before = snapshot();
  const plannedTarget = target(before.pages[0].items[0]);
  const bleedItem = item(0, 'Title', { geometricBounds: [-5, -5, 105, 105] });
  const after = snapshot({ pages: [{ index: 0, items: [bleedItem] }] });
  const allowed = runStructuralChecks({
    before,
    after,
    plan: plan([plannedTarget], [step(plannedTarget, { geometricBounds: bleedItem.geometricBounds })], {
      constraints: { bleed: { top: 5, right: 5, bottom: 5, left: 5 } },
    }),
  });
  assert.deepEqual(allowed, { pass: true, issues: [] });

  const beyondBleed = snapshot({
    pages: [{ index: 0, items: [item(0, 'Title', { geometricBounds: [-5.01, 10, 20, 20] })] }],
  });
  const rejected = runStructuralChecks({
    before,
    after: beyondBleed,
    plan: plan([plannedTarget], [step(plannedTarget, { geometricBounds: beyondBleed.pages[0].items[0].geometricBounds })], {
      bleed: 5,
    }),
  });
  assert.ok(hasCode(rejected, 'OUT_OF_BOUNDS'));
});

test('does not flag an unchanged pre-existing bounds violation as new', () => {
  const existing = item(0, 'Title', { geometricBounds: [-10, 10, 20, 20] });
  const before = snapshot({ pages: [{ index: 0, items: [existing] }] });
  const after = snapshot({ pages: [{ index: 0, items: [structuredClone(existing)] }] });
  assert.deepEqual(runStructuralChecks({ before, after, plan: plan([], []) }), { pass: true, issues: [] });
});

test('reports newly missing links and fonts but not pre-existing missing assets', () => {
  const before = snapshot({
    validation: { issues: ['Broken link: old.tif', 'Missing font: Old Font'] },
  });
  const unchanged = snapshot({ validation: { issues: ['Broken link: old.tif', 'Missing font: Old Font'] } });
  assert.deepEqual(runStructuralChecks({ before, after: unchanged, plan: plan([], []) }), { pass: true, issues: [] });

  const after = snapshot({
    validation: {
      issues: ['Broken link: old.tif', 'Missing font: Old Font', 'Broken link: new.tif', 'Missing font: New Font'],
    },
  });
  const result = runStructuralChecks({ before, after, plan: plan([], []) });
  assert.ok(hasCode(result, 'MISSING_LINK'));
  assert.ok(hasCode(result, 'MISSING_FONT'));
});

test('detects missing and substituted assets from structured link and font status', () => {
  const before = snapshot({
    links: [{ id: 'link-1', path: 'old.tif', status: 'NORMAL' }],
    fonts: [{ name: 'Body', status: 'INSTALLED' }],
  });
  const after = snapshot({
    links: [{ id: 'link-1', path: 'old.tif', status: 'MISSING' }],
    fonts: [{ name: 'Body', status: 'SUBSTITUTED', substitutedBy: 'Replacement' }],
  });
  const result = runStructuralChecks({ before, after, plan: plan([], []) });
  assert.ok(hasCode(result, 'MISSING_LINK'));
  assert.ok(hasCode(result, 'MISSING_FONT'));
});

test('reports newly duplicated style names within a style type', () => {
  const before = snapshot();
  const after = snapshot({
    styles: { paragraph: ['Body', 'Body', 'Body Copy'], character: [], object: [] },
  });
  const result = runStructuralChecks({ before, after, plan: plan([], []) });
  assert.ok(hasCode(result, 'DUPLICATE_STYLE'));
  assert.equal(codes(result).filter((code) => code === 'DUPLICATE_STYLE').length, 1);
});

test('does not confuse style types or report unchanged duplicate colors', () => {
  const before = snapshot({
    styles: { paragraph: ['Body'], character: ['Body'], object: [] },
    colors: ['Black', 'Black'],
  });
  const after = structuredClone(before);
  assert.deepEqual(runStructuralChecks({ before, after, plan: plan([], []) }), { pass: true, issues: [] });

  after.colors = ['Black', 'Black', 'Black'];
  assert.ok(hasCode(runStructuralChecks({ before, after, plan: plan([], []) }), 'DUPLICATE_STYLE'));
});

test('flags expected target state mismatches and missing targets', () => {
  const before = snapshot();
  const unchanged = snapshot();
  const plannedTarget = target(before.pages[0].items[0]);
  const expected = step(plannedTarget, { geometricBounds: [30, 10, 40, 20] });
  const mismatch = runStructuralChecks({ before, after: unchanged, plan: plan([plannedTarget], [expected]) });
  assert.ok(hasCode(mismatch, 'TARGET_STATE_MISMATCH'));

  const removed = snapshot({ pages: [{ index: 0, items: [] }] });
  const missing = runStructuralChecks({ before, after: removed, plan: plan([plannedTarget], [expected]) });
  assert.ok(hasCode(missing, 'TARGET_STATE_MISMATCH'));
});

test('allows removal only when the target has an explicit deletion step', () => {
  const before = snapshot();
  const after = snapshot({ pages: [{ index: 0, items: [] }] });
  const plannedTarget = target(before.pages[0].items[0]);
  const deletion = step(plannedTarget, { deleted: true }, {
    toolName: 'delete_page_item',
    arguments: { pageIndex: 0, itemIndex: 0 },
  });
  assert.deepEqual(runStructuralChecks({
    before, after, plan: plan([plannedTarget], [deletion]),
  }), { pass: true, issues: [] });
});

test('fails closed for malformed or missing required fixture fields', () => {
  const validBefore = snapshot();
  const validAfter = snapshot();
  const cases = [
    { before: null },
    { after: undefined },
    { before: {} },
    { before: snapshot({ document: null }) },
    { before: snapshot({ document: { pages: 1 } }) },
    { before: snapshot({ pages: null }) },
    { before: snapshot({ pages: [{}] }) },
    { before: snapshot({ pages: [{ index: -1, items: [] }] }) },
    { before: snapshot({ pages: [{ index: 0, items: null }] }) },
    { before: snapshot({ pages: [{ index: 0, items: [{}] }] }) },
    { before: snapshot({ pages: [{ index: 0, items: [null] }] }) },
    { before: snapshot({ styles: null }) },
    { after: snapshot({ colors: 'Black' }) },
    { after: snapshot({ validation: null }) },
    { after: snapshot({ validation: { issues: 'none' } }) },
    { plan: null },
    { plan: {} },
    { plan: plan([null]) },
    { plan: plan([], 'not steps') },
  ];
  for (const entry of cases) {
    const result = runStructuralChecks({
      before: validBefore,
      after: validAfter,
      plan: plan([], []),
      ...entry,
    });
    assert.equal(result.pass, false, JSON.stringify(entry));
    assert.ok(hasCode(result, 'TARGET_STATE_MISMATCH'), JSON.stringify(entry));
    assertOnlyKnownCodes(result);
  }
});

test('treats impossible page indexes and changed document counts conservatively', () => {
  const before = snapshot({
    document: { pages: 2, width: 100, height: 100 },
    pages: [{ index: 0, items: [] }, { index: 1, items: [] }],
  });
  const after = snapshot({
    document: { pages: 1, width: 100, height: 100 },
    pages: [{ index: 0, items: [] }, { index: 1, items: [] }],
  });
  const result = runStructuralChecks({ before, after, plan: plan([], []) });
  assert.equal(result.pass, false);
  assert.ok(hasCode(result, 'TARGET_STATE_MISMATCH'));
  assert.ok(hasCode(result, 'PAGE_COUNT_CHANGED'));
});

test('keeps planned targets bound to their page across planned index drift', () => {
  const title = item(0, 'Title', { id: 'title-id' });
  const before = snapshot({ pages: [{ index: 0, id: 'old-page', items: [title] }] });
  const moved = { ...title, geometricBounds: [30, 10, 40, 20] };
  const after = snapshot({
    document: { name: 'Brief', pages: 2, width: 100, height: 100 },
    pages: [
      { index: 0, id: 'new-page', items: [item(0, 'Inserted')] },
      { index: 1, id: 'old-page', items: [moved] },
    ],
  });
  const plannedTarget = target(title);
  const result = runStructuralChecks({
    before,
    after,
    plan: plan([plannedTarget], [
      { toolName: 'add_page', arguments: { position: 'AT_BEGINNING' } },
      step(plannedTarget, { geometricBounds: moved.geometricBounds }),
    ]),
  });
  assert.deepEqual(result, { pass: true, issues: [] });
});

test('rejects nameless style entries, malformed validation issues, and missing geometry', () => {
  const cases = [
    snapshot({ styles: [null] }),
    snapshot({ colors: [{}] }),
    snapshot({ validation: { issues: [42] } }),
    snapshot({ pages: [{ index: 0, items: [{ index: 0, name: 'No bounds' }] }] }),
  ];
  for (const after of cases) {
    const result = runStructuralChecks({ before: snapshot(), after, plan: plan([], []) });
    assert.equal(result.pass, false);
    assert.ok(hasCode(result, 'TARGET_STATE_MISMATCH'));
  }
});

test('rejects an explicitly failed planned step even when item state looks valid', () => {
  const before = snapshot();
  const plannedTarget = target(before.pages[0].items[0]);
  const failed = step(plannedTarget, {}, { status: 'failed' });
  const result = runStructuralChecks({ before, after: snapshot(), plan: plan([plannedTarget], [failed]) });
  assert.ok(hasCode(result, 'TARGET_STATE_MISMATCH'));
});

test('fails closed rather than throwing for a null top-level input', () => {
  const result = runStructuralChecks(null);
  assert.equal(result.pass, false);
  assert.ok(hasCode(result, 'TARGET_STATE_MISMATCH'));
});

test('handles cyclic missing-asset metadata without throwing', () => {
  const before = snapshot();
  const link = { status: 'MISSING' };
  link.self = link;
  const after = snapshot({ links: [link] });
  const result = runStructuralChecks({ before, after, plan: plan([], []) });
  assert.equal(result.pass, false);
  assert.ok(hasCode(result, 'MISSING_LINK'));
});

test('is pure and accepts deeply frozen inputs', () => {
  const before = snapshot();
  const after = snapshot({
    pages: [{ index: 0, items: [item(0, 'Title', { geometricBounds: [30, 10, 40, 20] })] }],
  });
  const planned = plan([target(before.pages[0].items[0])], []);
  const original = structuredClone({ before, after, plan: planned });
  function freeze(value) {
    if (value && typeof value === 'object') {
      Object.freeze(value);
      for (const child of Object.values(value)) freeze(child);
    }
    return value;
  }
  freeze(before);
  freeze(after);
  freeze(planned);
  const first = runStructuralChecks({ before, after, plan: planned });
  const second = runStructuralChecks({ before, after, plan: planned });
  assert.deepEqual(first, second);
  assert.deepEqual({ before, after, plan: planned }, original);
  assertOnlyKnownCodes(first);
});
