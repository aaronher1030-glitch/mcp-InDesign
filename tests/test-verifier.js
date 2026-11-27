import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPlan } from '../src/quality/verifier.js';

const visualReview = {
  status: 'passed',
  pass: true,
  scores: { hierarchy: 4, alignment: 5, spacing: 4, readability: 5, cropping: 5, consistency: 4 },
  findings: [],
  unintendedChanges: false,
};

function runtimeStub({ beforeArtifacts = ['/renders/before-2.png', '/renders/before-4.png'] } = {}) {
  return {
    getPlan: () => ({
      planId: 'plan-1',
      status: 'applied',
      before: {},
      after: {},
      beforeArtifacts,
      plan: {
        targets: [],
        expectedChanges: [],
        affectedPages: [1, 3],
        beforeArtifacts,
      },
    }),
  };
}

const completeAfterRender = async () => ({
  paths: ['/renders/after-2.png', '/renders/after-4.png'],
  pageIndexes: [1, 3],
});

test('combines structural and client-provided visual review with complete page coverage', async () => {
  const result = await verifyPlan({
    planId: 'plan-1',
    visualReview,
    runtime: runtimeStub(),
    inspect: async () => ({}),
    render: completeAfterRender,
    structural: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(result.status, 'verified');
});

test('a supplied visual pass is structural-only when after rendering throws', async () => {
  const result = await verifyPlan({
    planId: 'plan-1',
    visualReview,
    runtime: runtimeStub(),
    inspect: async () => ({}),
    render: async () => { throw new Error('after export failed'); },
    structural: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(result.status, 'structurally_checked_only');
  assert.equal(result.visual.status, 'unavailable');
  assert.deepEqual(result.artifacts.after, []);
});

test('a supplied visual pass is structural-only when after rendering returns no paths', async () => {
  const result = await verifyPlan({
    planId: 'plan-1',
    visualReview,
    runtime: runtimeStub(),
    inspect: async () => ({}),
    render: async () => ({ paths: [] }),
    structural: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(result.status, 'structurally_checked_only');
  assert.equal(result.visual.status, 'unavailable');
});

test('a supplied visual pass is structural-only when before rendering failed', async () => {
  const beforeArtifacts = [];
  const result = await verifyPlan({
    planId: 'plan-1',
    visualReview,
    runtime: runtimeStub({ beforeArtifacts }),
    inspect: async () => ({}),
    render: completeAfterRender,
    structural: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(result.status, 'structurally_checked_only');
  assert.equal(result.visual.status, 'unavailable');
  assert.deepEqual(result.artifacts.before, []);
});

test('a supplied visual pass is structural-only when either side lacks an affected page', async () => {
  for (const [beforeArtifacts, after] of [
    [['/renders/before-2.png'], { paths: ['/renders/after-2.png', '/renders/after-4.png'], pageIndexes: [1, 3] }],
    [['/renders/before-2.png', '/renders/before-4.png'], { paths: ['/renders/after-4.png'], pageIndexes: [3] }],
  ]) {
    const result = await verifyPlan({
      planId: 'plan-1',
      visualReview,
      runtime: runtimeStub({ beforeArtifacts }),
      inspect: async () => ({}),
      render: async () => after,
      structural: async () => ({ pass: true, issues: [] }),
    });
    assert.equal(result.status, 'structurally_checked_only');
    assert.equal(result.visual.status, 'unavailable');
  }
});

test('a supplied visual pass is structural-only when after page coverage is incomplete', async () => {
  const result = await verifyPlan({
    planId: 'plan-1',
    visualReview,
    runtime: runtimeStub(),
    inspect: async () => ({}),
    render: async () => ({
      paths: ['/renders/after-2.png', '/renders/after-2.png'],
      pageIndexes: [1],
    }),
    structural: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(result.status, 'structurally_checked_only');
  assert.equal(result.visual.status, 'unavailable');
});

test('structural pass with a valid visual rejection fails verification', async () => {
  const result = await verifyPlan({
    planId: 'plan-1',
    visualReview: { ...visualReview, pass: false, status: 'failed', unintendedChanges: true },
    runtime: runtimeStub(),
    inspect: async () => ({}),
    render: completeAfterRender,
    structural: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.visual.status, 'failed');
});

test('missing visual review is structural-only', async () => {
  const result = await verifyPlan({
    planId: 'plan-1',
    runtime: runtimeStub(),
    inspect: async () => ({}),
    render: completeAfterRender,
    structural: async () => ({ pass: true, issues: [] }),
  });
  assert.equal(result.status, 'structurally_checked_only');
});

test('structural failure is a failed verification', async () => {
  const result = await verifyPlan({
    planId: 'plan-1',
    visualReview,
    runtime: runtimeStub(),
    inspect: async () => ({}),
    render: completeAfterRender,
    structural: async () => ({ pass: false, issues: [{ code: 'TEXT_OVERFLOW' }] }),
  });
  assert.equal(result.status, 'failed');
});

test('refuses to verify a plan that was not applied', async () => {
  await assert.rejects(
    () => verifyPlan({
      planId: 'plan-1',
      runtime: { getPlan: () => ({ status: 'draft', plan: {} }) },
      structural: async () => ({ pass: true, issues: [] }),
      render: async () => ({ paths: [] }),
    }),
    /PLAN_INVALID/,
  );
});
