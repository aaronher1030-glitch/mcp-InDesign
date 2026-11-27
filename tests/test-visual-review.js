import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewLayout, validateVisualReview } from '../src/quality/visualReview.js';

const review = {
  pass: true,
  scores: { hierarchy: 4, alignment: 5, spacing: 4, readability: 5, cropping: 5, consistency: 4 },
  findings: [],
  unintendedChanges: false,
};

function imageFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'indesign-review-test-'));
  const path = join(dir, 'page_1.png');
  writeFileSync(path, Buffer.from('89504e470d0a1a0a', 'hex'));
  return { dir, path };
}

test('builds provider-specific image messages and parses structured output', async () => {
  const { dir, path } = imageFixture();
  try {
    let request;
    const complete = async (input) => {
      request = input;
      return { content: JSON.stringify(review), toolCalls: [] };
    };
    const result = await reviewLayout({
      beforePaths: [path],
      afterPaths: [path],
      intent: 'Move title down',
      plan: { expectedChanges: ['Move title'], affectedPages: [0] },
      settings: { provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'vision', apiKey: '' },
      complete,
    });
    assert.equal(result.status, 'passed');
    assert.equal(request.messages[0].content[1].type, 'image_url');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid model output becomes unavailable, never a pass', async () => {
  const { dir, path } = imageFixture();
  try {
    const result = await reviewLayout({
      beforePaths: [path],
      afterPaths: [path],
      intent: 'x',
      plan: {},
      settings: { provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'vision', apiKey: '' },
      complete: async () => ({ content: 'looks good', toolCalls: [] }),
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.pass, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a review without images is unavailable', async () => {
  for (const [beforePaths, afterPaths] of [
    [[], []],
    [[], ['/renders/after.png']],
    [['/renders/before.png'], []],
  ]) {
    const result = await reviewLayout({
      beforePaths,
      afterPaths,
      intent: 'x',
      plan: {},
      settings: { provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'vision', apiKey: '' },
      complete: async () => ({ content: JSON.stringify(review), toolCalls: [] }),
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.pass, false);
  }
});

test('visual review requires before and after images for every affected page', async () => {
  const { dir, path } = imageFixture();
  try {
    for (const [beforePaths, afterPaths] of [
      [[path], [path, path]],
      [[path, path], [path]],
      [[path, path], [path, path]],
    ]) {
      const result = await reviewLayout({
        beforePaths,
        afterPaths,
        intent: 'x',
        plan: { affectedPages: [1, 3] },
        settings: { provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'vision', apiKey: '' },
        complete: async () => ({ content: JSON.stringify(review), toolCalls: [] }),
      });
      assert.equal(result.status, 'unavailable');
      assert.equal(result.pass, false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('valid visual findings must contain the complete documented rubric shape', () => {
  const finding = { severity: 'info', page: 2, region: 'top', explanation: 'Title is clear.' };
  const result = validateVisualReview({ ...review, findings: [finding] });
  assert.equal(result.status, 'passed');
  assert.deepEqual(result.findings, [finding]);
});

test('missing or invalid review fields are unavailable, never a pass', async () => {
  const finding = { severity: 'info', page: 2, region: 'top', explanation: 'Title is clear.' };
  const invalidReviews = [
    ['missing pass', { pass: undefined }],
    ['invalid pass', { pass: 'true' }],
    ['missing unintendedChanges', { unintendedChanges: undefined }],
    ['invalid unintendedChanges', { unintendedChanges: 0 }],
    ['missing findings', { findings: undefined }],
    ['invalid findings', { findings: {} }],
    ['empty finding', { findings: [{}] }],
    ['null finding', { findings: [null] }],
    ['array finding', { findings: [[]] }],
    ['missing severity', { findings: [{ ...finding, severity: undefined }] }],
    ['blank severity', { findings: [{ ...finding, severity: ' ' }] }],
    ['invalid severity', { findings: [{ ...finding, severity: 1 }] }],
    ['missing page', { findings: [{ ...finding, page: undefined }] }],
    ['string page', { findings: [{ ...finding, page: '2' }] }],
    ['zero page', { findings: [{ ...finding, page: 0 }] }],
    ['fractional page', { findings: [{ ...finding, page: 1.5 }] }],
    ['missing region', { findings: [{ ...finding, region: undefined }] }],
    ['blank region', { findings: [{ ...finding, region: ' ' }] }],
    ['invalid region', { findings: [{ ...finding, region: {} }] }],
    ['missing explanation', { findings: [{ ...finding, explanation: undefined }] }],
    ['blank explanation', { findings: [{ ...finding, explanation: ' ' }] }],
    ['invalid explanation', { findings: [{ ...finding, explanation: [] }] }],
    ['missing scores', { scores: undefined }],
    ['array scores', { scores: [] }],
    ['missing hierarchy score', { scores: { ...review.scores, hierarchy: undefined } }],
    ['string score', { scores: { ...review.scores, alignment: '5' } }],
    ['low score', { scores: { ...review.scores, spacing: 0 } }],
    ['high score', { scores: { ...review.scores, readability: 6 } }],
    ['non-finite score', { scores: { ...review.scores, cropping: Number.NaN } }],
  ];
  const { dir, path } = imageFixture();
  try {
    for (const [name, change] of invalidReviews) {
      const candidate = { ...review, ...change };
      assert.equal(validateVisualReview(candidate), null, name);
      const result = await reviewLayout({
        beforePaths: [path],
        afterPaths: [path],
        intent: 'x',
        plan: { affectedPages: [0] },
        settings: { provider: 'openai', baseUrl: 'http://localhost:1234/v1', model: 'vision', apiKey: '' },
        complete: async () => ({ content: JSON.stringify(candidate), toolCalls: [] }),
      });
      assert.equal(result.status, 'unavailable', name);
      assert.equal(result.pass, false, name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Anthropic conversion preserves base64 image blocks', async () => {
  const { toAnthropic } = await import('../src/chat/providers.js');
  const converted = toAnthropic([{
    role: 'user',
    content: [
      { type: 'text', text: 'Review this page' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
    ],
  }]);
  assert.equal(converted.messages[0].content[1].source.data, 'abc');
});
