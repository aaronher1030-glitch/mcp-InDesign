import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { completeChat } from '../chat/providers.js';
import { QUALITY_RUBRIC_MARKDOWN } from '../skills/protocol.js';

const SCORE_KEYS = ['hierarchy', 'alignment', 'spacing', 'readability', 'cropping', 'consistency'];

function unavailable(reason) {
  return {
    status: 'unavailable',
    pass: false,
    scores: null,
    findings: [],
    unintendedChanges: null,
    reason: String(reason || 'Visual review unavailable'),
  };
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Ensure each affected page has a distinct, nonempty render on one side of
 * the comparison. Arrays without page indexes follow renderer request order.
 */
export function artifactCoverageError(artifact, pages, label) {
  const paths = Array.isArray(artifact) ? artifact : artifact?.paths;
  if (artifact?.error) return `The ${label} render failed: ${artifact.error}`;
  if (!Array.isArray(pages) || pages.length === 0) return 'No affected pages were available for visual review.';
  if (!Array.isArray(paths) || paths.length === 0) return `No ${label} renders were available for visual review.`;
  if (paths.some((path) => !nonemptyString(path))) return `The ${label} renders contain an empty path.`;
  if (paths.length !== pages.length || new Set(paths).size !== paths.length) {
    return `The ${label} renders do not cover every affected page exactly once.`;
  }
  const pageIndexes = artifact?.pageIndexes;
  if (pageIndexes !== undefined) {
    if (!Array.isArray(pageIndexes) || pageIndexes.length !== pages.length
      || pageIndexes.some((page) => !Number.isInteger(page) || page < 0)
      || new Set(pageIndexes).size !== pages.length
      || pageIndexes.some((page) => !pages.includes(page))) {
      return `The ${label} render page coverage is invalid or incomplete.`;
    }
  }
  return null;
}

function mediaType(path) {
  const extension = extname(path || '').toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  return 'image/png';
}

function stripFences(text) {
  const trimmed = String(text || '').trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1] : trimmed;
}

/**
 * Validate a client- or model-authored review. Returns null when invalid so a
 * malformed review can never be reported as a pass.
 */
export function validateVisualReview(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (typeof value.pass !== 'boolean') return null;
  if (typeof value.unintendedChanges !== 'boolean') return null;
  if (!Array.isArray(value.findings)) return null;
  if (!value.scores || typeof value.scores !== 'object' || Array.isArray(value.scores)) return null;
  const scores = {};
  for (const key of SCORE_KEYS) {
    const score = value.scores[key];
    if (typeof score !== 'number' || !Number.isFinite(score) || score < 1 || score > 5) return null;
    scores[key] = score;
  }
  for (const entry of value.findings) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (!nonemptyString(entry.severity)) return null;
    if (!Number.isInteger(entry.page) || entry.page < 1) return null;
    if (!nonemptyString(entry.region)) return null;
    if (!nonemptyString(entry.explanation)) return null;
  }
  const status = value.pass && value.unintendedChanges === false ? 'passed' : 'failed';
  return {
    status,
    pass: status === 'passed',
    scores,
    findings: value.findings,
    unintendedChanges: value.unintendedChanges,
  };
}

/**
 * Ask a vision model to review before/after renders against the rubric.
 * Any fetch error, non-JSON output, or invalid field becomes "unavailable".
 */
export async function reviewLayout({
  beforePaths = [],
  afterPaths = [],
  intent = '',
  plan = {},
  settings = {},
  complete = completeChat,
} = {}) {
  const affectedPages = Array.isArray(plan.affectedPages) && plan.affectedPages.length > 0
    ? [...new Set(plan.affectedPages)]
    : (plan.targets ?? []).map((target) => target.pageIndex).filter(Number.isInteger);
  const coverageError = artifactCoverageError(beforePaths, affectedPages, 'before')
    || artifactCoverageError(afterPaths, affectedPages, 'after');
  if (coverageError) return unavailable(coverageError);

  const images = [
    ...afterPaths.map((path) => ({ path, label: 'after' })),
    ...beforePaths.map((path) => ({ path, label: 'before' })),
  ];

  let blocks;
  try {
    blocks = images.map((image) => ({
      label: image.label,
      type: mediaType(image.path),
      data: readFileSync(image.path).toString('base64'),
    }));
  } catch (error) {
    return unavailable(`A rendered page could not be read: ${error.message}`);
  }

  const planSummary = {
    expectedChanges: plan.expectedChanges ?? [],
    qualityCriteria: plan.qualityCriteria ?? [],
    affectedPages: plan.affectedPages ?? [],
  };
  const prompt = [
    'You are reviewing an InDesign layout edit. The after images come first, then the before images.',
    `User intent: ${intent || '(not provided)'}`,
    `Plan summary: ${JSON.stringify(planSummary)}`,
    QUALITY_RUBRIC_MARKDOWN,
    'Reply with JSON only, in this shape:',
    '{"pass":true,"scores":{"hierarchy":4,"alignment":4,"spacing":4,"readability":4,"cropping":4,"consistency":4},"findings":[{"severity":"info","page":1,"region":"top","explanation":"..."}],"unintendedChanges":false}',
  ].join('\n\n');

  const isAnthropic = settings.provider === 'anthropic';
  const content = [{ type: 'text', text: prompt }];
  for (const block of blocks) {
    content.push(isAnthropic
      ? { type: 'image', source: { type: 'base64', media_type: block.type, data: block.data } }
      : { type: 'image_url', image_url: { url: `data:${block.type};base64,${block.data}` } });
  }

  let reply;
  try {
    reply = await complete({
      provider: isAnthropic ? 'anthropic' : 'openai',
      baseUrl: settings.baseUrl,
      model: settings.model,
      apiKey: settings.apiKey,
      messages: [{ role: 'user', content }],
      tools: [],
    });
  } catch (error) {
    return unavailable(`The vision model request failed: ${error.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFences(reply?.content));
  } catch {
    return unavailable('The vision model did not return structured JSON.');
  }
  const review = validateVisualReview(parsed);
  if (!review) return unavailable('The vision model returned an invalid review payload.');
  return review;
}
