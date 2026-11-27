import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillRuntime } from '../src/skills/runtime.js';
import { documentFingerprint } from '../src/skills/planSchema.js';

const documentResult = { name: 'Brief', filePath: 'C:/docs/brief.indd', pages: 1, width: 210, height: 297 };

function createRuntime(options = {}) {
  const calls = [];
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_document_info') return { success: true, result: documentResult };
    if (name === 'list_page_items') {
      return {
        success: true,
        result: {
          items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }],
        },
      };
    }
    if (name === 'validate_document') return { success: true, result: { issues: [] } };
    return { success: true, result: { ok: true } };
  };
  return { runtime: new SkillRuntime({ callTool, ...options }), calls };
}

const movePlan = {
  targets: [{ pageIndex: 0, itemIndex: 0, name: 'Title', before: { geometricBounds: [10, 10, 30, 100] } }],
  steps: [{ toolName: 'move_page_item', arguments: { pageIndex: 0, itemIndex: 0, x: 10, y: 20 } }],
  affectedPages: [0],
  expectedChanges: ['Move title down'],
  qualityCriteria: ['No overflow'],
};

const highRiskPlan = {
  ...movePlan,
  steps: [{ toolName: 'apply_master_spread', arguments: { masterName: 'A-Master' } }],
  expectedChanges: ['Apply the shared master'],
};

function createSavedHighRiskRuntime(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-approval-'));
  const filePath = join(dir, 'brief.indd');
  writeFileSync(filePath, 'saved baseline');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  let activePath = filePath;
  const runtime = new SkillRuntime({
    artifactDir: join(dir, 'artifacts'),
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'open_document') activePath = args.filePath;
      if (name === 'get_document_info') {
        return { success: true, result: { ...documentResult, filePath: activePath, saved: true, modified: false } };
      }
      if (name === 'list_page_items') {
        return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
      }
      return { success: true, result: {} };
    },
    render: async ({ pages }) => ({
      paths: pages.map((page) => `C:/renders/page_${page + 1}.png`),
      pageIndexes: pages,
    }),
    ...options,
  });
  return { runtime, calls, filePath };
}

async function createHighRiskPlan(runtime, plan = highRiskPlan) {
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  return runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'multi-page-consistency',
    plan,
  });
}

test('creates and applies a low-risk plan', async () => {
  const { runtime, calls } = createRuntime();
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const plan = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'align-distribute',
    plan: movePlan,
  });
  assert.equal(plan.status, 'draft');
  assert.equal(plan.risk, 'low');

  const result = await runtime.applyPlan({ planId: plan.planId, approved: false, expectedVersion: 1 });
  assert.equal(result.status, 'applied');
  assert.ok(calls.some((call) => call.name === 'move_page_item'));
  assert.equal(runtime.getPlan(plan.planId).plan.status, 'applied');
});

test('blocks high-risk plans without approval', async () => {
  const { runtime, calls } = createRuntime();
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const risky = {
    targets: [{ pageIndex: 0, itemIndex: 0, name: 'Title', before: { geometricBounds: [10, 10, 30, 100] } }],
    steps: [{ toolName: 'apply_master_spread', arguments: { masterName: 'A-Master' } }],
    affectedPages: [0],
    expectedChanges: ['Apply the shared master across pages'],
    qualityCriteria: ['Masters stay coherent'],
  };
  const plan = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'multi-page-consistency',
    plan: risky,
  });
  assert.equal(plan.risk, 'high');
  assert.equal(plan.status, 'approval_required');

  await assert.rejects(
    () => runtime.applyPlan({ planId: plan.planId, approved: false, expectedVersion: 1 }),
    /APPROVAL_REQUIRED/,
  );
  assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
});

test('a caller-supplied approved boolean cannot authorize a high-risk plan', async (t) => {
  const { runtime, calls } = createSavedHighRiskRuntime(t);
  const plan = await createHighRiskPlan(runtime);
  await assert.rejects(
    () => runtime.applyPlan({ planId: plan.planId, approved: true, expectedVersion: plan.version }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
  assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
});

test('a trusted capability is random, version-bound, private, and single-use', async (t) => {
  const { runtime, calls } = createSavedHighRiskRuntime(t);
  const plan = await createHighRiskPlan(runtime);
  const first = runtime.issueApprovalCapability({ planId: plan.planId, expectedVersion: plan.version });
  const second = runtime.issueApprovalCapability({ planId: plan.planId, expectedVersion: plan.version });
  assert.match(first.approvalToken, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.approvalToken, second.approvalToken);
  assert.equal(JSON.stringify(runtime.getPlan(plan.planId)).includes(first.approvalToken), false);
  assert.equal(JSON.stringify(runtime.listPlans()).includes(first.approvalToken), false);
  assert.equal(JSON.stringify(runtime.plans.get(plan.planId)).includes(first.approvalToken), false);

  const applied = await runtime.applyPlan({
    planId: plan.planId,
    expectedVersion: plan.version,
    approvalToken: second.approvalToken,
  });
  assert.equal(applied.status, 'applied');
  assert.equal(calls.filter((call) => call.name === 'apply_master_spread').length, 1);
  assert.equal(JSON.stringify(applied).includes(second.approvalToken), false);
});

test('approval capabilities cannot move across plans or versions and expire', async (t) => {
  let now = Date.parse('2026-11-25T12:00:00.000Z');
  const { runtime, calls } = createSavedHighRiskRuntime(t, {
    now: () => new Date(now),
    approvalTtlMs: 1000,
  });
  const plan = await createHighRiskPlan(runtime);
  const other = await createHighRiskPlan(runtime);
  const issued = runtime.issueApprovalCapability({ planId: plan.planId, expectedVersion: plan.version });

  await assert.rejects(
    () => runtime.applyPlan({ planId: other.planId, expectedVersion: other.version, approvalToken: issued.approvalToken }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
  await assert.rejects(
    () => runtime.applyPlan({ planId: plan.planId, expectedVersion: 2, approvalToken: issued.approvalToken }),
    (error) => error.code === 'APPROVAL_MISMATCH',
  );
  assert.throws(
    () => runtime.issueApprovalCapability({ planId: plan.planId, expectedVersion: 2 }),
    (error) => error.code === 'APPROVAL_MISMATCH',
  );
  now += 1000;
  await assert.rejects(
    () => runtime.applyPlan({ planId: plan.planId, expectedVersion: plan.version, approvalToken: issued.approvalToken }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
  assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
});

test('a capability is consumed before the first await so concurrent reuse cannot mutate', async (t) => {
  let releaseInspection;
  const gate = new Promise((resolve) => { releaseInspection = resolve; });
  let inspections = 0;
  const { runtime, calls } = createSavedHighRiskRuntime(t, {
    inspect: async (options, callTool) => {
      inspections += 1;
      if (inspections === 2) await gate;
      const info = await callTool('get_document_info');
      const items = await callTool('list_page_items', { pageIndex: 0 });
      return {
        inspectionId: 'insp', document: info.result,
        pages: [{ index: 0, items: items.result.items, summary: {} }],
        fingerprint: 'f'.repeat(64),
      };
    },
  });
  const plan = await createHighRiskPlan(runtime);
  const { approvalToken } = runtime.issueApprovalCapability({ planId: plan.planId, expectedVersion: plan.version });
  const first = runtime.applyPlan({ planId: plan.planId, expectedVersion: plan.version, approvalToken });
  const second = runtime.applyPlan({ planId: plan.planId, expectedVersion: plan.version, approvalToken }).then(
    () => null,
    (error) => error,
  );
  const reuseError = await second;
  assert.ok(['APPROVAL_REQUIRED', 'PLAN_INVALID'].includes(reuseError.code));
  releaseInspection();
  assert.equal((await first).status, 'applied');
  assert.equal(calls.filter((call) => call.name === 'apply_master_spread').length, 1);
});

test('high-risk before-render failures and incomplete coverage fail before any mutation', async (t) => {
  const cases = [
    ['renderer throws', async () => { throw new Error('PNG export failed'); }],
    ['unsuccessful response', async () => ({ success: false, paths: ['C:/renders/page_1.png', 'C:/renders/page_3.png'], pageIndexes: [0, 2] })],
    ['empty paths', async () => ({ paths: [], pageIndexes: [0, 2] })],
    ['duplicate paths', async () => ({ paths: ['C:/renders/page_1.png', 'C:/renders/page_1.png'], pageIndexes: [0, 2] })],
    ['whitespace-equivalent duplicate paths', async () => ({ paths: ['C:/renders/page_1.png', ' C:/renders/page_1.png '], pageIndexes: [0, 2] })],
    ['relative path', async () => ({ paths: ['page_1.png', 'C:/renders/page_3.png'], pageIndexes: [0, 2] })],
    ['missing page metadata', async () => ({ paths: ['C:/renders/page_1.png'], pageIndexes: [0] })],
    ['duplicate page metadata', async () => ({ paths: ['C:/renders/a.png', 'C:/renders/b.png'], pageIndexes: [0, 0] })],
    ['unverifiable custom paths', async () => ({ paths: ['C:/renders/a.png', 'C:/renders/b.png'] })],
  ];
  for (const [name, render] of cases) {
    await t.test(name, async () => {
      const { runtime, calls } = createSavedHighRiskRuntime(t, { render });
      const plan = await createHighRiskPlan(runtime, { ...highRiskPlan, affectedPages: [0, 2] });
      const { approvalToken } = runtime.issueApprovalCapability({ planId: plan.planId, expectedVersion: plan.version });
      await assert.rejects(
        () => runtime.applyPlan({ planId: plan.planId, expectedVersion: plan.version, approvalToken }),
        (error) => error.code === 'BEFORE_RENDER_FAILED'
          && Array.isArray(error.affectedPages)
          && Array.isArray(error.artifactPaths),
      );
      assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
      assert.equal(runtime.getPlan(plan.planId).journal, null);
      await assert.rejects(
        () => runtime.applyPlan({ planId: plan.planId, expectedVersion: plan.version, approvalToken }),
        (error) => error.code === 'APPROVAL_REQUIRED',
      );
    });
  }
});

test('high-risk rendering accepts canonical page filenames without page metadata', async (t) => {
  const { runtime, calls } = createSavedHighRiskRuntime(t, {
    render: async ({ pages }) => ({ paths: pages.map((page) => `C:/renders/page_${page + 1}.png`) }),
  });
  const plan = await createHighRiskPlan(runtime, { ...highRiskPlan, affectedPages: [0, 2] });
  const { approvalToken } = runtime.issueApprovalCapability({ planId: plan.planId, expectedVersion: plan.version });
  const result = await runtime.applyPlan({ planId: plan.planId, expectedVersion: plan.version, approvalToken });
  assert.equal(result.status, 'applied');
  assert.equal(calls.filter((call) => call.name === 'apply_master_spread').length, 1);
});

test('high-risk canonical rendering rejects artifacts for pages outside the plan', async (t) => {
  const { runtime, calls } = createSavedHighRiskRuntime(t, {
    render: async ({ pages }) => ({
      paths: [...pages.map((page) => `C:/renders/page_${page + 1}.png`), 'C:/renders/page_4.png'],
    }),
  });
  const plan = await createHighRiskPlan(runtime, { ...highRiskPlan, affectedPages: [0, 2] });
  const { approvalToken } = runtime.issueApprovalCapability({ planId: plan.planId, expectedVersion: plan.version });
  await assert.rejects(
    () => runtime.applyPlan({ planId: plan.planId, expectedVersion: plan.version, approvalToken }),
    (error) => error.code === 'BEFORE_RENDER_FAILED',
  );
  assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
});

test('low-risk before-render failure remains best-effort', async () => {
  const { runtime, calls } = createRuntime({ render: async () => { throw new Error('renderer unavailable'); } });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const plan = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  const result = await runtime.applyPlan({ planId: plan.planId });
  assert.equal(result.status, 'applied');
  assert.equal(calls.some((call) => call.name === 'move_page_item'), true);
});

test('prepareApproval revalidates and renders public details without issuing approval or mutating', async (t) => {
  const { runtime, calls } = createSavedHighRiskRuntime(t);
  const plan = await createHighRiskPlan(runtime, { ...highRiskPlan, affectedPages: [0, 2] });
  const prepared = await runtime.prepareApproval({ planId: plan.planId, expectedVersion: plan.version });
  assert.equal(prepared.planId, plan.planId);
  assert.equal(prepared.version, plan.version);
  assert.deepEqual(prepared.affectedPages, [0, 2]);
  assert.deepEqual(prepared.beforeArtifacts, ['C:/renders/page_1.png', 'C:/renders/page_3.png']);
  assert.deepEqual(prepared.beforeArtifactsPageIndexes, [0, 2]);
  assert.equal(Object.hasOwn(prepared, 'approvalToken'), false);
  assert.equal(Object.hasOwn(prepared, 'backup'), false);
  assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
  await assert.rejects(
    () => runtime.applyPlan({ planId: plan.planId, expectedVersion: plan.version }),
    (error) => error.code === 'APPROVAL_REQUIRED',
  );
});

test('prepareApproval rejects stale documents and incomplete renders before mutation', async (t) => {
  for (const failure of ['stale', 'render']) {
    await t.test(failure, async () => {
      let changed = false;
      const { runtime, calls } = createSavedHighRiskRuntime(t, {
        inspect: async ({ pageRange }, callTool) => {
          const info = await callTool('get_document_info');
          const items = await callTool('list_page_items', { pageIndex: 0 });
          return {
            inspectionId: 'insp', document: info.result,
            pages: [{ index: 0, items: items.result.items, summary: {} }],
            fingerprint: createHash('sha256').update(String(changed)).digest('hex'),
          };
        },
        render: async ({ pages }) => {
          if (failure === 'render') return { paths: ['C:/renders/page_1.png'], pageIndexes: [0] };
          changed = true;
          return { paths: pages.map((page) => `C:/renders/page_${page + 1}.png`), pageIndexes: pages };
        },
      });
      const plan = await createHighRiskPlan(runtime, { ...highRiskPlan, affectedPages: [0, 2] });
      if (failure === 'stale') changed = true;
      await assert.rejects(
        () => runtime.prepareApproval({ planId: plan.planId, expectedVersion: plan.version }),
        (error) => error.code === (failure === 'stale' ? 'STALE_PLAN' : 'BEFORE_RENDER_FAILED'),
      );
      assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
    });
  }
});

test('rejects a skill step the skill does not allow', async () => {
  const { runtime } = createRuntime();
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  await assert.rejects(
    () => runtime.createPlan({
      inspectionId: inspection.inspectionId,
      skillId: 'safe-layout-edit',
      plan: {
        ...movePlan,
        steps: [{ toolName: 'delete_page_item', arguments: { pageIndex: 0, itemIndex: 0 } }],
      },
    }),
    /PLAN_INVALID/,
  );
});

test('rejects a stale plan when the document changed', async () => {
  let moved = false;
  const { runtime } = createRuntime({
    inspect: async ({ pageRange }, callTool) => {
      const info = await callTool('get_document_info');
      const items = await callTool('list_page_items', { pageIndex: 0 });
      const itemsResult = moved
        ? { items: [{ index: 0, name: 'Title', geometricBounds: [40, 10, 60, 100] }] }
        : items.result;
      moved = true;
      return {
        inspectionId: 'insp',
        document: info.result,
        pages: [{ index: 0, items: itemsResult.items, summary: {} }],
        fingerprint: createHash('sha256')
          .update(`${pageRange}-${itemsResult.items[0].geometricBounds[0]}`)
          .digest('hex'),
      };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const plan = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'align-distribute',
    plan: movePlan,
  });
  await assert.rejects(
    () => runtime.applyPlan({ planId: plan.planId }),
    /STALE_PLAN/,
  );
});

test('rolls back completed low-risk steps after a later failure', async () => {
  const calls = [];
  let failProperties = false;
  const callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_document_info') return { success: true, result: documentResult };
    if (name === 'list_page_items') {
      return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
    }
    if (name === 'set_page_item_properties' && failProperties && args.fillColor === 'Red') return { success: false, result: 'failed' };
    return { success: true, result: { ok: true } };
  };
  const runtime = new SkillRuntime({ callTool });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const plan = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'align-distribute',
    plan: {
      ...movePlan,
      targets: [{
        pageIndex: 0,
        itemIndex: 0,
        name: 'Title',
        before: { geometricBounds: [10, 10, 30, 100], fillColor: 'Black' },
      }],
      steps: [
        movePlan.steps[0],
        { toolName: 'set_page_item_properties', arguments: { pageIndex: 0, itemIndex: 0, fillColor: 'Red' } },
      ],
    },
  });
  failProperties = true;
  await assert.rejects(
    () => runtime.applyPlan({ planId: plan.planId }),
    /STEP_FAILED/,
  );
  const last = calls.at(-1);
  assert.equal(last.name, 'move_page_item');
  assert.equal(last.args.y, 10);
  assert.equal(runtime.getPlan(plan.planId).plan.status, 'rolled_back');
});

test('rolls back an applied plan through the journal', async () => {
  const { runtime, calls } = createRuntime();
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const plan = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'align-distribute',
    plan: movePlan,
  });
  await runtime.applyPlan({ planId: plan.planId });
  const result = await runtime.rollbackPlan({ planId: plan.planId, reason: 'undo' });
  assert.equal(result.status, 'rolled_back');
  assert.equal(result.method, 'journal');
  assert.equal(calls.at(-1).name, 'move_page_item');
  assert.equal(calls.at(-1).args.y, 10);
});

test('verify reports verified only with a passing visual review', async () => {
  const { runtime } = createRuntime({
    structural: async () => ({ pass: true, issues: [] }),
    render: async () => ({ paths: ['before.png'], pageIndexes: [0] }),
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const plan = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'align-distribute',
    plan: movePlan,
  });
  await runtime.applyPlan({ planId: plan.planId });

  const structuralOnly = await runtime.verify({ planId: plan.planId });
  assert.equal(structuralOnly.status, 'structurally_checked_only');

  const verified = await runtime.verify({
    planId: plan.planId,
    visualReview: {
      pass: true,
      scores: { hierarchy: 4, alignment: 5, spacing: 4, readability: 5, cropping: 5, consistency: 4 },
      findings: [],
      unintendedChanges: false,
    },
  });
  assert.equal(verified.status, 'verified');
  assert.equal(runtime.getPlan(plan.planId).plan.status, 'verified');
});

test('a step without an undoable before-state cannot be planned as low risk', async () => {
  const { runtime, calls } = createRuntime();
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const plan = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'align-distribute',
    plan: {
      targets: [{ pageIndex: 0, itemIndex: 0, name: 'Title', before: { geometricBounds: [10, 10, 30, 100] } }],
      steps: [{
        toolName: 'set_page_item_properties',
        arguments: { pageIndex: 0, itemIndex: 0, fillColor: 'Red' },
      }],
      affectedPages: [0],
      expectedChanges: ['Recolor the title'],
      qualityCriteria: ['The title stays inside the margin'],
    },
  });

  assert.equal(plan.risk, 'high');
  assert.equal(plan.status, 'approval_required');
  assert.equal(plan.steps[0].reversible, false);
  await assert.rejects(() => runtime.applyPlan({ planId: plan.planId, expectedVersion: 1 }), /APPROVAL_REQUIRED/);
  assert.equal(calls.some((call) => call.name === 'set_page_item_properties'), false);
});

test('rollback reports failure instead of a clean rollback for a step without an inverse', async () => {
  const { runtime } = createRuntime();
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const plan = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'align-distribute',
    plan: movePlan,
  });
  await runtime.applyPlan({ planId: plan.planId });

  const record = runtime.plans.get(plan.planId);
  record.journal.entries[0].inverse = null;
  record.journal.entries[0].reversible = false;

  await assert.rejects(
    () => runtime.rollbackPlan({ planId: plan.planId }),
    (error) => error.code === 'ROLLBACK_FAILED'
      && error.status === 'ROLLBACK_FAILED'
      && error.unreversed.length === 1
      && /no inverse/i.test(error.message),
  );
  assert.equal(runtime.getPlan(plan.planId).plan.status, 'failed');
});

test('plan inputs and all returned plan views are defensive snapshots', async () => {
  const { runtime } = createRuntime();
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const input = structuredClone(movePlan);
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: input });
  input.targets[0].before.geometricBounds[0] = 999;
  input.steps[0].toolName = 'delete_page_item';
  created.targets[0].before.geometricBounds[0] = 888;
  created.steps[0].arguments.x = 777;
  created.risk = 'high';
  const view = runtime.getPlan(created.planId);
  view.plan.steps[0].toolName = 'delete_page_item';
  view.before.pages[0].items[0].geometricBounds[0] = 666;
  const listed = runtime.listPlans();
  listed[0].affectedPages[0] = 9;
  assert.equal(runtime.getPlan(created.planId).plan.targets[0].before.geometricBounds[0], 10);
  assert.equal(runtime.getPlan(created.planId).plan.steps[0].toolName, 'move_page_item');
  assert.equal(runtime.getPlan(created.planId).plan.risk, 'low');
  assert.deepEqual(runtime.getPlan(created.planId).plan.affectedPages, [0]);
  const result = await runtime.applyPlan({ planId: created.planId });
  assert.equal(result.status, 'applied');
});

test('revalidates the stored plan schema before execution', async () => {
  const { runtime, calls } = createRuntime();
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  runtime.plans.get(created.planId).plan.steps[0].arguments.x = 'not-a-number';
  await assert.rejects(() => runtime.applyPlan({ planId: created.planId }), /PLAN_INVALID/);
  assert.equal(calls.some((call) => call.name === 'move_page_item'), false);
});

test('rechecks each target immediately before its step and aborts a mismatched mutation', async () => {
  const calls = [];
  let bounds = [10, 10, 30, 100];
  const runtime = new SkillRuntime({
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_document_info') return { success: true, result: documentResult };
      if (name === 'list_page_items') return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: bounds }] } };
      if (name === 'move_page_item') bounds = [args.y, args.x, args.y + 20, args.x + 90];
      return { success: true, result: {} };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'align-distribute',
    plan: { ...movePlan, steps: [movePlan.steps[0], { ...movePlan.steps[0], id: 'second' }] },
  });
  await assert.rejects(() => runtime.applyPlan({ planId: created.planId }), /STALE_PLAN/);
  assert.equal(calls.filter((call) => call.name === 'move_page_item' && call.args.y === 20).length, 1);
});

test('rechecks document fingerprint after the before-render hook', async () => {
  let changed = false;
  const { runtime, calls } = createRuntime({
    inspect: async ({ pageRange }, callTool) => {
      const info = await callTool('get_document_info');
      const items = await callTool('list_page_items', { pageIndex: 0 });
      return {
        inspectionId: 'insp', document: info.result,
        pages: [{ index: 0, items: items.result.items, summary: {} }],
        fingerprint: createHash('sha256').update(String(changed)).digest('hex'),
      };
    },
    render: async () => { changed = true; return { paths: [] }; },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  await assert.rejects(() => runtime.applyPlan({ planId: created.planId }), /STALE_PLAN/);
  assert.equal(calls.some((call) => call.name === 'move_page_item'), false);
});

test('converts plan lengths to points at the handler boundary without changing identity', async () => {
  for (const [units, factor] of [['mm', 72 / 25.4], ['in', 72], ['cm', 72 / 2.54]]) {
    const calls = [];
    const callTool = async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_document_info') return { success: true, result: { ...documentResult, units } };
      if (name === 'list_page_items') return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
      return { success: true, result: {} };
    };
    const runtime = new SkillRuntime({ callTool });
    const inspection = await runtime.createInspection({ pageRange: 'all' });
    const created = await runtime.createPlan({
      inspectionId: inspection.inspectionId,
      skillId: 'align-distribute',
      plan: {
        ...movePlan,
        steps: [{ toolName: 'resize_page_item', arguments: { pageIndex: 0, itemIndex: 0, width: 10, height: 20 } }],
      },
    });
    await runtime.applyPlan({ planId: created.planId });
    const resize = calls.find((call) => call.name === 'resize_page_item');
    assert.equal(resize.args.pageIndex, 0);
    assert.equal(resize.args.itemIndex, 0);
    assert.ok(Math.abs(resize.args.width - 10 * factor) < 1e-10);
    assert.ok(Math.abs(resize.args.height - 20 * factor) < 1e-10);
  }
});

test('converts text font sizes from plan units while retaining frame identity', async () => {
  for (const [units, factor] of [['mm', 72 / 25.4], ['in', 72], ['cm', 72 / 2.54]]) {
    const calls = [];
    const runtime = new SkillRuntime({
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'get_document_info') return { success: true, result: { ...documentResult, units } };
        if (name === 'list_page_items') return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100], text: 'Old', fontSize: 12 }] } };
        return { success: true, result: {} };
      },
    });
    const inspection = await runtime.createInspection({ pageRange: 'all' });
    const created = await runtime.createPlan({
      inspectionId: inspection.inspectionId,
      skillId: 'safe-layout-edit',
      plan: {
        ...movePlan,
        steps: [{ toolName: 'edit_text_frame', arguments: { frameIndex: 0, content: 'New', fontSize: 10 } }],
      },
    });
    await runtime.applyPlan({ planId: created.planId });
    await runtime.rollbackPlan({ planId: created.planId });
    const edit = calls.find((call) => call.name === 'edit_text_frame');
    assert.equal(edit.args.frameIndex, 0);
    assert.equal(edit.args.content, 'New');
    assert.ok(Math.abs(edit.args.fontSize - 10 * factor) < 1e-10);
    const undo = calls.filter((call) => call.name === 'edit_text_frame')[1];
    assert.equal(undo.args.fontSize, 12);
  }
});

test('a failed attempted step is journaled and included in rollback', async () => {
  const calls = [];
  let fail = true;
  const runtime = new SkillRuntime({
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_document_info') return { success: true, result: documentResult };
      if (name === 'list_page_items') return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
      if (name === 'move_page_item' && fail) { fail = false; return { success: false, error: 'partial mutation' }; }
      return { success: true, result: {} };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  await assert.rejects(() => runtime.applyPlan({ planId: created.planId }), /STEP_FAILED/);
  assert.equal(calls.filter((call) => call.name === 'move_page_item').length, 2);
  const view = runtime.getPlan(created.planId);
  assert.equal(view.journal.steps.length, 1);
  assert.equal(view.plan.status, 'rolled_back');
});

test('automatic rollback requires explicit success and leaves failures detailed', async () => {
  const runtime = new SkillRuntime({
    callTool: async (name) => {
      if (name === 'get_document_info') return { success: true, result: documentResult };
      if (name === 'list_page_items') return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
      if (name === 'move_page_item') return {};
      return { success: true, result: {} };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  await assert.rejects(
    () => runtime.applyPlan({ planId: created.planId }),
    (error) => error.code === 'STEP_FAILED' && error.rollback.status === 'ROLLBACK_FAILED',
  );
  assert.equal(runtime.getPlan(created.planId).plan.status, 'failed');
});

test('verification failure automatically reverses completed low-risk steps', async () => {
  const { runtime, calls } = createRuntime({ structural: async () => ({ pass: false, issues: ['bad'] }) });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  await runtime.applyPlan({ planId: created.planId });
  const result = await runtime.verify({ planId: created.planId });
  assert.equal(result.status, 'failed');
  assert.equal(result.rollback.status, 'rolled_back');
  assert.equal(runtime.getPlan(created.planId).plan.status, 'rolled_back');
  assert.equal(calls.at(-1).name, 'move_page_item');
});

test('high-risk approval requires a capability and the exact version', async () => {
  const { runtime } = createRuntime();
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'multi-page-consistency',
    plan: { ...movePlan, steps: [{ toolName: 'apply_master_spread', arguments: { masterName: 'A-Master' } }] },
  });
  await assert.rejects(() => runtime.applyPlan({ planId: created.planId, approved: true }), /APPROVAL_REQUIRED/);
  await assert.rejects(() => runtime.applyPlan({ planId: created.planId, approved: true, expectedVersion: 2 }), /APPROVAL_MISMATCH/);
});

test('low-risk supplied expectedVersion must match', async () => {
  const { runtime } = createRuntime();
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  await assert.rejects(() => runtime.applyPlan({ planId: created.planId, expectedVersion: 2 }), /APPROVAL_MISMATCH/);
});

test('manual low-risk rollback refuses document changes after apply', async () => {
  let changed = false;
  const { runtime } = createRuntime({
    inspect: async ({ pageRange }, callTool) => {
      const info = await callTool('get_document_info');
      const items = await callTool('list_page_items', { pageIndex: 0 });
      return {
        inspectionId: 'insp', document: info.result,
        pages: [{ index: 0, items: items.result.items, summary: {} }],
        fingerprint: createHash('sha256').update(`${pageRange}-${changed}`).digest('hex'),
      };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  await runtime.applyPlan({ planId: created.planId });
  changed = true;
  await assert.rejects(() => runtime.rollbackPlan({ planId: created.planId }), /ROLLBACK_CONFLICT/);
  assert.equal(runtime.getPlan(created.planId).plan.status, 'applied');
});

test('approved high-risk edits execute after backup and restore that backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-high-risk-'));
  try {
    const filePath = join(dir, 'brief.indd');
    writeFileSync(filePath, 'saved baseline');
    const calls = [];
    let revision = 0;
    let activePath = filePath;
    const runtime = new SkillRuntime({
      artifactDir: join(dir, 'artifacts'),
      render: async () => ({ paths: ['C:/renders/page_1.png'], pageIndexes: [0] }),
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'open_document') { activePath = args.filePath; revision = 0; }
        if (name === 'get_document_info') return { success: true, result: { ...documentResult, filePath: activePath, saved: true, modified: false, revision } };
        if (name === 'list_page_items') return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
        if (name === 'apply_master_spread') revision += 1;
        return { success: true, result: {} };
      },
      inspect: async ({ pageRange }, callTool) => {
        const info = await callTool('get_document_info');
        const items = await callTool('list_page_items', { pageIndex: 0 });
        return {
          inspectionId: 'insp', document: info.result, baseRevision: revision,
          pages: [{ index: 0, items: items.result.items, summary: {} }],
          fingerprint: createHash('sha256').update(String(revision)).digest('hex'),
        };
      },
    });
    const inspection = await runtime.createInspection({ pageRange: 'all' });
    const created = await runtime.createPlan({
      inspectionId: inspection.inspectionId,
      skillId: 'multi-page-consistency',
      plan: { ...movePlan, steps: [{ toolName: 'apply_master_spread', arguments: { masterName: 'A-Master' } }] },
    });
    const { approvalToken } = runtime.issueApprovalCapability({ planId: created.planId, expectedVersion: 1 });
    const applied = await runtime.applyPlan({ planId: created.planId, approvalToken, expectedVersion: 1 });
    assert.equal(applied.status, 'applied');
    assert.ok(applied.backupPath);
    await runtime.rollbackPlan({ planId: created.planId });
    const opened = calls.find((call) => call.name === 'open_document');
    assert.equal(opened.args.filePath, applied.backupPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('approved high-risk failure restores backup instead of journal inverses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-high-risk-'));
  try {
    const filePath = join(dir, 'brief.indd');
    writeFileSync(filePath, 'saved baseline');
    const calls = [];
    let activePath = filePath;
    const runtime = new SkillRuntime({
      artifactDir: join(dir, 'artifacts'),
      render: async () => ({ paths: ['C:/renders/page_1.png'], pageIndexes: [0] }),
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'open_document') activePath = args.filePath;
        if (name === 'get_document_info') return { success: true, result: { ...documentResult, filePath: activePath, saved: true, modified: false } };
        if (name === 'list_page_items') return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
        if (name === 'apply_master_spread') return { success: false, error: 'partial' };
        return { success: true, result: {} };
      },
    });
    const inspection = await runtime.createInspection({ pageRange: 'all' });
    const created = await runtime.createPlan({
      inspectionId: inspection.inspectionId,
      skillId: 'multi-page-consistency',
      plan: { ...movePlan, steps: [{ toolName: 'apply_master_spread', arguments: { masterName: 'A-Master' } }] },
    });
    const { approvalToken } = runtime.issueApprovalCapability({ planId: created.planId, expectedVersion: 1 });
    const applyError = await runtime.applyPlan({ planId: created.planId, approvalToken, expectedVersion: 1 }).then(() => null, (error) => error);
    assert.equal(applyError?.code, 'STEP_FAILED', JSON.stringify(applyError?.rollback));
    assert.equal(applyError?.rollback?.method, 'backup', JSON.stringify(applyError?.rollback));
    assert.ok(calls.some((call) => call.name === 'open_document'));
    assert.equal(runtime.getPlan(created.planId).plan.status, 'rolled_back');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('after-render document changes fail verification and trigger rollback', async () => {
  let changed = false;
  const { runtime } = createRuntime({
    inspect: async ({ pageRange }, callTool) => {
      const info = await callTool('get_document_info');
      const items = await callTool('list_page_items', { pageIndex: 0 });
      return {
        inspectionId: 'insp', document: info.result,
        pages: [{ index: 0, items: items.result.items, summary: {} }],
        fingerprint: createHash('sha256').update(`${pageRange}-${changed}`).digest('hex'),
      };
    },
    structural: async () => ({ pass: true, issues: [] }),
    render: async (options) => {
      if (!options.outputDir) changed = true;
      return { paths: [options.outputDir ? 'before.png' : 'after.png'] };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  await runtime.applyPlan({ planId: created.planId });
  await assert.rejects(
    () => runtime.verify({ planId: created.planId }),
    (error) => error.code === 'ROLLBACK_FAILED' && error.rollback.status === 'ROLLBACK_CONFLICT',
  );
  assert.equal(runtime.getPlan(created.planId).plan.status, 'failed');
  assert.equal(runtime.getPlan(created.planId).journal.steps[0].completed, true);
});

test('high-risk verification failure restores the backup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'runtime-high-risk-'));
  try {
    const filePath = join(dir, 'brief.indd');
    writeFileSync(filePath, 'saved baseline');
    const calls = [];
    let activePath = filePath;
    const runtime = new SkillRuntime({
      artifactDir: join(dir, 'artifacts'),
      render: async () => ({ paths: ['C:/renders/page_1.png'], pageIndexes: [0] }),
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'open_document') activePath = args.filePath;
        if (name === 'get_document_info') return { success: true, result: { ...documentResult, filePath: activePath, saved: true, modified: false } };
        if (name === 'list_page_items') return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
        return { success: true, result: {} };
      },
      structural: async () => ({ pass: false, issues: ['bad'] }),
      render: async () => ({ paths: ['C:/renders/page_1.png'], pageIndexes: [0] }),
    });
    const inspection = await runtime.createInspection({ pageRange: 'all' });
    const created = await runtime.createPlan({
      inspectionId: inspection.inspectionId,
      skillId: 'multi-page-consistency',
      plan: { ...movePlan, steps: [{ toolName: 'apply_master_spread', arguments: { masterName: 'A-Master' } }] },
    });
    const { approvalToken } = runtime.issueApprovalCapability({ planId: created.planId, expectedVersion: 1 });
    await runtime.applyPlan({ planId: created.planId, approvalToken, expectedVersion: 1 });
    const result = await runtime.verify({ planId: created.planId });
    assert.equal(result.rollback.method, 'backup');
    assert.equal(runtime.getPlan(created.planId).plan.status, 'rolled_back');
    const opened = calls.find((call) => call.name === 'open_document');
    assert.equal(opened.args.filePath, runtime.getPlan(created.planId).backup.backupPath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('high-risk backup refuses unsaved or unverifiable saved state before mutation', async () => {
  for (const state of [{ ...documentResult, filePath: 'Unsaved', saved: false, modified: false }, { ...documentResult }]) {
    const { runtime, calls } = createRuntime({
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'get_document_info') return { success: true, result: state };
        if (name === 'list_page_items') return { success: true, result: { items: [{ index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] }] } };
        return { success: true, result: {} };
      },
    });
    const inspection = await runtime.createInspection({ pageRange: 'all' });
    const created = await runtime.createPlan({
      inspectionId: inspection.inspectionId,
      skillId: 'multi-page-consistency',
      plan: { ...movePlan, steps: [{ toolName: 'apply_master_spread', arguments: { masterName: 'A-Master' } }] },
    });
    const { approvalToken } = runtime.issueApprovalCapability({ planId: created.planId, expectedVersion: 1 });
    await assert.rejects(
      () => runtime.applyPlan({ planId: created.planId, approvalToken, expectedVersion: 1 }),
      /BACKUP_REQUIRED/,
    );
    assert.equal(calls.some((call) => call.name === 'apply_master_spread'), false);
  }
});

test('rejects an active-document switch before mutating the next step', async () => {
  let activePath = 'C:/docs/brief.indd';
  const calls = [];
  const runtime = new SkillRuntime({
    inspect: async ({ pageRange }, callTool) => {
      const info = await callTool('get_document_info');
      const items = await callTool('list_page_items', { pageIndex: 0 });
      return {
        inspectionId: 'insp', document: info.result,
        pages: [{ index: 0, items: items.result.items, summary: {} }],
        fingerprint: 'a'.repeat(64),
      };
    },
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_document_info') return { success: true, result: { ...documentResult, filePath: activePath } };
      if (name === 'list_page_items') return { success: true, result: { items: [
        { index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] },
        { index: 1, name: 'Subtitle', geometricBounds: [10, 40, 30, 130] },
      ] } };
      if (name === 'move_page_item' && args.itemIndex === 0) activePath = 'C:/docs/other.indd';
      return { success: true, result: {} };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'align-distribute',
    plan: {
      targets: [
        { pageIndex: 0, itemIndex: 0, before: { geometricBounds: [10, 10, 30, 100] } },
        { pageIndex: 0, itemIndex: 1, before: { geometricBounds: [10, 40, 30, 130] } },
      ],
      steps: [
        { toolName: 'move_page_item', targetIndex: 0, arguments: { x: 10, y: 20 } },
        { toolName: 'move_page_item', targetIndex: 1, arguments: { x: 10, y: 50 } },
      ],
      affectedPages: [0], expectedChanges: ['Move both lines'], qualityCriteria: ['No overflow'],
    },
  });
  const applyError = await runtime.applyPlan({ planId: created.planId }).then(() => null, (error) => error);
  assert.equal(applyError?.code, 'DOCUMENT_CHANGED', JSON.stringify(applyError?.rollback));
  assert.equal(applyError?.rollback?.status, 'ROLLBACK_CONFLICT', JSON.stringify(applyError?.rollback));
  assert.equal(calls.filter((call) => call.name === 'move_page_item' && call.args.y === 20).length, 1);
  assert.equal(calls.some((call) => call.name === 'move_page_item' && call.args.y === 50), false);
  assert.equal(runtime.getPlan(created.planId).plan.status, 'failed');
});

test('rolls back completed steps when a later pre-step inspection or binding throws', async () => {
  for (const failure of ['inspection', 'binding']) {
    const calls = [];
    let inspectionCount = 0;
    const runtime = new SkillRuntime({
      inspect: async ({ pageRange }, callTool) => {
        inspectionCount += 1;
        if (failure === 'inspection' && inspectionCount === 5) throw new Error('inspection exploded');
        const info = await callTool('get_document_info');
        const items = await callTool('list_page_items', { pageIndex: 0 });
        const resultItems = items.result.items.map((item) => ({ ...item }));
        if (failure === 'binding' && inspectionCount === 5) resultItems[1].uncloneable = 1n;
        return {
          inspectionId: 'insp', document: info.result,
          pages: [{ index: 0, items: resultItems, summary: {} }],
          fingerprint: 'b'.repeat(64),
        };
      },
      callTool: async (name, args) => {
        calls.push({ name, args });
        if (name === 'get_document_info') return { success: true, result: documentResult };
        if (name === 'list_page_items') return { success: true, result: { items: [
          { index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] },
          { index: 1, name: 'Subtitle', geometricBounds: [10, 40, 30, 130] },
        ] } };
        return { success: true, result: {} };
      },
    });
    const inspection = await runtime.createInspection({ pageRange: 'all' });
    const created = await runtime.createPlan({
      inspectionId: inspection.inspectionId,
      skillId: 'align-distribute',
      plan: {
        targets: [
          { pageIndex: 0, itemIndex: 0, before: { geometricBounds: [10, 10, 30, 100] } },
          { pageIndex: 0, itemIndex: 1, before: { geometricBounds: [10, 40, 30, 130] } },
        ],
        steps: [
          { toolName: 'move_page_item', targetIndex: 0, arguments: { x: 10, y: 20 } },
          { toolName: 'move_page_item', targetIndex: 1, arguments: { x: 10, y: 50 } },
        ],
        affectedPages: [0], expectedChanges: ['Move both lines'], qualityCriteria: ['No overflow'],
      },
    });
    const applyError = await runtime.applyPlan({ planId: created.planId }).then(() => null, (error) => error);
    assert.equal(inspectionCount, failure === 'inspection' ? 6 : 7, `${failure}: ${applyError?.stack ?? 'apply unexpectedly succeeded'}`);
    assert.equal(applyError?.code, 'PRE_STEP_FAILED', failure);
    assert.equal(applyError?.rollback?.status, 'rolled_back', failure);
    assert.equal(calls.some((call) => call.name === 'move_page_item' && call.args.y === 50), false, failure);
    assert.equal(calls.at(-1).name, 'move_page_item', failure);
    assert.equal(calls.at(-1).args.y, 10, failure);
    assert.equal(runtime.getPlan(created.planId).plan.status, 'rolled_back', failure);
  }
});

test('acquires the per-plan apply lock before the first await', async () => {
  let releaseInspection;
  let inspectionCount = 0;
  const gate = new Promise((resolve) => { releaseInspection = resolve; });
  const calls = [];
  const runtime = new SkillRuntime({
    inspect: async ({ pageRange }, callTool) => {
      inspectionCount += 1;
      if (inspectionCount === 2) await gate;
      const info = await callTool('get_document_info');
      const items = await callTool('list_page_items', { pageIndex: 0 });
      return {
        inspectionId: 'insp', document: info.result,
        pages: [{ index: 0, items: items.result.items, summary: {} }],
        fingerprint: 'c'.repeat(64),
      };
    },
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_document_info') return { success: true, result: documentResult };
      if (name === 'list_page_items') return { success: true, result: { items: [
        { index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] },
      ] } };
      return { success: true, result: {} };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  const first = runtime.applyPlan({ planId: created.planId });
  const second = runtime.applyPlan({ planId: created.planId }).then(
    () => ({ status: 'fulfilled' }),
    (error) => ({ status: 'rejected', code: error.code }),
  );
  const early = await Promise.race([second, new Promise((resolve) => setImmediate(() => resolve({ status: 'pending' })))]);
  releaseInspection();
  await first;
  const outcome = await second;
  assert.deepEqual(early, { status: 'rejected', code: 'PLAN_INVALID' });
  assert.deepEqual(outcome, { status: 'rejected', code: 'PLAN_INVALID' });
  assert.equal(calls.filter((call) => call.name === 'move_page_item').length, 1);
});

test('honors AbortSignal between steps and rolls back completed mutations', async () => {
  const controller = new AbortController();
  const calls = [];
  const runtime = new SkillRuntime({
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_document_info') return { success: true, result: documentResult };
      if (name === 'list_page_items') return { success: true, result: { items: [
        { index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] },
        { index: 1, name: 'Subtitle', geometricBounds: [10, 40, 30, 130] },
      ] } };
      if (name === 'move_page_item' && args.y === 20) controller.abort();
      return { success: true, result: {} };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'align-distribute',
    plan: {
      targets: [
        { pageIndex: 0, itemIndex: 0, before: { geometricBounds: [10, 10, 30, 100] } },
        { pageIndex: 0, itemIndex: 1, before: { geometricBounds: [10, 40, 30, 130] } },
      ],
      steps: [
        { toolName: 'move_page_item', targetIndex: 0, arguments: { x: 10, y: 20 } },
        { toolName: 'move_page_item', targetIndex: 1, arguments: { x: 10, y: 50 } },
      ],
      affectedPages: [0], expectedChanges: ['Move both lines'], qualityCriteria: ['No overflow'],
    },
  });
  await assert.rejects(
    () => runtime.applyPlan({ planId: created.planId, signal: controller.signal }),
    (error) => error.code === 'ABORTED' && error.rollback?.status === 'rolled_back',
  );
  assert.equal(calls.some((call) => call.name === 'move_page_item' && call.args.y === 50), false);
  assert.equal(calls.at(-1).args.y, 10);
  assert.equal(runtime.getPlan(created.planId).plan.status, 'rolled_back');
});

test('an abort during the final inspection still rolls back the applied steps', async () => {
  const controller = new AbortController();
  let inspectionCount = 0;
  const calls = [];
  const runtime = new SkillRuntime({
    inspect: async ({ pageRange }, callTool) => {
      inspectionCount += 1;
      if (inspectionCount === 5) controller.abort();
      const info = await callTool('get_document_info');
      const items = await callTool('list_page_items', { pageIndex: 0 });
      return {
        inspectionId: 'insp', document: info.result,
        pages: [{ index: 0, items: items.result.items, summary: {} }],
        fingerprint: 'd'.repeat(64),
      };
    },
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_document_info') return { success: true, result: documentResult };
      if (name === 'list_page_items') return { success: true, result: { items: [
        { index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] },
      ] } };
      return { success: true, result: {} };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  await assert.rejects(
    () => runtime.applyPlan({ planId: created.planId, signal: controller.signal }),
    (error) => error.code === 'ABORTED' && error.rollback?.status === 'rolled_back',
  );
  assert.equal(calls.at(-1).args.y, 10);
  assert.equal(runtime.getPlan(created.planId).plan.status, 'rolled_back');
});

test('an abort concurrent with a final inspection error still rolls back', async () => {
  const controller = new AbortController();
  let inspectionCount = 0;
  const calls = [];
  const runtime = new SkillRuntime({
    inspect: async ({ pageRange }, callTool) => {
      inspectionCount += 1;
      if (inspectionCount === 5) {
        controller.abort();
        throw new Error('final inspection unavailable');
      }
      const info = await callTool('get_document_info');
      const items = await callTool('list_page_items', { pageIndex: 0 });
      return {
        inspectionId: 'insp', document: info.result,
        pages: [{ index: 0, items: items.result.items, summary: {} }],
        fingerprint: 'e'.repeat(64),
      };
    },
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_document_info') return { success: true, result: documentResult };
      if (name === 'list_page_items') return { success: true, result: { items: [
        { index: 0, name: 'Title', geometricBounds: [10, 10, 30, 100] },
      ] } };
      return { success: true, result: {} };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  await assert.rejects(
    () => runtime.applyPlan({ planId: created.planId, signal: controller.signal }),
    (error) => error.code === 'ABORTED' && error.rollback?.status === 'rolled_back',
  );
  assert.equal(calls.at(-1).args.y, 10);
  assert.equal(runtime.getPlan(created.planId).plan.status, 'rolled_back');
});

test('a throwing after-render still checks freshness and cannot report structural success', async () => {
  let changed = false;
  let inspections = 0;
  const { runtime } = createRuntime({
    inspect: async ({ pageRange }, callTool) => {
      inspections += 1;
      const info = await callTool('get_document_info');
      const items = await callTool('list_page_items', { pageIndex: 0 });
      return {
        inspectionId: 'insp', document: info.result,
        pages: [{ index: 0, items: items.result.items, summary: {} }],
        fingerprint: createHash('sha256').update(String(changed)).digest('hex'),
      };
    },
    structural: async () => ({ pass: true, issues: [] }),
    render: async (options) => {
      if (!options.outputDir) {
        changed = true;
        throw new Error('after renderer crashed');
      }
      return { paths: ['before.png'], pageIndexes: [0] };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'align-distribute', plan: movePlan });
  await runtime.applyPlan({ planId: created.planId });
  const beforeVerify = inspections;
  await assert.rejects(
    () => runtime.verify({ planId: created.planId }),
    (error) => error.code === 'ROLLBACK_FAILED' && error.rollback?.status === 'ROLLBACK_CONFLICT',
  );
  assert.ok(inspections > beforeVerify);
  assert.equal(runtime.getPlan(created.planId).plan.status, 'failed');
});

test('runtime rebinds mixed text targets to the textFrames collection', async () => {
  const calls = [];
  const runtime = new SkillRuntime({
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'get_document_info') return { success: true, result: documentResult };
      if (name === 'list_page_items') return { success: true, result: { items: [
        { index: 0, type: 'Rectangle', name: 'Background', geometricBounds: [0, 0, 20, 20] },
        { index: 1, type: 'TextFrame', name: 'TextA', contents: 'Old A', geometricBounds: [0, 0, 20, 20] },
        { index: 2, type: 'TextFrame', name: 'TextB', contents: 'Old B', geometricBounds: [0, 0, 20, 20] },
      ] } };
      return { success: true, result: {} };
    },
  });
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  const created = await runtime.createPlan({
    inspectionId: inspection.inspectionId,
    skillId: 'safe-layout-edit',
    plan: {
      targets: [{ pageIndex: 0, itemIndex: 1, name: 'TextA', before: { contents: 'Old A' } }],
      steps: [{ toolName: 'edit_text_frame', arguments: { content: 'New A' } }],
      affectedPages: [0], expectedChanges: ['Edit TextA'], qualityCriteria: ['TextB is unchanged'],
    },
  });
  await runtime.applyPlan({ planId: created.planId });
  const edit = calls.find((call) => call.name === 'edit_text_frame');
  assert.equal(edit.args.frameIndex, 0);
  await runtime.rollbackPlan({ planId: created.planId });
  assert.equal(calls.filter((call) => call.name === 'edit_text_frame')[1].args.frameIndex, 0);
});

test('rejects unknown plans and skills with stable codes', async () => {
  const { runtime } = createRuntime();
  await assert.rejects(() => runtime.applyPlan({ planId: 'missing' }), /PLAN_INVALID/);
  const inspection = await runtime.createInspection({ pageRange: 'all' });
  await assert.rejects(
    () => runtime.createPlan({ inspectionId: inspection.inspectionId, skillId: 'nope', plan: movePlan }),
    /SKILL_NOT_FOUND/,
  );
});
