import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EDIT_PLAN_STATUSES,
  classifyPlanRisk,
  documentFingerprint,
  normalizePlanInput,
  targetFingerprint,
  validatePlan,
} from '../src/skills/planSchema.js';

const inspection = {
  inspectionId: 'inspection-1',
  baseRevision: 7,
  document: { name: 'Brief', filePath: 'C:/docs/brief.indd', pages: 2 },
  pages: [{ index: 0, items: [] }],
};

function plan(steps = [{ toolName: 'move_page_item', arguments: { x: 10, y: 20 } }]) {
  return {
    targets: [{ pageIndex: 0, itemIndex: 0, before: { geometricBounds: [0, 0, 20, 20] } }],
    steps,
    affectedPages: [0],
    expectedChanges: ['Move title'],
    qualityCriteria: ['No overflow'],
  };
}

function normalize(input = {}) {
  return normalizePlanInput({ inspection, skillId: 'align-distribute', plan: plan(), now: '2026-11-25T12:00:00.000Z', ...input });
}

function errorsFor(mutate) {
  const value = normalize();
  mutate(value);
  return validatePlan(value).errors;
}

test('classifies a small reversible move as low risk', () => {
  const normalized = normalize();
  assert.equal(classifyPlanRisk(normalized), 'low');
  assert.equal(normalized.status, 'draft');
  assert.equal(normalized.version, 1);
});

test('deletion and multi-page plans are high risk', () => {
  const deletion = normalize({ skillId: 'safe-layout-edit', plan: plan([
    { toolName: 'delete_page_item', arguments: { pageIndex: 0, itemIndex: 0 } },
  ]) });
  assert.equal(classifyPlanRisk(deletion), 'high');
  assert.equal(deletion.status, 'approval_required');

  const multi = plan();
  multi.affectedPages = [0, 1];
  const normalized = normalize({ skillId: 'safe-layout-edit', plan: multi });
  assert.equal(classifyPlanRisk(normalized), 'high');
  assert.equal(normalized.status, 'approval_required');
});

test('fingerprints change when geometry changes', () => {
  assert.notEqual(
    targetFingerprint({ pageIndex: 0, itemIndex: 0, before: { geometricBounds: [0, 0, 20, 20] } }),
    targetFingerprint({ pageIndex: 0, itemIndex: 0, before: { geometricBounds: [0, 0, 30, 20] } }),
  );
});

test('normalizes IDs, version, expiry, inspection metadata, and units', () => {
  const value = normalize({ inspection: { ...inspection, units: 'mm' } });
  assert.match(value.planId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(value.inspectionId, 'inspection-1');
  assert.equal(value.skillId, 'align-distribute');
  assert.equal(value.documentFingerprint, documentFingerprint({ ...inspection, units: 'mm' }));
  assert.equal(value.baseRevision, 7);
  assert.equal(value.units, 'mm');
  assert.equal(value.version, 1);
  assert.equal(value.expiresAt, '2026-11-25T12:10:00.000Z');
  assert.deepEqual(value.beforeArtifacts, []);
  assert.equal(value.status, 'draft');
  assert.equal(value.risk, 'low');
  assert.equal(validatePlan(value).valid, true);
});

test('uses the inspection fingerprint and defaults missing units to points', () => {
  const value = normalize({ inspection: { ...inspection, fingerprint: 'captured-fingerprint' } });
  assert.equal(value.documentFingerprint, 'captured-fingerprint');
  assert.equal(value.units, 'pt');
});

test('accepts the brief inspection fixture without optional inspection metadata', () => {
  const value = normalizePlanInput({
    inspection: { document: { name: 'Brief', filePath: 'C:/docs/brief.indd', pages: 2 }, pages: [{ index: 0, items: [] }] },
    skillId: 'align-distribute',
    plan: plan(),
    now: new Date('2026-11-25T12:00:00.000Z'),
  });
  assert.equal(validatePlan(value).valid, true);
  assert.equal(value.expiresAt, '2026-11-25T12:10:00.000Z');
});

test('normalizes target and step IDs and infers missing target arguments', () => {
  const input = plan();
  const value = normalize({ plan: input });
  assert.match(value.targets[0].id, /^[0-9a-f-]{36}$/);
  assert.match(value.steps[0].id, /^[0-9a-f-]{36}$/);
  assert.notEqual(value.targets[0].id, value.steps[0].id);
  assert.deepEqual(value.steps[0].arguments, { pageIndex: 0, itemIndex: 0, x: 10, y: 20 });
  assert.equal(value.targets[0].fingerprint, targetFingerprint(value.targets[0]));
  assert.equal(value.steps[0].targetFingerprint, value.targets[0].fingerprint);
  assert.equal(value.steps[0].reversible, true);
  assert.equal(value.steps[0].risk, 'low');
  assert.deepEqual(value.steps[0].expectedResult, {});
  assert.equal(input.steps[0].arguments.pageIndex, undefined);
});

test('normalizes affected pages and preserves plan input', () => {
  const input = plan();
  input.affectedPages = [1, 0, 1];
  const snapshot = structuredClone(input);
  const value = normalize({ plan: input });
  assert.deepEqual(value.affectedPages, [0, 1]);
  assert.deepEqual(input, snapshot);
  value.targets[0].before.geometricBounds[0] = 99;
  value.steps[0].arguments.x = 99;
  assert.deepEqual(input, snapshot);
});

test('associates steps with targets by index, identity, or explicit target ID', () => {
  const input = plan([
    { toolName: 'move_page_item', arguments: { pageIndex: 1, itemIndex: 2, x: 1, y: 2 } },
    { toolName: 'resize_page_item', targetIndex: 0, arguments: { width: 30, height: 20 } },
  ]);
  input.targets = [
    { pageIndex: 0, itemIndex: 0, before: { geometricBounds: [0, 0, 20, 20] } },
    { pageIndex: 1, itemIndex: 2, before: { geometricBounds: [0, 0, 20, 20] } },
  ];
  input.affectedPages = [0, 1];
  const value = normalize({ plan: input });
  assert.equal(value.steps[0].targetFingerprint, value.targets[1].fingerprint);
  assert.equal(value.steps[1].targetFingerprint, value.targets[0].fingerprint);
  assert.deepEqual(value.steps[1].arguments, { pageIndex: 0, itemIndex: 0, width: 30, height: 20 });

  const explicitInput = plan([{ toolName: 'move_page_item', targetId: 'target-a', arguments: { x: 3, y: 4 } }]);
  explicitInput.targets[0].id = 'target-a';
  const explicit = normalize({ plan: explicitInput });
  assert.equal(explicit.targets[0].id, 'target-a');
  assert.equal(explicit.steps[0].targetFingerprint, explicit.targets[0].fingerprint);
});

test('document fingerprints are canonical and ignore inspection volatility', () => {
  const left = { document: { name: 'Brief', pages: 2 }, pages: [{ index: 0, items: [] }], inspectionId: 'a', fingerprint: 'old', beforeArtifacts: ['a.png'] };
  const right = { pages: [{ items: [], index: 0 }], beforeArtifacts: ['b.png'], fingerprint: 'different', document: { pages: 2, name: 'Brief' }, inspectionId: 'b' };
  assert.equal(documentFingerprint(left), documentFingerprint(right));
  assert.notEqual(documentFingerprint(left), documentFingerprint({ ...left, document: { ...left.document, pages: 3 } }));
  assert.notEqual(documentFingerprint(left), documentFingerprint({ ...left, pages: [{ index: 0, items: [{ name: 'Title' }] }] }));
});

test('target fingerprints are canonical and include identity and content', () => {
  const left = { pageIndex: 0, itemIndex: 1, before: { name: 'Title', geometricBounds: [0, 0, 20, 20] } };
  const right = { before: { geometricBounds: [0, 0, 20, 20], name: 'Title' }, itemIndex: 1, pageIndex: 0, id: 'generated', fingerprint: 'ignored' };
  assert.equal(targetFingerprint(left), targetFingerprint(right));
  assert.notEqual(targetFingerprint(left), targetFingerprint({ ...left, itemIndex: 2 }));
  assert.notEqual(targetFingerprint(left), targetFingerprint({ ...left, before: { ...left.before, content: 'Changed' } }));
});

test('all and only the exact lifecycle status names are accepted', () => {
  assert.deepEqual(EDIT_PLAN_STATUSES, ['draft', 'approval_required', 'approved', 'applying', 'applied', 'verified', 'failed', 'rolled_back']);
  for (const status of EDIT_PLAN_STATUSES) {
    const value = normalize();
    value.status = status;
    assert.equal(validatePlan(value).valid, true, status);
  }
  assert.equal(errorsFor((value) => { value.status = 'complete'; }).some((error) => error.includes('status')), true);
});

test('enforces the five-target and one-page low-risk boundaries', () => {
  const five = plan();
  five.targets = Array.from({ length: 5 }, (_, itemIndex) => ({ pageIndex: 0, itemIndex, before: { geometricBounds: [0, 0, 20, 20] } }));
  assert.equal(classifyPlanRisk(normalize({ plan: five })), 'low');

  const six = structuredClone(five);
  six.targets.push({ pageIndex: 0, itemIndex: 5, before: { geometricBounds: [0, 0, 20, 20] } });
  assert.equal(classifyPlanRisk(normalize({ plan: six })), 'high');

  const noPages = plan();
  noPages.affectedPages = [];
  assert.equal(classifyPlanRisk(normalize({ plan: noPages })), 'high');
});

test('every low-risk allowlisted operation can normalize and validate', () => {
  const cases = [
    ['move_page_item', { x: 1, y: 2 }],
    ['resize_page_item', { width: 10, height: 20 }],
    ['set_page_item_properties', { fillColor: 'Red' }],
    ['edit_text_frame', { frameIndex: 0, content: 'Title' }],
    ['apply_paragraph_style', { frameIndex: 0, styleName: 'Body' }],
    ['apply_character_style', { frameIndex: 0, styleName: 'Body' }],
    ['apply_object_style', { itemIndex: 0, styleName: 'Card' }],
    ['apply_color', { objectIndex: 0, colorName: 'Red' }],
  ];
  for (const [toolName, args] of cases) {
    const value = normalize({ plan: plan([{ toolName, arguments: args }]) });
    assert.equal(value.steps[0].reversible, true, toolName);
    assert.equal(value.steps[0].risk, 'low', toolName);
    assert.equal(classifyPlanRisk(value), 'low', toolName);
    assert.equal(validatePlan(value).valid, true, toolName);
  }
});

test('irreversible steps and multi-page-consistency are always high risk', () => {
  const irreversible = normalize({ plan: plan([{ toolName: 'move_page_item', reversible: false, arguments: { x: 1, y: 2 } }]) });
  assert.equal(irreversible.steps[0].reversible, false);
  assert.equal(classifyPlanRisk(irreversible), 'high');

  const multiSkill = normalize({ skillId: 'multi-page-consistency' });
  assert.equal(classifyPlanRisk(multiSkill), 'high');
  assert.equal(multiSkill.status, 'approval_required');
});

test('unknown operations default high risk and fail validation', () => {
  const value = normalize({ plan: plan([{ toolName: 'future_operation', arguments: {} }]) });
  assert.equal(value.risk, 'high');
  assert.equal(value.steps[0].risk, 'high');
  assert.equal(value.steps[0].reversible, false);
  assert.equal(value.status, 'approval_required');
  const result = validatePlan(value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /unknown tool/i.test(error)));
});

test('does not trust caller-supplied reversibility for non-allowlisted tools', () => {
  const value = normalize({ plan: plan([{ toolName: 'delete_page_item', reversible: true, arguments: { pageIndex: 0, itemIndex: 0 } }]) });
  assert.equal(value.steps[0].reversible, false);
  assert.equal(classifyPlanRisk(value), 'high');
});

test('rejects arbitrary code and document-saving steps', () => {
  for (const toolName of ['execute_indesign_code', 'save_document', 'save_document_to_cloud']) {
    const args = toolName === 'execute_indesign_code' ? { code: 'app.documents.item(0).close()' } : {};
    const value = normalize({ plan: plan([{ toolName, arguments: args }]) });
    const result = validatePlan(value);
    assert.equal(result.valid, false, toolName);
    assert.ok(result.errors.some((error) => error.includes(toolName)), toolName);
  }
});

test('validation rejects missing document and target fingerprints', () => {
  assert.ok(errorsFor((value) => { delete value.documentFingerprint; }).some((error) => error.includes('documentFingerprint')));
  assert.ok(errorsFor((value) => { delete value.targets[0].fingerprint; }).some((error) => error.includes('targets[0].fingerprint')));
  assert.ok(errorsFor((value) => { delete value.steps[0].targetFingerprint; }).some((error) => error.includes('steps[0].targetFingerprint')));
});

test('validation rejects tampered target fingerprints and dangling step references', () => {
  assert.ok(errorsFor((value) => { value.targets[0].fingerprint = '0'.repeat(64); }).some((error) => /fingerprint mismatch/i.test(error)));
  assert.ok(errorsFor((value) => { value.steps[0].targetFingerprint = '0'.repeat(64); }).some((error) => /targetFingerprint/i.test(error)));
});

test('validation rejects empty steps and malformed plan containers without throwing', () => {
  assert.ok(errorsFor((value) => { value.steps = []; }).some((error) => /steps.*empty/i.test(error)));
  for (const malformed of [null, undefined, [], 'plan']) {
    const result = validatePlan(malformed);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  }
});

test('validation rejects malformed arguments and invalid target references', () => {
  const cases = [
    (value) => { value.steps[0].arguments = null; },
    (value) => { value.steps[0].arguments = []; },
    (value) => { delete value.steps[0].arguments.x; },
    (value) => { value.steps[0].arguments.x = '10'; },
    (value) => { value.steps[0].arguments.y = Infinity; },
    (value) => { value.steps[0].arguments.pageIndex = -1; },
    (value) => { value.steps[0].arguments.itemIndex = 0.5; },
    (value) => { value.steps[0].arguments = { ...value.steps[0].arguments, unexpected: true }; },
  ];
  for (const mutate of cases) {
    const result = validatePlan((() => { const value = normalize(); mutate(value); return value; })());
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes('steps[0].arguments')));
  }
});

test('validation checks enums, array items, and required arguments for known tools', () => {
  const invalidResize = normalize({ plan: plan([{ toolName: 'resize_page_item', arguments: { width: 10, height: 20, anchorPoint: 'MIDDLE' } }]) });
  assert.equal(validatePlan(invalidResize).valid, false);

  const invalidGroup = normalize({ plan: plan([{ toolName: 'create_group_from_items', arguments: { pageIndex: 0, itemIndices: [0] } }]) });
  assert.equal(validatePlan(invalidGroup).valid, false);

  const missingStyle = normalize({
    plan: plan([{ toolName: 'apply_paragraph_style', arguments: { frameIndex: 0 } }]),
  });
  assert.equal(validatePlan(missingStyle).valid, false);
});

test('validation rejects malformed targets, pages, metadata, and risk fields', () => {
  const cases = [
    (value) => { value.targets = null; },
    (value) => { value.targets[0].pageIndex = -1; },
    (value) => { value.targets[0].before = null; },
    (value) => { value.affectedPages = [0, 0]; },
    (value) => { value.affectedPages = ['0']; },
    (value) => { value.expectedChanges = []; },
    (value) => { value.qualityCriteria = [42]; },
    (value) => { value.version = 0; },
    (value) => { value.expiresAt = 'not-a-date'; },
    (value) => { value.units = 'pixels'; },
    (value) => { value.risk = 'medium'; },
    (value) => { value.planId = ''; },
    (value) => { value.skillId = ''; },
  ];
  for (const mutate of cases) {
    const value = normalize();
    mutate(value);
    assert.equal(validatePlan(value).valid, false);
  }
});

test('validation rejects duplicate IDs and inconsistent classified risk', () => {
  assert.ok(errorsFor((value) => { value.steps[0].id = value.targets[0].id; }).some((error) => /duplicate id/i.test(error)));
  assert.ok(errorsFor((value) => { value.risk = 'high'; }).some((error) => /risk/i.test(error)));
});

test('normalization rejects malformed top-level input and invalid now values', () => {
  assert.throws(() => normalizePlanInput(), /input object/i);
  assert.throws(() => normalize({ plan: null }), /plan/i);
  for (const now of ['invalid', null, true]) {
    assert.throws(() => normalize({ now }), /now/i);
  }
});

test('fingerprints reject circular input instead of overflowing', () => {
  const circular = { document: {}, pages: [] };
  circular.pages.push(circular);
  assert.throws(() => documentFingerprint(circular), /circular/i);

  const target = { pageIndex: 0, before: {} };
  target.before.self = target;
  assert.throws(() => targetFingerprint(target), /circular/i);
});

test('validation rejects circular arguments without throwing', () => {
  const value = normalize();
  value.steps[0].arguments.self = value.steps[0].arguments;
  const result = validatePlan(value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /circular/i.test(error)));
});

test('risk classification fails closed for malformed targets, steps, and skill IDs', () => {
  const value = normalize();
  assert.equal(classifyPlanRisk({ ...value, skillId: '' }), 'high');
  assert.equal(classifyPlanRisk({ ...value, targets: [null] }), 'high');
  assert.equal(classifyPlanRisk({ ...value, steps: [{ toolName: 'move_page_item', reversible: true, arguments: null }] }), 'high');
});

test('affected pages must include every target and step page', () => {
  const input = plan();
  input.targets[0].pageIndex = 1;
  input.affectedPages = [0];
  const value = normalize({ plan: input });
  assert.equal(classifyPlanRisk(value), 'high');
  const result = validatePlan(value);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('affectedPages')));
});
