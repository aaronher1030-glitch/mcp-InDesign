import { runStructuralChecks } from './structuralChecks.js';
import { artifactCoverageError, reviewLayout, validateVisualReview } from './visualReview.js';
import { renderPages } from './pageRenderer.js';

function verificationError(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

function affectedPageRange(plan) {
  const pages = Array.isArray(plan?.affectedPages) && plan.affectedPages.length > 0
    ? plan.affectedPages
    : (plan?.targets ?? []).map((target) => target.pageIndex).filter(Number.isInteger);
  return [...new Set(pages)].sort((left, right) => left - right);
}

/**
 * Combine deterministic structural checks with an optional visual review.
 * Never reports a full pass when visual review is unavailable.
 */
export async function verifyPlan({
  planId,
  visualReview,
  settings,
  intent = '',
  complete,
  runtime,
  inspect,
  render = renderPages,
  structural = runStructuralChecks,
  callTool,
} = {}) {
  if (!runtime || typeof runtime.getPlan !== 'function') {
    throw verificationError('PLAN_INVALID', 'verifyPlan requires a runtime with getPlan');
  }
  const record = runtime.getPlan(planId);
  const plan = record.plan ?? record;
  const planStatus = record.status ?? plan.status;
  if (planStatus !== 'applied') {
    throw verificationError('PLAN_INVALID', `Only applied plans can be verified (status: ${planStatus}).`);
  }

  const pages = affectedPageRange(plan);
  let after = record.after ?? null;
  if (!after && typeof inspect === 'function') {
    try {
      after = await inspect({ pageRange: pages.map((page) => page + 1).join(',') || 'all' });
    } catch (error) {
      after = null;
      record.verificationError = error.message;
    }
  }

  const structure = await structural({
    before: record.before ?? {},
    after: after ?? {},
    plan,
  });

  let afterArtifacts = record.afterArtifacts ?? null;
  if (!afterArtifacts) {
    try {
      afterArtifacts = await render({ pages, callTool: callTool ?? runtime.callTool });
    } catch (error) {
      afterArtifacts = { paths: [], error: error.message };
    }
  }

  const beforeArtifacts = record.beforeArtifacts ?? plan.beforeArtifacts ?? [];
  const beforePaths = Array.isArray(plan.beforeArtifacts)
    ? plan.beforeArtifacts
    : (Array.isArray(beforeArtifacts) ? beforeArtifacts : beforeArtifacts?.paths ?? []);
  const coverageError = artifactCoverageError({
    paths: beforePaths,
    pageIndexes: beforeArtifacts?.pageIndexes,
    error: beforeArtifacts?.error,
  }, pages, 'before') || artifactCoverageError(afterArtifacts, pages, 'after');

  let visual = null;
  let visualUnavailableReason = coverageError;
  if (!coverageError && visualReview !== undefined && visualReview !== null) {
    visual = validateVisualReview(visualReview);
    if (!visual) visualUnavailableReason = 'The submitted visual review was invalid.';
  } else if (!coverageError && settings) {
    try {
      visual = await reviewLayout({
        beforePaths,
        afterPaths: afterArtifacts?.paths ?? [],
        intent: intent || (plan.expectedChanges ?? []).join('; '),
        plan,
        settings,
        complete,
      });
    } catch (error) {
      visual = null;
      visualUnavailableReason = error.message;
    }
    if (visual && visual.status === 'unavailable') visualUnavailableReason = visual.reason;
  } else if (!coverageError) {
    visualUnavailableReason = 'No visual review was supplied and no vision model is configured.';
  }

  const visualPassed = visual?.status === 'passed';
  const status = !structure.pass || visual?.status === 'failed'
    ? 'failed'
    : visualPassed ? 'verified' : 'structurally_checked_only';

  return {
    planId,
    status,
    structural: structure,
    visual: visual ?? { status: 'unavailable', pass: false, reason: visualUnavailableReason },
    artifacts: {
      before: beforePaths,
      after: afterArtifacts?.paths ?? [],
    },
    changed: (plan.targets ?? []).map((target) => ({
      pageIndex: target.pageIndex,
      itemIndex: target.itemIndex ?? target.index,
      name: target.name ?? null,
    })),
    expectedChanges: plan.expectedChanges ?? [],
  };
}
